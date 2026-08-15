import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  AssistantMessage as DshAssistantMessage,
  ContentBlock,
  TokenUsage,
} from '@deepseek-ai/dsh-llm/types'
import type {
  AssistantMessage,
  Message,
  Part,
  TextPart,
  UserMessage,
} from '@opencode-ai/sdk/client'
import type {
  ModelRef,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageUser,
} from '@opencode-ai/sdk/v2/types'
import { DEFAULT_AGENT, externalProviderId, textFromBlocks } from './common.js'
import {
  completedToolPart,
  errorToolPart,
  pendingToolPart,
  type ToolCallInfo,
  type ToolResultInfo,
} from './tool.js'

export interface MessageConvertOptions {
  sessionId: string
  cwd: string
  /**
   * Model ref attached to user messages. The opencode TUI reads the last
   * user message's model to restore the session model, so it must name a
   * model present in the advertised catalog.
   */
  defaultModel?: { providerID: string; modelID: string }
  onSkip?: (eventType: string, reason: string) => void
}

export interface V1MessageEntry {
  info: Message
  parts: Part[]
}

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function usageTokens(usage?: TokenUsage) {
  if (!usage) return ZERO_TOKENS
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens ?? 0,
    cache: {
      read: usage.cacheReadTokens ?? 0,
      write: usage.cacheWriteTokens ?? 0,
    },
  }
}

function userMessageInfo(id: string, time: number, opts: MessageConvertOptions): UserMessage {
  return {
    id,
    sessionID: opts.sessionId,
    role: 'user',
    time: { created: time },
    agent: DEFAULT_AGENT,
    model: opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' },
  }
}

function assistantMessageInfo(
  message: DshAssistantMessage,
  time: number,
  parentID: string,
  opts: MessageConvertOptions,
  usage?: TokenUsage,
): AssistantMessage {
  return {
    id: String(message.id),
    sessionID: opts.sessionId,
    role: 'assistant',
    time: { created: time, completed: time },
    parentID,
    modelID: message.source.model,
    providerID: externalProviderId(message.source.provider),
    mode: DEFAULT_AGENT,
    path: { cwd: opts.cwd, root: opts.cwd },
    cost: 0,
    tokens: usageTokens(usage),
  }
}

function textPart(
  id: string,
  messageID: string,
  text: string,
  time: number,
  opts: MessageConvertOptions,
): TextPart {
  return {
    id,
    sessionID: opts.sessionId,
    messageID,
    type: 'text',
    text,
    time: { start: time },
  }
}

/** Build the v1 text/reasoning/tool parts for one assistant message. */
export function assistantPartsFromMessage(
  message: DshAssistantMessage,
  time: number,
  opts: MessageConvertOptions,
): { parts: Part[]; calls: Map<string, ToolCallInfo> } {
  const parts: Part[] = []
  const calls = new Map<string, ToolCallInfo>()
  const messageID = String(message.id)
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(textPart(`${messageID}:${index}`, messageID, block.text, time, opts))
    } else if (block.type === 'reasoning') {
      parts.push({
        id: `${messageID}:${index}`,
        sessionID: opts.sessionId,
        messageID,
        type: 'reasoning',
        text: block.text,
        time: { start: time },
      })
    } else if (block.type === 'tool-call') {
      const call: ToolCallInfo = {
        callId: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
      calls.set(call.callId, call)
      parts.push(
        pendingToolPart(call, {
          sessionID: opts.sessionId,
          messageID,
          time,
        }),
      )
    } else {
      opts.onSkip?.('assistant/message', `unhandled content block "${String((block as { type: string }).type)}"`)
    }
  })
  return { parts, calls }
}

function userPartsFromMessage(
  messageId: string,
  content: readonly ContentBlock[],
  time: number,
  opts: MessageConvertOptions,
): Part[] {
  const parts: Part[] = []
  content.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(textPart(`${messageId}:${index}`, messageId, block.text, time, opts))
    } else if (block.type === 'image') {
      // First version: image parts are skipped; the text surface still works.
      opts.onSkip?.('user/message', `image block skipped (${String((block.attachment as { mediaType?: string }).mediaType ?? 'unknown')})`)
    } else {
      opts.onSkip?.('user/message', `unhandled content block "${String((block as { type: string }).type)}"`)
    }
  })
  return parts
}

