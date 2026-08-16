import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  agentErrorEvents,
  commandResultEvents,
  MuxEventTranslator,
  opencodeError,
  type BridgeGlobalEvent,
} from '../src/bridge/events.js'
import { InteractionState } from '../src/bridge/state.js'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { SseHub } from '../src/bridge/sse.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, okRpc, sessionEvent } from './helpers.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gitFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-events-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@dsh-oc.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'dsh-oc e2e'], { cwd: dir })
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir })
  tempDirs.push(dir)
  return dir
}

function frame(payload: MuxFrame, rpcId = 'rpc-1'): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as never, payload }
}

function chunkRow(
  type: 'text-chunks' | 'reasoning-chunks',
  texts: string[],
  time0: number,
  seq = 10,
  index = 0,
  turn = 1,
  step = 1,
): SessionEvent {
  return {
    type,
    seq,
    time: time0,
    time0,
    data: {
      turn,
      step,
      index,
      dt: texts.length > 1 ? texts.slice(1).map(() => 0) : [],
      texts,
    },
  } as unknown as SessionEvent
}

function translator(
  state = new InteractionState(),
  logs: string[] = [],
  cwd = '/work',
  options: {
    toolFlushMs?: number
    setTimeoutImpl?: (callback: () => void, ms: number) => { unref?(): unknown }
    clearTimeoutImpl?: (handle: { unref?(): unknown } | undefined) => void
    onFlush?: (events: BridgeGlobalEvent[]) => void
  } = {},
) {
  const instance = new MuxEventTranslator({ cwd, state, log: (message) => logs.push(message), ...options })
  return {
    state,
    logs,
    translate: (frames: Array<RpcRequest<MuxFrame>>): BridgeGlobalEvent[] =>
      frames.flatMap((item) => instance.translate(item)),
  }
}

