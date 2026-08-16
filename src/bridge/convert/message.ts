import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
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
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageUser,
} from '@opencode-ai/sdk/v2/types'
import {
  DEFAULT_AGENT,
  externalProviderId,
  provisionalMessageId,
  provisionalPartId,
  textFromBlocks,
} from './common.js'
import {
  completedToolPart,
  errorToolPart,
  pendingToolPart,
  type ToolCallInfo,
  type ToolResultInfo,
} from './tool.js'
import { goalChangeText } from './goal.js'

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

/**
 * Packed dsh chunk rows surface through the session event feed as
 * `text-chunks` / `reasoning-chunks`. They are not part of the strict
 * `SessionEventMap` union, so the converter treats them as a narrow runtime
 * shape instead of extending the public type.
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

/** Dsh checkpoint rows written by compaction have a plugin `compact` source. */
export function isCompactCheckpoint(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { kind?: string; plugin?: string } | undefined
  return source?.kind === 'plugin' && source.plugin === 'compact'
}

/** Manual `/compact` records a sourceCommandId; automatic compaction omits it. */
export function isAutoCompactCheckpoint(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { sourceCommandId?: unknown } | undefined
  return source?.sourceCommandId === undefined
}

function compactionPart(
  messageId: string,
  opts: MessageConvertOptions,
  auto: boolean,
): Part {
  return {
    id: `${messageId}:compaction`,
    sessionID: opts.sessionId,
    messageID: messageId,
    type: 'compaction',
    auto,
  }
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
  created?: number,
  finish?: string,
): AssistantMessage & { agent: string } {
  return {
    id: String(message.id),
    sessionID: opts.sessionId,
    role: 'assistant',
    time: { created: created ?? time, completed: time },
    parentID,
    agent: DEFAULT_AGENT,
    modelID: message.source.model,
    providerID: externalProviderId(message.source.provider),
    mode: DEFAULT_AGENT,
    path: { cwd: opts.cwd, root: opts.cwd },
    cost: 0,
    tokens: usageTokens(usage),
    ...(finish === undefined ? {} : { finish }),
  }
}

function textPart(
  id: string,
  messageID: string,
  text: string,
  time: { start: number; end?: number },
  opts: MessageConvertOptions,
): TextPart {
  return {
    id,
    sessionID: opts.sessionId,
    messageID,
    type: 'text',
    text,
    time: { start: time.start, ...(time.end === undefined ? {} : { end: time.end }) },
  }
}

