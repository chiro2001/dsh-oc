import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { Part, ToolPart } from '@opencode-ai/sdk/client'
import { safeJsonParse, textFromBlocks } from './common.js'

export interface ToolCallInfo {
  callId: string
  name: string
  arguments: string
}

export interface ToolResultInfo {
  callId: string
  content: readonly ContentBlock[]
  error?: { name?: string; code?: string }
  time: number
  meta?: unknown
}

export interface ToolPartOptions {
  sessionID: string
  messageID: string
  time: number
}

function resultText(content: readonly ContentBlock[]): string {
  const blocks = content.flatMap((block) =>
    block.type === 'tool-result' ? block.content : [block],
  )
  return textFromBlocks(blocks as readonly { type: string; text?: unknown }[])
}

/** A `tool/call` event alone becomes a pending ToolPart. */
export function pendingToolPart(call: ToolCallInfo, options: ToolPartOptions): ToolPart {
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool: call.name,
    state: {
      status: 'pending',
      input: safeJsonParse(call.arguments),
      raw: call.arguments,
    },
    metadata: { start: options.time },
  }
}

/** Placeholder for an in-flight call (dsh does not emit this state today). */
export function runningToolPart(call: ToolCallInfo, options: ToolPartOptions): ToolPart {
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool: call.name,
    state: {
      status: 'running',
      input: safeJsonParse(call.arguments),
      title: call.name,
      time: { start: options.time },
    },
  }
}

/** A `tool/result` success event becomes a completed ToolPart. */
export function completedToolPart(
  call: ToolCallInfo,
  result: ToolResultInfo,
  options: ToolPartOptions,
): ToolPart {
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool: call.name,
    state: {
      status: 'completed',
      input: safeJsonParse(call.arguments),
      output: resultText(result.content),
      title: call.name,
      metadata: result.meta === undefined ? {} : { meta: result.meta },
      time: {
        start: options.time,
        end: result.time,
      },
    },
  }
}

/** A `tool/result` with an error becomes an error ToolPart. */
export function errorToolPart(
  call: ToolCallInfo,
  result: ToolResultInfo,
  options: ToolPartOptions,
): ToolPart {
  const message = result.error?.name ?? result.error?.code ?? 'tool failed'
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool: call.name,
    state: {
      status: 'error',
      input: safeJsonParse(call.arguments),
      error: message,
      time: {
        start: options.time,
        end: result.time,
      },
    },
  }
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool'
}
