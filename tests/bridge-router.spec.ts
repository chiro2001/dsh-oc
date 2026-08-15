import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter, type BridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import type { BridgeApi } from '../src/bridge/rpc.js'
import {
  errRpc,
  fakeApi,
  makeAssistantEvent,
  makeUserEvent,
  okRpc,
  sessionEvent,
} from './helpers.js'
import type { ClientResponse } from '@deepseek-ai/dsh-host-apiproxy/api'

const servers: BridgeServerHandle[] = []

async function boot(api: BridgeApi, cwd = '/work'): Promise<{ server: BridgeServerHandle; router: BridgeRouter }> {
  const router = createBridgeRouter(api, { cwd })
  const server = await startBridgeServer(router)
  servers.push(server)
  return { server, router }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function request(
  server: BridgeServerHandle,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(server.url + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: parsed,
  }
}

const STARTUP_GET_ROUTES = [
  '/path',
  '/project/current',
  '/config/providers',
  '/provider',
  '/experimental/capabilities',
  '/experimental/console',
  '/agent',
  '/config',
  '/project/global/directories',
  '/session',
  '/api/location',
  '/api/agent',
  '/api/integration',
  '/api/model',
  '/api/provider',
  '/api/reference',
  '/api/command',
  '/api/skill',
  '/command',
  '/lsp',
  '/mcp',
  '/experimental/resource',
  '/formatter',
  '/session/status',
  '/provider/auth',
  '/vcs',
  '/experimental/workspace',
  '/experimental/workspace/status',
] as const

describe('bridge router: startup GET routes', () => {
  it('answers every PROTOCOL §3 boot route with 2xx JSON', async () => {
    const { server } = await boot(fakeApi())
    for (const path of STARTUP_GET_ROUTES) {
      const result = await request(server, 'GET', path)
      expect(result.status, path).toBeGreaterThanOrEqual(200)
      expect(result.status, path).toBeLessThan(300)
      expect(result.contentType, path).toContain('application/json')
      expect(() => JSON.stringify(result.body), path).not.toThrow()
    }
  })

  it('returns the stub shapes exactly', async () => {
    const { server } = await boot(fakeApi())
    expect((await request(server, 'GET', '/lsp')).body).toEqual([])
    expect((await request(server, 'GET', '/mcp')).body).toEqual({})
    expect((await request(server, 'GET', '/formatter')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/resource')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/console')).body).toEqual({
      consoleManagedProviders: [],
      switchableOrgCount: 0,
    })
    expect((await request(server, 'GET', '/experimental/capabilities')).body).toEqual({
      backgroundSubagents: false,
    })
    expect((await request(server, 'GET', '/vcs')).body).toEqual({ branch: '' })
    expect((await request(server, 'GET', '/experimental/workspace')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/workspace/status')).body).toEqual([])
  })

  it('advertises the default build agent so the TUI prompt can submit', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      llm: {
        ...base.llm,
        models: async () => okRpc({
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'mock-model', name: 'Mock Model' }],
          }],
          failures: [],
        }),
      },
    }
    const { server } = await boot(api)
    const v1 = await request(server, 'GET', '/agent')
    expect(v1.status).toBe(200)
    expect(v1.body).toMatchObject([
      {
        name: 'build',
        mode: 'primary',
        permission: [],
        model: { providerID: 'deepseek', modelID: 'mock-model' },
      },
    ])
    const v2 = await request(server, 'GET', '/api/agent')
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({
      location: { directory: '/work' },
      data: [{ id: 'build', mode: 'primary', hidden: false, model: { id: 'mock-model', providerID: 'deepseek' } }],
    })
  })
})

