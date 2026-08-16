import { randomUUID } from 'node:crypto'
import type { MuxFrame, RpcRequest, ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolResultBlock } from '@deepseek-ai/dsh-llm/types'
import type { SnapshotFileDiff } from '@opencode-ai/sdk/v2/types'
import {
  assistantMessageFromEvent,
  isAutoCompactCheckpoint,
  isCompactCheckpoint,
  userMessageFromEvent,
  type MessageConvertOptions,
} from './convert/message.js'
import {
  DEFAULT_AGENT,
  projectIdFor,
  provisionalMessageId,
  provisionalPartId,
  stableId,
  textFromBlocks,
} from './convert/common.js'
import { toPermissionRequest } from './convert/permission.js'
import { toQuestionRequest } from './convert/question.js'
import {
  completedToolPart,
  errorToolPart,
  fileChangesFromToolResult,
  opencodeToolName,
  pendingToolPart,
  streamingToolPart,
  toolResultStructured,
  toolResultText,
  type FileChange,
  type ToolCallInfo,
} from './convert/tool.js'
import { safeJsonParse } from './convert/common.js'
import { convertGoalTodos } from './convert/goal.js'
import { minimalSession } from './convert/session.js'
import { filterGitTrackedDiffs } from './git.js'
import type { InteractionState, NewApprovalEntry, NewQuestionEntry } from './state.js'
import {
  agentErrorEvents,
  commandResultEvents,
  directoryFor,
  earliestBlockStart,
  makeEvent,
  messageEvents,
  messageOptions,
  opencodeError,
  provisionalAssistantMessage,
  streamPart,
  toolCallId,
  toolProgressStructured,
  zeroTokens,
  type BridgeGlobalEvent,
  type TimerHandle,
  type TranslateDeps,
} from './events-util.js'

export {
  agentErrorEvents,
  commandResultEvents,
  makeEvent,
  opencodeError,
  toolCallId,
  toolProgressStructured,
  type BridgeGlobalEvent,
  type TranslateDeps,
} from './events-util.js'

/**
 * Packed dsh chunk rows (`text-chunks` / `reasoning-chunks`) arrive through
 * the session event stream. They carry the first member's time at `time0`
 * plus per-member texts/gaps in `data`.
 */
interface StreamChunkRowEvent {
  type: 'text-chunks' | 'reasoning-chunks'
  seq: number
  time: number
  time0: number
  data: {
    turn: number
    step: number
    index: number
    dt?: number[]
    texts: string[]
  }
}

interface StreamBlockState {
  blockType: 'text' | 'reasoning'
  partId: string
  messageId: string
  start: number
  text: string
  sent: number
}

/**
 * Narrow runtime view of the dsh compaction lifecycle events
 * (`compaction/start`, `compaction/summary`, `compaction/end`). These are
 * plugin-merged session events, so they are read structurally instead of
 * through the public `SessionEvent` union.
 */
interface CompactionEvent {
  type: 'compaction/start' | 'compaction/summary' | 'compaction/end'
  seq: number
  time: number
  data: {
    compactionId?: unknown
    sourceCommandId?: unknown
    turn?: unknown
    summary?: readonly { type: string; text?: unknown }[]
    error?: unknown
  }
}

/** Per-compaction opencode event state (one SSE client's stream view). */
interface CompactionStreamState {
  messageID: string
  text: string
  reason: 'auto' | 'manual'
  ended: boolean
}

/** Accumulated streamed tool input for one `tool-call-delta` index. */
interface ToolInputState {
  key: string
  callId: string
  name: string
  messageID: string
  text: string
  pendingDelta: string
  lastTime: number
  timer?: TimerHandle
  ended: boolean
}

/**
 * Packed dsh tool-call argument rows (`tool-call-chunks`) surface through the
 * session event feed during history replay. Each member is one raw JSON
 * arguments fragment of the same call; the row shares `turn/step/index`.
 */
interface ToolCallChunkRowEvent {
  type: 'tool-call-chunks'
  seq: number
  time: number
  time0: number
  data: {
    turn: number
    step: number
    index: number
    id: unknown
    name?: unknown
    args: string[]
  }
}

interface SessionStreamState {
  turnStartTime?: number
  lastUserMessageId?: string
  provisionalMessageIds: Map<string, string>
  blockStarts: Map<string, number>
  blockEnds: Map<string, number>
  finishReasons: Map<string, string>
  blocks: Map<string, StreamBlockState>
  /** Durable streamed block part ids keyed by `${turn}:${step}:${index}:${blockType}`. */
  blockPartIds: Map<string, string>
  /** Message ids already opened for streaming in this session (per turn). */
  openedMessageIds: Set<string>
  /** Message ids already completed by a final assistant/message this turn. */
  completedMessageIds: Set<string>
  compactions: Map<string, CompactionStreamState>
  toolInputs: Map<string, ToolInputState>
}

/**
 * Per-stream translator: converts one mux frame into zero or more opencode
 * GlobalEvents. One instance is created per SSE client because tool/result
 * pairing and current-message tracking are stream-ordered state.
 */
