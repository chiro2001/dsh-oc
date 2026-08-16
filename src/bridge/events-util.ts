import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolResultBlock } from '@deepseek-ai/dsh-llm/types'
import type { MessageConvertOptions } from './convert/message.js'
import { DEFAULT_AGENT, projectIdFor, safeJsonParse } from './convert/common.js'
import { opencodeToolName, type ToolCallInfo } from './convert/tool.js'
import type { InteractionState } from './state.js'

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
  /** Per-SSE-connection replay guard for approval/question/chunk frames. */
  replayGuard?: { approvals: Set<string>; questions: Set<string>; chunks?: Set<string> }
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
export interface TimerHandle {
  unref?(): unknown
}

export function makeEvent(
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

export function directoryFor(sessionId: string, deps: TranslateDeps): string {
  return deps.state.sessionDirectories.get(sessionId) ?? deps.cwd
}

export function messageOptions(
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

export function messageEvents(
  sessionId: string,
  deps: TranslateDeps,
  build: () => { info: Record<string, unknown>; parts: Array<Record<string, unknown>> },
  partsFirst = false,
): BridgeGlobalEvent[] {
  const directory = directoryFor(sessionId, deps)
  const project = projectIdFor(directory)
  const { info, parts } = build()
  const update = makeEvent(directory, 'message.updated', { sessionID: sessionId, info }, project)
  const events: BridgeGlobalEvent[] = partsFirst
    ? []
    : [update]
  for (const part of parts) {
    events.push(
      makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part, time: Date.now() }, project),
    )
  }
  if (partsFirst) events.push(update)
  return events
}

export function toolCallId(resultEvent: SessionEvent<'tool/result'>): string {
  const block = resultEvent.data.message.content[0] as ToolResultBlock | undefined
  return String(block?.toolCallId ?? resultEvent.data.message.source.callId)
}

/** Best-effort structured progress label for a started tool call. */
export function toolProgressStructured(call: ToolCallInfo): Record<string, unknown> {
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

export function earliestBlockStart(
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

export function zeroTokens(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

export function provisionalAssistantMessage(
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

export function streamPart(
  blockType: 'text' | 'reasoning',
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  start: number,
  end?: number,
): Record<string, unknown> {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: blockType,
    text,
    time: end === undefined ? { start } : { start, end },
  }
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

/** Visible agent-error message used by the host-level error path. */
export function opencodeError(code: string, message: string): { name: string; data: Record<string, unknown> } {
  if (code === 'message-aborted' || code === 'aborted') {
    return { name: 'MessageAbortedError', data: { message } }
  }
  if (code === 'auth' || code === 'invalid_api_key' || code === 'authentication') {
    return { name: 'ProviderAuthError', data: { providerID: 'deepseek', message } }
  }
  return { name: 'UnknownError', data: { message } }
}

export function agentErrorEvents(sessionId: string, message: string, cwd: string): BridgeGlobalEvent[] {
  const project = projectIdFor(cwd)
  const created = Date.now()
  const id = `msg_err:${randomUUID()}`
  const partId = `${id}:0`
  return [
    makeEvent(cwd, 'session.error', {
      sessionID: sessionId,
      error: opencodeError('agent-error', message),
    }, project),
    makeEvent(cwd, 'message.updated', {
      sessionID: sessionId,
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        agent: DEFAULT_AGENT,
        time: { created },
        parentID: `pending:${sessionId}:user`,
        modelID: 'deepseek-chat',
        providerID: 'deepseek',
        mode: DEFAULT_AGENT,
        path: { cwd, root: cwd },
        cost: 0,
        tokens: zeroTokens(),
      },
    }, project),
    makeEvent(cwd, 'message.part.updated', {
      sessionID: sessionId,
      part: {
        id: partId,
        sessionID: sessionId,
        messageID: id,
        type: 'text',
        text: `[错误] ${message}`,
        time: { start: created, end: created },
      },
      time: created,
    }, project),
  ]
}