describe('bridge events: session event mapping', () => {
  it('emits a visible error message for host/agent-error frames', () => {
    const events = agentErrorEvents('s1', 'mock authentication failed', '/work')
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.error',
      'message.updated',
      'message.part.updated',
    ])
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 's1',
      error: { name: 'UnknownError', data: { message: 'mock authentication failed' } },
    })
    expect((events[1]?.payload.properties.info as { role?: string }).role).toBe('assistant')
    const part = events[2]?.payload.properties.part as { type?: string; text?: string }
    expect(part.type).toBe('text')
    expect(part.text).toContain('mock authentication failed')
  })

  it('maps turn/start and turn/end to status + idle', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 200),
      }),
    ])
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.status',
      'turn.wait',
      'session.status',
      'session.idle',
      'turn.idle',
    ])
    expect(events[0]?.payload.properties).toEqual({
      sessionID: 's1',
      status: { type: 'busy' },
    })
    expect(events[1]?.payload.properties).toEqual({ sessionID: 's1' })
    expect(events[2]?.payload.properties).toEqual({
      sessionID: 's1',
      status: { type: 'idle' },
    })
    for (const event of events) {
      expect(event.directory).toBe('/work')
      expect(event.project).toMatch(/^[0-9a-f]{16}$/)
      expect(event.payload.id).toBeTypeOf('string')
      expect(event.payload.data).toEqual(event.payload.properties)
    }
  })

  it('silently ignores log-only session events without log noise', () => {
    const logs: string[] = []
    const { translate } = translator(new InteractionState(), logs)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('step/start' as never, { turn: 1, step: 2 }, 20, 3000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('request/header' as never, { header: { config: {} } }, 21, 3100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('command/run' as never, {
          commandId: 'cmd-1',
          name: 'goal',
          args: 'x',
          source: { kind: 'user' },
        }, 22, 3200),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('command/done' as never, {
          commandId: 'cmd-1',
          kind: 'success',
          text: 'Goal created',
        }, 23, 3300),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('sandbox/mode' as never, { mode: 'danger-full-access' }, 24, 3400),
      }),
    ])
    expect(events).toEqual([])
    expect(logs.some((line) => line.includes('unhandled'))).toBe(false)
  })

  it('silently ignores seed/approval records and tracks preset selection', () => {
    const { translate, state } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('session/end-seed' as never, {}, 1, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('approval/asked' as never, {
          id: 'a1',
          toolName: 'write',
          callId: 'c1',
          reason: 'need write',
        }, 2, 200),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('approval/decided' as never, {
          id: 'a1',
          outcome: 'allowed-once',
        }, 3, 300),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent-preset/selected' as never, {
          agentPreset: 'standard',
        }, 4, 400),
      }),
    ])
    expect(events).toEqual([])
    expect(state.lastAgentPreset).toBe('standard')
  })

  it('handles the flat durable session row without a data envelope', () => {
    const { translate, state } = translator()
    state.sessionDirectories.set('s1', '/other')
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: {
          type: 'session',
          seq: 0,
          time: 100,
          id: 's1',
          createdAt: 50,
          cwd: '/real-cwd',
          agentPreset: 'minimal',
        } as unknown as SessionEvent,
      }),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.type).toBe('session.updated')
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 's1',
      info: { id: 's1', directory: '/real-cwd' },
    })
  })

  it('translates compaction checkpoints into message parts and compaction events', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('user/message', {
          id: 'checkpoint-1' as never,
          content: [{ type: 'text', text: '<compacted-summary>done</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', sourceCommandId: 'cmd-1' },
        }, 2, 1000),
      }),
    ])
    expect(events.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'session.next.compaction.ended',
    ])
    const part = events[1]?.payload.properties.part as { type?: string; messageID?: string }
    expect(part).toMatchObject({ type: 'compaction', messageID: 'checkpoint-1' })
    expect(events[2]?.payload.properties).toMatchObject({
      timestamp: 1000,
      sessionID: 's1',
      messageID: 'checkpoint-1',
      reason: 'manual',
      text: '<compacted-summary>done</compacted-summary>',
    })
  })

  it('translates the compaction lifecycle without duplicating the end event', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('compaction/start', {
          compactionId: 'c1',
          sourceCommandId: 'cmd-1',
          turn: null,
        }, 1, 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('compaction/summary', {
          compactionId: 'c1',
          sourceCommandId: 'cmd-1',
          summary: [{ type: 'text', text: '<compacted-summary>done</compacted-summary>' }],
          shadowedRange: { start: 1, end: 3 },
          shadowedSeqs: [1, 2, 3],
          shadowedTokenCount: 100,
          provider: 'deepseek-official',
          model: 'mock-model',
        }, 2, 950),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('user/message', {
          id: 'checkpoint-1' as never,
          content: [{ type: 'text', text: '<compacted-summary>done</compacted-summary>' }],
          source: {
            kind: 'plugin',
            plugin: 'compact',
            compactionId: 'c1',
            sourceCommandId: 'cmd-1',
          },
        }, 3, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('compaction/end', {
          compactionId: 'c1',
          sourceCommandId: 'cmd-1',
          turn: null,
        }, 4, 1050),
      }),
    ])
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.next.compaction.started',
      'session.next.compaction.delta',
      'message.updated',
      'message.part.updated',
      'session.next.compaction.ended',
    ])
    expect(events[0]?.payload.properties).toMatchObject({
      timestamp: 900,
      sessionID: 's1',
      messageID: 'checkpoint:c1',
      reason: 'manual',
    })
    expect(events[1]?.payload.properties).toMatchObject({
      timestamp: 950,
      sessionID: 's1',
      messageID: 'checkpoint:c1',
      text: '<compacted-summary>done</compacted-summary>',
    })
    expect(events[4]?.payload.properties).toMatchObject({
      timestamp: 1000,
      sessionID: 's1',
      messageID: 'checkpoint-1',
      reason: 'manual',
      text: '<compacted-summary>done</compacted-summary>',
      recent: '',
    })
  })

  it('emits a compaction end event when the summary fails before a checkpoint', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('compaction/start', {
          compactionId: 'c2',
          sourceCommandId: 'cmd-2',
          turn: null,
        }, 1, 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('compaction/end', {
          compactionId: 'c2',
          sourceCommandId: 'cmd-2',
          turn: null,
          error: 'summary',
        }, 2, 1100),
      }),
    ])
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.next.compaction.started',
      'session.next.compaction.ended',
    ])
    expect(events[1]?.payload.properties).toMatchObject({
      timestamp: 1100,
      sessionID: 's1',
      messageID: 'checkpoint:c2',
      reason: 'manual',
      text: 'Compaction failed: summary',
      recent: '',
    })
  })

  it('builds synthetic command result events with busy/idle status', () => {
    const state = new InteractionState()
    const events = commandResultEvents(
      { cwd: '/work', state, log: () => {} },
      's1',
      'minimal\nstandard (default)',
      { status: 'busy' },
    )
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.status',
      'message.updated',
      'message.part.updated',
    ])
    expect(events[0]?.payload.properties).toEqual({
      sessionID: 's1',
      status: { type: 'busy' },
    })
    const info = events[1]?.payload.properties.info as { id: string; role: string; parentID: string }
    expect(info).toMatchObject({
      role: 'assistant',
      agent: 'build',
      mode: 'build',
      modelID: 'deepseek-chat',
      providerID: 'deepseek',
    })
    expect(info.id).toMatch(/^msg_cmd:/)
    expect(info.parentID).toBe('pending:s1:user')
    const part = events[2]?.payload.properties.part as { id: string; messageID: string; type: string; text: string }
    expect(part).toMatchObject({
      messageID: info.id,
      type: 'text',
      text: 'minimal\nstandard (default)',
    })
    expect(part.id).toMatch(/^prt_cmd:/)
    expect(events[2]?.payload.properties.time).toBeTypeOf('number')
  })

  it('streams text chunks through a provisional message and reports real duration', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' the'], 1100, 10),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' attention'], 1200, 11),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: ' the attention mechanism,' },
        ], 'm-final', 2000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20, 2100),
      }),
    ])

    // The provisional `message.updated` (created, no completed) is emitted
    // when streaming starts under the same stable id the final update reuses.
    const provisionalIndex = events.findIndex((event) =>
      event.payload.type === 'message.updated'
      && String((event.payload.properties.info as { id?: unknown }).id).startsWith('msg_pending:'))
    expect(provisionalIndex).toBeGreaterThanOrEqual(0)
    const provisionalInfo = events[provisionalIndex]?.payload.properties.info as Record<string, unknown>
    expect(provisionalInfo).toMatchObject({
      role: 'assistant',
      agent: 'build',
      mode: 'build',
      providerID: 'deepseek',
      modelID: 'deepseek-chat',
      cost: 0,
    })
    expect(provisionalInfo.id).toBe('msg_pending:s1:1:1')
    expect((provisionalInfo.time as { created: number }).created).toBe(1100)

    const firstPartIndex = events.findIndex((event) =>
      event.payload.type === 'message.part.updated'
      && String((event.payload.properties.part as { id?: string }).id).startsWith('prt_stream:')
      && (event.payload.properties.part as { type?: string }).type === 'text')
    expect(firstPartIndex).toBeGreaterThan(provisionalIndex)
    expect(events[firstPartIndex]?.payload.properties).toMatchObject({
      sessionID: 's1',
      time: 1100,
      part: { type: 'text', text: '', time: { start: 1100 } },
    })
    expect((events[firstPartIndex]?.payload.properties.part as { time: { end?: number } }).time.end).toBeUndefined()
    expect((events[firstPartIndex]?.payload.properties.part as { id: string }).id).toBe('prt_stream:s1:1:1:text:0')

    const deltas = events
      .filter((event) => event.payload.type === 'message.part.delta')
      .map((event) => event.payload.properties.delta)
    expect(deltas).toEqual([' the', ' attention'])

    const removedIndex = events.findIndex((event) =>
      event.payload.type === 'message.removed'
      && String(event.payload.properties.messageID).startsWith('msg_pending:'))
    expect(removedIndex).toBe(-1)
    const finalIndex = events.findIndex((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'msg_pending:s1:1:1'
      && (event.payload.properties.info as { time: { completed?: number } }).time.completed === 2000)
    expect(finalIndex).toBeGreaterThanOrEqual(0)

    const finalInfo = events[finalIndex]?.payload.properties.info as { id?: string; time: { created: number; completed: number }; parentID?: string; finish?: string; agent?: string }
    expect(finalInfo.id).toBe('msg_pending:s1:1:1')
    expect(finalInfo.parentID).toBe('msg-user-1')
    expect(finalInfo.finish).toBe('stop')
    expect(finalInfo.agent).toBe('build')
    expect(finalInfo.time.created).toBe(1100)
    expect(finalInfo.time.completed).toBe(2000)
    expect(finalInfo.time.created).toBeLessThan(finalInfo.time.completed)

    const finalTextPart = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'msg_pending:s1:1:1'
      && (event.payload.properties.part as { type?: string }).type === 'text'
      && (event.payload.properties.part as { text?: string }).text === ' the attention mechanism,')
    expect(finalTextPart).toHaveLength(1)
    expect(finalTextPart[0]?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:text:0',
      text: ' the attention mechanism,',
      time: { start: 1100, end: 2000 },
    })
  })

  it('streams reasoning chunks as reasoning parts without an end until the final message', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('reasoning-chunks', [' think'], 1100, 10),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'reasoning', text: ' think' },
        ], 'm-reason', 2000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20, 2100),
      }),
    ])

    const provisionalIndex = events.findIndex((event) =>
      event.payload.type === 'message.updated'
      && String((event.payload.properties.info as { id?: unknown }).id).startsWith('msg_pending:'))
    expect(provisionalIndex).toBeGreaterThanOrEqual(0)
    const firstPart = events.find((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'reasoning')
    expect(firstPart).toBeDefined()
    const part = firstPart?.payload.properties.part as { id: string; text: string; time: { start: number; end?: number } }
    expect(part.text).toBe('')
    expect(part.time.start).toBe(1100)
    expect(part.time.end).toBeUndefined()
    expect(part.id).toBe('prt_stream:s1:1:1:reasoning:0')
    const delta = events.find((event) => event.payload.type === 'message.part.delta')
    expect(delta?.payload.properties).toMatchObject({
      partID: 'prt_stream:s1:1:1:reasoning:0',
      field: 'text',
      delta: ' think',
    })

    const finalPart = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'msg_pending:s1:1:1'
      && (event.payload.properties.part as { type?: string }).type === 'reasoning'
      && (event.payload.properties.part as { text?: string }).text === ' think')
    expect(finalPart).toHaveLength(1)
    expect(finalPart[0]?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:reasoning:0',
      text: ' think',
      time: { start: 1100, end: 1100 },
    })
  })

  it('reuses streamed reasoning/text part ids when the final message follows a text block', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('reasoning-chunks', [' think'], 1100, 10),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' answer'], 1200, 11, 1),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'reasoning', text: ' think' },
          { type: 'text', text: ' answer' },
        ], 'm-reason', 2000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20, 2100),
      }),
    ])

    const finalParts = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'msg_pending:s1:1:1')
    const reasoning = finalParts.find((event) =>
      (event.payload.properties.part as { type?: string }).type === 'reasoning'
      && (event.payload.properties.part as { text?: string }).text === ' think')
    const text = finalParts.find((event) =>
      (event.payload.properties.part as { type?: string }).type === 'text'
      && (event.payload.properties.part as { text?: string }).text === ' answer')
    expect(reasoning?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:reasoning:0',
      text: ' think',
    })
    expect(text?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:text:1',
      text: ' answer',
    })
  })

  it('closes an open reasoning part when the text block starts', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('reasoning-chunks', [' think'], 1100, 10),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' an'], 1500, 11, 1),
      }),
    ])
    const closes = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'reasoning'
      && (event.payload.properties.part as { time?: { end?: number } }).time?.end !== undefined)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:reasoning:0',
      text: ' think',
      time: { start: 1100, end: 1500 },
    })
  })

  it('closes an open reasoning part on turn/end without a final message', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('reasoning-chunks', [' think'], 1100, 10),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'canceled' } }, 20, 2000),
      }),
    ])
    const closes = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'reasoning'
      && (event.payload.properties.part as { time?: { end?: number } }).time?.end !== undefined)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.payload.properties.part).toMatchObject({
      id: 'prt_stream:s1:1:1:reasoning:0',
      text: ' think',
      time: { start: 1100, end: 2000 },
    })
  })

  it('streams raw assistant/chunk text deltas incrementally', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 0, blockType: 'text' },
        }, 5, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'st' },
        }, 6, 1100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 're' },
        }, 7, 1200),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: 'stream' },
        ], 'm-raw', 2000),
      }),
    ])

    const partUpdatedTexts = events
      .filter((event) => event.payload.type === 'message.part.updated')
      .map((event) => (event.payload.properties.part as { text?: string }).text)
    expect(partUpdatedTexts).toEqual(['', 'stream'])
    const deltaTexts = events
      .filter((event) => event.payload.type === 'message.part.delta')
      .map((event) => event.payload.properties.delta)
    expect(deltaTexts).toEqual(['st', 're'])
    const firstPart = events.find((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'text')
    expect(firstPart?.payload.properties.part).toMatchObject({
      type: 'text',
      text: '',
      messageID: 'msg_pending:s1:1:1',
      time: { start: 1000 },
    })
    expect((firstPart?.payload.properties.part as { id: string }).id).toBe('prt_stream:s1:1:1:text:0')
  })

  it('rebuilds complete messages for user/assistant events', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'm1', 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'answer' },
        ], 'm2', 200),
      }),
    ])
    expect(events[0]?.payload.type).toBe('message.updated')
    expect(events[0]?.payload.properties).toMatchObject({ sessionID: 's1', info: { id: 'm1', role: 'user' } })
    expect(events[1]?.payload.type).toBe('message.part.updated')
    expect(events[1]?.payload.properties).toMatchObject({ part: { type: 'text', text: 'hello' } })
    const updated = events.find((event) => event.payload.type === 'message.updated' && event.payload.properties.sessionID === 's1' && (event.payload.properties.info as { id: string }).id === 'm2')
    expect(updated).toBeDefined()
    const types = events.map((event) => event.payload.type)
    expect(types.filter((type) => type === 'message.part.updated')).toHaveLength(3)
  })

  it('pairs tool/call and tool/result as part updates', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
        ], 'm3', 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 't1' as never,
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'done' }] }],
            source: { kind: 'tool', callId: 'c1' as never },
          },
        }, 4, 150),
      }),
    ])
    const toolEvents = events.filter((event) => event.payload.type === 'message.part.updated')
    expect(toolEvents).toHaveLength(2)
    const first = toolEvents[0]?.payload.properties.part as { state: { status: string } }
    expect(first.state.status).toBe('pending')
    const second = toolEvents[1]?.payload.properties.part as {
      state: { status: string; output?: string }
    }
    expect(second.state.status).toBe('completed')
    if (second.state.status === 'completed') {
      expect(second.state.output).toBe('done')
    }
  })

  it('streams tool input deltas and emits the v2 tool lifecycle', () => {
    const flushed: BridgeGlobalEvent[] = []
    let timer: (() => void) | undefined
    const { translate } = translator(new InteractionState(), [], '/work', {
      toolFlushMs: 1000,
      setTimeoutImpl: (callback): { unref?(): unknown } => {
        timer = callback
        return {}
      },
      clearTimeoutImpl: () => {
        timer = undefined
      },
      onFlush: (events) => flushed.push(...events),
    })

    const started = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c1' as never,
            name: 'bash',
            argumentsDelta: '{"command":"echo ',
          },
        }, 2, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c1' as never,
            argumentsDelta: 'hello"}',
          },
        }, 3, 110),
      }),
    ])
    expect(started.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'session.next.tool.input.started',
      'message.part.updated',
    ])
    const provisionalID = (started[0]?.payload.properties as { info: { id: string } }).info.id
    expect(provisionalID).toBe('msg_pending:s1:1:1')
    expect((started[2]?.payload.properties as { part: { messageID: string } }).part.messageID).toBe(provisionalID)
    expect(started[1]?.payload.properties).toMatchObject({
      sessionID: 's1',
      callID: 'c1',
      name: 'bash',
    })
    expect(flushed).toEqual([])

    timer?.()
    expect(flushed.map((event) => event.payload.type)).toEqual([
      'session.next.tool.input.delta',
      'message.part.updated',
    ])
    expect(flushed[0]?.payload.properties).toMatchObject({
      callID: 'c1',
      delta: '{"command":"echo hello"}',
    })

    const done = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c1' as never,
          name: 'bash',
          arguments: '{"command":"echo hello"}',
        }, 4, 120),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 't1' as never,
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'c1' as never,
              content: [{ type: 'text', text: 'hello' }],
            }],
            source: { kind: 'tool', callId: 'c1' as never },
          },
        }, 5, 150),
      }),
    ])
    const types = done.map((event) => event.payload.type)
    expect(types).toContain('session.next.tool.input.ended')
    expect(types).toContain('session.next.tool.called')
    expect(types).toContain('session.next.tool.progress')
    expect(types).toContain('message.part.updated')
    expect(types).toContain('session.next.tool.success')
    expect(done.find((event) => event.payload.type === 'session.next.tool.called')?.payload.properties)
      .toMatchObject({
        callID: 'c1',
        tool: 'bash',
        input: { command: 'echo hello' },
      })
    expect(done.find((event) => event.payload.type === 'session.next.tool.success')?.payload.properties)
      .toMatchObject({
        callID: 'c1',
        content: [{ type: 'text', text: 'hello' }],
        provider: { executed: true },
      })
  })

  it('coalesces bursts of deltas into one delta at tool/call and maps failures', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c2' as never,
            name: 'bash',
            argumentsDelta: '{"command":"',
          },
        }, 2, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c2' as never,
            argumentsDelta: 'fail"}',
          },
        }, 3, 105),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c2' as never,
          name: 'bash',
          arguments: '{"command":"fail"}',
        }, 4, 110),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 't2' as never,
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'c2' as never,
              content: [{ type: 'text', text: '' }],
            }],
            source: { kind: 'tool', callId: 'c2' as never },
          },
          error: { name: 'command exited 1', code: 'TOOL_EXIT_CODE' },
        }, 5, 150),
      }),
    ])
    const deltas = events.filter((event) => event.payload.type === 'session.next.tool.input.delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.payload.properties).toMatchObject({ callID: 'c2', delta: '{"command":"fail"}' })
    const failed = events.find((event) => event.payload.type === 'session.next.tool.failed')
    expect(failed?.payload.properties).toMatchObject({
      callID: 'c2',
      error: { code: 'TOOL_EXIT_CODE', message: 'command exited 1' },
    })
  })

  it('emits started/ended/called immediately for non-streamed tool calls', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c3' as never,
          name: 'read',
          arguments: JSON.stringify({ file_path: '/tmp/a.txt' }),
        }, 2, 100),
      }),
    ])
    const types = events.map((event) => event.payload.type)
    expect(types).toEqual([
      'message.updated',
      'session.next.tool.input.started',
      'session.next.tool.input.ended',
      'session.next.tool.called',
      'session.next.tool.progress',
      'message.part.updated',
    ])
    const messageID = (events[0]?.payload.properties as { info: { id: string } }).info.id
    expect(messageID).toBe('msg_pending:s1:1:1')
    expect((events.at(-1)?.payload.properties as { part: { messageID: string } }).part.messageID).toBe(messageID)
    expect(events.find((event) => event.payload.type === 'session.next.tool.progress')?.payload.properties)
      .toMatchObject({
        callID: 'c3',
        structured: { title: 'read' },
        content: [],
      })
  })

  it('keeps one message id across a streamed tool turn (no duplicate cards)', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c5' as never,
            name: 'bash',
            argumentsDelta: '{"command":"echo hi"}',
          },
        }, 2, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent(
          [{ type: 'tool-call', id: 'c5' as never, name: 'bash', arguments: '{"command":"echo hi"}' }],
          'msg-real-5',
          130,
        ),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c5' as never,
          name: 'bash',
          arguments: '{"command":"echo hi"}',
        }, 4, 140),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 't5' as never,
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'c5' as never,
              content: [{ type: 'text', text: 'hi' }],
            }],
            source: { kind: 'tool', callId: 'c5' as never },
          },
        }, 5, 150),
      }),
    ])
    const partIDs = events
      .filter((event) => event.payload.type === 'message.part.updated')
      .map((event) => (event.payload.properties as { part: { messageID: string } }).part.messageID)
    expect(partIDs.length).toBeGreaterThanOrEqual(2)
    expect(new Set(partIDs).size).toBe(1)
    const messageIDs = events
      .filter((event) => event.payload.type === 'message.updated')
      .map((event) => (event.payload.properties as { info: { id: string } }).info.id)
    expect(messageIDs).toContain(partIDs[0])
    expect(messageIDs).not.toContain('msg-real-5')
  })

  it('emits snapshot/patch parts and session.diff after a file-changing tool', () => {
    const work = gitFixture({ 'src/a.ts': 'const a = 1' })
    const trackedPath = join(work, 'src', 'a.ts')
    const { translate } = translator(new InteractionState(), [], work)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c1' as never,
          name: 'str_replace_editor',
          arguments: JSON.stringify({
            command: 'str_replace',
            path: trackedPath,
            old_str: 'const a = 1',
            new_str: 'const a = 2',
          }),
        }, 3, 100),
        view: {
          for: 'call',
          view: {
            card: 'diff',
            title: `str_replace ${trackedPath}`,
            diffs: [{
              path: trackedPath,
              oldText: 'const a = 1',
              newText: 'const a = 2',
            }],
          },
        },
      }, 'rpc-call'),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 't1' as never,
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'c1' as never,
              content: [{ type: 'text', text: 'Edited' }],
            }],
            source: { kind: 'tool', callId: 'c1' as never },
          },
        }, 4, 150),
        view: {
          for: 'result',
          view: {
            card: 'diff',
            title: `str_replace ${trackedPath}`,
            diffs: [{
              path: trackedPath,
              oldText: 'const a = 1',
              newText: 'const a = 2',
            }],
          },
        },
      }, 'rpc-result'),
    ])

    const partEvents = events.filter((event) => event.payload.type === 'message.part.updated')
    expect(partEvents.map((event) => (event.payload.properties.part as { type?: string }).type)).toEqual([
      'tool',
      'tool',
      'snapshot',
      'patch',
    ])
    expect(partEvents[0]?.payload.properties.part).toMatchObject({
      tool: 'edit',
      state: { status: 'pending' },
    })
    expect(partEvents[1]?.payload.properties.part).toMatchObject({
      tool: 'edit',
      state: {
        status: 'completed',
        metadata: {
          files: [trackedPath],
          command: 'str_replace',
        },
      },
    })
    const patch = partEvents[3]?.payload.properties.part as { type: string; files: string[]; hash: string }
    expect(patch.type).toBe('patch')
    expect(patch.files).toEqual([trackedPath])
    expect(patch.hash).toBeTypeOf('string')

    const diff = events.find((event) => event.payload.type === 'session.diff')
    expect(diff?.payload.properties).toMatchObject({
      sessionID: 's1',
      diff: [{
        file: trackedPath,
        additions: 1,
        deletions: 1,
        status: 'modified',
      }],
    })
  })

  it('maps todo/write to todo.updated', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('todo/write', { todos: [{ content: 'a', status: 'pending' }] }, 1, 100),
      }),
    ])
    expect(events[0]?.payload.type).toBe('todo.updated')
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 's1',
      todos: [{ content: 'a', status: 'pending', priority: 'medium' }],
    })
  })

  it('merges goal/change into todo.updated and keeps the goal across turns', () => {
    const { translate } = translator()
    const goal = {
      goal: {
        id: 'g1',
        revision: 1,
        objective: 'ship the goal feature',
        phase: 'active',
        maxGoalRounds: 5,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 100,
    }
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('todo/write', { todos: [{ content: 'step 1', status: 'in_progress' }] }, 1, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('goal/change', { operation: 'create', ...goal }, 2, 200),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 300),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('todo/write', { todos: [{ content: 'step 2', status: 'pending' }] }, 4, 400),
      }),
    ])
    const todoEvents = events.filter((event) => event.payload.type === 'todo.updated')
    expect(todoEvents).toHaveLength(3)
    expect(todoEvents[1]?.payload.properties).toMatchObject({
      sessionID: 's1',
      todos: [
        { id: 'goal:g1', content: 'Goal: ship the goal feature', status: 'in_progress', priority: 'high' },
        { content: 'step 1', status: 'in_progress', priority: 'medium' },
      ],
    })
    // turn/end resets stream state but not the goal/todo merge cache.
    expect(todoEvents[2]?.payload.properties).toMatchObject({
      sessionID: 's1',
      todos: [
        { content: 'Goal: ship the goal feature', status: 'in_progress' },
        { content: 'step 2', status: 'pending' },
      ],
    })
  })

  it('maps a goal clear tombstone back to plain todos', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('goal/change', {
          operation: 'create',
          goal: {
            id: 'g1',
            revision: 1,
            objective: 'temp',
            phase: 'active',
            maxGoalRounds: 5,
          },
        }, 1, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('goal/change', {
          operation: 'clear',
          cleared: { id: 'g1', revision: 2 },
          clearedAt: 200,
        }, 2, 200),
      }),
    ])
    expect(events[1]?.payload.properties).toMatchObject({
      sessionID: 's1',
      todos: [],
    })
  })

  it('emits session.updated for created/title events when they arrive', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('session/created', {}, 1, 100),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('session/title', { title: 'Titled' }, 2, 200),
      }),
    ])
    expect(events[0]?.payload.type).toBe('session.updated')
    expect((events[0]?.payload.properties.info as { id: string }).id).toBe('s1')
    expect((events[1]?.payload.properties.info as { title: string }).title).toBe('Titled')
  })

  it('keeps the real session agent across title/projection updates', () => {
    const state = new InteractionState()
    state.setSessionAgent('s1', 'standard')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('session/title', { title: 'Titled' }, 2, 200),
      }),
    ])
    expect((events[0]?.payload.properties.info as { agent?: string }).agent).toBe('standard')
  })

  it('marks run input activity on user messages but not bare session creation', () => {
    const created = new InteractionState()
    const createdTranslate = translator(created).translate
    createdTranslate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('session/created', {}, 1, 100),
      }),
    ])
    expect(created.newInputDuringRun).toBe(false)

    const input = new InteractionState()
    const inputTranslate = translator(input).translate
    inputTranslate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello'),
      }),
    ])
    expect(input.newInputDuringRun).toBe(true)
  })

  it('emits a child session header with parent and directory', () => {
    const state = new InteractionState()
    state.sessionParents.set('child', 'parent')
    state.sessionDirectories.set('child', '/child-work')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 'child' as never,
        event: sessionEvent('session', {
          id: 'child',
          createdAt: 500,
          cwd: '/child-work',
        }, 1, 500),
      }),
    ])
    expect(events[0]?.payload.type).toBe('session.updated')
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 'child',
      info: {
        id: 'child',
        directory: '/child-work',
        parentID: 'parent',
        time: { created: 500 },
      },
    })
    expect(events[0]?.directory).toBe('/child-work')
  })

  it('uses the session directory when known and logs unknown events', () => {
    const state = new InteractionState()
    state.sessionDirectories.set('s1', '/other')
    const logs: string[] = []
    const events = new MuxEventTranslator({ cwd: '/work', state, log: (m) => logs.push(m) })
      .translate(frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('totally-unknown-event' as never, { value: 1 }, 1, 100),
      }))
    expect(events).toEqual([])
    expect(logs.some((line) => line.includes('totally-unknown-event'))).toBe(true)
    const status = new MuxEventTranslator({ cwd: '/work', state, log: () => {} })
      .translate(frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/start', { turn: 1 }, 2, 100),
      }))
    expect(status[0]?.directory).toBe('/other')
  })
})

