import { randomUUID } from 'node:crypto'
import type { BridgeFrame, ToolEventView } from './dsh-types.js'
import type { BridgeEvent } from './dsh-types.js'
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
  externalProviderId,
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
  isSubagentToolName,
  opencodeToolName,
  pendingToolPart,
  runningToolPart,
  subagentTypeFromToolName,
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
import type {
  InteractionState,
  NewApprovalEntry,
  NewQuestionEntry,
  SubagentCallRecord,
  SubagentChildRecord,
} from './state.js'
import {
  agentErrorEvents,
  commandResultEvents,
  commandResultMessage,
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

function minimumAssistantCreatedAt(userTime: number | undefined): number {
  return userTime === undefined ? Number.MIN_SAFE_INTEGER : userTime + 1
}

export {
  agentErrorEvents,
  commandResultEvents,
  commandResultMessage,
  makeEvent,
  opencodeError,
  toolCallId,
  toolProgressStructured,
  type BridgeGlobalEvent,
  type TranslateDeps,
} from './events-util.js'

/**
 * Extract an error descriptor from a tool-result message content when dsh
 * marked the block `isError` (e.g. a permission-rejected tool) without a
 * top-level `error` field on the event. Returns the first matching error
 * carrying the block's own text, so the opencode TUI renders a readable
 * "failed: <text>" (the mini TUI has no tool card title, only the error).
 */
function toolResultContentError(
  content: readonly unknown[],
): { name: string; code: string } | undefined {
  for (const block of content) {
    const record = block as { type?: unknown; isError?: unknown; content?: unknown } | null
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'tool-result') continue
    if (record.isError !== true) continue
    const inner = Array.isArray(record.content) ? record.content : []
    for (const part of inner) {
      const text = (part as { type?: unknown; text?: unknown } | null)?.text
      if (typeof text === 'string' && text.length > 0) {
        return { name: text, code: 'tool-rejected' }
      }
    }
  }
  return undefined
}

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
  /** Latest visible user timestamp used to keep a provisional assistant key
   * from preceding its parent when turn/start arrives first. */
  lastUserMessageCreatedAt?: number
  provisionalMessageIds: Map<string, string>
  /** Stable `time.created` for each provisional assistant message. OpenCode
   * 1.18.18 keys live messages by `time.created + id`; when turn/start opens
   * a card before the first chunk, its timestamp must be reused by the final
   * assistant update or the TUI inserts a second card and leaves the first
   * one spinning forever. */
  provisionalMessageCreatedAt: Map<string, number>
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

  /** Drop all live/replay state when the Host reports a Session removal. */
  disposeSession(sessionId: string): void {
    this.currentAssistant.delete(sessionId)
    this.pendingCalls.delete(sessionId)
    this.pendingAssistantCompletions.delete(sessionId)
    this.streams.delete(sessionId)
    this.sessionGoals.delete(sessionId)
    this.sessionTodos.delete(sessionId)
  }

  private streamState(sessionId: string): SessionStreamState {
    let state = this.streams.get(sessionId)
    if (!state) {
      state = {
        provisionalMessageIds: new Map(),
        provisionalMessageCreatedAt: new Map(),
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

  /** Preserve child identity on every replacement session.updated payload. */
  private sessionLineageOptions(sessionId: string): {
    parentID?: string
    metadata?: Record<string, unknown>
  } {
    const parentID = this.deps.state.sessionParents.get(sessionId)
    if (parentID === undefined) return {}
    return {
      parentID,
      ...(this.deps.state.isSubagentSession(sessionId) ? { metadata: { origin: 'subagent' } } : {}),
    }
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

  /** Register a dsh delegation in shared state before rendering its part. */
  private registerSubagentCall(
    sessionId: string,
    call: ToolCallInfo,
    messageID: string,
    time: number,
    turn?: number,
    step?: number,
  ): { call: ToolCallInfo; record?: SubagentCallRecord; child?: SubagentChildRecord } {
    if (!isSubagentToolName(call.name)) return { call }
    const input = safeJsonParse(call.arguments)
    const record: SubagentCallRecord = {
      parentSessionId: sessionId,
      callId: call.callId,
      toolName: call.name,
      arguments: call.arguments,
      messageId: messageID,
      description: typeof input.description === 'string' ? input.description : call.name,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      subagentType: typeof input.subagent_type === 'string' && input.subagent_type.trim() !== ''
        ? input.subagent_type
        : subagentTypeFromToolName(call.name),
      ...(input.run_in_background === true ? { background: true } : {}),
      ...(input.run_in_background === false ? { childMode: 'one-shot' as const } : {}),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      createdAt: time,
    }
    const registered = this.deps.state.registerSubagentCall(record)
    const child = this.deps.state.subagentChildForCall(sessionId, call.callId)
    if (child === undefined) return { call, record: registered }
    return {
      record: registered,
      child,
      call: {
        ...call,
        subagent: {
          sessionId: child.sessionId,
          parentSessionId: sessionId,
          ...(child.mode ?? registered.childMode) === undefined ? {} : { mode: child.mode ?? registered.childMode },
          ...(registered.background === undefined ? {} : { background: registered.background }),
        },
      },
    }
  }

  /** Refresh a stored delegation call with any child identity learned later. */
  private callWithSubagentChild(sessionId: string, call: ToolCallInfo): ToolCallInfo {
    if (!isSubagentToolName(call.name)) return call
    const record = this.deps.state.subagentCallFor(sessionId, call.callId)
    const child = this.deps.state.subagentChildForCall(sessionId, call.callId)
    if (child === undefined && call.subagent === undefined) return call
    return {
      ...call,
      subagent: {
        ...(call.subagent ?? {}),
        ...(record?.background === undefined ? {} : { background: record.background }),
        ...(child === undefined ? {} : {
          sessionId: child.sessionId,
          parentSessionId: sessionId,
          ...((child.mode ?? record?.childMode) === undefined ? {} : { mode: child.mode ?? record?.childMode }),
        }),
      },
    }
  }

  /** Emit a running Task replacement once the child session is known. */
  private subagentTaskUpdate(
    sessionId: string,
    call: ToolCallInfo,
    record: SubagentCallRecord | undefined,
    child: SubagentChildRecord | undefined,
    time: number,
  ): BridgeGlobalEvent | undefined {
    if (!isSubagentToolName(call.name) || record?.partEmitted !== true || child === undefined) return undefined
    const effective = this.callWithSubagentChild(sessionId, {
      ...call,
      subagent: {
        sessionId: child.sessionId,
        parentSessionId: sessionId,
        ...((child.mode ?? record.childMode) === undefined ? {} : { mode: child.mode ?? record.childMode }),
        ...(record.background === undefined ? {} : { background: record.background }),
      },
    })
    const directory = directoryFor(sessionId, this.deps)
    const result = record?.resultStatus === undefined
      ? undefined
      : {
          callId: effective.callId,
          content: (record.resultContent ?? []) as never,
          time: record.resultTime ?? time,
          ...(record.resultError === undefined ? {} : { error: record.resultError }),
        }
    const part = result === undefined
      ? runningToolPart(effective, {
          sessionID: sessionId,
          messageID: record.messageId,
          time: record.createdAt,
        })
      : record.resultStatus === 'error'
        ? errorToolPart(effective, result, {
            sessionID: sessionId,
            messageID: record.messageId,
            time: record.createdAt,
          })
        : completedToolPart(effective, result, {
            sessionID: sessionId,
            messageID: record.messageId,
            time: record.createdAt,
          })
    return makeEvent(directory, 'message.part.updated', {
      sessionID: sessionId,
      part,
      time,
    }, projectIdFor(directory))
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
    const promptCreatedAt = state.lastUserMessageCreatedAt
      ?? (state.lastUserMessageId === undefined
        ? undefined
        : this.deps.state.promptMessageCreatedAt(sessionId, state.lastUserMessageId))
    const createdAt = Math.max(
      this.deps.state.assistantMessageCreatedAt(sessionId, messageID) ?? time,
      minimumAssistantCreatedAt(promptCreatedAt),
    )
    state.provisionalMessageIds.set(stepKey, messageID)
    state.provisionalMessageCreatedAt.set(stepKey, createdAt)
    this.deps.state.setAssistantMessageCreatedAt(sessionId, messageID, createdAt)
    this.deps.state.markAssistantPending(sessionId, messageID)
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
              createdAt,
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

  translate(frame: BridgeFrame): BridgeGlobalEvent[] {
    switch (frame.type) {
      case 'session/event':
        return this.translateSessionEvent(frame.sessionId, frame.event, frame.view)
      case 'approval/requested': {
        const approvalId = String(frame.approvalId)
        if (this.deps.replayGuard?.approvals.has(approvalId)) return []
        this.deps.replayGuard?.approvals.add(approvalId)
        const entry: NewApprovalEntry = {
          rpcId: String(frame.rpcId),
          sessionId: String(frame.sessionId),
          approvalId,
          toolName: frame.toolName,
          callId: frame.callId === undefined ? undefined : String(frame.callId),
          reason: frame.reason,
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
        const entry = this.deps.state.permissionByApprovalId(String(frame.approvalId))
        if (!entry) {
          this.deps.log(`[bridge/events] approval/resolved for unknown approval ${String(frame.approvalId)}`)
          return []
        }
        const directory = directoryFor(entry.sessionId, this.deps)
        const reply = frame.outcome === 'allowed-once' ? 'once' : 'reject'
        const pending = this.deps.state.pendingApprovals.get(entry.rpcId)
        if (pending !== undefined) {
          this.deps.state.pendingApprovals.delete(entry.rpcId)
          pending(frame.outcome)
        }
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
          sessionId: String(frame.sessionId),
          items: frame.questions,
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
        const entry = this.deps.state.questionByRpcId(String(frame.questionRpcId))
        if (!entry) {
          this.deps.log(`[bridge/events] question/resolved for unknown rpcId ${String(frame.questionRpcId)}`)
          return []
        }
        const directory = directoryFor(entry.sessionId, this.deps)
        const project = projectIdFor(directory)
        this.deps.state.removeQuestion(entry.opencodeId)
        const pending = this.deps.state.pendingQuestions.get(entry.rpcId)
        if (pending !== undefined) {
          this.deps.state.pendingQuestions.delete(entry.rpcId)
          pending(frame.outcome === 'answered'
            ? { answers: entry.items.map((item, index) => ({
                id: item.id,
                selected: frame.answers?.[index] ?? [],
              })) }
            : undefined)
        }
        if (frame.outcome === 'answered') {
          return [
            makeEvent(directory, 'question.replied', {
              sessionID: entry.sessionId,
              requestID: entry.opencodeId,
              answers: frame.answers ?? [],
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
        return this.translateProjection(frame.sessionId, frame.key, frame.value, Date.now())
      case 'session/jobs':
        return []
      case 'session/queue': {
        const sessionId = String(frame.sessionId)
        const directory = directoryFor(sessionId, this.deps)
        const project = projectIdFor(directory)
        const items = Array.isArray(frame.items)
          ? (frame.items as Array<{
              placement: 'queued' | 'steering' | 'context'
              rpcId?: string
              message: { id: string; content: readonly unknown[]; source?: { kind: string } }
            }>)
          : []
        const { added } = this.deps.state.initializeInboxProjection(sessionId, items, Date.now())
        return this.queuedMessageEvents(sessionId, added, directory, project)
      }
      case 'control/baseline': {
        const events: BridgeGlobalEvent[] = []
        for (const [sessionId, items] of Object.entries(frame.value.queues ?? {})) {
          const directory = directoryFor(sessionId, this.deps)
          const project = projectIdFor(directory)
          const { added, removed } = this.deps.state.initializeInboxProjection(
            sessionId,
            items.map((item) => ({
              placement: item.placement,
              rpcId: item.rpcId,
              message: item.message,
            })),
            Date.now(),
            true,
          )
          events.push(...this.queuedMessageEvents(sessionId, added, directory, project))
          for (const message of removed) {
            if (message.source.kind !== 'user') continue
            events.push(makeEvent(directory, 'message.removed', {
              sessionID: sessionId,
              messageID: message.id,
            }, project))
          }
        }
        for (const [sessionId, projection] of Object.entries(frame.value.projections ?? {})) {
          for (const [key, value] of Object.entries(projection.values ?? {})) {
            events.push(...this.translateProjection(sessionId, key, value, Date.now()))
          }
        }
        return events
      }
      case 'stream/error':
        this.deps.log(`[bridge/events] stream/error: ${frame.error.code} ${frame.error.message}`)
        return [makeEvent(this.deps.cwd, 'session.error', {
          error: opencodeError(String(frame.error.code), frame.error.message),
        }, projectIdFor(this.deps.cwd))]
      default:
        this.deps.log(`[bridge/events] unhandled mux frame ${String((frame as { type: string }).type)}`)
        return []
    }
  }

  private translateProjection(
    sessionId: string,
    key: string,
    value: unknown,
    time = Date.now(),
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
              ...this.sessionLineageOptions(sessionId),
            }),
          },
          project,
        ),
      ]
    }
    if (key === 'agentPreset') {
      if (typeof value !== 'string' || value.length === 0) return []
      this.deps.state.setSessionAgent(sessionId, value)
      return [makeEvent(directory, 'session.updated', {
        sessionID: sessionId,
        info: minimalSession(sessionId, {
          cwd: directory,
          title: this.deps.state.sessionTitleFor(sessionId),
          agent: value,
          ...this.sessionLineageOptions(sessionId),
        }),
      }, project)]
    }
    if (key === 'subagent') {
      const childValue = value as { mode?: unknown; label?: unknown } | null
      const mode = childValue?.mode === 'one-shot' || childValue?.mode === 'continuable'
        ? childValue.mode
        : undefined
      const label = typeof childValue?.label === 'string' && childValue.label.length > 0
        ? childValue.label
        : undefined
      const call = this.deps.state.recordSubagentDescriptor(sessionId, {
        ...(mode === undefined ? {} : { mode }),
        ...(label === undefined ? {} : { label }),
      })
      if (call === undefined) return []
      const child = this.deps.state.subagentChildren.get(sessionId)
      if (child === undefined) return []
      const original: ToolCallInfo = {
        callId: call.callId,
        name: call.toolName,
        arguments: call.arguments,
      }
      const task = this.subagentTaskUpdate(call.parentSessionId, original, call, child, time)
      return task === undefined ? [] : [task]
    }
    if (key === 'modelSelection') {
      const selection = value as {
        next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
        lastUsed?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
      } | null
      const current = selection?.next ?? selection?.lastUsed
      if (current !== null && current !== undefined
        && typeof current.provider === 'string' && typeof current.model === 'string') {
        this.deps.state.setSessionModelSelection(sessionId, {
          providerID: externalProviderId(current.provider),
          modelID: current.model,
          ...(typeof current.reasoningEffort === 'string' ? { variant: current.reasoningEffort } : {}),
        })
      }
      return []
    }
    return []
  }

  private translateSessionEvent(
    sessionId: string,
    event: BridgeEvent,
    view?: ToolEventView,
  ): BridgeGlobalEvent[] {
    const directory = directoryFor(sessionId, this.deps)
    const project = projectIdFor(directory)
    switch (event.type) {
      case 'agent/inbox/spliced': {
        const splice = event.data as unknown as {
          target: 'next-turn' | 'next-step'
          start: number
          removedCount?: number
          inserted: Array<{ id: string; rpcId?: string; content: readonly unknown[]; source: { kind: string; rpcId?: string } }>
          outcome?: 'canceled'
        }
        const { added, removed } = this.deps.state.applyInboxSplice(
          sessionId,
          splice.target,
          splice.start,
          splice.removedCount ?? 0,
          splice.inserted,
          event.time,
          splice.outcome,
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
        const stream = this.streamState(sessionId)
        if (isUserPrompt) stream.lastUserMessageCreatedAt = event.time
        const surfaceId = isUserPrompt
          ? this.deps.state.takePromptMessageId(sessionId, dshId)
          : dshId
        if (isUserPrompt && surfaceId !== dshId) {
          // The prompt route already echoed this user message (with the
          // bridge-generated id) so the TUI could render its queued card
          // immediately; re-emitting it here would duplicate the card.
          this.deps.state.markBroadcastDshId(sessionId, dshId)
          this.streamState(sessionId).lastUserMessageId = surfaceId
          return []
        }
        if (isUserPrompt && this.deps.state.isBroadcastDshId(sessionId, dshId)) {
          // dsh re-broadcasts the durable user/message after the route echo;
          // keep the bridge id as the parent anchor and stay silent.
          this.streamState(sessionId).lastUserMessageId = this.deps.state.promptIdForDshId(sessionId, dshId) ?? dshId
          return []
        }
        if (isUserPrompt && this.deps.state.hasPresentedQueued(sessionId, dshId)) {
          // The queued card for this id is already on screen (surfaced from
          // `agent/inbox/spliced`); re-emitting the same user message would
          // render a second card. Keep the durable id in the stream state so
          // the assistant message still parents to it.
          this.deps.state.clearPresentedQueued(sessionId, dshId)
          this.streamState(sessionId).lastUserMessageId = dshId
          return []
        }
        // Plugin/system rows (dcp boundary markers, subagent-settled notices,
        // goal rounds) are not transcript user cards. They also must never
        // consume the pending TUI prompt id: the durable user message that
        // follows owns that id and its route echo. Compaction checkpoints
        // keep their existing visible card.
        if (!isUserPrompt && !isCompactCheckpoint(event)) return []
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
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
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
      case 'tool-call-chunks':
        return this.translateToolCallChunks(
          sessionId,
          event as unknown as ToolCallChunkRowEvent,
          directory,
          project,
        )
      case 'text-chunks':
      case 'reasoning-chunks':
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
        // Prefer the timestamp used when the provisional live card was
        // opened. In particular, turn/start can precede the first text/tool
        // chunk; changing `time.created` on the final update violates the
        // OpenCode TUI message key and renders a duplicate assistant card.
        // Once the live provisional card is emitted, its `time.created` is
        // part of the OpenCode TUI identity (`created + id`).  A durable
        // user/message echo can arrive after turn/start (the normal dsh
        // order), so applying its newer timestamp here would create a second
        // assistant card when the final update arrives.  The provisional
        // timestamp was already chosen from the optimistic prompt card; keep
        // it byte-for-byte stable and only apply the user lower bound when no
        // provisional card exists yet.
        const provisionalCreated = state.provisionalMessageCreatedAt.get(stepKey)
        const created = provisionalCreated ?? Math.max(
          earliestBlockStart(state.blockStarts, event.data.turn, event.data.step)
            ?? state.turnStartTime
            ?? event.time,
          minimumAssistantCreatedAt(state.lastUserMessageCreatedAt),
        )
        this.deps.state.setAssistantMessageCreatedAt(sessionId, messageID, created)
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
            // The TUI badge renders `message.mode`, so it must follow the
            // session's actual preset (the hardcoded build fallback made a
            // Tab-switched first reply still read "Build").
            mode: this.deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT,
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
            this.deps.state.markAssistantCompleted(sessionId, messageID)
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
        {
          const state = this.streamState(sessionId)
          state.turnStartTime = event.time
          // A prompt route has already registered an optimistic user card and
          // its assistant id. Open that pending assistant at turn/start, before
          // a tool approval can pause the stream, so a later queue item gets a
          // deterministic QUEUED badge even when the approval dialog wins the
          // race with the first streamed tool event.
          if (state.lastUserMessageId === undefined) {
            state.lastUserMessageId = this.deps.state.peekPromptMessageId(sessionId)
          }
          const promptAnchor = state.lastUserMessageId ?? this.deps.state.peekPromptMessageId(sessionId)
          const hasPromptAssistant = promptAnchor !== undefined
            && this.deps.state.assistantIdForUser(sessionId, promptAnchor) !== undefined
          if (state.lastUserMessageId === undefined && hasPromptAssistant) state.lastUserMessageId = promptAnchor
          const provisional = hasPromptAssistant
            ? this.ensureProvisionalMessage(sessionId, event.data.turn, 1, event.time, directory, project)
            : { events: [] as BridgeGlobalEvent[] }
          const status = this.deps.state.shouldBroadcastSessionStatus(sessionId, true)
          return [
          ...(status ? [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'busy' } }, project)] : []),
          makeEvent(directory, 'turn.wait', { sessionID: sessionId }, project),
            ...provisional.events,
          ]
        }
      case 'turn/end': {
        const state = this.streamState(sessionId)
        const status = this.deps.state.shouldBroadcastSessionStatus(sessionId, false)
        const events = [
          ...(status ? [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project)] : []),
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
            this.deps.state.markAssistantCompleted(sessionId, pending.messageID)
          }
          this.pendingAssistantCompletions.delete(sessionId)
        }
        // Close provisional assistant messages that never got a final
        // assistant/message (interrupt/error): without `completed` the TUI
        // keeps them pending forever (the "spinner keeps spinning" class).
        for (const [stepKey, messageID] of [...state.provisionalMessageIds]) {
          if (state.completedMessageIds.has(messageID)) continue
          const provisionalCreated = state.provisionalMessageCreatedAt.get(stepKey)
          const created = provisionalCreated ?? Math.max(
            state.blockStarts.get(`${stepKey}:text`)
              ?? state.blockStarts.get(`${stepKey}:reasoning`)
              ?? state.turnStartTime
              ?? event.time,
            minimumAssistantCreatedAt(state.lastUserMessageCreatedAt),
          )
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
          this.deps.state.markAssistantCompleted(sessionId, messageID)
        }
        state.provisionalMessageIds.clear()
        state.provisionalMessageCreatedAt.clear()
        state.openedMessageIds.clear()
        state.completedMessageIds.clear()
        this.currentAssistant.delete(sessionId)
        this.pendingCalls.delete(sessionId)
        this.clearToolTimers(sessionId)
        this.streams.delete(sessionId)
        this.deps.state.clearPendingAssistants(sessionId)
        return events
      }
      case 'step/end': {
        // A tool-call step may be followed by more steps of the same turn
        // (e.g. the follow-up text after the tool result). Completing the
        // message here marks the card finished too early and later parts for
        // the same message render out of order. Defer completion to
        // `turn/end`; the QUEUED badge for prompts submitted mid-turn stays
        // correct as long as the message is incomplete.
        return []
      }
      case 'todo/write':
        this.sessionTodos.set(sessionId, (event.data as { todos: unknown }).todos)
        return this.todoUpdateEvents(sessionId, directory, project)
      case 'model/selection': {
        const data = event.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
        if (typeof data.provider === 'string' && typeof data.model === 'string') {
          this.deps.state.setSessionModelSelection(sessionId, {
            providerID: externalProviderId(data.provider),
            modelID: data.model,
            ...(typeof data.reasoningEffort === 'string' ? { variant: data.reasoningEffort } : {}),
          })
        }
        return []
      }
      case 'step/start':
      case 'request/context':
      case 'session/title-llm-request':
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'command/run':
      case 'command/done':
      case 'session/end-seed':
      case 'approval/asked':
      case 'approval/decided':
        // Log-only / environment-snapshot events: no TUI surface. Explicitly
        // silent so genuinely unknown event types stay loud in the logs.
        return []
      case 'request/header': {
        const config = (event.data as { header?: { config?: unknown } }).header?.config as {
          provider?: unknown; model?: unknown; reasoningEffort?: unknown
        } | undefined
        if (typeof config?.provider === 'string' && typeof config.model === 'string') {
          this.deps.state.setSessionModelSelection(sessionId, {
            providerID: externalProviderId(config.provider),
            modelID: config.model,
            ...(typeof config.reasoningEffort === 'string' ? { variant: config.reasoningEffort } : {}),
          })
        }
        return []
      }
      case 'agent-preset/selected': {
        const preset = (event.data as { agentPreset?: unknown }).agentPreset
        if (typeof preset === 'string') {
          // Fold the committed preset into the per-session agent too, so
          // later prompts carrying the same agent are recognized as already
          // effective (out-of-band plugin switches) instead of re-selecting
          // and tripping the agent-preset-locked warning.
          this.deps.state.setSessionAgent(sessionId, preset)
        }
        return []
      }
      case 'subagent/descriptor': {
        const data = event.data as { mode?: unknown; label?: unknown }
        const mode = data.mode === 'one-shot' || data.mode === 'continuable'
          ? data.mode
          : undefined
        const label = typeof data.label === 'string' && data.label.length > 0
          ? data.label
          : undefined
        const call = this.deps.state.recordSubagentDescriptor(sessionId, {
          ...(mode === undefined ? {} : { mode }),
          ...(label === undefined ? {} : { label }),
        })
        if (call === undefined) return []
        const child = this.deps.state.subagentChildren.get(sessionId)
        if (child === undefined) return []
        const original: ToolCallInfo = {
          callId: call.callId,
          name: call.toolName,
          arguments: call.arguments,
        }
        const task = this.subagentTaskUpdate(call.parentSessionId, original, call, child, event.time)
        return task === undefined ? [] : [task]
      }
      case 'goal/change': {
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
        let call: ToolCallInfo = {
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
        const provisional = this.currentAssistant.get(sessionId) === undefined
          ? this.ensureProvisionalMessage(sessionId, data.turn, data.step, event.time, directory, project)
          : undefined
        const messageID = this.currentAssistant.get(sessionId)
          ?? provisional?.messageID
          ?? `assistant:${data.turn}:${data.step}`
        const registered = this.registerSubagentCall(sessionId, call, messageID, event.time, data.turn, data.step)
        call = registered.call
        calls.set(call.callId, call)
        const inputState = this.findToolInput(sessionId, call.callId)
        const inputEvents = inputState === undefined
          ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time)
          : this.endToolInput(sessionId, inputState, directory, project, event.time)
        const part = registered.child === undefined
          ? pendingToolPart(call, { sessionID: sessionId, messageID, time: event.time })
          : runningToolPart(call, { sessionID: sessionId, messageID, time: event.time })
        if (registered.record !== undefined) registered.record.partEmitted = true
        return [
          ...(provisional?.events ?? []),
          ...inputEvents,
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part,
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
        const effectiveCall = this.callWithSubagentChild(sessionId, call)
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
        // dsh 0.1.2 signals a rejected/errored tool result via the block's
        // `isError` flag inside `message.content`; `data.error` is undefined in
        // that case, so the bridge must treat either as an error.
        const contentError = toolResultContentError(data.message.content)
        const resultError = data.error ?? contentError
        const part = resultError === undefined
          ? completedToolPart(effectiveCall, {
              ...resultInfo,
            }, { sessionID: sessionId, messageID, time: event.time })
          : errorToolPart(effectiveCall, {
              ...resultInfo,
              error: resultError,
            }, { sessionID: sessionId, messageID, time: event.time })
        const delegation = this.deps.state.subagentCallFor(sessionId, callId)
        if (delegation !== undefined) {
          delegation.resultStatus = resultError === undefined ? 'completed' : 'error'
          delegation.resultTime = event.time
          delegation.resultContent = data.message.content
          if (resultError === undefined) delete delegation.resultError
          else delegation.resultError = resultError
        }
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
        const tail = resultError === undefined
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
                code: resultError.code,
                message: resultError.name,
              },
              provider: { executed: true },
            }, project)]
        if (resultError === undefined) {
          const changes = fileChangesFromToolResult(effectiveCall, resultInfo)
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
                ...this.sessionLineageOptions(sessionId),
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
                ...this.sessionLineageOptions(sessionId),
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
                ...this.sessionLineageOptions(sessionId),
              }),
            }, project),
          ]
        }
        this.deps.log(`[bridge/events] unhandled session event ${event.type}`)
        return []
      }
    }
  }

  /** Surface dsh pending inbox messages as opencode queued user messages. */
  private queuedMessageEvents(
    sessionId: string,
    messages: readonly { id: string; rpcId?: string; content: readonly unknown[]; source: { kind: string }; enqueuedAt: number }[],
    directory: string,
    project: string | undefined,
  ): BridgeGlobalEvent[] {
    const events: BridgeGlobalEvent[] = []
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      // A prompt route already emitted a local card. For rc.1 queue frames the
      // rpcId is the same client-minted id, so update that exact card instead
      // of emitting a second one; the update is what lets the TUI mark it
      // QUEUED while the active turn is blocked (e.g. on approval).
      const localPromptId = this.deps.state.peekPromptMessageId(sessionId)
      const localCard = localPromptId !== undefined && message.rpcId === localPromptId
      if (localPromptId !== undefined && !localCard) continue
      if (this.deps.state.isBroadcastDshId(sessionId, String(message.id))) continue
      // OpenCode 1.18.18 orders messages by `time.created + id`, not by id
      // alone. A queue-state update for an optimistic local card must retain
      // the original timestamp or the TUI inserts a second user card instead
      // of reconciling the existing one, which destroys the QUEUED predicate.
      const created = localCard && localPromptId !== undefined
        ? (this.deps.state.promptMessageCreatedAt(sessionId, localPromptId) ?? message.enqueuedAt)
        : message.enqueuedAt
      const selected = this.deps.state.sessionModelSelectionFor(sessionId)
      const model = selected === undefined
        ? (this.deps.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' })
        : {
            providerID: selected.providerID,
            modelID: selected.modelID,
          }
      const agent = this.deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT
      events.push(
        makeEvent(directory, 'message.updated', {
          sessionID: sessionId,
          info: {
            id: localCard ? localPromptId : message.id,
            sessionID: sessionId,
            role: 'user',
            time: { created },
            agent,
            model,
          },
        }, project),
      )
      if (localCard) continue
      message.content.forEach((block, index) => {
        const textBlock = block as { type?: string; text?: unknown }
        if (textBlock.type !== 'text' || typeof textBlock.text !== 'string') return
        events.push(
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part: {
              id: `${localCard ? localPromptId : message.id}:${index}`,
              sessionID: sessionId,
              messageID: localCard ? localPromptId : message.id,
              type: 'text',
              text: textBlock.text,
              time: { start: created, end: created },
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
        const promptCreatedAt = state.lastUserMessageCreatedAt
          ?? (state.lastUserMessageId === undefined
            ? undefined
            : this.deps.state.promptMessageCreatedAt(sessionId, state.lastUserMessageId))
        const provisionalCreated = Math.max(
          state.blockStarts.get(blockStartKey)
          ?? this.deps.state.assistantMessageCreatedAt(sessionId, provisionalId)
          ?? state.turnStartTime
          ?? time0,
          minimumAssistantCreatedAt(promptCreatedAt),
        )
        state.provisionalMessageIds.set(stepKey, provisionalId)
        state.provisionalMessageCreatedAt.set(stepKey, provisionalCreated)
        this.deps.state.setAssistantMessageCreatedAt(sessionId, provisionalId, provisionalCreated)
        this.deps.state.markAssistantPending(sessionId, provisionalId)
        if (bridgeId !== undefined) state.openedMessageIds.add(bridgeId)
        if (!alreadyOpen) {
          events.push(
            makeEvent(directory, 'message.updated', {
              sessionID: sessionId,
              info: provisionalAssistantMessage(
                sessionId,
                this.deps,
                provisionalId,
                provisionalCreated,
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