function applyToolResultV1(
  entries: V1MessageEntry[],
  calls: Map<string, ToolCallInfo>,
  event: SessionEvent<'tool/result'>,
  opts: MessageConvertOptions,
): void {
  const data = event.data
  const callId = String(data.message.content[0]?.toolCallId ?? data.message.source.callId)
  const call = calls.get(callId)
  if (!call) {
    opts.onSkip?.('tool/result', `no matching tool/call for "${callId}"`)
    return
  }
  const result: ToolResultInfo = {
    callId,
    content: data.message.content,
    error: data.error,
    time: event.time,
    meta: data.meta,
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as V1MessageEntry
    if (entry.info.role !== 'assistant') continue
    const index = entry.parts.findIndex((part) => part.type === 'tool' && part.callID === callId)
    if (index === -1) continue
    const replacement = data.error === undefined
      ? completedToolPart(call, result, {
          sessionID: opts.sessionId,
          messageID: entry.info.id,
          time: event.time,
        })
      : errorToolPart(call, result, {
          sessionID: opts.sessionId,
          messageID: entry.info.id,
          time: event.time,
        })
    entry.parts[index] = replacement
    return
  }
  opts.onSkip?.('tool/result', `no assistant message holds "${callId}"`)
}

/** Fold dsh history events into the v1 `{ info, parts }` message list. */
export function convertMessagesV1(
  events: readonly SessionEvent[],
  opts: MessageConvertOptions,
): V1MessageEntry[] {
  const entries: V1MessageEntry[] = []
  const calls = new Map<string, ToolCallInfo>()
  let lastMessageId = ''
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const data = event.data
        const id = String(data.id)
        entries.push({
          info: userMessageInfo(id, event.time, opts),
          parts: userPartsFromMessage(id, data.content, event.time, opts),
        })
        lastMessageId = id
        break
      }
      case 'assistant/message': {
        const data = event.data
        const id = String(data.message.id)
        const { parts, calls: messageCalls } = assistantPartsFromMessage(
          data.message,
          event.time,
          opts,
        )
        for (const [callId, call] of messageCalls) calls.set(callId, call)
        entries.push({
          info: assistantMessageInfo(data.message, event.time, lastMessageId || id, opts, data.usage),
          parts,
        })
        lastMessageId = id
        break
      }
      case 'tool/call': {
        const data = event.data
        calls.set(String(data.callId), {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
        })
        break
      }
      case 'tool/result': {
        applyToolResultV1(entries, calls, event, opts)
        break
      }
      default:
        // Log-only events (turn/start, request/header, todo/write, ...) are
        // not part of the message surface.
        break
    }
  }
  return entries
}

/** Single-event v1 conversion used by the SSE bridge. */
export function userMessageFromEvent(
  event: SessionEvent<'user/message'>,
  opts: MessageConvertOptions,
): V1MessageEntry {
  const id = String(event.data.id)
  return {
    info: userMessageInfo(id, event.time, opts),
    parts: userPartsFromMessage(id, event.data.content, event.time, opts),
  }
}

/** Single-event v1 conversion used by the SSE bridge. */
export function assistantMessageFromEvent(
  event: SessionEvent<'assistant/message'>,
  opts: MessageConvertOptions,
): V1MessageEntry {
  const id = String(event.data.message.id)
  const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts)
  return {
    info: assistantMessageInfo(event.data.message, event.time, id, opts, event.data.usage),
    parts,
  }
}

// ---- v2 conversion (GET /api/session/{id}/message) ----

interface V2AssistantState {
  info: SessionMessageAssistant
  calls: Map<string, ToolCallInfo>
}

function toV2ModelRef(message: DshAssistantMessage): ModelRef {
  return {
    id: message.source.model,
    providerID: externalProviderId(message.source.provider),
  }
}

