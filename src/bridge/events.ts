import { randomUUID } from 'node:crypto'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolResultBlock } from '@deepseek-ai/dsh-llm/types'
import {
  assistantMessageFromEvent,
  userMessageFromEvent,
  type MessageConvertOptions,
} from './convert/message.js'
import { projectIdFor } from './convert/common.js'
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

/**
 * Per-stream translator: converts one mux frame into zero or more opencode
 * GlobalEvents. One instance is created per SSE client because tool/result
 * pairing and current-message tracking are stream-ordered state.
 */
export class MuxEventTranslator {
  private currentAssistant = new Map<string, string>()
  private pendingCalls = new Map<string, Map<string, ToolCallInfo>>()
  private blockStarts = new Map<string, number>()

  constructor(private deps: TranslateDeps) {}

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
      case 'user/message':
        return messageEvents(sessionId, this.deps, () => {
          const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps))
          return {
            info: entry.info as unknown as Record<string, unknown>,
            parts: entry.parts as unknown as Array<Record<string, unknown>>,
          }
        })
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'block-start') {
          this.blockStarts.set(`${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`, event.time)
        }
        return []
      }
      case 'assistant/message': {
        const events = messageEvents(sessionId, this.deps, () => {
          const entry = assistantMessageFromEvent(
            event,
            messageOptions(sessionId, this.deps),
            (index, blockType) => this.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`),
          )
          return {
            info: entry.info as unknown as Record<string, unknown>,
            parts: entry.parts as unknown as Array<Record<string, unknown>>,
          }
        })
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
        return [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'busy' } }, project)]
      case 'turn/end':
        return [
          makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project),
          makeEvent(directory, 'session.idle', { sessionID: sessionId }, project),
        ]
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
        const messageID = this.currentAssistant.get(sessionId) ?? `assistant:${data.turn}:${data.step}`
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
        const messageID = this.currentAssistant.get(sessionId) ?? `assistant:${data.turn}:${data.step}`
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