describe('bridge events: approval/question frames', () => {
  it('registers and emits permission.asked, then replied on resolution', () => {
    const { translate, state } = translator()
    const asked = translate([
      frame({
        type: 'approval/requested',
        sessionId: 's1' as never,
        approvalId: 'a1' as never,
        toolName: 'bash',
        callId: 'c1' as never,
        reason: 'run',
      }, 'rpc-a1'),
    ])
    expect(asked[0]?.payload.type).toBe('permission.asked')
    const request = asked[0]?.payload.properties as { id: string; sessionID: string; permission: string }
    expect(request).toMatchObject({ sessionID: 's1', permission: 'bash' })
    expect(state.permissions.size).toBe(1)
    const replied = translate([
      frame({
        type: 'approval/resolved',
        sessionId: 's1' as never,
        approvalId: 'a1' as never,
        outcome: 'allowed-once',
      }, 'rpc-a1'),
    ])
    expect(replied[0]?.payload.type).toBe('permission.replied')
    expect(replied[0]?.payload.properties).toEqual({
      sessionID: 's1',
      requestID: request.id,
      reply: 'once',
    })
    expect(state.permissions.size).toBe(0)
  })

  it('registers and emits question.asked, replied and rejected', () => {
    const { translate, state } = translator()
    const asked = translate([
      frame({
        type: 'question/requested',
        sessionId: 's1' as never,
        questions: [{ id: 'dq1', question: 'Go?', options: [{ label: 'Yes' }] }],
      }, 'rpc-q1'),
    ])
    expect(asked[0]?.payload.type).toBe('question.asked')
    const request = asked[0]?.payload.properties as { id: string; sessionID: string; questions: unknown[] }
    expect(request.questions).toHaveLength(1)

    const replied = translate([
      frame({
        type: 'question/resolved',
        sessionId: 's1' as never,
        questionRpcId: 'rpc-q1' as never,
        outcome: 'answered',
      }, 'rpc-q1'),
    ])
    expect(replied[0]?.payload.type).toBe('question.replied')
    expect(replied[0]?.payload.properties).toMatchObject({ sessionID: 's1', requestID: request.id })
    expect(state.questions.size).toBe(0)

    translate([
      frame({
        type: 'question/requested',
        sessionId: 's1' as never,
        questions: [{ id: 'dq2', question: 'No?', options: [{ label: 'N' }] }],
      }, 'rpc-q2'),
    ])
    const rejected = translate([
      frame({
        type: 'question/resolved',
        sessionId: 's1' as never,
        questionRpcId: 'rpc-q2' as never,
        outcome: 'cancelled',
      }, 'rpc-q2'),
    ])
    expect(rejected[0]?.payload.type).toBe('question.rejected')
  })
})