/** Build the v1 text/reasoning/tool parts for one assistant message. */
export function assistantPartsFromMessage(
  message: DshAssistantMessage,
  time: number,
  opts: MessageConvertOptions,
  blockStart?: (index: number, blockType: string) => number | undefined,
  blockEnd?: (index: number, blockType: string) => number | undefined,
  partIdFor?: (index: number, blockType: string) => string | undefined,
): { parts: Part[]; calls: Map<string, ToolCallInfo> } {
  const parts: Part[] = []
  const calls = new Map<string, ToolCallInfo>()
  const messageID = String(message.id)
  message.content.forEach((block, index) => {
    const start = blockStart?.(index, block.type) ?? time
    if (block.type === 'text') {
      parts.push(textPart(partIdFor?.(index, block.type) ?? `${messageID}:${index}`, messageID, block.text, { start, end: time }, opts))
    } else if (block.type === 'reasoning') {
      parts.push({
        id: partIdFor?.(index, block.type) ?? `${messageID}:${index}`,
        sessionID: opts.sessionId,
        messageID,
        type: 'reasoning',
        text: block.text,
        time: { start, end: blockEnd?.(index, 'reasoning') ?? time },
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
      parts.push(textPart(`${messageId}:${index}`, messageId, block.text, { start: time, end: time }, opts))
    } else if (block.type === 'image') {
      // First version: image parts are skipped; the text surface still works.
      opts.onSkip?.('user/message', `image block skipped (${String((block.attachment as { mediaType?: string }).mediaType ?? 'unknown')})`)
    } else {
      opts.onSkip?.('user/message', `unhandled content block "${String((block as { type: string }).type)}"`)
    }
  })
  return parts
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

type StreamBlockType = 'text' | 'reasoning'

interface StreamBlockAccumulator {
  blockType: StreamBlockType
  start: number
  text: string
}

type StreamBlocksByStep = Map<string, Map<string, StreamBlockAccumulator>>

function accumulateStreamBlock(
  blocksByStep: StreamBlocksByStep,
  turn: number,
  step: number,
  index: number,
  blockType: StreamBlockType,
  text: string,
  start: number,
): void {
  const stepKey = `${turn}:${step}`
  let blocks = blocksByStep.get(stepKey)
  if (!blocks) {
    blocks = new Map()
    blocksByStep.set(stepKey, blocks)
  }
  const blockKey = `${index}:${blockType}`
  const existing = blocks.get(blockKey)
  if (existing) {
    existing.text += text
  } else {
    blocks.set(blockKey, { blockType, start, text })
  }
}

function partialAssistantMessageInfo(
  id: string,
  created: number,
  parentID: string,
  opts: MessageConvertOptions,
): AssistantMessage {
  const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  return {
    id,
    sessionID: opts.sessionId,
    role: 'assistant',
    time: { created },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: DEFAULT_AGENT,
    path: { cwd: opts.cwd, root: opts.cwd },
    cost: 0,
    tokens: ZERO_TOKENS,
  }
}

function v1StreamPart(
  block: StreamBlockAccumulator,
  messageID: string,
  partId: string,
  opts: MessageConvertOptions,
): Part {
  if (block.blockType === 'text') {
    return textPart(partId, messageID, block.text, { start: block.start }, opts)
  }
  return {
    id: partId,
    sessionID: opts.sessionId,
    messageID,
    type: 'reasoning',
    text: block.text,
    time: { start: block.start },
  }
}

function upsertPartialV1(
  entries: V1MessageEntry[],
  pending: Map<string, V1MessageEntry>,
  blocksByStep: StreamBlocksByStep,
  pendingCallsByStep: Map<string, Map<string, ToolCallInfo>>,
  opts: MessageConvertOptions,
  turn: number,
  step: number,
  created: number,
  parentID: string,
): V1MessageEntry {
  const stepKey = `${turn}:${step}`
  let entry = pending.get(stepKey)
  if (!entry) {
    entry = {
      info: partialAssistantMessageInfo(
        provisionalMessageId(opts.sessionId, turn, step),
        created,
        parentID,
        opts,
      ),
      parts: [],
    }
    pending.set(stepKey, entry)
    entries.push(entry)
  }
  const blocks = blocksByStep.get(stepKey)
  if (blocks) {
    for (const [blockKey, block] of blocks) {
      const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(':')))
      const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex)
      const partIndex = entry.parts.findIndex((part) => part.id === partId)
      const replacement = v1StreamPart(block, entry.info.id, partId, opts)
      if (partIndex === -1) {
        entry.parts.push(replacement)
      } else {
        entry.parts[partIndex] = replacement
      }
    }
  }
  const calls = pendingCallsByStep.get(stepKey)
  if (calls) {
    for (const call of calls.values()) {
      if (!entry.parts.some((part) => part.type === 'tool' && part.callID === call.callId)) {
        entry.parts.push(pendingToolPart(call, {
          sessionID: opts.sessionId,
          messageID: entry.info.id,
          time: created,
        }))
      }
    }
  }
  return entry
}

