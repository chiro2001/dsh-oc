import { randomUUID } from 'node:crypto'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolResultBlock } from '@deepseek-ai/dsh-llm/types'
import {
  assistantMessageFromEvent,
  userMessageFromEvent,
  type MessageConvertOptions,
} from './convert/message.js'
import { projectIdFor, provisionalMessageId, provisionalPartId } from './convert/common.js'
import { toPermissionRequest } from './convert/permission.js'
import { toQuestionRequest } from './convert/question.js'
import { convertTodos } from './convert/todo.js'
import { completedToolPart, errorToolPart, pendingToolPart, type ToolCallInfo } from './convert/tool.js'
import { minimalSession } from './convert/session.js'
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

interface SessionStreamState {
  turnStartTime?: number
  lastUserMessageId?: string
  provisionalMessageIds: Map<string, string>
  blockStarts: Map<string, number>
  blocks: Map<string, StreamBlockState>
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

  constructor(private deps: TranslateDeps) {}

  private streamState(sessionId: string): SessionStreamState {
    let state = this.streams.get(sessionId)
    if (!state) {
      state = {
        provisionalMessageIds: new Map(),
        blockStarts: new Map(),
        blocks: new Map(),
      }
      this.streams.set(sessionId, state)
    }
    return state
  }

  translate(frame: RpcRequest<MuxFrame>): BridgeGlobalEvent[] {
    const payload = frame.payload
    switch (payload.type) {
      case 'session/event':
        return this.translateSessionEvent(frame.rpcId, payload.sessionId, payload.event)
      case 'approval/requested': {
        const entry: NewApprovalEntry = {
          rpcId: String(frame.rpcId),
          sessionId: String(payload.sessionId),
          approvalId: String(payload.approvalId),
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
        const entry: NewQuestionEntry = {
          rpcId: String(frame.rpcId),
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
        return []
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
      return [makeEvent(directory, 'todo.updated', { sessionID: sessionId, todos: convertTodos(value) }, project)]
    }
    if (key === 'produced-files') {
      return [makeEvent(directory, 'session.diff', { sessionID: sessionId, diff: convertProducedFiles(value) }, project)]
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
        this.streamState(sessionId).lastUserMessageId = String(event.data.id)
        return events
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'block-start') {
          this.streamState(sessionId).blockStarts.set(
            `${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`,
            event.time,
          )
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
        this.streams.delete(sessionId)
        return [
          makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project),
          makeEvent(directory, 'session.idle', { sessionID: sessionId }, project),
        ]
      }
      case 'todo/write':
        return [makeEvent(directory, 'todo.updated', { sessionID: sessionId, todos: convertTodos(event.data.todos) }, project)]
      case 'tool/call': {
        const data = event.data
        const call: ToolCallInfo = {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
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
        return [
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
        const part = data.error === undefined
          ? completedToolPart(call, {
              callId,
              content: data.message.content,
              time: event.time,
              meta: data.meta,
            }, { sessionID: sessionId, messageID, time: event.time })
          : errorToolPart(call, {
              callId,
              content: data.message.content,
              error: data.error,
              time: event.time,
              meta: data.meta,
            }, { sessionID: sessionId, messageID, time: event.time })
        calls?.delete(callId)
        return [
          makeEvent(directory, 'message.part.updated', {
            sessionID: sessionId,
            part,
            time: event.time,
          }, project),
        ]
      }
      default: {
        const type = event.type as string
        const data = (event as unknown as { data: { time?: number; title?: unknown; text?: unknown } }).data
        if (type === 'session/created') {
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, { cwd: directory, createdAt: data.time }),
            }, project),
          ]
        }
        if (type === 'session/title') {
          const title = typeof data.title === 'string' ? data.title
            : typeof data.text === 'string' ? data.text
              : ''
          return [
            makeEvent(directory, 'session.updated', {
              sessionID: sessionId,
              info: minimalSession(sessionId, { cwd: directory, title, createdAt: data.time }),
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
export function convertProducedFiles(value: unknown): Array<{
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}> {
  if (!Array.isArray(value)) return []
  const result: Array<{
    file?: string
    patch?: string
    additions: number
    deletions: number
    status?: 'added' | 'deleted' | 'modified'
  }> = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const additions = typeof item.additions === 'number' ? item.additions : 0
    const deletions = typeof item.deletions === 'number' ? item.deletions : 0
    const file = typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : undefined
    const status = item.status === 'added' || item.status === 'deleted' || item.status === 'modified'
      ? item.status
      : undefined
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