describe('bridge router: session routes', () => {
  const item = {
    sessionId: 's1' as never,
    updatedAt: 2000,
    running: true,
    blank: false,
    cwd: '/work',
    agentPreset: 'build',
    projections: { asOfSeq: 0, values: { title: 'Session One' } as never },
  }

  it('lists sessions and status for v1 and v2', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [item] }) },
    }
    const { server } = await boot(api)
    const v1 = await request(server, 'GET', '/session')
    expect(v1.status).toBe(200)
    expect((v1.body as Array<{ id: string; title: string; slug: string }>)[0]).toMatchObject({
      id: 's1',
      slug: 's1',
      title: 'Session One',
    })
    const status = await request(server, 'GET', '/session/status')
    expect(status.body).toEqual({ s1: { type: 'busy' } })
    const v2 = await request(server, 'GET', '/api/session')
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({ data: [{ id: 's1', title: 'Session One' }], cursor: {} })
  })

  it('lists child sessions with parentID and inherits the parent cwd', async () => {
    const base = fakeApi()
    const parent = {
      sessionId: 'parent-1' as never,
      updatedAt: 3000,
      running: false,
      blank: false,
      cwd: '/work',
    }
    const child = {
      sessionId: 'child-1' as never,
      updatedAt: 2000,
      running: true,
      blank: false,
      parentSessionId: 'parent-1' as never,
      origin: 'subagent' as const,
      cwd: undefined,
      projections: undefined,
    }
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [child, parent] }) },
    }
    const { server, router } = await boot(api)
    const v1 = await request(server, 'GET', '/session')
    expect(v1.status).toBe(200)
    expect((v1.body as Array<{ id: string; parentID?: string; metadata?: unknown; directory: string }>)[0])
      .toMatchObject({
        id: 'child-1',
        parentID: 'parent-1',
        metadata: { origin: 'subagent' },
        directory: '/work',
      })
    expect(router.ctx.state.sessionDirectories.get('child-1')).toBe('/work')
    expect(router.ctx.state.sessionParents.get('child-1')).toBe('parent-1')
    const v2 = await request(server, 'GET', '/api/session')
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({
      data: [
        { id: 'child-1', parentID: 'parent-1', location: { directory: '/work' } },
        { id: 'parent-1' },
      ],
    })
  })

  it('gets a session and its messages for v1 and v2', async () => {
    const base = fakeApi()
    const history = [makeUserEvent('hello'), makeAssistantEvent([{ type: 'text', text: 'hi back' }])]
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: history.map((event) => ({ event })), hasMore: false }),
      },
    }
    const { server } = await boot(api)
    const session = await request(server, 'GET', '/session/s1')
    expect(session.status).toBe(200)
    expect((session.body as { id: string }).id).toBe('s1')
    const messages = await request(server, 'GET', '/session/s1/message')
    expect(messages.status).toBe(200)
    expect(messages.body).toHaveLength(2)
    const v2Messages = await request(server, 'GET', '/api/session/s1/message')
    expect(v2Messages.status).toBe(200)
    expect(v2Messages.body).toMatchObject({ data: [{ type: 'user' }, { type: 'assistant' }], cursor: {} })
  })

  it('tags user messages with an advertised model so the TUI keeps a valid selection', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      llm: {
        ...base.llm,
        models: async () => okRpc({
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'mock-model', name: 'Mock Model' }],
          }],
          failures: [],
        }),
      },
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [{ event: makeUserEvent('hello') }], hasMore: false }),
      },
    }
    const { server } = await boot(api)
    const messages = await request(server, 'GET', '/session/s1/message')
    expect(messages.status).toBe(200)
    expect((messages.body as Array<{ info: { role: string; model?: unknown } }>)[0]?.info).toMatchObject({
      role: 'user',
      model: { providerID: 'deepseek', modelID: 'mock-model' },
    })
  })

  it('creates sessions (v1), forks from parentID, and creates v2 sessions', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request.payload })
          return okRpc({ sessionId: 'new-session' as never })
        },
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request.payload })
          return okRpc({ sessionId: 'fork-session' as never })
        },
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
      },
    }
    const { server } = await boot(api)
    const created = await request(server, 'POST', '/session', { title: 'New' })
    expect(created.status).toBe(200)
    expect((created.body as { id: string }).id).toBe('new-session')
    expect(calls[0]).toMatchObject({ method: 'session.create', payload: { cwd: '/work' } })
    const forked = await request(server, 'POST', '/session', { parentID: 's1' })
    expect(forked.status).toBe(200)
    expect(calls[1]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })
    const v2 = await request(server, 'POST', '/api/session', { id: 'x1', location: { directory: '/tmp' } })
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({ data: { id: 'new-session' } })
    expect(calls[2]).toMatchObject({ method: 'session.create', payload: { cwd: '/tmp', sessionId: 'x1' } })
  })

  it('forks through the opencode route and maps messageID to the dsh atSeq', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const child = {
      sessionId: 'fork-session' as never,
      updatedAt: 3000,
      running: false,
      blank: false,
      parentSessionId: 's1' as never,
      cwd: '/work',
    }
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request.payload })
          return okRpc({ sessionId: 'fork-session' as never })
        },
        list: async () => okRpc({ items: [child] }),
        history: async () => okRpc({
          events: [{ event: makeUserEvent('hello', 'msg-user-1', 1000) }],
          hasMore: false,
        }),
      },
    }
    const { server } = await boot(api)
    const noMessage = await request(server, 'POST', '/session/s1/fork')
    expect(noMessage.status).toBe(200)
    expect((noMessage.body as { id: string; parentID?: string }).id).toBe('fork-session')
    expect((noMessage.body as { parentID?: string }).parentID).toBe('s1')
    expect(calls[0]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })

    const withMessage = await request(server, 'POST', '/session/s1/fork', {
      messageID: 'msg-user-1',
    })
    expect(withMessage.status).toBe(200)
    expect(calls[1]).toMatchObject({
      method: 'session.fork',
      payload: { sessionId: 's1', atSeq: 2 },
    })

    const v2 = await request(server, 'POST', '/api/session/s1/fork', {})
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({ data: { id: 'fork-session', parentID: 's1' } })
    expect(calls[2]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })
  })

  it('runs /compact through the dsh command registry for summarize and compact routes', async () => {
    const base = fakeApi()
    const lines: string[] = []
    const api: BridgeApi = {
      ...base,
      agents: {
        get: (sessionId) => sessionId === 's1' ? { id: sessionId } : undefined,
      },
      commands: {
        execute: async (_agent, line) => {
          lines.push(line)
          return { commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted 3 history items' } }
        },
      },
    }
    const { server } = await boot(api)
    const summarize = await request(server, 'POST', '/session/s1/summarize', {
      providerID: 'deepseek',
      modelID: 'mock-model',
    })
    expect(summarize.status).toBe(200)
    expect(summarize.body).toBe(true)

    const alias = await request(server, 'POST', '/session/s1/compact')
    expect(alias.status).toBe(200)
    expect(alias.body).toBe(true)

    const v2 = await request(server, 'POST', '/api/session/s1/compact')
    expect(v2.status).toBe(204)
    expect(v2.body).toBe('')
    expect(lines).toEqual(['/compact', '/compact', '/compact'])
  })

  it('rejects compact when the session agent or command registry is missing', async () => {
    const base = fakeApi()
    const { server } = await boot(base)
    const noAgent = await request(server, 'POST', '/session/s1/summarize', {
      providerID: 'deepseek',
      modelID: 'mock-model',
    })
    expect(noAgent.status).toBe(409)

    const withAgent = await boot({
      ...base,
      agents: { get: () => ({ id: 's1' }) },
    })
    const noRegistry = await request(withAgent.server, 'POST', '/session/s1/summarize', {})
    expect(noRegistry.status).toBe(500)
  })

  it('renames, prompts, and aborts sessions', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request.payload })
          return okRpc({ title: 'renamed', seq: 3 })
        },
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
        cancel: async (request) => {
          calls.push({ method: 'session.cancel', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)
    const patched = await request(server, 'PATCH', '/session/s1', { title: 'renamed' })
    expect(patched.status).toBe(200)
    expect(calls[0]).toMatchObject({ method: 'session.rename', payload: { sessionId: 's1', title: 'renamed' } })

    const prompt = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(prompt.status).toBe(200)
    expect(calls[1]).toMatchObject({
      method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(prompt.body).toMatchObject({ info: { role: 'assistant' }, parts: [] })

    const promptAlias = await request(server, 'POST', '/session/s1/prompt', {
      parts: [{ type: 'text', text: 'via alias' }],
    })
    expect(promptAlias.status).toBe(200)
    expect(calls[2]).toMatchObject({
      method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'via alias' }] },
    })

    const promptV2 = await request(server, 'POST', '/api/session/s1/prompt', {
      parts: [{ type: 'text', text: 'via v2' }],
    })
    expect(promptV2.status).toBe(200)
    expect(promptV2.body).toMatchObject({
      data: { sessionID: 's1', prompt: { parts: [{ type: 'text', text: 'via v2' }] }, delivery: 'queue' },
    })
    expect(calls[3]).toMatchObject({
      method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'via v2' }] },
    })

    const slashPrompt = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/compact' }],
    })
    expect(slashPrompt.status).toBe(200)
    expect(calls[4]).toMatchObject({
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '/compact' }],
      },
    })

    const aborted = await request(server, 'POST', '/session/s1/abort')
    expect(aborted.status).toBe(200)
    expect(aborted.body).toBe(true)
    expect(calls[5]).toMatchObject({ method: 'session.cancel', payload: { sessionId: 's1' } })
  })

  it('rejects unsupported prompt parts with 400', async () => {
    const { server } = await boot(fakeApi())
    const result = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'subtask', prompt: 'x', description: 'y', agent: 'z' }],
    })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ name: 'BadRequest' })
  })

  it('serves todo and diff from history/projections', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [
            { event: sessionEvent('todo/write', { todos: [{ content: 'a', status: 'in_progress' }] }, 1, 100) },
          ],
          hasMore: false,
          projections: {
            asOfSeq: 1,
            values: {
              'produced-files': [{ file: 'src/a.ts', additions: 3, deletions: 1, status: 'modified' }],
            } as never,
          },
        }),
      },
    }
    const { server } = await boot(api)
    const todo = await request(server, 'GET', '/session/s1/todo')
    expect(todo.status).toBe(200)
    expect(todo.body).toMatchObject([{ content: 'a', status: 'in_progress', priority: 'medium' }])
    const diff = await request(server, 'GET', '/session/s1/diff')
    expect(diff.status).toBe(200)
    expect(diff.body).toMatchObject([{ file: 'src/a.ts', additions: 3, deletions: 1 }])
  })

  it('returns empty todo/diff when no data exists', async () => {
    const { server } = await boot(fakeApi())
    expect((await request(server, 'GET', '/session/s1/todo')).body).toEqual([])
    expect((await request(server, 'GET', '/session/s1/diff')).body).toEqual([])
  })
})