function applyToolResultV1(
  entries: V1MessageEntry[],
  calls: Map<string, ToolCallInfo>,
  event: SessionEvent<'tool/result'>,
  opts: MessageConvertOptions,
  view?: ToolEventView,
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
    view,
    callView: call.view,
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
  views?: ReadonlyArray<ToolEventView | undefined>,
): V1MessageEntry[] {
  const entries: V1MessageEntry[] = []
  const calls = new Map<string, ToolCallInfo>()
  const blockStarts = new Map<string, number>()
  const turnStarts = new Map<number, number>()
  const finishReasons = new Map<string, string>()
  const blockEnds = new Map<string, number>()
  const blocksByStep: StreamBlocksByStep = new Map()
  const pending = new Map<string, V1MessageEntry>()
  const pendingCallsByStep = new Map<string, Map<string, ToolCallInfo>>()
  let lastMessageId = ''
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex] as SessionEvent
    const view = views?.[eventIndex]
    switch (event.type) {
      case 'turn/start': {
        turnStarts.set(event.data.turn, event.time)
        break
      }
      case 'user/message': {
        const data = event.data
        const id = String(data.id)
        const compact = isCompactCheckpoint(event)
        entries.push({
          info: userMessageInfo(id, event.time, opts),
          parts: compact
            ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))]
            : userPartsFromMessage(id, data.content, event.time, opts),
        })
        lastMessageId = id
        break
      }
      case 'assistant/chunk': {
        const data = event.data
        const chunk = data.chunk
        if (chunk.type === 'block-start') {
          blockStarts.set(`${data.turn}:${data.step}:${chunk.index}:${chunk.blockType}`, event.time)
        } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const blockType = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          const key = `${data.turn}:${data.step}:${chunk.index}:${blockType}`
          if (!blockStarts.has(key)) blockStarts.set(key, event.time)
          blockEnds.set(key, event.time)
          const start = blockStarts.get(key) ?? event.time
          accumulateStreamBlock(blocksByStep, data.turn, data.step, chunk.index, blockType, chunk.text, start)
          upsertPartialV1(
            entries,
            pending,
            blocksByStep,
            pendingCallsByStep,
            opts,
            data.turn,
            data.step,
            earliestBlockStart(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time,
            lastMessageId || `pending:${opts.sessionId}:user`,
          )
        }
        break
      }
      case 'text-chunks' as SessionEvent['type']:
      case 'reasoning-chunks' as SessionEvent['type']: {
        const chunk = event as unknown as StreamChunkRowEvent
        const blockType = chunk.type === 'text-chunks' ? 'text' : 'reasoning'
        const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`
        const time0 = chunk.time0 ?? chunk.time
        if (!blockStarts.has(key)) {
          blockStarts.set(key, time0)
        }
        blockEnds.set(key, event.time)
        const start = blockStarts.get(key) ?? time0
        accumulateStreamBlock(
          blocksByStep,
          chunk.data.turn,
          chunk.data.step,
          chunk.data.index,
          blockType,
          chunk.data.texts.join(''),
          start,
        )
        upsertPartialV1(
          entries,
          pending,
          blocksByStep,
          pendingCallsByStep,
          opts,
          chunk.data.turn,
          chunk.data.step,
          earliestBlockStart(blockStarts, chunk.data.turn, chunk.data.step) ?? turnStarts.get(chunk.data.turn) ?? time0,
          lastMessageId || `pending:${opts.sessionId}:user`,
        )
        break
      }
      case 'assistant/message': {
        const data = event.data
        const id = String(data.message.id)
        const stepKey = `${data.turn}:${data.step}`
        const { parts, calls: messageCalls } = assistantPartsFromMessage(
          data.message,
          event.time,
          opts,
          (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`),
          (index, blockType) => blockEnds.get(`${data.turn}:${data.step}:${index}:${blockType}`),
          (index, blockType) => provisionalPartId(opts.sessionId, data.turn, data.step, blockType, index),
        )
        for (const [callId, call] of messageCalls) calls.set(callId, call)
        const pendingEntry = pending.get(stepKey)
        const pendingIndex = pendingEntry === undefined
          ? -1
          : entries.findIndex((entry) => entry.info.id === pendingEntry.info.id)
        entries.push({
          info: assistantMessageInfo(
            data.message,
            event.time,
            lastMessageId || id,
            opts,
            data.usage,
            earliestBlockStart(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time,
            finishReasons.get(`${data.turn}:${data.step}`) ?? 'stop',
          ),
          parts,
        })
        if (pendingIndex !== -1) entries.splice(pendingIndex, 1)
        pending.delete(stepKey)
        pendingCallsByStep.delete(stepKey)
        lastMessageId = id
        break
      }
      case 'tool/call': {
        const data = event.data
        const call: ToolCallInfo = {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
          ...(view === undefined ? {} : { view }),
        }
        calls.set(call.callId, call)
        const stepKey = `${data.turn}:${data.step}`
        let stepCalls = pendingCallsByStep.get(stepKey)
        if (!stepCalls) {
          stepCalls = new Map()
          pendingCallsByStep.set(stepKey, stepCalls)
        }
        stepCalls.set(call.callId, call)
        const pendingEntry = pending.get(stepKey)
        if (
          pendingEntry
          && !pendingEntry.parts.some((part) => part.type === 'tool' && part.callID === call.callId)
        ) {
          pendingEntry.parts.push(pendingToolPart(call, {
            sessionID: opts.sessionId,
            messageID: pendingEntry.info.id,
            time: event.time,
          }))
        }
        break
      }
      case 'tool/result': {
        applyToolResultV1(entries, calls, event, opts, view)
        break
      }
      default:
        // Log-only events (turn/start, request/header, ...) are not part of
        // the message surface; goal changes become concise assistant notes.
        if (event.type === 'goal/change' as SessionEvent['type']) {
          const text = goalChangeText((event as unknown as { data: unknown }).data)
          if (text !== undefined) {
            const id = `goal:${event.seq}`
            entries.push({
              info: partialAssistantMessageInfo(
                id,
                event.time,
                lastMessageId || `pending:${opts.sessionId}:user`,
                opts,
              ),
              parts: [textPart(`${id}:note`, id, text, { start: event.time, end: event.time }, opts)],
            })
          }
        }
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
    parts: isCompactCheckpoint(event)
      ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))]
      : userPartsFromMessage(id, event.data.content, event.time, opts),
  }
}