describe('bridge events: projection and control frames', () => {
  it('maps todos and produced-files projections', () => {
    const work = gitFixture({ 'a.ts': 'x' })
    const { translate } = translator(new InteractionState(), [], work)
    const events = translate([
      frame({
        type: 'session/projection',
        sessionId: 's1' as never,
        key: 'todos',
        value: [{ content: 'x', status: 'pending' }],
        seq: 1,
      }),
      frame({
        type: 'session/projection',
        sessionId: 's1' as never,
        key: 'produced-files',
        value: [{ file: 'a.ts', additions: 2, deletions: 1, status: 'modified' }],
        seq: 2,
      }),
    ])
    expect(events[0]?.payload.type).toBe('todo.updated')
    expect(events[1]?.payload.type).toBe('session.diff')
    expect(events[1]?.payload.properties).toMatchObject({
      sessionID: 's1',
      diff: [{ file: 'a.ts', additions: 2, deletions: 1, status: 'modified' }],
    })
  })

  it('maps a goal projection to merged todo.updated', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/projection',
        sessionId: 's1' as never,
        key: 'goal',
        value: {
          goal: {
            id: 'g1',
            revision: 1,
            objective: 'finish the goal',
            phase: 'active',
            maxGoalRounds: 5,
          },
          roundsStarted: 0,
          createdAt: 100,
          updatedAt: 100,
        },
        seq: 1,
      }),
    ])
    expect(events[0]?.payload.type).toBe('todo.updated')
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 's1',
      todos: [{ id: 'goal:g1', content: 'Goal: finish the goal', status: 'in_progress', priority: 'high' }],
    })
  })

  it('normalizes produced-files patch/status into SnapshotFileDiff', () => {
    const work = gitFixture({ 'src/new.ts': 'hello\n' })
    const { translate } = translator(new InteractionState(), [], work)
    const events = translate([
      frame({
        type: 'session/projection',
        sessionId: 's1' as never,
        key: 'produced-files',
        value: [{
          file: 'src/new.ts',
          patch: '--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\n',
          additions: 1,
          deletions: 0,
        }],
        seq: 2,
      }),
    ])
    expect(events[0]?.payload.properties.diff).toEqual([{
      file: 'src/new.ts',
      patch: '--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\n',
      additions: 1,
      deletions: 0,
      status: 'modified',
    }])
  })

  it('ignores control frames and maps stream errors to session.error', () => {
    const logs: string[] = []
    const events = new MuxEventTranslator({ cwd: '/work', state: new InteractionState(), log: (m) => logs.push(m) })
      .translate(frame({
        type: 'session/subscribed',
        sessionId: 's1' as never,
        lastSeq: 0,
      }))
    expect(events).toEqual([])
    const ignored = new MuxEventTranslator({ cwd: '/work', state: new InteractionState(), log: (m) => logs.push(m) })
      .translate(frame({
        type: 'session/queue',
        sessionId: 's1' as never,
        items: [],
      }))
    expect(ignored).toEqual([])
    const errored = new MuxEventTranslator({ cwd: '/work', state: new InteractionState(), log: (m) => logs.push(m) })
      .translate(frame({
        type: 'stream/error',
        error: { code: 'internal', message: 'boom', details: {} },
      }))
    expect(errored).toHaveLength(1)
    expect(errored[0]?.payload.type).toBe('session.error')
    expect(errored[0]?.payload.properties).toMatchObject({
      error: { name: 'UnknownError', data: { message: 'boom' } },
    })
    expect(logs.some((line) => line.includes('stream/error'))).toBe(true)
  })

  it('maps dsh error codes to the official session.error union shape', () => {
    const aborted = opencodeError('aborted', 'turn aborted')
    expect(aborted).toEqual({ name: 'MessageAbortedError', data: { message: 'turn aborted' } })
    const auth = opencodeError('invalid_api_key', 'bad key')
    expect(auth).toEqual({
      name: 'ProviderAuthError',
      data: { providerID: 'deepseek', message: 'bad key' },
    })
    const generic = opencodeError('internal', 'boom')
    expect(generic).toEqual({ name: 'UnknownError', data: { message: 'boom' } })
  })

  it('surfaces pending inbox messages as queued user messages from the queue snapshot', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/queue',
        sessionId: 's1' as never,
        items: [{
          id: 'queued-1' as never,
          placement: 'queued',
          message: {
            id: 'queued-1' as never,
            role: 'user',
            content: [{ type: 'text', text: 'hello from queue' }],
            source: { kind: 'user' },
          },
        }],
      }),
    ])
    expect(events.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
    ])
    expect(events[0]?.payload.properties).toMatchObject({
      sessionID: 's1',
      info: {
        id: 'queued-1',
        role: 'user',
        sessionID: 's1',
        time: { created: expect.any(Number) },
      },
    })
    expect(events[1]?.payload.properties).toMatchObject({
      sessionID: 's1',
      part: {
        id: 'queued-1:0',
        messageID: 'queued-1',
        type: 'text',
        text: 'hello from queue',
      },
    })
  })

  it('does not re-emit a user message already surfaced from the queue', () => {
    const { translate } = translator()
    const queued = translate([
      frame({
        type: 'session/queue',
        sessionId: 's1' as never,
        items: [{
          id: 'queued-1' as never,
          placement: 'queued',
          message: {
            id: 'queued-1' as never,
            role: 'user',
            content: [{ type: 'text', text: 'hello from queue' }],
            source: { kind: 'user' },
          },
        }],
      }),
    ])
    expect(queued).toHaveLength(2)

    const durable = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello from queue', 'queued-1', 1500),
      }),
    ])
    expect(durable).toEqual([])

    const fresh = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('second prompt', 'queued-2', 1600),
      }),
    ])
    expect(fresh.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
    ])
    expect(fresh[0]?.payload.properties).toMatchObject({
      info: { id: 'queued-2' },
    })
  })

  it('skips the durable echo for prompts already broadcast by the route', () => {
    const state = new InteractionState()
    state.registerPromptMessageId('s1', 'msg_tui_1')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'dsh-msg-1', 1500),
      }),
    ])
    expect(events).toEqual([])
    expect(state.promptIdForDshId('s1', 'dsh-msg-1')).toBe('msg_tui_1')
  })

  it('stays silent when dsh re-broadcasts a user message after the route echo', () => {
    const state = new InteractionState()
    state.registerPromptMessageId('s1', 'msg_tui_1')
    const { translate } = translator(state)
    const first = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'dsh-msg-1', 1500),
      }),
    ])
    expect(first).toEqual([])

    const replay = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'dsh-msg-1', 1600),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: 'answer' },
        ], 'dsh-asst-1', 1700),
      }),
    ])
    expect(replay.filter((event) => event.payload.type === 'message.updated' && (event.payload.properties.info as { role?: string }).role === 'user'))
      .toEqual([])
    const assistant = replay.find((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { role?: string }).role === 'assistant')
    // The assistant still parents to the bridge user id, not the dsh id.
    expect(assistant?.payload.properties).toMatchObject({
      info: { parentID: 'msg_tui_1' },
    })
  })

  it('reuses the prompt placeholder assistant id for the streamed reply', () => {
    const state = new InteractionState()
    state.registerAssistantIdForUser('s1', 'msg-user-1', 'msg_assistant_1')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: 'answer' },
        ], 'dsh-asst-1', 1100),
      }),
    ])
    const assistant = events.find((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { role?: string }).role === 'assistant')
    expect(assistant?.payload.properties).toMatchObject({
      info: { id: 'msg_assistant_1', parentID: 'msg-user-1' },
    })
    const part = events.find((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'msg_assistant_1')
    expect(part?.payload.properties.part).toMatchObject({
      messageID: 'msg_assistant_1',
      id: 'msg_assistant_1:0',
    })
    expect(state.assistantIdForDshId('s1', 'dsh-asst-1')).toBe('msg_assistant_1')
  })

  it('keeps the placeholder assistant id across streamed chunks', () => {
    const state = new InteractionState()
    state.registerAssistantIdForUser('s1', 'msg-user-2', 'msg_assistant_2')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-2', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'text-delta',
            index: 0,
            text: 'answ',
          },
        }, 2, 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: 'answer' },
        ], 'dsh-asst-2', 1100),
      }),
    ])
    const updates = events.filter((event) => event.payload.type === 'message.updated')
    const assistantIds = updates
      .map((event) => (event.payload.properties.info as { id?: string }).id)
      .filter((id) => id?.startsWith('msg_assistant_2'))
    // start update + completion reset (completed=no) + final completion.
    expect(assistantIds).toEqual(['msg_assistant_2', 'msg_assistant_2', 'msg_assistant_2'])
    const streamedPart = events.find((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'text'
      && (event.payload.properties.part as { text?: string }).text === 'answer')
    expect(streamedPart?.payload.properties.part).toMatchObject({
      messageID: 'msg_assistant_2',
    })
    expect(state.assistantIdForDshId('s1', 'dsh-asst-2')).toBe('msg_assistant_2')
  })

  it('keeps the real user anchor when dsh injects a plugin context message', () => {
    const state = new InteractionState()
    state.registerAssistantIdForUser('s1', 'msg-user-1', 'msg_turn_1')
    const { translate } = translator(state)
    translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('user/message', {
          id: 'ctx-1' as never,
          content: [{ type: 'text', text: 'Current runtime context' }],
          source: { kind: 'plugin', plugin: 'fs' },
        }, 4, 950),
      }),
    ])
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'text', text: 'answer' },
        ], 'dsh-asst-ctx', 1000),
      }),
    ])
    const assistant = events.find((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { role?: string }).role === 'assistant')
    // The plugin context must not hijack the parent anchor: the reply still
    // reuses the bridge id registered for the real user prompt.
    expect(assistant?.payload.properties).toMatchObject({
      info: { id: 'msg_turn_1', parentID: 'msg-user-1' },
    })
  })

  it('gives the follow-up step its own message id for recoverable history', () => {
    const state = new InteractionState()
    state.registerAssistantIdForUser('s1', 'msg-user-1', 'msg_turn_1')
    const { translate } = translator(state)
    const stepOne = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      // Step 1: a streamed tool-call opens the turn message.
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c1' as never,
            name: 'bash',
            argumentsDelta: '{}',
          },
        }, 3, 950),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
        ], 'dsh-asst-1', 1000),
      }),
    ])
    const stepOneUpdates = stepOne.filter((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'msg_turn_1')
    expect(stepOneUpdates).toHaveLength(2)

    // Step 2: the follow-up text belongs to the same user turn/message; its
    // chunk stream must not reopen the already-open message card.
    const stepTwo = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' answer'], 1100, 11, 0, 1, 2),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/message', {
          turn: 1,
          step: 2,
          message: {
            id: 'dsh-asst-2' as never,
            role: 'assistant',
            content: [{ type: 'text', text: ' answer' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          },
        }, 12, 1200),
      }),
    ])
    const stepTwoUpdates = stepTwo.filter((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'msg_turn_1')
    // The follow-up gets a fresh provisional id so live and restarted
    // history views keep the same message structure (the in-memory bridge id
    // mapping is not durable across processes).
    expect(stepTwoUpdates.map((event) => (event.payload.properties.info as { id?: string }).id))
      .toEqual([])
    const followUpIds = stepTwo
      .filter((event) => event.payload.type === 'message.updated')
      .map((event) => (event.payload.properties.info as { id?: string }).id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('msg_pending:s1:1:2'))
    expect(followUpIds.length).toBeGreaterThan(0)
    const textParts = [...stepOne, ...stepTwo].filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { type?: string }).type === 'text'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'msg_turn_1')
    for (const event of textParts) {
      expect((event.payload.properties.part as { messageID?: string }).messageID).toBe('msg_turn_1')
    }
    expect(state.assistantIdForDshId('s1', 'dsh-asst-1')).toBe('msg_turn_1')
    expect(state.assistantIdForDshId('s1', 'dsh-asst-2')).not.toBe('msg_turn_1')
  })

  it('skips queue surfacing for TUI-submitted prompts with a local card', () => {
    const state = new InteractionState()
    state.registerPromptMessageId('s1', 'msg_tui_2')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/queue',
        sessionId: 's1' as never,
        items: [{
          id: 'dsh-msg-2' as never,
          placement: 'queued',
          message: {
            id: 'dsh-msg-2' as never,
            role: 'user',
            content: [{ type: 'text', text: 'queued prompt' }],
            source: { kind: 'user' },
          },
        }],
      }),
    ])
    expect(events).toEqual([])
  })

  it('does not resurface queue snapshot messages already seen', () => {
    const { translate } = translator()
    const queue = () => frame({
      type: 'session/queue',
      sessionId: 's1' as never,
      items: [{
        id: 'queued-1' as never,
        placement: 'queued',
        message: {
          id: 'queued-1' as never,
          role: 'user',
          content: [{ type: 'text', text: 'hello from queue' }],
          source: { kind: 'user' },
        },
      }],
    })
    expect(translate([queue()])).toHaveLength(2)
    expect(translate([queue()])).toEqual([])
  })

  it('surfaces inbox splice insertions and keeps claimed messages visible', () => {
    const { translate } = translator()
    const inserted = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent/inbox/spliced', {
          target: 'next-turn',
          start: 2,
          inserted: [{
            id: 'queued-2',
            role: 'user',
            content: [{ type: 'text', text: 'second prompt' }],
            source: { kind: 'user' },
          }],
        }, 10, 2000),
      }),
    ])
    expect(inserted.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
    ])
    expect(inserted[0]?.payload.properties).toMatchObject({
      info: { id: 'queued-2', time: { created: 2000 } },
    })

    // claim: a removal without outcome must not hide the queued message
    const claimed = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
        }, 11, 3000),
      }),
    ])
    expect(claimed).toEqual([])
  })

  it('hides cancelled inbox messages and ignores non-user insertions', () => {
    const { translate } = translator()
    translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [{
            id: 'queued-3',
            role: 'user',
            content: [{ type: 'text', text: 'cancel me' }],
            source: { kind: 'user' },
          }],
        }, 20, 4000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent/inbox/spliced', {
          target: 'next-step',
          start: 0,
          inserted: [{
            id: 'injected-1',
            role: 'user',
            content: [{ type: 'text', text: 'file changed' }],
            source: { kind: 'plugin', plugin: 'fs' },
          }],
        }, 21, 4100),
      }),
    ])
    const cancelled = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        }, 22, 4200),
      }),
    ])
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.payload).toMatchObject({
      type: 'message.removed',
      properties: { sessionID: 's1', messageID: 'queued-3' },
    })
  })

  it('streams packed tool-call-chunks rows from history replay', () => {
    const flushed: BridgeGlobalEvent[] = []
    let timer: (() => void) | undefined
    const { translate } = translator(new InteractionState(), [], '/work', {
      toolFlushMs: 1000,
      setTimeoutImpl: (callback): { unref?(): unknown } => {
        timer = callback
        return {}
      },
      clearTimeoutImpl: () => {
        timer = undefined
      },
      onFlush: (events) => flushed.push(...events),
    })

    const started = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('tool-call-chunks' as never, {
          turn: 1,
          step: 1,
          index: 0,
          id: 'c4' as never,
          name: 'bash',
          args: ['{"command":"echo ', 'packed"}'],
        }, 2, 100),
      }),
    ])
    expect(started.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'session.next.tool.input.started',
      'message.part.updated',
    ])
    timer?.()
    expect(flushed.map((event) => event.payload.type)).toEqual([
      'session.next.tool.input.delta',
      'message.part.updated',
    ])
    expect(flushed[0]?.payload.properties).toMatchObject({
      callID: 'c4',
      delta: '{"command":"echo packed"}',
    })
  })

  it('keeps tool-call assistants incomplete until the turn ends', () => {
    const { translate } = translator()
    const assistant = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          {
            type: 'tool-call',
            id: 'call-1',
            name: 'bash',
            arguments: '{}',
          },
        ], 'assistant-tool-1', 5000),
      }),
    ])
    const info = assistant[1]?.payload.properties.info as { time?: { completed?: number } }
    expect(assistant.map((event) => event.payload.type)).toEqual([
      'message.part.updated',
      'message.updated',
    ])
    expect(info.time).toMatchObject({ created: 5000 })
    expect(info.time?.completed).toBeUndefined()

    // step/end must not complete the message: a follow-up step of the same
    // turn may still stream parts under this message id.
    const stepEnded = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('step/end', { turn: 1, step: 1 }, 12, 6000),
      }),
    ])
    expect(stepEnded).toEqual([])

    const ended = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 13, 6500),
      }),
    ])
    const completion = ended.find((event) => event.payload.type === 'message.updated')
    expect(completion?.payload).toMatchObject({
      type: 'message.updated',
      properties: {
        sessionID: 's1',
        info: { id: 'assistant-tool-1', time: { created: 5000, completed: 6500 } },
      },
    })
  })

  it('completes every tool-call assistant when a turn has several', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('run tools', 'msg-user-1', 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/message', {
          turn: 1,
          step: 1,
          message: {
            id: 'dsh-tool-1' as never,
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          },
        }, 3, 1500),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/message', {
          turn: 1,
          step: 2,
          message: {
            id: 'dsh-tool-2' as never,
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'c2' as never, name: 'bash', arguments: '{}' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          },
        }, 4, 1600),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20, 2000),
      }),
    ])

    const updates = events.filter((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { role?: string }).role === 'assistant'
      && (event.payload.properties.info as { id?: string }).id !== undefined)
    const completed = updates.map((event) => {
      const info = event.payload.properties.info as { id: string; time?: { completed?: number } }
      return { id: info.id, completed: info.time?.completed }
    })
    // Both tool-call assistants must receive their completion at turn/end,
    // not only the last one (single-slot pending regression).
    expect(completed.filter((entry) => entry.completed === 2000).map((entry) => entry.id).sort())
      .toEqual(['dsh-tool-1', 'dsh-tool-2'])
  })

  it('does not re-complete a turn message finalized by a follow-up step', () => {
    const state = new InteractionState()
    state.registerAssistantIdForUser('s1', 'msg-user-1', 'msg_turn_1')
    const { translate } = translator(state)
    const events = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeUserEvent('hello', 'msg-user-1', 900),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: {
            type: 'tool-call-delta',
            index: 0,
            id: 'c1' as never,
            name: 'bash',
            argumentsDelta: '{}',
          },
        }, 3, 950),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: makeAssistantEvent([
          { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
        ], 'dsh-asst-1', 1000),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', [' answer'], 1100, 11, 0, 1, 2),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('assistant/message', {
          turn: 1,
          step: 2,
          message: {
            id: 'dsh-asst-2' as never,
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          },
        }, 12, 1200),
      }),
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20, 1300),
      }),
    ])
    const updates = events.filter((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'msg_turn_1')
    // Opening update + tool-call finalize (completed unset) + turn/end
    // completion. The follow-up step owns its own message id, so it cannot
    // finalize the tool message.
    expect(updates).toHaveLength(3)
    const completions = updates
      .map((event) => (event.payload.properties.info as { time?: { completed?: number } }).time?.completed)
      .filter((value): value is number => value !== undefined)
    expect(completions).toEqual([1300])

    // The skipped pending completion must be discarded, not deferred: a later
    // turn/end must not emit a stale completion for the already-finalized id.
    const nextTurn = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, 30, 2000),
      }),
    ])
    const stale = nextTurn.filter((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'msg_turn_1')
    expect(stale).toEqual([])
  })

  it('closes provisional messages on turn/end after an interrupt', () => {
    const { translate } = translator()
    translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: chunkRow('text-chunks', ['partial '], 100, 1, 0, 1, 1),
      }),
    ])
    const ended = translate([
      frame({
        type: 'session/event',
        sessionId: 's1' as never,
        event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 2, 200),
      }),
    ])
    const updated = ended.filter((event) => event.payload.type === 'message.updated')
    expect(updated.length).toBeGreaterThan(0)
    const info = updated[updated.length - 1]?.payload.properties.info as {
      id?: string
      role?: string
      time?: { created?: number; completed?: number }
    }
    expect(info).toMatchObject({
      role: 'assistant',
      time: { completed: 200 },
    })
    expect(info.id).toMatch(/^msg_pending:/)
  })

  it('dedupes replayed approval and question frames per SSE connection', () => {
    const state = new InteractionState()
    const guard = { approvals: new Set<string>(), questions: new Set<string>() }
    const instance = new MuxEventTranslator({
      cwd: '/work',
      state,
      log: () => {},
      replayGuard: guard,
    })

    const approvalFrame = frame({
      type: 'approval/requested',
      sessionId: 's1' as never,
      approvalId: 'a1' as never,
      toolName: 'bash',
      callId: 'c1' as never,
    }, 'rpc-approval')
    const firstApproval = instance.translate(approvalFrame)
    expect(firstApproval.map((event) => event.payload.type)).toContain('permission.asked')
    expect(instance.translate(approvalFrame)).toEqual([])
    expect(state.permissions.size).toBe(1)

    const questionFrame = frame({
      type: 'question/requested',
      sessionId: 's1' as never,
      questions: [{ id: 'q1', question: 'pick one', options: [] }],
    }, 'rpc-question')
    const firstQuestion = instance.translate(questionFrame)
    expect(firstQuestion.map((event) => event.payload.type)).toContain('question.asked')
    expect(instance.translate(questionFrame)).toEqual([])
    expect(state.questions.size).toBe(1)
  })

  it('dedupes replayed text-chunks and assistant/chunk frames per SSE connection', () => {
    const state = new InteractionState()
    const guard = {
      approvals: new Set<string>(),
      questions: new Set<string>(),
      chunks: new Set<string>(),
    }
    const instance = new MuxEventTranslator({
      cwd: '/work',
      state,
      log: () => {},
      replayGuard: guard,
    })

    const packed = frame({
      type: 'session/event',
      sessionId: 's1' as never,
      event: chunkRow('text-chunks', [' the'], 1100, 10),
    })
    const firstPacked = instance.translate(packed)
    expect(firstPacked.map((event) => event.payload.type)).toContain('message.part.delta')
    expect(instance.translate(packed)).toEqual([])

    const raw = frame({
      type: 'session/event',
      sessionId: 's1' as never,
      event: sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'x' },
      }, 11, 1200),
    })
    const firstRaw = instance.translate(raw)
    expect(firstRaw.map((event) => event.payload.type)).toContain('message.part.delta')
    expect(instance.translate(raw)).toEqual([])
  })

  it('dedupes replayed text chunks across translator rebuilds (mux resubscribe)', () => {
    const state = new InteractionState()
    const guard = {
      approvals: new Set<string>(),
      questions: new Set<string>(),
      chunks: new Set<string>(),
    }
    const makeTranslator = () => new MuxEventTranslator({
      cwd: '/work',
      state,
      log: () => {},
      replayGuard: guard,
    })

    const replayRow = chunkRow('text-chunks', ['part-one '], 1100, 10)
    const replayFrame = frame({
      type: 'session/event',
      sessionId: 's1' as never,
      event: replayRow,
    })
    const first = makeTranslator()
    const firstEvents = first.translate(replayFrame)
    expect(firstEvents.map((event) => event.payload.type)).toContain('message.part.delta')
    expect(firstEvents.map((event) => event.payload.properties.delta).join('')).toContain('part-one')

    // The mux stream dies and is re-subscribed; dsh replays the same prefix.
    // The replay guard is connection-scoped, so the rebuilt translator must
    // skip the replayed row instead of emitting the delta twice.
    const second = makeTranslator()
    expect(second.translate(replayFrame)).toEqual([])

    const nextRow = chunkRow('text-chunks', ['part-two'], 1200, 11)
    const nextEvents = second.translate(frame({
      type: 'session/event',
      sessionId: 's1' as never,
      event: nextRow,
    }))
    expect(nextEvents.map((event) => event.payload.type)).toContain('message.part.delta')
    expect(nextEvents.map((event) => event.payload.properties.delta).join('')).toContain('part-two')
  })

  it('shares todo/goal projection state across translator rebuilds', () => {
    const shared = { todos: new Map<string, unknown>(), goals: new Map<string, unknown>() }
    const deps = { cwd: '/work', state: new InteractionState(), log: () => {}, sharedState: shared }

    const first = new MuxEventTranslator(deps)
    first.translate(frame({
      type: 'session/projection',
      sessionId: 's1' as never,
      key: 'todos',
      value: [{ content: 'keep me', status: 'pending' }],
      seq: 1,
    }))

    const second = new MuxEventTranslator(deps)
    const events = second.translate(frame({
      type: 'session/projection',
      sessionId: 's1' as never,
      key: 'goal',
      value: null,
      seq: 2,
    }))
    const todo = events.find((event) => event.payload.type === 'todo.updated')
    expect(todo?.payload.properties).toMatchObject({
      todos: expect.arrayContaining([expect.objectContaining({ content: 'keep me' })]),
    })
  })
})

