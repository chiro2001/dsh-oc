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

/**
 * SSE event emitted to opencode. We deliberately carry the same payload under
 * both `properties` (the 1.18.18 TUI binary's expectation) and `data` (the
 * published `@opencode-ai/sdk@1.18.18` type), so either consumer can parse it.
 */
export interface BridgeGlobalEvent {
  directory: string
  project?: string
  workspace?: string
  payload: {
    id: string
    type: string
    properties: Record<string, unknown>
    data: Record<string, unknown>
  }
}

export interface TranslateDeps {
  cwd: string
  state: InteractionState
  defaultModel?: { providerID: string; modelID: string }
  log(message: string): void
  /** Per-SSE-connection replay guard for approval/question frames. */
  replayGuard?: { approvals: Set<string>; questions: Set<string> }
  /** Per-SSE-connection projection state surviving translator rebuilds. */
  sharedState?: { todos: Map<string, unknown>; goals: Map<string, unknown> }
  /** Coalescing window for `tool-call-delta` events before flushing (ms). */
  toolFlushMs?: number
  /** Injectable timer used by the tool-input throttle. */
  setTimeoutImpl?: (callback: () => void, ms: number) => TimerHandle
  /** Injectable timer clearer used by the tool-input throttle. */
  clearTimeoutImpl?: (handle: TimerHandle | undefined) => void
  /** Called with events flushed asynchronously by the tool-input throttle. */
  onFlush?: (events: BridgeGlobalEvent[]) => void
}

/** Structural timer handle so tests can inject a fake scheduler. */
interface TimerHandle {
  unref?(): unknown
}

/**
 * Build the opencode SSE events that make a server-side command result
 * visible in the TUI: an optional session status change plus one synthetic
 * assistant message with a text part. The message is intentionally
 * ephemeral — dsh history is not touched, so no model turn is triggered.
 */
export function commandResultEvents(
  deps: TranslateDeps,
  sessionId: string,
  text: string,
  options: { status?: 'busy' | 'idle'; parentID?: string } = {},
): BridgeGlobalEvent[] {
  const directory = directoryFor(sessionId, deps)
  const project = projectIdFor(directory)
  const events: BridgeGlobalEvent[] = []
  if (options.status !== undefined) {
    events.push(
      makeEvent(directory, 'session.status', {
        sessionID: sessionId,
        status: { type: options.status },
      }, project),
    )
  }
  const id = `msg_cmd:${randomUUID()}`
  const partId = `prt_cmd:${randomUUID()}`
  const created = Date.now()
  const model = deps.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  events.push(
    makeEvent(directory, 'message.updated', {
      sessionID: sessionId,
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        agent: DEFAULT_AGENT,
        time: { created },
        parentID: options.parentID ?? `pending:${sessionId}:user`,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: DEFAULT_AGENT,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: zeroTokens(),
      },
    }, project),
  )
  events.push(
    makeEvent(directory, 'message.part.updated', {
      sessionID: sessionId,
      part: {
        id: partId,
        sessionID: sessionId,
        messageID: id,
        type: 'text',
        text,
        time: { start: created },
      },
      time: created,
    }, project),
  )
  return events
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

interface SessionStreamState {
  turnStartTime?: number
  lastUserMessageId?: string
  provisionalMessageIds: Map<string, string>
  blockStarts: Map<string, number>
  finishReasons: Map<string, string>
  blocks: Map<string, StreamBlockState>
  compactions: Map<string, CompactionStreamState>
  toolInputs: Map<string, ToolInputState>
}

function makeEvent(
  directory: string,
  type: string,
  properties: Record<string, unknown>,
  project?: string,
): BridgeGlobalEvent {
  return {
    directory,
    ...(project === undefined ? {} : { project }),
    payload: {
      id: randomUUID(),
      type,
      properties,
      data: properties,
    },
  }
}

function directoryFor(sessionId: string, deps: TranslateDeps): string {
  return deps.state.sessionDirectories.get(sessionId) ?? deps.cwd
}

function messageOptions(
  sessionId: string,
  deps: TranslateDeps,
): MessageConvertOptions {
  return {
    sessionId,
    cwd: deps.cwd,
    ...(deps.defaultModel === undefined ? {} : { defaultModel: deps.defaultModel }),
    onSkip: (eventType, reason) => deps.log(`[bridge/events] skip ${eventType}: ${reason}`),
  }
}

