import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { InteractionState } from '../src/bridge/state.js'
import { MuxEventTranslator, type BridgeGlobalEvent } from '../src/bridge/events.js'
import {
  convertMessagesV1,
  convertMessagesV2,
  type MessageConvertOptions,
} from '../src/bridge/convert/message.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'replay')
const manifest = JSON.parse(
  readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'),
) as {
  fixtures: Array<{
    file: string
    eventCount: number
    features: string[]
    equivalence: boolean
  }>
}

interface NormPart {
  type: string
  text: string
  name?: string
  status?: string
}

interface NormMessage {
  role: string
  parent: number | null
  parts: NormPart[]
}

function normParts(parts: Array<Record<string, unknown>>): NormPart[] {
  return parts.map((part) => {
    const state = (part.state ?? {}) as Record<string, unknown>
    let text = ''
    if (typeof part.text === 'string') {
      text = part.text
    } else if (typeof state.output === 'string') {
      text = state.output
    } else if (typeof state.error === 'string') {
      text = state.error
    } else if (typeof (state.error as { message?: unknown } | undefined)?.message === 'string') {
      text = String((state.error as { message: string }).message)
    } else if (Array.isArray(state.content)) {
      text = (state.content as Array<{ text?: unknown }>).map((entry) => entry.text ?? '').join('')
    }
    return {
      type: String(part.type ?? ''),
      text,
      ...(part.type === 'tool'
        ? { name: String(part.tool ?? part.name ?? ''), status: String(state.status ?? '') }
        : {}),
    }
  })
}

function normV1(entries: Array<{
  info: { id: string; role: string; parentID?: string }
  parts: Array<Record<string, unknown>>
}>): NormMessage[] {
  const ids = entries.map((entry) => entry.info.id)
  return entries.map((entry) => ({
    role: entry.info.role,
    parent: entry.info.parentID == null
      ? null
      : ids.indexOf(entry.info.parentID) === -1 ? null : ids.indexOf(entry.info.parentID),
    parts: normParts(entry.parts),
  }))
}

function normV2(messages: Array<{
  type: string
  text?: string
  content?: Array<Record<string, unknown>>
}>): NormMessage[] {
  return messages.map((message) => ({
    role: message.type,
    parent: null,
    parts: message.type === 'user'
      ? [{ type: 'text', text: message.text ?? '' }]
      : normParts(message.content ?? []),
  }))
}

function withoutParent(messages: NormMessage[]): NormMessage[] {
  return messages.map((message) => ({ ...message, parent: null }))
}

function replay(events: SessionEvent[]) {
  const state = new InteractionState()
  const all: BridgeGlobalEvent[] = []
  const unhandled: Record<string, number> = {}
  const errors: string[] = []
  const translator = new MuxEventTranslator({
    cwd: '/work',
    state,
    log: (message) => {
      if (message.includes('unhandled')) {
        const type = /unhandled (?:session )?event ([^\s]+)/.exec(message)?.[1] ?? message
        unhandled[type] = (unhandled[type] ?? 0) + 1
      } else if (message.includes('error') || message.includes('failed')) {
        errors.push(message)
      }
    },
    toolFlushMs: 0,
    onFlush: (events) => all.push(...events),
  })
  for (const event of events) {
    const frame = {
      rpcId: `rpc-${String((event as unknown as { seq?: number }).seq ?? 0)}` as never,
      payload: { type: 'session/event' as const, sessionId: 's1' as never, event },
    }
    for (const translated of translator.translate(frame)) all.push(translated)
  }
  return { all, unhandled, errors }
}