describe('bridge events: SSE connection lifecycle', () => {
  const servers: BridgeServerHandle[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it('buffers enqueued events until the first client connects', () => {
    const hub = new SseHub(() => {})
    const written: string[] = []
    const fakeRes = {
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      on: () => fakeRes,
      destroyed: false,
    }
    const event: BridgeGlobalEvent = {
      directory: '/work',
      payload: {
        id: 'e1',
        type: 'session.updated',
        properties: { sessionID: 's1' },
        data: {},
      },
    }
    hub.enqueue([event])
    expect(written).toEqual([])

    const client = hub.add(fakeRes as never)
    expect(written.join('')).toContain('session.updated')
    expect(written.join('')).toContain('"id":"e1"')

    // With a connected client, enqueue broadcasts immediately.
    hub.enqueue([{ ...event, payload: { ...event.payload, id: 'e2' } }])
    expect(written.join('')).toContain('"id":"e2"')
    hub.remove(client)
  })

  it('streams events and cleans up the mux consumer on disconnect', async () => {
    let aborted!: Promise<void>
    let started = false
    const base = fakeApi()
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          started = true
          aborted = new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
          yield frame({
            type: 'session/event',
            sessionId: 's1' as never,
            event: sessionEvent('turn/start', { turn: 1 }, 1, 100),
          }, 'rpc-stream')
          await aborted
        },
      },
    }
    const router = createBridgeRouter(api as never, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (reader && !text.includes('session.status')) {
      const { done, value } = await reader.read()
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('retry: 3000')
    expect(text).toContain('session.status')
    expect(router.ctx.hub.size).toBe(1)
    controller.abort()
    await aborted
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(router.ctx.hub.size).toBe(0)
    expect(started).toBe(true)
  })

  it('surfaces host agent errors as session.error events', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
        host: async function* () {
          yield {
            rpcId: 'rpc-host' as never,
            payload: { type: 'host/agent-error', sessionId: 's1', message: 'agent crashed' },
          }
        },
      },
    }
    const router = createBridgeRouter(api as never, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (reader && !text.includes('session.error')) {
      const { done, value } = await reader.read()
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('"type":"session.error"')
    expect(text).toContain('"sessionID":"s1"')
    expect(text).toContain('agent crashed')
    controller.abort()
  })

  it('auto-approves matching requests after an always grant', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const responses: Array<{ rpcId: string; outcome?: string }> = []
    const base = fakeApi()
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          yield {
            rpcId: 'rpc-1' as never,
            payload: {
              type: 'approval/requested',
              sessionId: 's1',
              approvalId: 'a1',
              toolName: 'bash',
              callId: 'c1',
            },
          }
          await gate
          yield {
            rpcId: 'rpc-2' as never,
            payload: {
              type: 'approval/requested',
              sessionId: 's1',
              approvalId: 'a2',
              toolName: 'bash',
              callId: 'c2',
            },
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
      },
      respond: async (request: { rpcId?: unknown; result?: { value?: { outcome?: string } } }) => {
        responses.push({
          rpcId: String(request.rpcId),
          outcome: request.result?.value?.outcome,
        })
        return { accepted: true }
      },
    }
    const router = createBridgeRouter(api as never, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (reader && !text.includes('permission.asked')) {
      const { done, value } = await reader.read()
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    const id = /"type":"permission\.asked".*?"id":"([^"]+)"/s.exec(text)?.[1] ?? ''
    expect(id).toBeTruthy()

    const reply = await fetch(server.url + `/permission/${id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'always' }),
    })
    expect(reply.status).toBe(200)

    const saved = await (await fetch(server.url + '/api/permission/saved')).json() as {
      data: Array<{ id: string; sessionID: string; action: string; resource: string }>
    }
    expect(saved.data).toEqual([{
      id: 's1:bash',
      projectID: expect.any(String),
      action: 'bash',
      resource: 'bash',
      sessionID: 's1',
      grantedAt: expect.any(Number),
    }])

    release()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(responses).toHaveLength(2)
    expect(responses[1]?.outcome).toBe('allowed-once')
    controller.abort()
  })

  it('does not block the mux loop on session list refresh', async () => {
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    const base = fakeApi()
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => {
          await listGate
          return okRpc({ items: [] })
        },
      },
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          yield {
            rpcId: 'rpc-title' as never,
            payload: {
              type: 'session/event',
              sessionId: 's1',
              event: sessionEvent('session/title', { title: 't' }, 1, 100),
            },
          }
          yield {
            rpcId: 'rpc-turn' as never,
            payload: {
              type: 'session/event',
              sessionId: 's1',
              event: sessionEvent('turn/start', { turn: 1 }, 2, 200),
            },
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
      },
    }
    const router = createBridgeRouter(api as never, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !text.includes('session.status')) {
      const { done, value } = await reader?.read() ?? { done: true, value: undefined }
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('session.status')
    releaseList()
    controller.abort()
  })

  it('retries a transient mux stream error with backoff', async () => {
    let subscriptions = 0
    let threw = false
    const base = fakeApi()
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          subscriptions += 1
          if (!threw) {
            threw = true
            throw new Error('transient mux failure')
          }
          yield {
            rpcId: 'rpc-turn' as never,
            payload: {
              type: 'session/event',
              sessionId: 's1',
              event: sessionEvent('turn/start', { turn: 1 }, 1, 100),
            },
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
      },
    }
    const router = createBridgeRouter(api as never, {
      cwd: '/work',
      sseRetryBaseMs: 10,
      sseRetryMaxAttempts: 3,
    })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !text.includes('session.status')) {
      const { done, value } = await reader?.read() ?? { done: true, value: undefined }
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('session.status')
    expect(subscriptions).toBe(2)
    controller.abort()
  })

  it('retries a transient host stream error', async () => {
    let subscriptions = 0
    let threw = false
    const base = fakeApi()
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
        host: async function* () {
          subscriptions += 1
          if (!threw) {
            threw = true
            throw new Error('transient host failure')
          }
          yield {
            rpcId: 'rpc-host' as never,
            payload: { type: 'host/agent-error', sessionId: 's1', message: 'after retry' },
          }
        },
      },
    }
    const router = createBridgeRouter(api as never, {
      cwd: '/work',
      sseRetryBaseMs: 10,
      sseRetryMaxAttempts: 3,
    })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !text.includes('after retry')) {
      const { done, value } = await reader?.read() ?? { done: true, value: undefined }
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('after retry')
    expect(subscriptions).toBe(2)
    controller.abort()
  })

  it('keeps pending approvals deduped across mux retries', async () => {
    let subscription = 0
    const base = fakeApi()
    const approvalFrame = {
      rpcId: 'rpc-approval' as never,
      payload: {
        type: 'approval/requested',
        sessionId: 's1' as never,
        approvalId: 'a1' as never,
        toolName: 'bash',
        callId: 'c1' as never,
      },
    }
    const api = {
      ...base,
      events: {
        ...base.events,
        mux: async function* (_request: never, signal: AbortSignal) {
          subscription += 1
          if (subscription === 1) {
            yield approvalFrame
            throw new Error('transient after approval')
          }
          // dsh replays the still-pending approval on resubscribe.
          yield approvalFrame
          yield {
            rpcId: 'rpc-turn' as never,
            payload: {
              type: 'session/event',
              sessionId: 's1',
              event: sessionEvent('turn/start', { turn: 1 }, 1, 100),
            },
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          })
        },
      },
    }
    const router = createBridgeRouter(api as never, {
      cwd: '/work',
      sseRetryBaseMs: 10,
      sseRetryMaxAttempts: 3,
    })
    const server = await startBridgeServer(router)
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !text.includes('session.status')) {
      const { done, value } = await reader?.read() ?? { done: true, value: undefined }
      text += decoder.decode(value ?? new Uint8Array())
      if (done) break
    }
    expect(text).toContain('session.status')
    expect(subscription).toBe(2)
    const asked = (text.match(/permission\.asked/g) ?? []).length
    expect(asked).toBe(1)

    const pending = await (await fetch(server.url + '/permission')).json() as unknown[]
    expect(pending).toHaveLength(1)
    controller.abort()
  })
})