/** Single-event v1 conversion used by the SSE bridge. */
export function assistantMessageFromEvent(
  event: SessionEvent<'assistant/message'>,
  opts: MessageConvertOptions,
  blockStart?: (index: number, blockType: string) => number | undefined,
  blockEnd?: (index: number, blockType: string) => number | undefined,
  created?: number,
  parentID?: string,
  finish?: string,
  partIdFor?: (index: number, blockType: string) => string | undefined,
): V1MessageEntry {
  const id = String(event.data.message.id)
  const effectivePartIdFor = partIdFor ?? ((index: number, blockType: string) =>
    provisionalPartId(opts.sessionId, event.data.turn, event.data.step, blockType, index))
  const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts, blockStart, blockEnd, effectivePartIdFor)
  return {
    info: assistantMessageInfo(event.data.message, event.time, parentID ?? id, opts, event.data.usage, created, finish),
    parts,
  }
}

// ---- v2 conversion (GET /api/session/{id}/message) ----

interface V2AssistantState {
  info: SessionMessageAssistant
  calls: Map<string, ToolCallInfo>
}

function partialV2Assistant(
  id: string,
  created: number,
  opts: MessageConvertOptions,
): SessionMessageAssistant {
  const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  return {
    id,
    time: { created },
    type: 'assistant',
    agent: DEFAULT_AGENT,
    model: { id: model.modelID, providerID: model.providerID },
    content: [],
    cost: 0,
    tokens: ZERO_TOKENS,
  }
}

function v2StreamPart(
  block: StreamBlockAccumulator,
  partId: string,
): SessionMessageAssistantText | SessionMessageAssistantReasoning {
  if (block.blockType === 'text') {
    return {
      type: 'text',
      id: partId,
      text: block.text,
    }
  }
  return {
    type: 'reasoning',
    id: partId,
    text: block.text,
    time: { created: block.start },
  }
}