function messageEvents(
  sessionId: string,
  deps: TranslateDeps,
  build: () => { info: Record<string, unknown>; parts: Array<Record<string, unknown>> },
): BridgeGlobalEvent[] {
  const directory = directoryFor(sessionId, deps)
  const project = projectIdFor(directory)
  const { info, parts } = build()
  const events: BridgeGlobalEvent[] = [
    makeEvent(directory, 'message.updated', { sessionID: sessionId, info }, project),
  ]
  for (const part of parts) {
    events.push(
      makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part, time: Date.now() }, project),
    )
  }
  return events
}

function toolCallId(resultEvent: SessionEvent<'tool/result'>): string {
  const block = resultEvent.data.message.content[0] as ToolResultBlock | undefined
  return String(block?.toolCallId ?? resultEvent.data.message.source.callId)
}

/** Best-effort structured progress label for a started tool call. */
function toolProgressStructured(call: ToolCallInfo): Record<string, unknown> {
  const present = call.view?.for === 'call'
    ? (call.view.view as unknown as { title?: unknown; card?: unknown })
    : undefined
  const title = typeof present?.title === 'string'
    ? present.title
    : opencodeToolName(call.name, safeJsonParse(call.arguments))
  return {
    title,
    ...(typeof present?.card === 'string' ? { card: present.card } : {}),
  }
}

function earliestBlockStart(
  blockStarts: Map<string, number>,
  turn: number,
  step: number,
): number | undefined {
  let earliest: number | undefined
  for (const [key, value] of blockStarts) {
    const [keyTurn, keyStep] = key.split(':')
    if (Number(keyTurn) === turn && Number(keyStep) === step) {
      if (earliest === undefined || value < earliest) earliest = value
    }
  }
  return earliest
}

function zeroTokens(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

function provisionalAssistantMessage(
  sessionId: string,
  deps: TranslateDeps,
  id: string,
  created: number,
  parentID: string,
): Record<string, unknown> {
  const model = deps.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  return {
    id,
    sessionID: sessionId,
    role: 'assistant',
    agent: 'build',
    time: { created },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: 'build',
    path: { cwd: deps.cwd, root: deps.cwd },
    cost: 0,
    tokens: zeroTokens(),
  }
}

function streamPart(
  blockType: 'text' | 'reasoning',
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  start: number,
): Record<string, unknown> {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: blockType,
    text,
    time: { start },
  }
}

/**
 * Per-stream translator: converts one mux frame into zero or more opencode
 * GlobalEvents. One instance is created per SSE client because tool/result
 * pairing and current-message tracking are stream-ordered state.
 */