export class MuxEventTranslator {
  private currentAssistant = new Map<string, string>()
  private pendingCalls = new Map<string, Map<string, ToolCallInfo>>()
  /** Assistant messages waiting for their tool step to finish before the TUI
   * considers them complete (drives the QUEUED badge for later user prompts).
   * One turn may contain several tool-call assistant messages, so the set is
   * keyed by session then message id. */
  private pendingAssistantCompletions = new Map<string, Map<string, {
    messageID: string
    stepKey: string
    info: Record<string, unknown>
  }>>()
  private streams = new Map<string, SessionStreamState>()
  private readonly sessionGoals: Map<string, unknown>
  private readonly sessionTodos: Map<string, unknown>
  private readonly flushMs: number
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle | undefined) => void

  constructor(private deps: TranslateDeps) {
    this.flushMs = deps.toolFlushMs ?? 32
    this.setTimer = deps.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = deps.clearTimeoutImpl ?? ((handle) => {
      if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout)
    })
    this.sessionGoals = deps.sharedState?.goals ?? new Map<string, unknown>()
    this.sessionTodos = deps.sharedState?.todos ?? new Map<string, unknown>()
  }

  private streamState(sessionId: string): SessionStreamState {
    let state = this.streams.get(sessionId)
    if (!state) {
      state = {
        provisionalMessageIds: new Map(),
        blockStarts: new Map(),
        blockEnds: new Map(),
        finishReasons: new Map(),
        blocks: new Map(),
        blockPartIds: new Map(),
        openedMessageIds: new Set(),
        completedMessageIds: new Set(),
        compactions: new Map(),
        toolInputs: new Map(),
      }
      this.streams.set(sessionId, state)
    }
    return state
  }

  /** Emit the merged goal + todo list for one session. */
  private todoUpdateEvents(
    sessionId: string,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    return [
      makeEvent(directory, 'todo.updated', {
        sessionID: sessionId,
        todos: convertGoalTodos(this.sessionGoals.get(sessionId), this.sessionTodos.get(sessionId)),
      }, project),
    ]
  }

  private toolKey(turn: number, step: number, index: number): string {
    return `${turn}:${step}:${index}`
  }

  private assistantMessageId(sessionId: string, turn: number, step: number): string {
    return this.currentAssistant.get(sessionId)
      ?? this.streamState(sessionId).provisionalMessageIds.get(`${turn}:${step}`)
      ?? `assistant:${turn}:${step}`
  }

  private findToolInput(sessionId: string, callId: string): ToolInputState | undefined {
    for (const state of this.streamState(sessionId).toolInputs.values()) {
      if (state.callId === callId) return state
    }
    return undefined
  }

  /**
   * Make sure the current step has a provisional assistant message id so tool
   * parts stream under the same message that the final `assistant/message`
   * will reuse (same id, so the TUI updates one card instead of rendering
   * two). The bridge-generated id registered for the user turn is preferred
   * so the streamed reply also merges with the prompt-route placeholder.
   */
  private ensureProvisionalMessage(
    sessionId: string,
    turn: number,
    step: number,
    time: number,
    directory: string,
    project: string,
  ): { messageID: string; events: BridgeGlobalEvent[] } {
    const state = this.streamState(sessionId)
    const stepKey = `${turn}:${step}`
    const existing = state.provisionalMessageIds.get(stepKey)
    if (existing !== undefined) return { messageID: existing, events: [] }
    const bridgeId = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? '')
    const alreadyOpen = bridgeId !== undefined && state.openedMessageIds.has(bridgeId)
    const messageID = alreadyOpen
      ? provisionalMessageId(sessionId, turn, step)
      : (bridgeId ?? provisionalMessageId(sessionId, turn, step))
    state.provisionalMessageIds.set(stepKey, messageID)
    if (bridgeId !== undefined) state.openedMessageIds.add(bridgeId)
    return {
      messageID,
      events: alreadyOpen
        ? []
        : [makeEvent(directory, 'message.updated', {
            sessionID: sessionId,
            info: provisionalAssistantMessage(
              sessionId,
              this.deps,
              messageID,
              state.turnStartTime ?? time,
              state.lastUserMessageId ?? `pending:${sessionId}:user`,
            ),
          }, project)],
    }
  }

  /**
   * Register a streamed tool input on its first `tool-call-delta` and emit the
   * v2 `input.started` event plus a v1 running ToolPart placeholder.
   */
  private startToolInput(
    sessionId: string,
    turn: number,
    step: number,
    index: number,
    chunk: { id: string; name?: string },
    time: number,
    directory: string,
    project: string,
  ): { state: ToolInputState; events: BridgeGlobalEvent[] } {
    const key = this.toolKey(turn, step, index)
    const existing = this.streamState(sessionId).toolInputs.get(key)
    if (existing !== undefined) return { state: existing, events: [] }

    const callId = String(chunk.id)
    const provisional = this.ensureProvisionalMessage(sessionId, turn, step, time, directory, project)
    const messageID = provisional.messageID
    const state: ToolInputState = {
      key,
      callId,
      name: chunk.name ?? '',
      messageID,
      text: '',
      pendingDelta: '',
      lastTime: time,
      ended: false,
    }
    this.streamState(sessionId).toolInputs.set(key, state)
    const events: BridgeGlobalEvent[] = [
      ...provisional.events,
      makeEvent(directory, 'session.next.tool.input.started', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: messageID,
        callID: callId,
        name: state.name,
      }, project),
      makeEvent(directory, 'message.part.updated', {
        sessionID: sessionId,
        part: streamingToolPart(
          { callId, name: state.name, arguments: '' },
          { sessionID: sessionId, messageID, time },
        ),
        time,
      }, project),
    ]
    return { state, events }
  }

  /** Feed one arguments fragment into a streamed tool input (live or packed). */
  private feedToolCallDelta(
    sessionId: string,
    turn: number,
    step: number,
    index: number,
    id: unknown,
    name: unknown,
    delta: string,
    time: number,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    const { state, events } = this.startToolInput(
      sessionId,
      turn,
      step,
      index,
      { id: String(id), ...(typeof name === 'string' ? { name } : {}) },
      time,
      directory,
      project,
    )
    if (state.name === '' && typeof name === 'string') state.name = name
    state.text += delta
    state.lastTime = time
    this.queueToolDelta(sessionId, state, delta, time, directory, project)
    return events
  }

  /** Coalesce deltas for one tool input into a single pending flush. */
  private queueToolDelta(
    sessionId: string,
    state: ToolInputState,
    delta: string,
    time: number,
    directory: string,
    project: string,
  ): void {
    state.pendingDelta += delta
    state.lastTime = time
    if (state.timer !== undefined) return
    state.timer = this.setTimer(() => {
      state.timer = undefined
      const events = this.flushToolDelta(sessionId, state, directory, project)
      if (events.length > 0) this.deps.onFlush?.(events)
    }, this.flushMs)
  }

  /** Flush one coalesced input delta as v2 delta + v1 running part update. */
  private flushToolDelta(
    sessionId: string,
    state: ToolInputState,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    if (state.timer !== undefined) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
    if (state.ended || state.pendingDelta.length === 0) return []
    const delta = state.pendingDelta
    state.pendingDelta = ''
    return [
      makeEvent(directory, 'session.next.tool.input.delta', {
        timestamp: state.lastTime,
        sessionID: sessionId,
        assistantMessageID: state.messageID,
        callID: state.callId,
        delta,
      }, project),
      makeEvent(directory, 'message.part.updated', {
        sessionID: sessionId,
        part: streamingToolPart(
          { callId: state.callId, name: state.name, arguments: state.text },
          { sessionID: sessionId, messageID: state.messageID, time: state.lastTime },
        ),
        time: state.lastTime,
      }, project),
    ]
  }

  /**
   * Finish a streamed tool input: flush remaining deltas, emit `input.ended`
   * plus `called` with the full parsed input.
   */
  private endToolInput(
    sessionId: string,
    state: ToolInputState,
    directory: string,
    project: string,
    time: number,
  ): BridgeGlobalEvent[] {
    const events = this.flushToolDelta(sessionId, state, directory, project)
    if (state.ended) return events
    state.ended = true
    const input = safeJsonParse(state.text)
    events.push(
      makeEvent(directory, 'session.next.tool.input.ended', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: state.messageID,
        callID: state.callId,
        text: state.text,
      }, project),
      makeEvent(directory, 'session.next.tool.called', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: state.messageID,
        callID: state.callId,
        tool: opencodeToolName(state.name, input),
        input,
        provider: { executed: false },
      }, project),
      makeEvent(directory, 'session.next.tool.progress', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: state.messageID,
        callID: state.callId,
        structured: { title: opencodeToolName(state.name, safeJsonParse(state.text)) },
        content: [],
      }, project),
    )
    return events
  }

  /** Non-streamed fallback: emit started/ended/called in one batch. */
  private completeToolInputImmediately(
    sessionId: string,
    call: ToolCallInfo,
    messageID: string,
    directory: string,
    project: string,
    time: number,
  ): BridgeGlobalEvent[] {
    const input = safeJsonParse(call.arguments)
    return [
      makeEvent(directory, 'session.next.tool.input.started', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: messageID,
        callID: call.callId,
        name: call.name,
      }, project),
      makeEvent(directory, 'session.next.tool.input.ended', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: messageID,
        callID: call.callId,
        text: call.arguments,
      }, project),
      makeEvent(directory, 'session.next.tool.called', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: messageID,
        callID: call.callId,
        tool: opencodeToolName(call.name, input),
        input,
        provider: { executed: false },
      }, project),
      makeEvent(directory, 'session.next.tool.progress', {
        timestamp: time,
        sessionID: sessionId,
        assistantMessageID: messageID,
        callID: call.callId,
        structured: toolProgressStructured(call),
        content: [],
      }, project),
    ]
  }

  private clearToolTimers(sessionId: string): void {
    for (const state of this.streamState(sessionId).toolInputs.values()) {
      if (state.timer !== undefined) {
        this.clearTimer(state.timer)
        state.timer = undefined
      }
    }
  }

  /** Clear any pending throttle timers; safe to call when the SSE ends. */
  dispose(): void {
    for (const sessionId of [...this.streams.keys()]) {
      this.clearToolTimers(sessionId)
    }
  }

  /**
   * Translate the dsh compaction lifecycle to the opencode
   * `session.next.compaction.*` family. The replacement checkpoint
   * `user/message` emits `session.next.compaction.ended` itself, so
   * `compaction/end` only emits when the checkpoint never appeared (e.g. a
   * failed summary) to avoid duplicate compaction entries in the TUI.
   */
  private translateCompactionEvent(
    sessionId: string,
    event: CompactionEvent,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    const key = typeof event.data.compactionId === 'string'
      ? event.data.compactionId
      : String(event.data.compactionId ?? '')
    if (!key) return []
    const state = this.streamState(sessionId)
    const reason = event.data.sourceCommandId === undefined ? 'auto' : 'manual'
    switch (event.type) {
      case 'compaction/start': {
        const messageID = `checkpoint:${key}`
        state.compactions.set(key, { messageID, text: '', reason, ended: false })
        return [
          makeEvent(directory, 'session.next.compaction.started', {
            timestamp: event.time,
            sessionID: sessionId,
            messageID,
            reason,
          }, project),
        ]
      }
      case 'compaction/summary': {
        const pending = state.compactions.get(key)
        if (!pending) return []
        pending.text = textFromBlocks(event.data.summary ?? [])
        return [
          makeEvent(directory, 'session.next.compaction.delta', {
            timestamp: event.time,
            sessionID: sessionId,
            messageID: pending.messageID,
            text: pending.text,
          }, project),
        ]
      }
      case 'compaction/end': {
        const pending = state.compactions.get(key)
        if (!pending || pending.ended) return []
        pending.ended = true
        state.compactions.delete(key)
        const text = pending.text
          || (typeof event.data.error === 'string' && event.data.error
            ? `Compaction failed: ${event.data.error}`
            : '')
        return [
          makeEvent(directory, 'session.next.compaction.ended', {
            timestamp: event.time,
            sessionID: sessionId,
            messageID: pending.messageID,
            reason: pending.reason,
            text,
            recent: '',
          }, project),
        ]
      }
    }
  }

  translate(frame: RpcRequest<MuxFrame>): BridgeGlobalEvent[] {
    const payload = frame.payload
    switch (payload.type) {
      case 'session/event':
        return this.translateSessionEvent(frame.rpcId, payload.sessionId, payload.event, payload.view)
      case 'approval/requested': {
        const approvalId = String(payload.approvalId)
        if (this.deps.replayGuard?.approvals.has(approvalId)) return []
        this.deps.replayGuard?.approvals.add(approvalId)
        const entry: NewApprovalEntry = {
          rpcId: String(frame.rpcId),
          sessionId: String(payload.sessionId),
          approvalId,
          toolName: payload.toolName,
          callId: payload.callId === undefined ? undefined : String(payload.callId),
          reason: payload.reason,
        }
        const registered = this.deps.state.registerApproval({
          opencodeId: randomUUID(),
          ...entry,
        })
        const directory = directoryFor(registered.sessionId, this.deps)
        return [
          makeEvent(
            directory,
            'permission.asked',
            toPermissionRequest(registered) as unknown as Record<string, unknown>,
            projectIdFor(directory),
          ),
        ]
      }
      case 'approval/resolved': {
        const entry = this.deps.state.permissionByApprovalId(String(payload.approvalId))
        if (!entry) {
          this.deps.log(`[bridge/events] approval/resolved for unknown approval ${String(payload.approvalId)}`)
          return []
        }
        const directory = directoryFor(entry.sessionId, this.deps)
        const reply = payload.outcome === 'allowed-once' ? 'once' : 'reject'
        this.deps.state.removePermission(entry.opencodeId)
        return [
          makeEvent(
            directory,
            'permission.replied',
            { sessionID: entry.sessionId, requestID: entry.opencodeId, reply },
            projectIdFor(directory),
          ),
        ]
      }
      case 'question/requested': {
        const questionKey = String(frame.rpcId)
        if (this.deps.replayGuard?.questions.has(questionKey)) return []
        this.deps.replayGuard?.questions.add(questionKey)
        const entry: NewQuestionEntry = {
          rpcId: questionKey,
          sessionId: String(payload.sessionId),
          items: payload.questions,
        }
        const registered = this.deps.state.registerQuestion({
          opencodeId: randomUUID(),
          ...entry,
        })
        const directory = directoryFor(registered.sessionId, this.deps)
        return [
          makeEvent(
            directory,
            'question.asked',
            toQuestionRequest(registered) as unknown as Record<string, unknown>,
            projectIdFor(directory),
          ),
        ]
      }
      case 'question/resolved': {
        const entry = this.deps.state.questionByRpcId(String(payload.questionRpcId))
        if (!entry) {
          this.deps.log(`[bridge/events] question/resolved for unknown rpcId ${String(payload.questionRpcId)}`)
          return []
        }
        const directory = directoryFor(entry.sessionId, this.deps)
        const project = projectIdFor(directory)
        this.deps.state.removeQuestion(entry.opencodeId)
        if (payload.outcome === 'answered') {
          return [
            makeEvent(directory, 'question.replied', {
              sessionID: entry.sessionId,
              requestID: entry.opencodeId,
              answers: [],
            }, project),
          ]
        }
        return [
          makeEvent(directory, 'question.rejected', {
            sessionID: entry.sessionId,
            requestID: entry.opencodeId,
          }, project),
        ]
      }
      case 'session/projection':
        return this.translateProjection(payload.sessionId, payload.key, payload.value)
      case 'session/subscribed':
      case 'session/jobs':
        return []
      case 'session/queue': {
        const sessionId = String(payload.sessionId)
        const directory = directoryFor(sessionId, this.deps)
        const project = projectIdFor(directory)
        const items = Array.isArray(payload.items)
          ? (payload.items as Array<{
              placement: 'queued' | 'steering' | 'context'
              message: { id: string; content: readonly unknown[]; source: { kind: string } }
            }>)
          : []
        const { added } = this.deps.state.initializeInboxProjection(sessionId, items, Date.now())
        return this.queuedMessageEvents(sessionId, added, directory, project)
      }
      case 'stream/error':
        this.deps.log(`[bridge/events] stream/error: ${payload.error.code} ${payload.error.message}`)
        return [makeEvent(this.deps.cwd, 'session.error', {
          error: opencodeError(String(payload.error.code), payload.error.message),
        }, projectIdFor(this.deps.cwd))]
      default:
        this.deps.log(`[bridge/events] unhandled mux frame ${String((payload as { type: string }).type)}`)
        return []
    }
  }

  private translateProjection(
    sessionId: string,
    key: string,
    value: unknown,
  ): BridgeGlobalEvent[] {
    const directory = directoryFor(sessionId, this.deps)
    const project = projectIdFor(directory)
    if (key === 'todos') {
      this.sessionTodos.set(sessionId, value)
      return this.todoUpdateEvents(sessionId, directory, project)
    }
    if (key === 'goal') {
      this.sessionGoals.set(sessionId, value)
      return this.todoUpdateEvents(sessionId, directory, project)
    }
    if (key === 'produced-files') {
      const diff = filterGitTrackedDiffs(directory, convertProducedFiles(value))
      return [makeEvent(directory, 'session.diff', { sessionID: sessionId, diff }, project)]
    }
    if (key === 'title') {
      const title = typeof value === 'string' ? value : ''
      this.deps.state.setSessionTitle(sessionId, title)
      return [
        makeEvent(
          directory,
          'session.updated',
          {
            sessionID: sessionId,
            info: minimalSession(sessionId, {
              cwd: directory,
              title,
              ...(this.deps.state.sessionAgentFor(sessionId) === undefined
                ? {}
                : { agent: this.deps.state.sessionAgentFor(sessionId) }),
            }),
          },
          project,
        ),
      ]
    }
    return []
  }

  private translateSessionEvent(
    rpcId: string,
    sessionId: string,
    event: SessionEvent,
    view?: ToolEventView,
  ): BridgeGlobalEvent[] {
    const directory = directoryFor(sessionId, this.deps)
    const project = projectIdFor(directory)
    switch (event.type) {
      case 'agent/inbox/spliced' as SessionEvent['type']: {
        const splice = event.data as unknown as {
          target: 'next-turn' | 'next-step'
          start: number
          removedCount?: number
          inserted: Array<{ id: string; content: readonly unknown[]; source: { kind: string } }>
          outcome?: 'canceled'
        }
        const { added, removed } = this.deps.state.applyInboxSplice(
          sessionId,
          splice.target,
          splice.start,
          splice.removedCount ?? 0,
          splice.inserted,
          event.time,
        )
        const events = this.queuedMessageEvents(sessionId, added, directory, project)
        if (splice.outcome === 'canceled') {
          for (const message of removed) {
            if (message.source.kind !== 'user') continue
            events.push(
              makeEvent(directory, 'message.removed', {
                sessionID: sessionId,
                messageID: message.id,
              }, project),
            )
          }
        }
        return events
      }
      case 'user/message': {
        this.deps.state.markInput()
        const dshId = String(event.data.id)
        const sourceKind = (event.data.source as { kind?: string } | undefined)?.kind
        const isUserPrompt = sourceKind === 'user'
        const surfaceId = this.deps.state.takePromptMessageId(sessionId, dshId)
        if (surfaceId !== dshId) {
          // The prompt route already echoed this user message (with the
          // bridge-generated id) so the TUI could render its queued card
          // immediately; re-emitting it here would duplicate the card.
          this.deps.state.markBroadcastDshId(sessionId, dshId)
          if (isUserPrompt) this.streamState(sessionId).lastUserMessageId = surfaceId
          return []
        }
        if (this.deps.state.isBroadcastDshId(sessionId, dshId)) {
          // dsh re-broadcasts the durable user/message after the route echo;
          // keep the bridge id as the parent anchor and stay silent.
          if (isUserPrompt) {
            this.streamState(sessionId).lastUserMessageId = this.deps.state.promptIdForDshId(sessionId, dshId) ?? dshId
          }
          return []
        }
        if (this.deps.state.hasPresentedQueued(sessionId, dshId)) {
          // The queued card for this id is already on screen (surfaced from
          // `agent/inbox/spliced`); re-emitting the same user message would
          // render a second card. Keep the durable id in the stream state so
          // the assistant message still parents to it.
          this.deps.state.clearPresentedQueued(sessionId, dshId)
          if (isUserPrompt) this.streamState(sessionId).lastUserMessageId = dshId
          return []
        }
        const events = messageEvents(sessionId, this.deps, () => {
          const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps))
          return {
            info: {
              ...(entry.info as unknown as Record<string, unknown>),
              agent: this.deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT,
            },
            parts: entry.parts as unknown as Array<Record<string, unknown>>,
          }
        })
        if (isCompactCheckpoint(event)) {
          const source = event.data.source as { compactionId?: unknown; sourceCommandId?: unknown }
          const key = typeof source.compactionId === 'string' ? source.compactionId : undefined
          if (key !== undefined) {
            const pending = this.streamState(sessionId).compactions.get(key)
            if (pending) {
              pending.messageID = String(event.data.id)
              pending.text = textFromBlocks(
                event.data.content as readonly { type: string; text?: unknown }[],
              )
              pending.reason = isAutoCompactCheckpoint(event) ? 'auto' : 'manual'
              pending.ended = true
              this.streamState(sessionId).compactions.delete(key)
            }
          }
          events.push(
            makeEvent(
              directory,
              'session.next.compaction.ended',
              {
                timestamp: event.time,
                sessionID: sessionId,
                messageID: String(event.data.id),
                reason: isAutoCompactCheckpoint(event) ? 'auto' : 'manual',
                text: textFromBlocks(
                  event.data.content as readonly { type: string; text?: unknown }[],
                ),
                recent: '',
              },
              project,
            ),
          )
        }
        if (isUserPrompt) this.streamState(sessionId).lastUserMessageId = dshId
        return events
      }
      case 'compaction/start' as SessionEvent['type']:
      case 'compaction/summary' as SessionEvent['type']:
      case 'compaction/end' as SessionEvent['type']:
        return this.translateCompactionEvent(
          sessionId,
          event as unknown as CompactionEvent,
          directory,
          project,
        )
      case 'assistant/chunk': {
        const chunkSeqKey = `${sessionId}:${event.seq}`
        if (this.deps.replayGuard?.chunks?.has(chunkSeqKey)) return []
        this.deps.replayGuard?.chunks?.add(chunkSeqKey)
        const chunk = event.data.chunk
        if (chunk.type === 'block-start') {
          this.streamState(sessionId).blockStarts.set(
            `${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`,
            event.time,
          )
          return []
        }
        if (chunk.type === 'finish') {
          this.streamState(sessionId).finishReasons.set(`${event.data.turn}:${event.data.step}`, chunk.reason.kind)
          return []
        }
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          return this.translateStreamChunks(
            sessionId,
            {
              type: chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks',
              seq: event.seq,
              time: event.time,
              time0: event.time,
              data: {
                turn: event.data.turn,
                step: event.data.step,
                index: chunk.index,
                texts: [chunk.text],
              },
            },
            directory,
            project,
          )
        }
        if (chunk.type === 'tool-call-delta') {
          return this.feedToolCallDelta(
            sessionId,
            event.data.turn,
            event.data.step,
            chunk.index,
            chunk.id,
            chunk.name,
            chunk.argumentsDelta,
            event.time,
            directory,
            project,
          )
        }
        return []
      }
      case 'tool-call-chunks' as SessionEvent['type']:
        return this.translateToolCallChunks(
          sessionId,
          event as unknown as ToolCallChunkRowEvent,
          directory,
          project,
        )
      case 'text-chunks' as SessionEvent['type']:
      case 'reasoning-chunks' as SessionEvent['type']:
        {
          const chunkSeqKey = `${sessionId}:${event.seq}`
          if (this.deps.replayGuard?.chunks?.has(chunkSeqKey)) return []
          this.deps.replayGuard?.chunks?.add(chunkSeqKey)
        }
        return this.translateStreamChunks(
          sessionId,
          event as unknown as StreamChunkRowEvent,
          directory,
          project,
        )
      case 'assistant/message': {
        const state = this.streamState(sessionId)
        const stepKey = `${event.data.turn}:${event.data.step}`
        const dshId = String(event.data.message.id)
        const provisionalId = state.provisionalMessageIds.get(stepKey)
        const streamed = provisionalId !== undefined
        const bridgeForUser = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? '')
        const messageID = streamed
          ? provisionalId
          : (bridgeForUser ?? dshId)
        if (streamed) {
          this.deps.state.recordAssistantId(sessionId, dshId, provisionalId)
        } else if (bridgeForUser !== undefined) {
          this.deps.state.recordAssistantId(sessionId, dshId, bridgeForUser)
        }
        const created = earliestBlockStart(state.blockStarts, event.data.turn, event.data.step)
          ?? state.turnStartTime
          ?? event.time
        const events = messageEvents(sessionId, this.deps, () => {
          const entry = assistantMessageFromEvent(
            event,
            messageOptions(sessionId, this.deps),
            (index, blockType) => state.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`),
            (index, blockType) => state.blockEnds.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`),
            created,
            state.lastUserMessageId,
            state.finishReasons.get(stepKey) ?? 'stop',
            (index, blockType) => {
              return state.blockPartIds.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`)
            },
          )
          const info = {
            ...entry.info,
            id: messageID,
            agent: this.deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT,
          } as unknown as Record<string, unknown>
          if (event.data.message.content.some((block) => block.type === 'tool-call')) {
            // The message is not complete until its tool calls finish; leaving
            // `time.completed` unset keeps later user prompts marked QUEUED.
            const time = info.time as { created?: number; completed?: number } | undefined
            if (time !== undefined) delete time.completed
            let byMessage = this.pendingAssistantCompletions.get(sessionId)
            if (byMessage === undefined) {
              byMessage = new Map()
              this.pendingAssistantCompletions.set(sessionId, byMessage)
            }
            byMessage.set(messageID, {
              messageID,
              stepKey,
              info,
            })
          } else if ((info.time as { completed?: number } | undefined)?.completed !== undefined) {
            state.completedMessageIds.add(messageID)
          }
          return {
            info,
            parts: entry.parts.map((part) => ({
              ...part,
              id: String(part.id).replaceAll(dshId, messageID),
              messageID,
            })) as unknown as Array<Record<string, unknown>>,
          }
        }, true)
        // The official TUI resets streamed parts when a completed=no
        // message.updated arrives after the final parts; without that reset
        // update, a fast completion can leave the streamed text block AND the
        // final text block both rendered (duplicate reply).
        const last = events.at(-1)
        if (last?.payload.type === 'message.updated'
          && (last.payload.properties.info as { time?: { completed?: number } }).time?.completed !== undefined) {
          events.pop()
          const info = last.payload.properties.info as { time: { created: number; completed: number } }
          events.push(
            makeEvent(directory, 'message.updated', {
              sessionID: sessionId,
              info: { ...info, time: { created: info.time.created } },
            }, project),
            last,
          )
        }
        if (streamed) state.provisionalMessageIds.delete(stepKey)
        this.currentAssistant.set(sessionId, messageID)
        let calls = this.pendingCalls.get(sessionId)
        if (!calls) {
          calls = new Map<string, ToolCallInfo>()
          this.pendingCalls.set(sessionId, calls)
        }
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            calls.set(String(block.id), {
              callId: String(block.id),
              name: block.name,
              arguments: block.arguments,
            })
            const inputState = this.findToolInput(sessionId, String(block.id))
            if (inputState !== undefined && !inputState.ended) {
              events.push(...this.endToolInput(sessionId, inputState, directory, project, event.time))
            }
          }
        }
        // The finalized message replaced the provisional parts; drop the
        // streamed blocks so turn/end does not emit stale closing updates.
        for (const key of [...state.blocks.keys()]) {
          if (key.startsWith(`${stepKey}:`)) state.blocks.delete(key)
        }
        return events
      }
      case 'turn/start':
        this.streamState(sessionId).turnStartTime = event.time
        return [
          makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'busy' } }, project),
          makeEvent(directory, 'turn.wait', { sessionID: sessionId }, project),
        ]
      case 'turn/end': {
        const state = this.streamState(sessionId)
        const events = [
          makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project),
          makeEvent(directory, 'session.idle', { sessionID: sessionId }, project),
          makeEvent(directory, 'turn.idle', { sessionID: sessionId }, project),
        ]
        // On interrupt the final assistant/message may never arrive; close any
        // still-open reasoning blocks so the TUI's thinking indicator stops.
        for (const [key, candidate] of [...state.blocks]) {
          if (candidate.blockType === 'reasoning') {
            events.push(
              makeEvent(directory, 'message.part.updated', {
                sessionID: sessionId,
                part: streamPart('reasoning', sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, event.time),
                time: event.time,
              }, project),
            )
            state.blocks.delete(key)
          }
        }
        const pendings = this.pendingAssistantCompletions.get(sessionId)
        if (pendings !== undefined) {
          for (const pending of pendings.values()) {
            if (!state.completedMessageIds.has(pending.messageID)) {
              events.push(
                makeEvent(directory, 'message.updated', {
                  sessionID: sessionId,
                  info: {
                    ...pending.info,
                    time: {
                      created: (pending.info.time as { created?: number })?.created ?? event.time,
                      completed: event.time,
                    },
                  },
                }, project),
              )
            }
          }
          this.pendingAssistantCompletions.delete(sessionId)
        }
        // Close provisional assistant messages that never got a final
        // assistant/message (interrupt/error): without `completed` the TUI
        // keeps them pending forever (the "spinner keeps spinning" class).
        for (const [stepKey, messageID] of [...state.provisionalMessageIds]) {
          if (state.completedMessageIds.has(messageID)) continue
          const created = state.blockStarts.get(`${stepKey}:text`)
            ?? state.blockStarts.get(`${stepKey}:reasoning`)
            ?? state.turnStartTime
            ?? event.time
          const base = provisionalAssistantMessage(
            sessionId,
            this.deps,
            messageID,
            created,
            state.lastUserMessageId ?? `pending:${sessionId}:user`,
          )
          const baseTime = base.time as { created?: number } | undefined
          events.push(
            makeEvent(directory, 'message.updated', {
              sessionID: sessionId,
              info: {
                ...base,
                time: { created: baseTime?.created ?? created, completed: event.time },
              },
            }, project),
          )
        }
        state.provisionalMessageIds.clear()
        state.openedMessageIds.clear()
        state.completedMessageIds.clear()
        this.currentAssistant.delete(sessionId)
        this.pendingCalls.delete(sessionId)
        this.clearToolTimers(sessionId)
        this.streams.delete(sessionId)
        return events
      }
      case 'step/end' as SessionEvent['type']: {
        // A tool-call step may be followed by more steps of the same turn
        // (e.g. the follow-up text after the tool result). Completing the
        // message here marks the card finished too early and later parts for
        // the same message render out of order. Defer completion to
        // `turn/end`; the QUEUED badge for prompts submitted mid-turn stays
        // correct as long as the message is incomplete.
        return []
      }
      case 'todo/write':
        this.sessionTodos.set(sessionId, event.data.todos)
        return this.todoUpdateEvents(sessionId, directory, project)
      case 'step/start' as SessionEvent['type']:
      case 'request/header' as SessionEvent['type']:
      case 'request/context' as SessionEvent['type']:
      case 'session/title-llm-request' as SessionEvent['type']:
      case 'permission/preset' as SessionEvent['type']:
      case 'sandbox/mode' as SessionEvent['type']:
      case 'approval/policy' as SessionEvent['type']:
      case 'command/run' as SessionEvent['type']:
      case 'command/done' as SessionEvent['type']:
      case 'session/end-seed' as SessionEvent['type']:
      case 'approval/asked' as SessionEvent['type']:
      case 'approval/decided' as SessionEvent['type']:
        // Log-only / environment-snapshot events: no TUI surface. Explicitly
        // silent so genuinely unknown event types stay loud in the logs.
        return []
      case 'agent-preset/selected' as SessionEvent['type']: {
        const preset = (event.data as { agentPreset?: unknown }).agentPreset
        if (typeof preset === 'string') this.deps.state.lastAgentPreset = preset
        return []
      }
      case 'goal/change' as SessionEvent['type']: {
        const data = (event as unknown as { data: { goal?: unknown; cleared?: unknown } }).data
        if (data?.goal !== undefined) {
          this.sessionGoals.set(sessionId, { goal: data.goal })
        } else if (data?.cleared !== undefined) {
          this.sessionGoals.set(sessionId, null)
        } else {
          return []
        }
        return this.todoUpdateEvents(sessionId, directory, project)
      }
      case 'tool/call': {
        const data = event.data
        const call: ToolCallInfo = {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
          ...(view === undefined ? {} : { view }),
        }
        let calls = this.pendingCalls.get(sessionId)
        if (!calls) {
          calls = new Map<string, ToolCallInfo>()
          this.pendingCalls.set(sessionId, calls)
        }
        calls.set(call.callId, call)
        const provisional = this.currentAssistant.get(sessionId) === undefined
          ? this.ensureProvisionalMessage(sessionId, data.turn, data.step, event.time, directory, project)
          : undefined
        const messageID = this.currentAssistant.get(sessionId)
          ?? provisional?.messageID
          ?? `assistant:${data.turn}:${data.step}`
        const inputState = this.findToolInput(sessionId, call.callId)
        const inputEvents = inputState === undefined
          ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time)
          : this.endToolInput(sessionId, inputState, directory, project, event.time)
        return [
          ...(provisional?.events ?? []),
          ...inputEvents,
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part: pendingToolPart(call, { sessionID: sessionId, messageID, time: event.time }),
            time: event.time,
          }, project),
        ]
      }
      case 'tool/result': {
        const data = event.data
        const callId = toolCallId(event)
        const calls = this.pendingCalls.get(sessionId)
        const call = calls?.get(callId)
        if (!call) {
          this.deps.log(`[bridge/events] tool/result without tool/call for ${callId}`)
          return []
        }
        const provisional = this.currentAssistant.get(sessionId) === undefined
          ? this.ensureProvisionalMessage(sessionId, data.turn, data.step, event.time, directory, project)
          : undefined
        const messageID = this.currentAssistant.get(sessionId)
          ?? provisional?.messageID
          ?? `assistant:${data.turn}:${data.step}`
        const inputState = this.findToolInput(sessionId, callId)
        const inputEvents = inputState === undefined
          ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time)
          : this.endToolInput(sessionId, inputState, directory, project, event.time)
        const resultInfo = {
          callId,
          content: data.message.content,
          time: event.time,
          meta: data.meta,
          view,
          callView: call.view,
        }
        const part = data.error === undefined
          ? completedToolPart(call, {
              ...resultInfo,
            }, { sessionID: sessionId, messageID, time: event.time })
          : errorToolPart(call, {
              ...resultInfo,
              error: data.error,
            }, { sessionID: sessionId, messageID, time: event.time })
        calls?.delete(callId)
        const events: BridgeGlobalEvent[] = [
          ...(provisional?.events ?? []),
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part,
            time: event.time,
          }, project),
        ]
        const output = toolResultText(resultInfo)
        const tail = data.error === undefined
          ? [makeEvent(directory, 'session.next.tool.success', {
              timestamp: event.time,
              sessionID: sessionId,
              assistantMessageID: messageID,
              callID: callId,
              structured: toolResultStructured(resultInfo),
              content: [{ type: 'text', text: output }],
              provider: { executed: true },
            }, project)]
          : [makeEvent(directory, 'session.next.tool.failed', {
              timestamp: event.time,
              sessionID: sessionId,
              assistantMessageID: messageID,
              callID: callId,
              error: {
                code: data.error.code,
                message: data.error.name,
              },
              provider: { executed: true },
            }, project)]
        if (data.error === undefined) {
          const changes = fileChangesFromToolResult(call, resultInfo)
          if (changes.length > 0) {
            events.push(...fileChangeEvents(sessionId, messageID, changes, project, directory, event.time))
          }
        }
        return [...inputEvents, ...events, ...tail]
      }
      default: {
        const type = event.type as string
        const data = (event as unknown as { data: { time?: number; title?: unknown; text?: unknown } }).data
        if (type === 'session') {
          // The durable `session` row is flat (id/createdAt/cwd live on the
          // event, not under `data`); tolerate both shapes.
          const flat = event as unknown as { createdAt?: number; cwd?: string; title?: string }
          const header = (data ?? flat) as { createdAt?: number; cwd?: string; title?: string }
          const childDirectory = header.cwd ?? this.deps.state.sessionDirectories.get(sessionId) ?? directory
          const parentID = this.deps.state.sessionParents.get(sessionId)
          return [
            makeEvent(childDirectory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: childDirectory,
                title: header.title ?? '',
                createdAt: header.createdAt ?? Date.now(),
                ...(this.deps.state.sessionAgentFor(sessionId) === undefined
                  ? {}
                  : { agent: this.deps.state.sessionAgentFor(sessionId) }),
                ...(parentID === undefined ? {} : { parentID }),
              }),
            }, projectIdFor(childDirectory)),
          ]
        }
        if (type === 'session/created') {
          const parentID = this.deps.state.sessionParents.get(sessionId)
          const flat = event as unknown as { createdAt?: number }
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: directory,
                createdAt: data?.time ?? flat.createdAt,
                ...(this.deps.state.sessionAgentFor(sessionId) === undefined
                  ? {}
                  : { agent: this.deps.state.sessionAgentFor(sessionId) }),
                ...(parentID === undefined ? {} : { parentID }),
              }),
            }, project),
          ]
        }
        if (type === 'session/title') {
          const title = typeof data.title === 'string' ? data.title
            : typeof data.text === 'string' ? data.text
              : ''
          this.deps.state.setSessionTitle(sessionId, title)
          const parentID = this.deps.state.sessionParents.get(sessionId)
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: directory,
                title,
                createdAt: data.time,
                ...(this.deps.state.sessionAgentFor(sessionId) === undefined
                  ? {}
                  : { agent: this.deps.state.sessionAgentFor(sessionId) }),
                ...(parentID === undefined ? {} : { parentID }),
              }),
            }, project),
          ]
        }
        this.deps.log(`[bridge/events] unhandled session event ${event.type} (rpcId ${rpcId})`)
        return []
      }
    }
  }

  /** Surface dsh pending inbox messages as opencode queued user messages. */
  private queuedMessageEvents(
    sessionId: string,
    messages: readonly { id: string; content: readonly unknown[]; source: { kind: string }; enqueuedAt: number }[],
    directory: string,
    project: string | undefined,
  ): BridgeGlobalEvent[] {
    const events: BridgeGlobalEvent[] = []
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      // Prompts echoed by the prompt route (or surfaced there via the dsh
      // user/message echo) must not be presented again from the queue; that
      // would render a second user card.
      if (this.deps.state.peekPromptMessageId(sessionId) !== undefined) continue
      if (this.deps.state.isBroadcastDshId(sessionId, String(message.id))) continue
      const model = this.deps.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
      const agent = this.deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT
      events.push(
        makeEvent(directory, 'message.updated', {
          sessionID: sessionId,
          info: {
            id: message.id,
            sessionID: sessionId,
            role: 'user',
            time: { created: message.enqueuedAt },
            agent,
            model,
          },
        }, project),
      )
      message.content.forEach((block, index) => {
        const textBlock = block as { type?: string; text?: unknown }
        if (textBlock.type !== 'text' || typeof textBlock.text !== 'string') return
        events.push(
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part: {
              id: `${message.id}:${index}`,
              sessionID: sessionId,
              messageID: message.id,
              type: 'text',
              text: textBlock.text,
              time: { start: message.enqueuedAt, end: message.enqueuedAt },
            },
          }, project),
        )
      })
    }
    return events
  }

  private translateStreamChunks(
    sessionId: string,
    event: StreamChunkRowEvent,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    const state = this.streamState(sessionId)
    const blockType = event.type === 'text-chunks' ? 'text' : 'reasoning'
    const blockKey = `${event.data.turn}:${event.data.step}:${event.data.index}`
    const blockStartKey = `${blockKey}:${blockType}`
    const time0 = event.time0 ?? event.time
    let block = state.blocks.get(blockKey)
    if (block && block.blockType !== blockType) {
      this.deps.log(`[bridge/events] chunk block type changed for ${blockKey} (${block.blockType} -> ${blockType})`)
      return []
    }
    const events: BridgeGlobalEvent[] = []
    if (!block) {
      if (!state.blockStarts.has(blockStartKey)) {
        state.blockStarts.set(blockStartKey, time0)
      }
      if (blockType === 'text') {
        // The model finished reasoning once the first text chunk of the step
        // arrives; close the open reasoning part so the TUI stops animating it.
        for (const [key, candidate] of [...state.blocks]) {
          if (candidate.blockType === 'reasoning' && key.startsWith(`${event.data.turn}:${event.data.step}:`)) {
            events.push(
              makeEvent(directory, 'message.part.updated', {
                sessionID: sessionId,
                part: streamPart('reasoning', sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, time0),
                time: time0,
              }, project),
            )
            state.blocks.delete(key)
          }
        }
      }
      const stepKey = `${event.data.turn}:${event.data.step}`
      let provisionalId = state.provisionalMessageIds.get(stepKey)
      if (!provisionalId) {
        const bridgeId = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? '')
        const alreadyOpen = bridgeId !== undefined && state.openedMessageIds.has(bridgeId)
        provisionalId = alreadyOpen
          ? provisionalMessageId(sessionId, event.data.turn, event.data.step)
          : (bridgeId ?? provisionalMessageId(sessionId, event.data.turn, event.data.step))
        state.provisionalMessageIds.set(stepKey, provisionalId)
        if (bridgeId !== undefined) state.openedMessageIds.add(bridgeId)
        if (!alreadyOpen) {
          events.push(
            makeEvent(directory, 'message.updated', {
              sessionID: sessionId,
              info: provisionalAssistantMessage(
                sessionId,
                this.deps,
                provisionalId,
                state.blockStarts.get(blockStartKey) ?? state.turnStartTime ?? time0,
                state.lastUserMessageId ?? `pending:${sessionId}:user`,
              ),
            }, project),
          )
        }
      }
      block = {
        blockType,
        partId: provisionalPartId(sessionId, event.data.turn, event.data.step, blockType, event.data.index),
        messageId: provisionalId,
        start: state.blockStarts.get(blockStartKey) ?? time0,
        text: '',
        sent: 0,
      }
      state.blocks.set(blockKey, block)
      state.blockPartIds.set(blockStartKey, block.partId)
    }
    const sent = block.sent
    block.text += event.data.texts.join('')
    state.blockEnds.set(blockStartKey, event.time ?? time0)
    block.sent = block.text.length
    if (sent === 0) {
      events.push(
        makeEvent(directory, 'message.part.updated', {
          sessionID: sessionId,
          part: streamPart(block.blockType, sessionId, block.messageId, block.partId, '', block.start),
          time: time0,
        }, project),
      )
    }
    if (block.sent > sent) {
      events.push(
        makeEvent(directory, 'message.part.delta', {
          sessionID: sessionId,
          messageID: block.messageId,
          partID: block.partId,
          field: 'text',
          delta: block.text.slice(sent),
          time: time0,
        }, project),
      )
    }
    return events
  }

  /** Translate a packed `tool-call-chunks` storage row (history replay). */
  private translateToolCallChunks(
    sessionId: string,
    event: ToolCallChunkRowEvent,
    directory: string,
    project: string,
  ): BridgeGlobalEvent[] {
    const events: BridgeGlobalEvent[] = []
    const time = event.time0 ?? event.time
    for (const fragment of event.data.args) {
      if (typeof fragment !== 'string' || fragment.length === 0) continue
      events.push(...this.feedToolCallDelta(
        sessionId,
        event.data.turn,
        event.data.step,
        event.data.index,
        event.data.id,
        event.data.name,
        fragment,
        time,
        directory,
        project,
      ))
    }
    return events
  }
}

/** Best-effort conversion of a produced-files projection to SnapshotFileDiff[]. */
export function convertProducedFiles(value: unknown): SnapshotFileDiff[] {
  if (!Array.isArray(value)) return []
  const result: SnapshotFileDiff[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const additions = typeof item.additions === 'number' ? item.additions : 0
    const deletions = typeof item.deletions === 'number' ? item.deletions : 0
    const file = typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : undefined
    const status = item.status === 'added' || item.status === 'deleted' || item.status === 'modified'
      ? item.status
      : file === undefined ? undefined : 'modified'
    result.push({
      ...(file === undefined ? {} : { file }),
      ...(typeof item.patch === 'string' ? { patch: item.patch } : {}),
      additions,
      deletions,
      ...(status === undefined ? {} : { status }),
    })
  }
  return result
}

/** Convert bridge file changes to the opencode SnapshotFileDiff shape. */
export function toSnapshotFileDiffs(changes: readonly FileChange[]): SnapshotFileDiff[] {
  return changes.map((change) => ({
    file: change.file,
    ...(change.patch === undefined ? {} : { patch: change.patch }),
    additions: change.additions,
    deletions: change.deletions,
    ...(change.status === undefined ? {} : { status: change.status }),
  }))
}

/**
 * Emit the message parts and session diff that make a completed file-changing
 * tool visible to the opencode TUI (sidebar "Modified Files" plus snapshot /
 * patch parts for consumers that render them).
 */
export function fileChangeEvents(
  sessionID: string,
  messageID: string,
  changes: readonly FileChange[],
  project: string,
  directory: string,
  time: number,
): BridgeGlobalEvent[] {
  if (changes.length === 0) return []
  const trackedChanges = filterGitTrackedDiffs(directory, changes)
  if (trackedChanges.length === 0) return []
  const patch = trackedChanges
    .map((change) => change.patch)
    .filter((value): value is string => value !== undefined)
    .join('\n')
  const files = trackedChanges.map((change) => change.file)
  const hash = stableId(`${sessionID}:${messageID}:${files.join('\u0000')}:${patch}`)
  const events: BridgeGlobalEvent[] = [
    makeEvent(directory, 'message.part.updated', {
      sessionID,
      part: {
        id: `patch:${hash}`,
        sessionID,
        messageID,
        type: 'patch',
        hash,
        files,
      },
      time,
    }, project),
    makeEvent(directory, 'session.diff', {
      sessionID,
      diff: toSnapshotFileDiffs(trackedChanges),
    }, project),
  ]
  if (patch) {
    events.unshift(
      makeEvent(directory, 'message.part.updated', {
        sessionID,
        part: {
          id: `snapshot:${hash}`,
          sessionID,
          messageID,
          type: 'snapshot',
          snapshot: hash,
        },
        time,
      }, project),
    )
  }
  return events
}

/**
 * Map a dsh `host/agent-error` frame to opencode events: the protocol
 * `session.error` plus a visible assistant message so the TUI conversation
 * shows the error text instead of swallowing it or rendering an object.
 */