function upsertPartialV2(
  messages: SessionMessage[],
  pending: Map<string, SessionMessageAssistant>,
  blocksByStep: StreamBlocksByStep,
  pendingCallsByStep: Map<string, Map<string, ToolCallInfo>>,
  opts: MessageConvertOptions,
  turn: number,
  step: number,
  created: number,
  seq: number,
  pushFn?: (message: SessionMessage, seq: number) => void,
): V2AssistantState {
  const stepKey = `${turn}:${step}`
  let info = pending.get(stepKey)
  if (!info) {
    info = partialV2Assistant(provisionalMessageId(opts.sessionId, turn, step), created, opts)
    pending.set(stepKey, info)
    if (pushFn === undefined) {
      messages.push(info)
    } else {
      pushFn(info, seq)
    }
  }
  const blocks = blocksByStep.get(stepKey)
  if (blocks) {
    for (const [blockKey, block] of blocks) {
      const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(':')))
      const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex)
      const replacement = v2StreamPart(block, partId)
      const partIndex = info.content.findIndex((part) => part.id === partId)
      if (partIndex === -1) {
        info.content.push(replacement)
      } else {
        info.content[partIndex] = replacement
      }
    }
  }
  const calls = pendingCallsByStep.get(stepKey) ?? new Map<string, ToolCallInfo>()
  for (const call of calls.values()) {
    if (!info.content.some((part) => part.type === 'tool' && part.id === `tool:${call.callId}`)) {
      const tool: SessionMessageAssistantTool = {
        type: 'tool',
        id: `tool:${call.callId}`,
        name: call.name,
        state: { status: 'pending', input: call.arguments },
        time: { created },
      }
      info.content.push(tool)
    }
  }
  return { info, calls }
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
  created?: number,
  blockStart?: (index: number, blockType: string) => number | undefined,
): V2AssistantState {
  const data = event.data
  const messageID = String(data.message.id)
  const content: SessionMessageAssistant['content'] = []
  const calls = new Map<string, ToolCallInfo>()
  data.message.content.forEach((block, index) => {
    if (block.type === 'text') {
      const part: SessionMessageAssistantText = {
        type: 'text',
        id: provisionalPartId(opts.sessionId, data.turn, data.step, 'text', index),
        text: block.text,
      }
      content.push(part)
    } else if (block.type === 'reasoning') {
      const start = blockStart?.(index, block.type) ?? event.time
      content.push({
        type: 'reasoning',
        id: provisionalPartId(opts.sessionId, data.turn, data.step, 'reasoning', index),
        text: block.text,
        time: { created: start, completed: event.time },
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
    time: { created: created ?? event.time, completed: event.time },
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
  views?: ReadonlyArray<ToolEventView | undefined>,
  anchorSeqs?: number[],
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const pushMessage = (message: SessionMessage, seq: number): void => {
    messages.push(message)
    anchorSeqs?.push(seq)
  }
  const spliceMessage = (index: number): void => {
    messages.splice(index, 1)
    anchorSeqs?.splice(index, 1)
  }
  const calls = new Map<string, ToolCallInfo>()
  const blockStarts = new Map<string, number>()
  const turnStarts = new Map<number, number>()
  const finishReasons = new Map<string, string>()
  const blocksByStep: StreamBlocksByStep = new Map()
  const pending = new Map<string, SessionMessageAssistant>()
  const pendingCallsByStep = new Map<string, Map<string, ToolCallInfo>>()
  let lastAssistant: V2AssistantState | undefined
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex] as SessionEvent
    const view = views?.[eventIndex]
    switch (event.type) {
      case 'turn/start': {
        turnStarts.set(event.data.turn, event.time)
        break
      }
      case 'user/message': {
        const data = event.data
        const compact = isCompactCheckpoint(event)
        const message: SessionMessageUser = {
          id: String(data.id),
          time: { created: event.time },
          text: compact
            ? ''
            : textFromBlocks(data.content as readonly { type: string; text?: unknown }[]),
          type: 'user',
        }
        pushMessage(message, event.seq)
        break
      }
      case 'assistant/chunk': {
        const data = event.data
        const chunk = data.chunk
        if (chunk.type === 'block-start') {
          blockStarts.set(`${data.turn}:${data.step}:${chunk.index}:${chunk.blockType}`, event.time)
        } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const blockType = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          const key = `${data.turn}:${data.step}:${chunk.index}:${blockType}`
          if (!blockStarts.has(key)) blockStarts.set(key, event.time)
          const start = blockStarts.get(key) ?? event.time
          accumulateStreamBlock(blocksByStep, data.turn, data.step, chunk.index, blockType, chunk.text, start)
          lastAssistant = upsertPartialV2(
            messages,
            pending,
            blocksByStep,
            pendingCallsByStep,
            opts,
            data.turn,
            data.step,
            earliestBlockStart(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time,
            event.seq,
            (message, seq) => pushMessage(message, seq),
          )
        }
        break
      }
      case 'text-chunks' as SessionEvent['type']:
      case 'reasoning-chunks' as SessionEvent['type']: {
        const chunk = event as unknown as StreamChunkRowEvent
        const blockType = chunk.type === 'text-chunks' ? 'text' : 'reasoning'
        const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`
        const time0 = chunk.time0 ?? chunk.time
        if (!blockStarts.has(key)) {
          blockStarts.set(key, time0)
        }
        const start = blockStarts.get(key) ?? time0
        accumulateStreamBlock(
          blocksByStep,
          chunk.data.turn,
          chunk.data.step,
          chunk.data.index,
          blockType,
          chunk.data.texts.join(''),
          start,
        )
        lastAssistant = upsertPartialV2(
          messages,
          pending,
          blocksByStep,
          pendingCallsByStep,
          opts,
          chunk.data.turn,
          chunk.data.step,
          earliestBlockStart(blockStarts, chunk.data.turn, chunk.data.step) ?? turnStarts.get(chunk.data.turn) ?? time0,
          chunk.seq,
          (message, seq) => pushMessage(message, seq),
        )
        break
      }
      case 'assistant/message': {
        const data = event.data
        const stepKey = `${data.turn}:${data.step}`
        const state = toV2Assistant(
          event,
          opts,
          earliestBlockStart(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time,
          (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`),
        )
        const pendingMessage = pending.get(stepKey)
        const pendingIndex = pendingMessage === undefined
          ? -1
          : messages.findIndex((message) => message.id === pendingMessage.id)
        pushMessage(state.info, event.seq)
        if (pendingIndex !== -1) spliceMessage(pendingIndex)
        pending.delete(stepKey)
        pendingCallsByStep.delete(stepKey)
        for (const [callId, call] of state.calls) calls.set(callId, call)
        lastAssistant = state
        break
      }
      case 'tool/call': {
        const data = event.data
        const call: ToolCallInfo = {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
          ...(view === undefined ? {} : { view }),
        }
        calls.set(call.callId, call)
        const stepKey = `${data.turn}:${data.step}`
        let stepCalls = pendingCallsByStep.get(stepKey)
        if (!stepCalls) {
          stepCalls = new Map()
          pendingCallsByStep.set(stepKey, stepCalls)
        }
        stepCalls.set(call.callId, call)
        const pendingMessage = pending.get(stepKey)
        if (
          pendingMessage
          && !pendingMessage.content.some((part) => part.type === 'tool' && part.id === `tool:${call.callId}`)
        ) {
          pendingMessage.content.push({
            type: 'tool',
            id: `tool:${call.callId}`,
            name: call.name,
            state: { status: 'pending', input: call.arguments },
            time: { created: event.time },
          })
        }
        if (pendingMessage) lastAssistant = { info: pendingMessage, calls: stepCalls }
        break
      }
      case 'tool/result': {
        applyToolResultV2(messages, lastAssistant, calls, event, opts)
        break
      }
      default:
        if (event.type === 'goal/change' as SessionEvent['type']) {
          const text = goalChangeText((event as unknown as { data: unknown }).data)
          if (text !== undefined) {
            const id = `goal:${event.seq}`
            const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
            pushMessage({
              id,
              time: { created: event.time, completed: event.time },
              type: 'assistant',
              agent: DEFAULT_AGENT,
              model: {
                id: model.modelID,
                providerID: model.providerID,
              },
              content: [{ type: 'text', id: `${id}:note`, text }],
              cost: 0,
              tokens: ZERO_TOKENS,
            }, event.seq)
          }
        }
        break
    }
  }
  return messages
}