export class MuxEventTranslator {
  private currentAssistant = new Map<string, string>()
  private pendingCalls = new Map<string, Map<string, ToolCallInfo>>()
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
        finishReasons: new Map(),
        blocks: new Map(),
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
    const messageID = this.assistantMessageId(sessionId, turn, step)
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
      case 'session/queue':
      case 'session/jobs':
        return []
      case 'stream/error':
        this.deps.log(`[bridge/events] stream/error: ${payload.error.code} ${payload.error.message}`)
        return [makeEvent(this.deps.cwd, 'session.error', {
          error: { code: payload.error.code, message: payload.error.message },
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
      return [
        makeEvent(
          directory,
          'session.updated',
          {
            sessionID: sessionId,
            info: minimalSession(sessionId, { cwd: directory, title }),
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
      case 'user/message': {
        const events = messageEvents(sessionId, this.deps, () => {
          const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps))
          return {
            info: entry.info as unknown as Record<string, unknown>,
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
        this.streamState(sessionId).lastUserMessageId = String(event.data.id)
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
          const { state, events } = this.startToolInput(
            sessionId,
            event.data.turn,
            event.data.step,
            chunk.index,
            { id: chunk.id, name: chunk.name },
            event.time,
            directory,
            project,
          )
          if (state.name === '' && chunk.name !== undefined) state.name = chunk.name
          state.text += chunk.argumentsDelta
          state.lastTime = event.time
          this.queueToolDelta(sessionId, state, chunk.argumentsDelta, event.time, directory, project)
          return events
        }
        return []
      }
      case 'text-chunks' as SessionEvent['type']:
      case 'reasoning-chunks' as SessionEvent['type']:
        return this.translateStreamChunks(
          sessionId,
          event as unknown as StreamChunkRowEvent,
          directory,
          project,
        )
      case 'assistant/message': {
        const state = this.streamState(sessionId)
        const stepKey = `${event.data.turn}:${event.data.step}`
        const provisionalId = state.provisionalMessageIds.get(stepKey)
        const created = earliestBlockStart(state.blockStarts, event.data.turn, event.data.step)
          ?? state.turnStartTime
          ?? event.time
        const events = messageEvents(sessionId, this.deps, () => {
          const entry = assistantMessageFromEvent(
            event,
            messageOptions(sessionId, this.deps),
            (index, blockType) => state.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`),
            created,
            state.lastUserMessageId,
            state.finishReasons.get(stepKey) ?? 'stop',
          )
          return {
            info: entry.info as unknown as Record<string, unknown>,
            parts: entry.parts as unknown as Array<Record<string, unknown>>,
          }
        })
        if (provisionalId) {
          events.unshift(
            makeEvent(directory, 'message.removed', {
              sessionID: sessionId,
              messageID: provisionalId,
            }, project),
          )
          state.provisionalMessageIds.delete(stepKey)
        }
        this.currentAssistant.set(sessionId, String(event.data.message.id))
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
        return events
      }
      case 'turn/start':
        this.streamState(sessionId).turnStartTime = event.time
        return [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'busy' } }, project)]
      case 'turn/end': {
        this.currentAssistant.delete(sessionId)
        this.pendingCalls.delete(sessionId)
        this.clearToolTimers(sessionId)
        this.streams.delete(sessionId)
        return [
          makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project),
          makeEvent(directory, 'session.idle', { sessionID: sessionId }, project),
        ]
      }
      case 'todo/write':
        this.sessionTodos.set(sessionId, event.data.todos)
        return this.todoUpdateEvents(sessionId, directory, project)
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
        const messageID = this.currentAssistant.get(sessionId)
          ?? this.streamState(sessionId).provisionalMessageIds.get(`${data.turn}:${data.step}`)
          ?? `assistant:${data.turn}:${data.step}`
        const inputState = this.findToolInput(sessionId, call.callId)
        const inputEvents = inputState === undefined
          ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time)
          : this.endToolInput(sessionId, inputState, directory, project, event.time)
        return [
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
        const messageID = this.currentAssistant.get(sessionId)
          ?? this.streamState(sessionId).provisionalMessageIds.get(`${data.turn}:${data.step}`)
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
          const header = data as { createdAt?: number; cwd?: string; title?: string }
          const childDirectory = header.cwd ?? this.deps.state.sessionDirectories.get(sessionId) ?? directory
          const parentID = this.deps.state.sessionParents.get(sessionId)
          return [
            makeEvent(childDirectory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: childDirectory,
                title: header.title ?? '',
                createdAt: header.createdAt ?? Date.now(),
                ...(parentID === undefined ? {} : { parentID }),
              }),
            }, projectIdFor(childDirectory)),
          ]
        }
        if (type === 'session/created') {
          const parentID = this.deps.state.sessionParents.get(sessionId)
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: directory,
                createdAt: data.time,
                ...(parentID === undefined ? {} : { parentID }),
              }),
            }, project),
          ]
        }
        if (type === 'session/title') {
          const title = typeof data.title === 'string' ? data.title
            : typeof data.text === 'string' ? data.text
              : ''
          const parentID = this.deps.state.sessionParents.get(sessionId)
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, {
                cwd: directory,
                title,
                createdAt: data.time,
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
      const stepKey = `${event.data.turn}:${event.data.step}`
      let provisionalId = state.provisionalMessageIds.get(stepKey)
      if (!provisionalId) {
        provisionalId = provisionalMessageId(sessionId, event.data.turn, event.data.step)
        state.provisionalMessageIds.set(stepKey, provisionalId)
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
      block = {
        blockType,
        partId: provisionalPartId(sessionId, event.data.turn, event.data.step, blockType, event.data.index),
        messageId: provisionalId,
        start: state.blockStarts.get(blockStartKey) ?? time0,
        text: '',
        sent: 0,
      }
      state.blocks.set(blockKey, block)
    }
    const sent = block.sent
    block.text += event.data.texts.join('')
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

/** Map a dsh `host/agent-error` frame to the opencode `session.error` event. */
export function agentErrorEvent(sessionId: string, message: string, cwd: string): BridgeGlobalEvent {
  return makeEvent(cwd, 'session.error', {
    sessionID: sessionId,
    error: { code: 'agent-error', message },
  }, projectIdFor(cwd))
}