function toV2Assistant(
  event: SessionEvent<'assistant/message'>,
  opts: MessageConvertOptions,
): V2AssistantState {
  const data = event.data
  const messageID = String(data.message.id)
  const content: SessionMessageAssistant['content'] = []
  const calls = new Map<string, ToolCallInfo>()
  data.message.content.forEach((block, index) => {
    if (block.type === 'text') {
      const part: SessionMessageAssistantText = {
        type: 'text',
        id: `${messageID}:${index}`,
        text: block.text,
      }
      content.push(part)
    } else if (block.type === 'reasoning') {
      content.push({
        type: 'reasoning',
        id: `${messageID}:${index}`,
        text: block.text,
        time: { created: event.time },
      })
    } else if (block.type === 'tool-call') {
      const call: ToolCallInfo = {
        callId: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
      calls.set(call.callId, call)
      const tool: SessionMessageAssistantTool = {
        type: 'tool',
        id: `tool:${call.callId}`,
        name: call.name,
        state: { status: 'pending', input: call.arguments },
        time: { created: event.time },
      }
      content.push(tool)
    } else {
      opts.onSkip?.('assistant/message', `unhandled v2 block "${String((block as { type: string }).type)}"`)
    }
  })
  const info: SessionMessageAssistant = {
    id: messageID,
    time: { created: event.time, completed: event.time },
    type: 'assistant',
    agent: DEFAULT_AGENT,
    model: toV2ModelRef(data.message),
    content,
    cost: 0,
    tokens: usageTokens(data.usage),
  }
  return { info, calls }
}

function applyToolResultV2(
  messages: SessionMessage[],
  state: V2AssistantState | undefined,
  calls: Map<string, ToolCallInfo>,
  event: SessionEvent<'tool/result'>,
  opts: MessageConvertOptions,
): void {
  const data = event.data
  const callId = String(data.message.content[0]?.toolCallId ?? data.message.source.callId)
  const call = calls.get(callId)
  if (!call || !state) {
    opts.onSkip?.('tool/result', `no matching v2 tool/call for "${callId}"`)
    return
  }
  const blocks = data.message.content.flatMap((block) =>
    block.type === 'tool-result' ? block.content : [block],
  )
  const text = textFromBlocks(blocks as readonly { type: string; text?: unknown }[])
  const content = text.length === 0 ? [] : [{ type: 'text' as const, text }]
  const tool = state.info.content.find(
    (part): part is SessionMessageAssistantTool => part.type === 'tool' && part.id === `tool:${callId}`,
  )
  if (!tool) {
    opts.onSkip?.('tool/result', `no v2 tool part for "${callId}"`)
    return
  }
  if (data.error !== undefined) {
    tool.state = {
      status: 'error',
      input: {},
      content: [],
      structured: {},
      error: { type: 'unknown', message: data.error.name ?? data.error.code ?? 'tool failed' },
    }
  } else {
    tool.state = {
      status: 'completed',
      input: {},
      content,
      structured: {},
      result: undefined,
    }
  }
  tool.time = { ...tool.time, completed: event.time }
  void messages
}

/** Fold dsh history events into the v2 `SessionMessage[]` list. */
export function convertMessagesV2(
  events: readonly SessionEvent[],
  opts: MessageConvertOptions,
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const calls = new Map<string, ToolCallInfo>()
  let lastAssistant: V2AssistantState | undefined
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const data = event.data
        const message: SessionMessageUser = {
          id: String(data.id),
          time: { created: event.time },
          text: textFromBlocks(data.content as readonly { type: string; text?: unknown }[]),
          type: 'user',
        }
        messages.push(message)
        break
      }
      case 'assistant/message': {
        const state = toV2Assistant(event, opts)
        messages.push(state.info)
        for (const [callId, call] of state.calls) calls.set(callId, call)
        lastAssistant = state
        break
      }
      case 'tool/call': {
        const data = event.data
        calls.set(String(data.callId), {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
        })
        break
      }
      case 'tool/result': {
        applyToolResultV2(messages, lastAssistant, calls, event, opts)
        break
      }
      default:
        break
    }
  }
  return messages
}