describe('bridge router: catalog routes', () => {
  const groups = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
  ]

  it('serves providers/models to v1 and v2', async () => {
    const base = fakeApi()
    const api = { ...base, llm: { ...base.llm, models: async () => okRpc({ groups, failures: [] }) } }
    const { server } = await boot(api)
    const configProviders = await request(server, 'GET', '/config/providers')
    expect(configProviders.body).toMatchObject({ providers: [{ id: 'deepseek' }], default: {} })
    const provider = await request(server, 'GET', '/provider')
    expect(provider.body).toMatchObject({ all: [{ id: 'deepseek' }], connected: ['deepseek'], default: {} })
    const model = await request(server, 'GET', '/api/model')
    expect(model.body).toMatchObject({ data: [{ id: 'deepseek-chat', providerID: 'deepseek' }] })
    const providerV2 = await request(server, 'GET', '/api/provider')
    expect(providerV2.body).toMatchObject({ data: [{ id: 'deepseek' }] })
    const location = await request(server, 'GET', '/api/location')
    expect(location.body).toMatchObject({ directory: '/work', project: { directory: '/work' } })
    expect((location.body as { project: { id: string } }).project.id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('bridge router: error mapping', () => {
  it('maps session-not-found to 404 NotFoundError', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: { ...base.sessions, history: async () => errRpc('session-not-found', 'missing', { sessionId: 'x' }) },
    }
    const { server } = await boot(api)
    const result = await request(server, 'GET', '/session/x')
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({
      name: 'NotFoundError',
      message: 'missing',
      data: { code: 'session-not-found' },
    })
  })

  it('maps agent-busy to 409', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: { ...base.sessions, prompt: async () => errRpc('agent-busy', 'busy', { reason: 'x' }) },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/message', { parts: [{ type: 'text', text: 'x' }] })
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ name: 'ConflictError', data: { code: 'agent-busy' } })
  })

  it('maps bad-request to 400', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: { ...base.sessions, rename: async () => errRpc('title-invalid', 'bad title', { sessionId: 's1' }) },
    }
    const { server } = await boot(api)
    const result = await request(server, 'PATCH', '/session/s1', { title: ' ' })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ name: 'BadRequest' })
  })

  it('answers unlisted routes with 501 NotFoundError', async () => {
    const { server } = await boot(fakeApi())
    for (const path of ['/nope', '/api/event', '/session/s1/forkx']) {
      const result = await request(server, 'GET', path)
      expect(result.status, path).toBe(501)
      expect(result.body, path).toMatchObject({ name: 'NotFoundError' })
    }
  })
})

