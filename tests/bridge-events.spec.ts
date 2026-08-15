import { afterEach, describe, expect, it } from 'vitest'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { MuxEventTranslator, type BridgeGlobalEvent } from '../src/bridge/events.js'
import { InteractionState } from '../src/bridge/state.js'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, sessionEvent } from './helpers.js'

function frame(payload: MuxFrame, rpcId = 'rpc-1'): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as never, payload }
}

function translator(state = new InteractionState(), logs: string[] = []) {
  const instance = new MuxEventTranslator({ cwd: '/work', state, log: (message) => logs.push(message) })
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
    const { translate } = translator()
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