describe('replay corpus (experiment 1c)', () => {
  for (const fixture of manifest.fixtures) {
    it(`replays ${fixture.file} (${fixture.features.join(',')})`, async () => {
      const raw = readFileSync(join(fixtureDir, fixture.file), 'utf8')
      const events = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent)
      expect(events.length).toBe(fixture.eventCount)

      const { all, unhandled, errors } = replay(events)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(errors).toEqual([])
      expect(unhandled).toEqual({})

      const opts: MessageConvertOptions = {
        sessionId: 's1',
        cwd: '/work',
        defaultModel: { providerID: 'deepseek', modelID: 'mock-model' },
      }
      const v1 = convertMessagesV1(events, opts)
      const v2 = convertMessagesV2(events, opts)

      // Tool calls must be paired with results, and every durable tool part
      // must reach a terminal state.
      const calls = events
        .filter((event) => event.type === 'tool/call')
        .map((event) => String((event.data as { callId?: unknown }).callId ?? ''))
        .sort()
      const results = events
        .filter((event) => event.type === 'tool/result')
        .map((event) => String(((event.data as { message?: { source?: { callId?: unknown } } }).message?.source)?.callId ?? ''))
        .sort()
      expect(results).toEqual(calls)
      for (const entry of v1) {
        for (const part of entry.parts) {
          if (part.type === 'tool') {
            expect(['completed', 'error']).toContain(
              String((part as { state?: { status?: unknown } }).state?.status ?? ''),
            )
          }
        }
      }

      const v1Norm = normV1(v1 as Array<{
        info: { id: string; role: string; parentID?: string }
        parts: Array<Record<string, unknown>>
      }>)
      const v2Norm = normV2(v2 as Array<{ type: string; text?: string; content?: Array<Record<string, unknown>> }>)

      // Live event invariants: every tool call reaches a terminal part state.
      const toolStatuses = new Map<string, string[]>()
      let completedAssistantCount = 0
      const queuedUsers = new Set<string>()
      let sawTodoUpdate = false
      for (const event of all) {
        const props = event.payload.properties as Record<string, unknown>
        if (event.payload.type === 'message.part.updated') {
          const part = props.part as { type?: string; callID?: string; state?: { status?: string } } | undefined
          if (part?.type === 'tool' && part.callID !== undefined) {
            const statuses = toolStatuses.get(part.callID) ?? []
            statuses.push(part.state?.status ?? '')
            toolStatuses.set(part.callID, statuses)
          }
        } else if (event.payload.type === 'message.updated') {
          const info = props.info as { role?: string; id?: string; time?: { completed?: number } } | undefined
          if (info?.role === 'assistant' && info.id !== undefined && info.time?.completed !== undefined) {
            completedAssistantCount += 1
            if (fixture.file === 'multi-tool-queued.jsonl') {
              console.log('DBG completed', info.id)
            }
          }
          if (info?.role === 'user' && info.id !== undefined && info.id.startsWith('msg-queued-')) {
            queuedUsers.add(info.id)
          }
        } else if (event.payload.type === 'todo.updated') {
          sawTodoUpdate = true
        }
      }
      for (const callId of calls) {
        const statuses = toolStatuses.get(callId) ?? []
        expect(statuses.some((status) => status === 'completed' || status === 'error'))
          .toBe(true)
      }

      if (fixture.equivalence) {
        // Both durable surfaces must agree exactly (v2 carries no parent).
        expect(withoutParent(v1Norm)).toEqual(withoutParent(v2Norm))
        // Live stream must close at least as many assistant messages as the
        // durable fold, and exactly as many now that multi-tool turns
        // complete every pending tool-call assistant at turn/end (ids differ:
        // live keeps msg_pending ids without the bridge's surface-id remap).
        const durableAssistants = v1.filter((entry) => entry.info.role === 'assistant').length
        expect(completedAssistantCount).toBe(durableAssistants)
      } else if (fixture.features.includes('interrupt')) {
        // Interrupted turn: both surfaces keep a partial assistant; the live
        // translator additionally closes it at turn/end.
        expect(v1Norm.filter((message) => message.role === 'assistant').length).toBeGreaterThan(0)
        expect(completedAssistantCount).toBeGreaterThan(0)
      } else if (fixture.features.includes('goal')) {
        expect(v1Norm.some((message) =>
          message.role === 'assistant' && message.parts.some((part) => part.text.includes('synthetic goal'))))
          .toBe(true)
        expect(sawTodoUpdate).toBe(true)
      }
      if (fixture.features.includes('queue')) {
        // The queued user must be surfaced live at the splice point.
        expect(queuedUsers.has('msg-queued-1')).toBe(true)
      }
    })
  }
})