describe('bridge router: permission and question replies', () => {
  it('lists, replies, and removes pending permissions', async () => {
    const responses: ClientResponse[] = []
    const base = fakeApi({ respond: async (message) => {
      responses.push(message)
      return { accepted: true }
    } })
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p1',
      rpcId: 'rpc-p1',
      sessionId: 's1',
      approvalId: 'a1',
      toolName: 'bash',
      callId: 'c1',
    })
    const listed = await request(server, 'GET', '/permission')
    expect(listed.body).toMatchObject([{ id: 'p1', sessionID: 's1', permission: 'bash' }])
    const replied = await request(server, 'POST', '/permission/p1/reply', { reply: 'once' })
    expect(replied.status).toBe(200)
    expect(replied.body).toBe(true)
    expect(responses[0]?.result).toMatchObject({
      ok: true,
      value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
    })
    expect((await request(server, 'GET', '/permission')).body).toEqual([])
  })

  it('degrades always to allowed-once', async () => {
    const responses: ClientResponse[] = []
    const base = fakeApi({ respond: async (message) => {
      responses.push(message)
      return { accepted: true }
    } })
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p2',
      rpcId: 'rpc-p2',
      sessionId: 's1',
      approvalId: 'a2',
      toolName: 'edit',
    })
    await request(server, 'POST', '/permission/p2/reply', { reply: 'always' })
    expect(responses[0]?.result).toMatchObject({ ok: true, value: { outcome: 'allowed-once' } })
  })

  it('answers v2 permission reply with 204', async () => {
    const responses: ClientResponse[] = []
    const base = fakeApi({ respond: async (message) => {
      responses.push(message)
      return { accepted: true }
    } })
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p3',
      rpcId: 'rpc-p3',
      sessionId: 's1',
      approvalId: 'a3',
      toolName: 'bash',
    })
    const listed = await request(server, 'GET', '/api/session/s1/permission')
    expect(listed.body).toMatchObject({ data: [{ id: 'p3', action: 'bash' }] })
    const reply = await request(server, 'POST', '/api/session/s1/permission/p3/reply', { reply: 'reject' })
    expect(reply.status).toBe(204)
    expect(responses[0]?.result).toMatchObject({ ok: true, value: { outcome: 'rejected' } })
  })

  it('replies and rejects questions on v1 and v2', async () => {
    const responses: ClientResponse[] = []
    const base = fakeApi({ respond: async (message) => {
      responses.push(message)
      return { accepted: true }
    } })
    const { server, router } = await boot(base)
    router.ctx.state.registerQuestion({
      opencodeId: 'q1',
      rpcId: 'rpc-q1',
      sessionId: 's1',
      items: [{ id: 'dq1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    })
    const listed = await request(server, 'GET', '/question')
    expect(listed.body).toMatchObject([{ id: 'q1', sessionID: 's1', questions: [{ question: 'Proceed?' }] }])
    const reply = await request(server, 'POST', '/question/q1/reply', { answers: [['Yes']] })
    expect(reply.status).toBe(200)
    expect(reply.body).toBe(true)
    expect(responses[0]?.result).toMatchObject({
      ok: true,
      value: { sessionId: 's1', answer: { answers: [{ id: 'dq1', selected: ['Yes'] }] } },
    })

    router.ctx.state.registerQuestion({
      opencodeId: 'q2',
      rpcId: 'rpc-q2',
      sessionId: 's1',
      items: [{ id: 'dq2', question: 'Again?', options: [{ label: 'Y' }] }],
    })
    const reject = await request(server, 'POST', '/question/q2/reject')
    expect(reject.status).toBe(200)
    expect(responses[1]?.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })

    router.ctx.state.registerQuestion({
      opencodeId: 'q3',
      rpcId: 'rpc-q3',
      sessionId: 's1',
      items: [{ id: 'dq3', question: 'V2?', options: [{ label: 'Y' }] }],
    })
    const v2List = await request(server, 'GET', '/api/session/s1/question')
    expect(v2List.body).toMatchObject({ data: [{ id: 'q3' }] })
    const v2Reply = await request(server, 'POST', '/api/session/s1/question/q3/reply', { answers: [['Y']] })
    expect(v2Reply.status).toBe(204)

    router.ctx.state.registerQuestion({
      opencodeId: 'q4',
      rpcId: 'rpc-q4',
      sessionId: 's1',
      items: [{ id: 'dq4', question: 'V2 reject?', options: [{ label: 'Y' }] }],
    })
    const v2Reject = await request(server, 'POST', '/api/session/s1/question/q4/reject')
    expect(v2Reject.status).toBe(204)
  })

  it('returns 404 for unknown permission/question ids', async () => {
    const { server } = await boot(fakeApi())
    expect((await request(server, 'POST', '/permission/nope/reply', { reply: 'once' })).status).toBe(404)
    expect((await request(server, 'POST', '/question/nope/reply', { answers: [[]] })).status).toBe(404)
    expect((await request(server, 'POST', '/question/nope/reject')).status).toBe(404)
  })

  it('serves saved permissions as an empty v2 list', async () => {
    const { server } = await boot(fakeApi())
    expect((await request(server, 'GET', '/api/permission/saved')).body).toEqual({ data: [] })
  })
})

describe('bridge router: OPTIONS and CORS', () => {
  it('answers preflight with 204 and CORS headers', async () => {
    const { server } = await boot(fakeApi())
    const response = await fetch(server.url + '/session', { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
