import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  commandResultEvents,
  MuxEventTranslator,
  type BridgeGlobalEvent,
} from '../src/bridge/events.js'
import { InteractionState } from '../src/bridge/state.js'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, sessionEvent } from './helpers.js'

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

function translator(state = new InteractionState(), logs: string[] = [], cwd = '/work') {
  const instance = new MuxEventTranslator({ cwd, state, log: (message) => logs.push(message) })
  return {
    state,
    logs,
    translate: (frames: Array<RpcRequest<MuxFrame>>): BridgeGlobalEvent[] =>
      frames.flatMap((item) => instance.translate(item)),
  }
}

describe('bridge events: session event mapping', () => {
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
      'session.status',
      'session.idle',
    ])
    expect(events[0]?.payload.properties).toEqual({
      sessionID: 's1',
      status: { type: 'busy' },
    })
    expect(events[1]?.payload.properties).toEqual({
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
    const finalIndex = events.findIndex((event) =>
      event.payload.type === 'message.updated'
      && (event.payload.properties.info as { id?: string }).id === 'm-final')
    expect(removedIndex).toBeGreaterThanOrEqual(0)
    expect(removedIndex).toBeLessThan(finalIndex)

    const finalInfo = events[finalIndex]?.payload.properties.info as { time: { created: number; completed: number }; parentID?: string; finish?: string }
    expect(finalInfo.parentID).toBe('msg-user-1')
    expect(finalInfo.finish).toBe('stop')
    expect(finalInfo.time.created).toBe(1100)
    expect(finalInfo.time.completed).toBe(2000)
    expect(finalInfo.time.created).toBeLessThan(finalInfo.time.completed)

    const finalTextPart = events.filter((event) =>
      event.payload.type === 'message.part.updated'
      && (event.payload.properties.part as { messageID?: string }).messageID === 'm-final'
      && (event.payload.properties.part as { type?: string }).type === 'text')
    expect(finalTextPart).toHaveLength(1)
    expect(finalTextPart[0]?.payload.properties.part).toMatchObject({
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
      && (event.payload.properties.part as { messageID?: string }).messageID === 'm-reason'
      && (event.payload.properties.part as { type?: string }).type === 'reasoning')
    expect(finalPart).toHaveLength(1)
    expect(finalPart[0]?.payload.properties.part).toMatchObject({
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
        event: sessionEvent('request/header', { header: {}, reason: 'turn' }, 1, 100),
      }))
    expect(events).toEqual([])
    expect(logs.some((line) => line.includes('request/header'))).toBe(true)
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

  it('ignores control frames and stream errors', () => {
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
    expect(errored).toEqual([])
    expect(logs.some((line) => line.includes('stream/error'))).toBe(true)
  })
})

describe('bridge events: SSE connection lifecycle', () => {
  const servers: BridgeServerHandle[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
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
})
