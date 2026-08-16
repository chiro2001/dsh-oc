import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createBridgeRouter, type BridgeRouter } from '../src/bridge/router.js'
import { extractParams, matchPattern, seedProjectionState } from '../src/bridge/router.js'
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
const tempDirs: string[] = []

function gitFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-git-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
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

async function boot(api: BridgeApi, cwd = '/work'): Promise<{ server: BridgeServerHandle; router: BridgeRouter }> {
  const router = createBridgeRouter(api, { cwd })
  const server = await startBridgeServer(router)
  servers.push(server)
  return { server, router }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
    expect((await request(server, 'GET', '/config')).body).toEqual({ autoupdate: false })
    expect((await request(server, 'GET', '/lsp')).body).toEqual([])
    expect((await request(server, 'GET', '/mcp')).body).toEqual({})
    expect((await request(server, 'GET', '/formatter')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/resource')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/console')).body).toEqual({
      consoleManagedProviders: [],
      switchableOrgCount: 0,
    })
    expect((await request(server, 'GET', '/experimental/capabilities')).body).toEqual({
      backgroundSubagents: true,
    })
    expect((await request(server, 'GET', '/api/health')).body).toEqual({ healthy: true })
    const health = await request(server, 'GET', '/global/health')
    expect(health.body).toMatchObject({ healthy: true, version: expect.any(String) })
    expect((await request(server, 'POST', '/global/dispose')).body).toBe(true)
    expect((await request(server, 'POST', '/instance/dispose')).body).toBe(true)
    expect((await request(server, 'POST', '/experimental/session/s1/background')).body).toBe(true)
    expect((await request(server, 'GET', '/vcs')).body).toEqual({})
    expect((await request(server, 'GET', '/experimental/workspace')).body).toEqual([])
    expect((await request(server, 'GET', '/experimental/workspace/status')).body).toEqual([])
  })

  it('serves real vcs info, status, diff and raw diff from the workspace', async () => {
    const work = gitFixture({ 'a.txt': 'one\n' })
    writeFileSync(join(work, 'a.txt'), 'two\n')
    const { server } = await boot(fakeApi(), work)
    const info = await request(server, 'GET', '/vcs')
    expect(info.body).toMatchObject({ branch: 'main' })
    const status = await request(server, 'GET', '/vcs/status')
    expect(status.body).toEqual([{ file: 'a.txt', additions: 1, deletions: 1, status: 'modified' }])
    const diff = await request(server, 'GET', '/vcs/diff')
    expect(diff.body).toHaveLength(1)
    expect((diff.body as Array<{ patch?: string }>)[0]?.patch).toContain('diff --git')
    const raw = await request(server, 'GET', '/vcs/diff/raw')
    expect(raw.body).toContain('diff --git')
  })

  it('setCwd changes /path and session create honors the directory query', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request.payload })
          return okRpc({ sessionId: 'created' as never })
        },
      },
    }
    const { server, router } = await boot(api, '/work')

    let path = await request(server, 'GET', '/path')
    expect((path.body as { directory: string }).directory).toBe('/work')

    router.setCwd('/sub')
    path = await request(server, 'GET', '/path')
    expect((path.body as { directory: string }).directory).toBe('/sub')

    const created = await request(server, 'POST', '/session?directory=/sub2', {})
    expect(created.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.create',
      payload: { cwd: '/sub2' },
    })
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

describe('bridge router: wildcard pattern and workspace fs routes', () => {
  it('matches a trailing * segment and captures the remaining path', () => {
    expect(matchPattern('/api/fs/read/*', '/api/fs/read/a/b.txt')).toBe(true)
    expect(matchPattern('/api/fs/read/*', '/api/fs/read')).toBe(false)
    expect(matchPattern('/api/fs/read/*', '/api/fs/list')).toBe(false)
    expect(extractParams('/api/fs/read/*', '/api/fs/read/a/b.txt')).toEqual({
      '*': 'a/b.txt',
    })
  })

  it('reads workspace files raw and guards escapes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-router-fs-'))
    tempDirs.push(work)
    writeFileSync(join(work, 'readme.txt'), 'hello fs\n')
    const { server } = await boot(fakeApi(), work)
    const read = await request(server, 'GET', '/api/fs/read/readme.txt')
    expect(read.status).toBe(200)
    expect(read.contentType).toContain('text/plain')
    expect(read.body).toBe('hello fs\n')
    expect((await request(server, 'GET', '/api/fs/read/missing.txt')).status).toBe(404)
    expect((await request(server, 'GET', '/api/fs/read/..%2Fescape.txt')).status).toBe(400)
  })

  it('lists and finds workspace entries', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-router-fs-'))
    tempDirs.push(work)
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'readme.txt'), 'hello fs\n')
    writeFileSync(join(work, 'src', 'main.ts'), 'export {}\n')
    const { server } = await boot(fakeApi(), work)
    const listed = await request(server, 'GET', '/api/fs/list')
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      location: { directory: work },
      data: [
        { path: 'src', type: 'directory' },
        { path: 'readme.txt', type: 'file' },
      ],
    })
    const found = await request(server, 'GET', '/api/fs/find?query=.txt&type=file')
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({
      data: [{ path: 'readme.txt', type: 'file' }],
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

  it('warms real session titles from history projections into the list', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [{ ...item, projections: undefined }] }),
        history: async () => {
          historyCalls += 1
          return okRpc({
            events: [],
            hasMore: false,
            projections: { asOfSeq: 2, values: { title: 'Real Title' } as never },
          })
        },
      },
    }
    const { server } = await boot(api)
    const v1 = await request(server, 'GET', '/session')
    expect((v1.body as Array<{ title: string }>).at(0)?.title).toBe('Real Title')
    const v2 = await request(server, 'GET', '/api/session')
    expect((v2.body as { data: Array<{ title: string }> }).data.at(0)?.title).toBe('Real Title')
    expect(historyCalls).toBe(1)
  })

  it('skips blank sessions when warming list titles', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({
          items: [
            { ...item, projections: undefined },
            { ...item, sessionId: 's-blank' as never, blank: true, projections: undefined },
          ],
        }),
        history: async () => {
          historyCalls += 1
          return okRpc({ events: [], hasMore: false })
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'GET', '/session')
    const titles = (result.body as Array<{ id: string; title: string }>).map((entry) => entry.title)
    expect(titles).toEqual(['work', 'work'])
    expect(historyCalls).toBe(1)
  })

  it('does not flag a bare new session as exit-note activity', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        create: async () => okRpc({ sessionId: 's-new' as never }),
      },
    }
    const { server, router } = await boot(api)
    expect(router.hasNewActivity()).toBe(false)
    const result = await request(server, 'POST', '/session', {})
    expect(result.status).toBe(200)
    expect(router.hasNewActivity()).toBe(false)
    expect(await router.exitNoteNeeded()).toBe(false)
  })

  it('tracks new prompt input for the exit note signal', async () => {
    const base = fakeApi()
    const { server, router } = await boot(base)
    expect(router.hasNewActivity()).toBe(false)
    const result = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(result.status).toBe(200)
    expect(router.hasNewActivity()).toBe(true)
    expect(await router.exitNoteNeeded()).toBe(true)
  })

  it('needs the exit note for a resumed session with a durable title', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [],
          hasMore: false,
          projections: { asOfSeq: 2, values: { title: 'Resumed Title' } as never },
        }),
      },
    }
    const { router } = await boot(api)
    expect(await router.exitNoteNeeded()).toBe(false)
    router.prefetchSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await router.exitNoteNeeded()).toBe(true)
  })

  it('skips the exit note for an empty resumed session', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [],
          hasMore: false,
          projections: { asOfSeq: 1, values: { title: null } as never },
        }),
      },
    }
    const { router } = await boot(api)
    router.prefetchSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await router.exitNoteNeeded()).toBe(false)
  })

  it('filters session lists by the directory query', async () => {
    const base = fakeApi()
    const other = { ...item, sessionId: 's2' as never, cwd: '/other' }
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [item, other] }) },
    }
    const { server } = await boot(api)

    const v1 = await request(server, 'GET', '/session?directory=/other')
    expect((v1.body as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['s2'])

    const v2 = await request(server, 'GET', '/api/session?directory=/work')
    expect((v2.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual(['s1'])

    const status = await request(server, 'GET', '/session/status?directory=/other')
    expect(status.body).toEqual({ s2: { type: 'busy' } })

    const all = await request(server, 'GET', '/session')
    expect((all.body as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['s1', 's2'])
  })

  it('resolves relative directory queries against the bridge cwd', async () => {
    const base = fakeApi()
    const sub = { ...item, sessionId: 's-sub' as never, cwd: '/work/sub' }
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [item, sub] }) },
    }
    const { server } = await boot(api, '/work')
    const result = await request(server, 'GET', '/session?directory=sub')
    expect(result.status).toBe(200)
    expect((result.body as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['s-sub'])
  })

  it('caches the session list within TTL and invalidates on rename', async () => {
    const calls: string[] = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => {
          calls.push('list')
          return okRpc({ items: [item] })
        },
        rename: async () => {
          calls.push('rename')
          return okRpc({ title: 'x', seq: 2 })
        },
      },
    }
    const { server } = await boot(api)

    await request(server, 'GET', '/session')
    await request(server, 'GET', '/session')
    expect(calls.filter((call) => call === 'list')).toHaveLength(1)

    await request(server, 'PATCH', '/session/s1', { title: 'x' })
    await request(server, 'GET', '/session')
    expect(calls.filter((call) => call === 'list')).toHaveLength(2)
  })

  it('prefetches the session list into the cache', async () => {
    const calls: string[] = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => {
          calls.push('list')
          return okRpc({ items: [item] })
        },
      },
    }
    const { server, router } = await boot(api)
    router.prefetchSessionList()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await request(server, 'GET', '/session')
    expect(result.status).toBe(200)
    expect(calls).toEqual(['list'])
  })

  it('prefetches the most recent session histories after the list', async () => {
    const historyCalls: string[] = []
    const base = fakeApi()
    const s2 = { ...item, sessionId: 's2' as never }
    const s3 = { ...item, sessionId: 's3' as never }
    const s4 = { ...item, sessionId: 's4' as never }
    const s5 = { ...item, sessionId: 's5' as never }
    const s6 = { ...item, sessionId: 's6' as never }
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item, s2, s3, s4, s5, s6] }),
        history: async (request) => {
          historyCalls.push(String((request.payload as { sessionId?: string }).sessionId))
          return okRpc({ events: [], hasMore: false })
        },
      },
    }
    const { router } = await boot(api)
    router.prefetchSessionList()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(historyCalls.sort()).toEqual(['s1', 's2', 's3', 's4', 's5'])
  })

  it('prefetches one session history into the cache', async () => {
    const historyCalls: string[] = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => {
          historyCalls.push('history')
          return okRpc({ events: [], hasMore: false })
        },
      },
    }
    const { server, router } = await boot(api)
    router.prefetchSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await request(server, 'GET', '/session/s1/message')
    expect(result.status).toBe(200)
    expect(historyCalls).toEqual(['history'])
  })

  it('caches history per page and invalidates after a prompt', async () => {
    const historyCalls: string[] = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async (request) => {
          const maxMessages = (request.payload as { maxMessages?: number }).maxMessages
          historyCalls.push(maxMessages === undefined ? 'tail' : String(maxMessages))
          return okRpc({ events: [], hasMore: false })
        },
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server } = await boot(api)

    await request(server, 'GET', '/session/s1/message?limit=10')
    await request(server, 'GET', '/session/s1/message?limit=10')
    expect(historyCalls).toEqual(['10'])

    await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'hi' }],
    })
    await request(server, 'GET', '/session/s1/message?limit=10')
    expect(historyCalls).toEqual(['10', '10'])
  })

  it('coalesces concurrent session list loads into one RPC', async () => {
    let listCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => {
          listCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return okRpc({ items: [item, { ...item, sessionId: 's2' as never }] })
        },
      },
    }
    const { server } = await boot(api)
    const [first, second] = await Promise.all([
      request(server, 'GET', '/session'),
      request(server, 'GET', '/session'),
    ])
    expect(listCalls).toBe(1)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((first.body as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['s1', 's2'])
    expect((second.body as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['s1', 's2'])
  })

  it('coalesces concurrent history page loads into one RPC', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => {
          historyCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return okRpc({ events: [], hasMore: false })
        },
      },
    }
    const { server } = await boot(api)
    const [first, second] = await Promise.all([
      request(server, 'GET', '/session/s1/message?limit=10'),
      request(server, 'GET', '/session/s1/message?limit=10'),
    ])
    expect(historyCalls).toBe(1)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  it('serves the message page from a previously loaded full tail', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => {
          historyCalls += 1
          return okRpc({ events: [{ event: makeUserEvent('hi') }], hasMore: false })
        },
      },
    }
    const { server } = await boot(api)
    await request(server, 'GET', '/session/s1')
    await request(server, 'GET', '/session/s1/message?limit=100')
    expect(historyCalls).toBe(1)
  })

  it('serves the full tail from a complete 100-message page', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => {
          historyCalls += 1
          return okRpc({ events: [{ event: makeUserEvent('hi') }], hasMore: false })
        },
      },
    }
    const { server } = await boot(api)
    await request(server, 'GET', '/session/s1/message?limit=100')
    await request(server, 'GET', '/session/s1')
    expect(historyCalls).toBe(1)
  })

  it('starts a fresh list scan after invalidation during an in-flight load', async () => {
    let listCalls = 0
    const base = fakeApi()
    const stale = { ...item, sessionId: 's-stale' as never }
    const fresh = { ...item, sessionId: 's-fresh' as never }
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => {
          listCalls += 1
          const value = listCalls === 1 ? stale : fresh
          await new Promise((resolve) => setTimeout(resolve, 20))
          return okRpc({ items: [value] })
        },
      },
    }
    const { server } = await boot(api)
    const inFlight = request(server, 'GET', '/session')
    const listStarted = Date.now() + 2000
    while (listCalls === 0 && Date.now() < listStarted) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(listCalls).toBe(1)
    await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'hi' }],
    })
    const [first, second] = await Promise.all([
      inFlight,
      request(server, 'GET', '/session'),
    ])
    expect(listCalls).toBe(2)
    expect((first.body as Array<{ id: string }>).at(0)?.id).toBe('s-stale')
    expect((second.body as Array<{ id: string }>).at(0)?.id).toBe('s-fresh')
  })

  it('serves the dsh skill catalog for the matching session', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item] }),
      },
      skills: {
        list: async () => okRpc({
          skills: [{
            name: 'code-review',
            description: 'Review code before merge',
            whenToUse: 'Before merging',
            modelInvocable: true,
          }],
        }),
      },
    }
    const { server } = await boot(api)

    const v1 = await request(server, 'GET', '/skill?directory=/work')
    expect(v1.status).toBe(200)
    expect(v1.body).toEqual([{
      name: 'code-review',
      description: 'Review code before merge',
      whenToUse: 'Before merging',
    }])

    const v2 = await request(server, 'GET', '/api/skill')
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({
      location: { directory: '/work' },
      data: [{ name: 'code-review', description: 'Review code before merge' }],
    })

    const commands = await request(server, 'GET', '/command')
    expect((commands.body as Array<{ name: string }>).map((entry) => entry.name)).toContain('code-review')
    const v2Commands = await request(server, 'GET', '/api/command')
    expect((v2Commands.body as { data: Array<{ name: string }> }).data.map((entry) => entry.name))
      .toContain('code-review')
  })

  it('runs a skill command through the prompt path', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
      skills: {
        list: async () => okRpc({
          skills: [{ name: 'code-review', description: 'Review code', modelInvocable: true }],
        }),
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/command', {
      command: 'code-review',
      arguments: 'strict',
    })
    expect(result.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '/code-review strict' }],
      },
    })
  })

  it('returns an empty skill catalog without sessions', async () => {
    const { server } = await boot(fakeApi())
    expect((await request(server, 'GET', '/skill')).body).toEqual([])
  })

  it('injects fake skills for e2e when DSH_OC_E2E_FAKE_SKILLS is set', async () => {
    const previous = process.env.DSH_OC_E2E_FAKE_SKILLS
    process.env.DSH_OC_E2E_FAKE_SKILLS = 'code-review,smoke'
    try {
      const base = fakeApi()
      const api: BridgeApi = {
        ...base,
        sessions: { ...base.sessions, list: async () => okRpc({ items: [item] }) },
      }
      const { server } = await boot(api)
      const v1 = await request(server, 'GET', '/skill')
      expect((v1.body as Array<{ name: string }>).map((skill) => skill.name)).toEqual([
        'code-review',
        'smoke',
      ])
      const commands = await request(server, 'GET', '/command')
      expect((commands.body as Array<{ name: string }>).map((command) => command.name)).toContain('code-review')
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_OC_E2E_FAKE_SKILLS
      } else {
        process.env.DSH_OC_E2E_FAKE_SKILLS = previous
      }
    }
  })

  it('searches v2 session lists through session.search and applies limit', async () => {
    const base = fakeApi()
    const other = { ...item, sessionId: 's2' as never, cwd: '/other' }
    const searchCalls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item, other] }),
        search: async (request) => {
          searchCalls.push({ method: 'session.search', payload: request.payload })
          return okRpc({
            items: [{ sessionId: 's2' as never, snippet: 'needle found' }],
            hasMore: false,
          })
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'GET', '/api/session?search=needle&limit=10')
    expect(result.status).toBe(200)
    expect((result.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual(['s2'])
    expect(searchCalls[0]).toMatchObject({
      method: 'session.search',
      payload: { query: 'needle' },
    })
  })

  it('honors order=asc on the v2 session list', async () => {
    const base = fakeApi()
    const other = { ...item, sessionId: 's2' as never, cwd: '/other' }
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [item, other] }) },
    }
    const { server } = await boot(api)
    const result = await request(server, 'GET', '/api/session?order=asc')
    expect(result.status).toBe(200)
    expect((result.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual([
      's2',
      's1',
    ])
  })

  it('paginates the v2 session list with an opaque cursor', async () => {
    const base = fakeApi()
    const s2 = { ...item, sessionId: 's2' as never }
    const s3 = { ...item, sessionId: 's3' as never }
    const api = {
      ...base,
      sessions: { ...base.sessions, list: async () => okRpc({ items: [item, s2, s3] }) },
    }
    const { server } = await boot(api)

    const first = await request(server, 'GET', '/api/session?limit=2')
    expect((first.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual([
      's1',
      's2',
    ])
    const next = (first.body as { cursor: { next?: string } }).cursor.next
    expect(next).toBeTypeOf('string')

    const second = await request(
      server,
      'GET',
      `/api/session?limit=2&cursor=${encodeURIComponent(next ?? '')}`,
    )
    expect(second.status).toBe(200)
    expect((second.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual(['s3'])
    expect((second.body as { cursor: { next?: string; previous?: string } }).cursor.next).toBeUndefined()
    expect((second.body as { cursor: { previous?: string } }).cursor.previous).toBeTypeOf('string')

    const invalid = await request(server, 'GET', '/api/session?cursor=bad')
    expect(invalid.status).toBe(400)
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
    const children = await request(server, 'GET', '/session/parent-1/children')
    expect(children.status).toBe(200)
    expect(children.body).toMatchObject([
      { id: 'child-1', parentID: 'parent-1', metadata: { origin: 'subagent' } },
    ])
    const noChildren = await request(server, 'GET', '/session/missing/children')
    expect(noChildren.status).toBe(200)
    expect(noChildren.body).toEqual([])
    const experimental = await request(server, 'GET', '/experimental/session')
    expect(experimental.status).toBe(200)
    expect(experimental.body).toMatchObject([
      { id: 'child-1', parentID: 'parent-1', metadata: { origin: 'subagent' } },
      { id: 'parent-1' },
    ])
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
    const init = await request(server, 'POST', '/session/s1/init')
    expect(init.status).toBe(200)
    expect(init.body).toBe(true)
    const messages = await request(server, 'GET', '/session/s1/message')
    expect(messages.status).toBe(200)
    expect(messages.body).toHaveLength(2)
    const firstID = (messages.body as Array<{ info: { id: string } }>)[0]?.info.id
    expect(firstID).toBeDefined()
    const single = await request(server, 'GET', `/session/s1/message/${firstID}`)
    expect(single.status).toBe(200)
    expect((single.body as { info: { id: string } }).info.id).toBe(firstID)
    const missing = await request(server, 'GET', '/session/s1/message/nope')
    expect(missing.status).toBe(404)
    const v2Messages = await request(server, 'GET', '/api/session/s1/message')
    expect(v2Messages.status).toBe(200)
    expect(v2Messages.body).toMatchObject({ data: [{ type: 'user' }, { type: 'assistant' }], cursor: {} })
    const context = await request(server, 'GET', '/api/session/s1/context')
    expect(context.status).toBe(200)
    expect(context.body).toMatchObject({ data: [{ type: 'user' }, { type: 'assistant' }] })
    const v2FirstID = (v2Messages.body as { data: Array<{ id: string }> }).data[0]?.id
    expect(v2FirstID).toBeDefined()
    const v2Single = await request(server, 'GET', `/api/session/s1/message/${v2FirstID}`)
    expect(v2Single.status).toBe(200)
    expect((v2Single.body as { data: { id: string } }).data.id).toBe(v2FirstID)
    expect((await request(server, 'GET', '/api/session/s1/message/nope')).status).toBe(404)
  })

  it('reports the active session through /api/session/active', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [{
          sessionId: 'new-session' as never,
          updatedAt: Date.now(),
          running: true,
          blank: false,
        }] }),
      },
    }
    const { server } = await boot(api)
    const empty = await request(server, 'GET', '/api/session/active')
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ data: {} })
    await request(server, 'POST', '/session', {})
    const active = await request(server, 'GET', '/api/session/active')
    expect(active.status).toBe(200)
    expect(active.body).toEqual({ data: { 'new-session': { type: 'running' } } })
  })

  it('waits for a session to become idle', async () => {
    const base = fakeApi()
    const states = [{ running: true }, { running: false }]
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [{
          sessionId: 's1' as never,
          updatedAt: Date.now(),
          running: states.shift()?.running ?? false,
          blank: false,
        }] }),
      },
    }
    const { server } = await boot(api)
    const waited = await request(server, 'POST', '/api/session/s1/wait')
    expect(waited.status).toBe(204)
    expect((await request(server, 'POST', '/api/session/missing/wait')).status).toBe(404)
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
    let forkCreated = false
    const child = {
      sessionId: 'fork-session' as never,
      updatedAt: 3000,
      running: false,
      blank: false,
      parentSessionId: 's1' as never,
      cwd: '/work',
      projections: {
        asOfSeq: 0,
        values: { title: 'Session One (fork #1)' } as never,
      },
    }
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
          forkCreated = true
          return okRpc({ sessionId: 'fork-session' as never })
        },
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request.payload })
          return okRpc({ title: request.payload.title, seq: 3 })
        },
        list: async () => okRpc({ items: forkCreated ? [child] : [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
      },
    }
    const { server } = await boot(api)
    const created = await request(server, 'POST', '/session', { title: 'New' })
    expect(created.status).toBe(200)
    expect((created.body as { id: string }).id).toBe('new-session')
    expect(calls[0]).toMatchObject({ method: 'session.create', payload: { cwd: '/work' } })
    const forkedBody = await request(server, 'POST', '/session', { parentID: 's1' })
    expect(forkedBody.status).toBe(200)
    expect(forkedBody.body).toMatchObject({
      id: 'fork-session',
      title: 'Session One (fork #1)',
    })
    expect((forkedBody.body as { parentID?: string }).parentID).toBeUndefined()
    expect(calls[1]).toMatchObject({ method: 'session.rename', payload: { sessionId: 'new-session', title: 'New' } })
    expect(calls[2]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })
    expect(calls[3]).toMatchObject({
      method: 'session.rename',
      payload: { sessionId: 'fork-session', title: 'Session One (fork #1)' },
    })
    const v2 = await request(server, 'POST', '/api/session', { id: 'x1', location: { directory: '/tmp' } })
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({ data: { id: 'new-session' } })
    expect(calls[4]).toMatchObject({ method: 'session.create', payload: { cwd: '/tmp', sessionId: 'x1' } })
  })

  it('forks through the opencode route and maps messageID to the dsh atSeq', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const children: Array<{
      sessionId: never
      updatedAt: number
      running: boolean
      blank: boolean
      parentSessionId: never
      cwd: string
      projections: { asOfSeq: number; values: never }
    }> = []
    const childBase = {
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
          children.push({
            ...childBase,
            projections: {
              asOfSeq: 0,
              values: { title: `Session One (fork #${children.length + 1})` } as never,
            },
          })
          return okRpc({ sessionId: 'fork-session' as never })
        },
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request.payload })
          return okRpc({ title: request.payload.title, seq: 3 })
        },
        list: async () => okRpc({ items: [item, ...children] }),
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
    expect((noMessage.body as { parentID?: string }).parentID).toBeUndefined()
    expect(noMessage.body).toMatchObject({ title: 'Session One (fork #1)' })
    expect(calls[0]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })
    expect(calls[1]).toMatchObject({
      method: 'session.rename',
      payload: { sessionId: 'fork-session', title: 'Session One (fork #1)' },
    })

    const withMessage = await request(server, 'POST', '/session/s1/fork', {
      messageID: 'msg-user-1',
    })
    expect(withMessage.status).toBe(200)
    expect(calls[2]).toMatchObject({
      method: 'session.fork',
      payload: { sessionId: 's1', atSeq: 2 },
    })
    expect(calls[3]).toMatchObject({
      method: 'session.rename',
      payload: { sessionId: 'fork-session', title: 'Session One (fork #2)' },
    })

    const v2 = await request(server, 'POST', '/api/session/s1/fork', {})
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({
      data: { id: 'fork-session' },
    })
    expect((v2.body as { data: { parentID?: string } }).data.parentID).toBeUndefined()
    expect(calls[4]).toMatchObject({ method: 'session.fork', payload: { sessionId: 's1' } })
    expect(calls[5]).toMatchObject({
      method: 'session.rename',
      payload: { sessionId: 'fork-session', title: 'Session One (fork #3)' },
    })
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

    const interrupted = await request(server, 'POST', '/api/session/s1/interrupt')
    expect(interrupted.status).toBe(204)
    expect(calls[6]).toMatchObject({ method: 'session.cancel', payload: { sessionId: 's1' } })
  })

  it('rejects unsupported prompt parts with 400', async () => {
    const { server } = await boot(fakeApi())
    const result = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'subtask', prompt: 'x', description: 'y', agent: 'z' }],
    })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ name: 'BadRequest' })
  })

  it('accepts prompt_async submissions used by --mini attach', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/prompt_async', {
      model: { providerID: 'deepseek', modelID: 'mock-model' },
      parts: [{ type: 'text', text: 'mini hello' }],
    })
    expect(result.status).toBe(204)
    expect(calls[0]).toMatchObject({
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: 'mini hello' }],
      },
    })
  })

  it('accepts text and image file parts from data URLs and local paths', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-attach-'))
    tempDirs.push(work)
    writeFileSync(join(work, 'notes.txt'), 'hello from notes')

    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        prompt: async (request: { payload: unknown }) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api, work)

    const textData = await request(server, 'POST', '/session/s1/message', {
      parts: [{
        type: 'file',
        mime: 'text/plain',
        filename: 'hello.txt',
        url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      }],
    })
    expect(textData.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.prompt',
      payload: { content: [{ type: 'text', text: 'hello' }] },
    })

    const local = await request(server, 'POST', '/session/s1/message', {
      parts: [{
        type: 'file',
        mime: 'text/plain',
        filename: 'notes.txt',
        url: `file://${join(work, 'notes.txt')}`,
      }],
    })
    expect(local.status).toBe(200)
    expect(calls[1]).toMatchObject({
      payload: { content: [{ type: 'text', text: 'hello from notes' }] },
    })

    const imageData = Buffer.from('png').toString('base64')
    const image = await request(server, 'POST', '/session/s1/prompt', {
      parts: [{
        type: 'file',
        mime: 'image/png',
        filename: 'pic.png',
        url: `data:image/png;base64,${imageData}`,
      }],
    })
    expect(image.status).toBe(200)
    expect(calls[2]).toMatchObject({
      payload: { content: [{ type: 'image', mediaType: 'image/png', data: imageData }] },
    })
  })

  it('rejects file parts outside the session cwd and unsupported binary mimes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-attach-outside-'))
    tempDirs.push(work)
    const { server } = await boot(fakeApi(), work)

    const outside = await request(server, 'POST', '/session/s1/message', {
      parts: [{
        type: 'file',
        mime: 'text/plain',
        url: `file://${join(tmpdir(), 'secret.txt')}`,
      }],
    })
    expect(outside.status).toBe(400)
    expect(outside.body).toMatchObject({ name: 'BadRequest' })

    const binary = await request(server, 'POST', '/session/s1/message', {
      parts: [{
        type: 'file',
        mime: 'application/pdf',
        url: `data:application/pdf;base64,${Buffer.from('%PDF-').toString('base64')}`,
      }],
    })
    expect(binary.status).toBe(400)
    expect(binary.body).toMatchObject({ name: 'BadRequest' })
  })

  it('passes the v2 message limit query into session.history', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async (request) => {
          calls.push({ method: 'session.history', payload: request.payload })
          return okRpc({ events: [], hasMore: false })
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'GET', '/api/session/s1/message?limit=3')
    expect(result.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 3 },
    })
  })

  it('paginates v2 messages with an opaque before cursor', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const events = [
      {
        event: sessionEvent('user/message', {
          id: 'm1' as never,
          content: [{ type: 'text', text: 'a' }],
          source: { kind: 'user' },
        }, 10, 100),
      },
      {
        event: sessionEvent('assistant/message', {
          turn: 1,
          step: 1,
          message: {
            id: 'm2' as never,
            role: 'assistant',
            content: [{ type: 'text', text: 'b' }],
            source: { kind: 'model', provider: 'x', model: 'y' },
          },
        }, 11, 200),
      },
    ]
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async (request) => {
          calls.push({ method: 'session.history', payload: request.payload })
          return okRpc({ events, hasMore: true })
        },
      },
    }
    const { server } = await boot(api)

    const first = await request(server, 'GET', '/api/session/s1/message?limit=2')
    expect(first.status).toBe(200)
    const cursor = (first.body as { cursor: { previous?: string } }).cursor.previous
    expect(cursor).toBeTypeOf('string')
    expect(calls[0]).toMatchObject({
      method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 2 },
    })

    const second = await request(
      server,
      'GET',
      `/api/session/s1/message?limit=2&cursor=${encodeURIComponent(cursor ?? '')}`,
    )
    expect(second.status).toBe(200)
    expect(calls[1]).toMatchObject({
      method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 2, beforeSeq: 10 },
    })

    const invalid = await request(server, 'GET', '/api/session/s1/message?cursor=not-a-cursor')
    expect(invalid.status).toBe(400)

    const desc = await request(server, 'GET', '/api/session/s1/message?order=desc')
    expect(desc.status).toBe(200)
    expect((desc.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual([
      'm2',
      'm1',
    ])
  })

  it('serves todo and diff from history/projections', async () => {
    const work = gitFixture({ 'src/a.ts': 'const a = 1' })
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
    const { server } = await boot(api, work)
    const todo = await request(server, 'GET', '/session/s1/todo')
    expect(todo.status).toBe(200)
    expect(todo.body).toMatchObject([{ content: 'a', status: 'in_progress', priority: 'medium' }])
    const diff = await request(server, 'GET', '/session/s1/diff')
    expect(diff.status).toBe(200)
    expect(diff.body).toMatchObject([{ file: 'src/a.ts', additions: 3, deletions: 1 }])
    const v2Diff = await request(server, 'GET', '/api/session/s1/diff')
    expect(v2Diff.status).toBe(200)
    expect(v2Diff.body).toMatchObject([{
      file: 'src/a.ts',
      additions: 3,
      deletions: 1,
      status: 'modified',
    }])
    expect((v2Diff.body as Array<Record<string, unknown>>)[0]).not.toHaveProperty('patch')
  })

  it('derives diff from tool result views when no produced-files projection exists', async () => {
    const work = gitFixture({ 'src/a.ts': 'const a = 1' })
    const trackedPath = join(work, 'src', 'a.ts')
    const base = fakeApi()
    const callEvent = sessionEvent('tool/call', {
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
    }, 1, 100)
    const resultEvent = sessionEvent('tool/result', {
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
    }, 2, 150)
    const callView: ToolEventView = {
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
    }
    const resultView: ToolEventView = {
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
    }
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [
            {
              event: callEvent,
              view: callView,
            },
            {
              event: resultEvent,
              view: resultView,
            },
          ],
          hasMore: false,
        }),
      },
    }
    const { server } = await boot(api, work)
    const diff = await request(server, 'GET', '/session/s1/diff')
    expect(diff.status).toBe(200)
    expect(diff.body).toMatchObject([{
      file: trackedPath,
      additions: 1,
      deletions: 1,
    }])
    const v2Diff = await request(server, 'GET', '/api/session/s1/diff')
    expect(v2Diff.status).toBe(200)
    expect(v2Diff.body).toMatchObject([{
      file: trackedPath,
      status: 'modified',
      additions: 1,
      deletions: 1,
    }])
    expect(String((v2Diff.body as Array<{ patch?: string }>)[0]?.patch ?? '')).toContain('@@')
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
    const providerSingle = await request(server, 'GET', '/api/provider/deepseek')
    expect(providerSingle.status).toBe(200)
    expect(providerSingle.body).toMatchObject({ data: { id: 'deepseek' } })
    expect((await request(server, 'GET', '/api/provider/nope')).status).toBe(404)
    const location = await request(server, 'GET', '/api/location')
    expect(location.body).toMatchObject({ directory: '/work', project: { directory: '/work' } })
    expect((location.body as { project: { id: string } }).project.id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('bridge router: model variants, agent presets and /preset', () => {
  const groups = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'off',
        },
      }],
    },
  ]

  it('advertises variants, dsh presets as agents, and /preset', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      llm: { ...base.llm, models: async () => okRpc({ groups, failures: [] }) },
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: true },
            { id: 'standard', trust: 'system', isDefault: false },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => okRpc({ agentPreset: 'minimal' }),
      },
    }
    const { server } = await boot(api)

    const providers = await request(server, 'GET', '/config/providers')
    expect((providers.body as {
      providers: Array<{ models: Record<string, { variants?: Record<string, unknown> }> }>
    }).providers[0]?.models['deepseek-v4-flash']?.variants).toEqual({
      off: { reasoningEffort: 'off', name: 'Off' },
      max: { reasoningEffort: 'max', name: 'Max' },
    })

    const v1Agents = await request(server, 'GET', '/agent')
    expect((v1Agents.body as Array<{ name: string }>).map((agent) => agent.name)).toEqual([
      'build',
      'minimal',
      'standard',
    ])
    const v2Agents = await request(server, 'GET', '/api/agent')
    expect((v2Agents.body as { data: Array<{ id: string }> }).data.map((agent) => agent.id)).toEqual([
      'build',
      'minimal',
      'standard',
    ])

    const v1Commands = await request(server, 'GET', '/command')
    expect(v1Commands.body).toMatchObject([
      { name: 'preset', template: 'preset' },
      { name: 'goal', template: 'goal' },
      { name: 'help', template: 'help' },
    ])
    const v2Commands = await request(server, 'GET', '/api/command')
    expect(v2Commands.body).toMatchObject({
      data: [
        { name: 'preset', template: 'preset' },
        { name: 'goal', template: 'goal' },
        { name: 'help', template: 'help' },
      ],
    })
  })

  it('selects a model through the v2 route and reflects it on the session', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const item = {
      sessionId: 's1' as never,
      updatedAt: 2000,
      running: false,
      blank: true,
      cwd: '/work',
      agentPreset: 'minimal',
      projections: { asOfSeq: 0, values: { title: 'Model Session' } as never },
    }
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
        models: async () => okRpc({
          current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
          routable: true,
          groups: [],
          failures: [],
        }),
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request.payload })
          return okRpc({
            selected: {
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
              reasoningEffort: 'max',
            },
          })
        },
      },
    }
    const { server } = await boot(api)
    const switched = await request(server, 'POST', '/api/session/s1/model', {
      model: { providerID: 'deepseek', id: 'deepseek-v4-flash', variant: 'max' },
    })
    expect(switched.status).toBe(204)
    expect(calls[0]).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: 's1',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      },
    })
    const session = await request(server, 'GET', '/api/session/s1')
    expect(session.body).toMatchObject({
      data: {
        model: { id: 'deepseek-v4-flash', providerID: 'deepseek', variant: 'max' },
        agent: 'minimal',
      },
    })
  })

  it('re-applies a lost variant before the next prompt', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    let currentVariant: string | undefined = 'high'
    const api = fakeApi({
      sessions: {
        ...fakeApi().sessions,
        models: async () => okRpc({
          current: {
            provider: 'deepseek-official',
            model: 'mock-model',
            ...(currentVariant === undefined ? {} : { reasoningEffort: currentVariant }),
          },
          routable: true,
          groups: [],
          failures: [],
        }),
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request.payload })
          currentVariant = (request.payload as { reasoningEffort?: string }).reasoningEffort
          return okRpc({
            selected: { provider: 'deepseek-official', model: 'mock-model', reasoningEffort: currentVariant },
          })
        },
      },
    })
    const { server } = await boot(api)
    await request(server, 'POST', '/api/session/s1/model', {
      model: { providerID: 'deepseek', modelID: 'mock-model', variant: 'high' },
    })
    expect(calls).toHaveLength(1)

    // dsh loses the reasoning effort (model re-selection / preset switch).
    currentVariant = undefined
    await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'probe' }],
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: 's1',
        provider: 'deepseek-official',
        model: 'mock-model',
        reasoningEffort: 'high',
      },
    })
  })

  it('passes agentPreset into session.create and selects the create model', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [{ id: 'minimal', trust: 'system', isDefault: true }],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => okRpc({ agentPreset: 'minimal' }),
      },
      sessions: {
        ...base.sessions,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request.payload })
          return okRpc({ sessionId: 'new-session' as never })
        },
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request.payload })
          return okRpc({
            selected: {
              provider: 'deepseek-official',
              model: 'mock-model',
              reasoningEffort: 'max',
            },
          })
        },
      },
    }
    const { server } = await boot(api)
    const created = await request(server, 'POST', '/session', {
      title: 'With Preset',
      agent: 'minimal',
      model: { providerID: 'deepseek', id: 'mock-model', variant: 'max' },
    })
    expect(created.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.create',
      payload: { cwd: '/work', agentPreset: 'minimal' },
    })
    expect(calls[1]).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: 'new-session',
        provider: 'deepseek-official',
        model: 'mock-model',
        reasoningEffort: 'max',
      },
    })
  })

  it('applies the model carried by an existing-session prompt body', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request.payload })
          return okRpc({
            selected: {
              provider: 'deepseek-official',
              model: 'mock-model',
              reasoningEffort: 'off',
            },
          })
        },
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)
    const prompted = await request(server, 'POST', '/session/s1/message', {
      model: { providerID: 'deepseek', modelID: 'mock-model', variant: 'off' },
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(prompted.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: 's1',
        provider: 'deepseek-official',
        model: 'mock-model',
        reasoningEffort: 'off',
      },
    })
    expect(calls[1]).toMatchObject({
      method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue' },
    })
  })

  it('applies the Tab-selected agent carried in prompt bodies', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: true },
            { id: 'standard', trust: 'system', isDefault: false },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async (request) => {
          calls.push({ method: 'agentPreset.select', payload: request.payload })
          return okRpc({ agentPreset: 'standard' })
        },
      },
      sessions: {
        ...base.sessions,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server } = await boot(api)
    for (const path of ['/session/s1/message', '/session/s1/prompt', '/api/session/s1/prompt']) {
      const result = await request(server, 'POST', path, {
        agent: 'standard',
        parts: [{ type: 'text', text: 'hi' }],
      })
      expect(result.status).toBe(200)
    }
    const asyncResult = await request(server, 'POST', '/session/s1/prompt_async', {
      agent: 'standard',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(asyncResult.status).toBe(204)
    const selects = calls.filter((call) => call.method === 'agentPreset.select')
    expect(selects).toHaveLength(4)
    expect(selects[0]).toMatchObject({
      method: 'agentPreset.select',
      payload: { sessionId: 's1', agentPreset: 'standard' },
    })
  })

  it('does not switch agents when the prompt carries the default build agent', async () => {
    const base = fakeApi()
    let selects = 0
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [{ id: 'minimal', trust: 'system', isDefault: true }],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => {
          selects += 1
          return okRpc({ agentPreset: 'minimal' })
        },
      },
      sessions: {
        ...base.sessions,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/message', {
      agent: 'build',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(result.status).toBe(200)
    expect(selects).toBe(0)
  })

  it('notifies once when the prompt agent is locked by dsh', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: true },
            { id: 'standard', trust: 'system', isDefault: false },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => errRpc('agent-preset-locked', 'agent preset is fixed'),
      },
      sessions: {
        ...base.sessions,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server, router } = await boot(api)
    const hub = router.ctx.hub
    const originalBroadcast = hub.broadcast.bind(hub)
    const notices: string[] = []
    ;(hub as unknown as {
      broadcast(events: Array<{ payload: { type?: string; properties?: { part?: { text?: string } } } }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        if (event.payload.type === 'message.part.updated') {
          const text = event.payload.properties?.part?.text
          if (typeof text === 'string') notices.push(text)
        }
      }
      originalBroadcast(events as never)
    }
    for (let index = 0; index < 2; index++) {
      const result = await request(server, 'POST', '/session/s1/message', {
        agent: 'standard',
        parts: [{ type: 'text', text: 'hi' }],
      })
      expect(result.status).toBe(200)
    }
    const locked = notices.filter((text) => text.includes('Agent switch locked'))
    expect(locked).toHaveLength(1)
  })

  it('switches blank-session agents and maps agent-preset-locked to 409', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: false },
            { id: 'standard', trust: 'system', isDefault: true },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async (request) => {
          calls.push({ method: 'agentPreset.select', payload: request.payload })
          const payload = request.payload as { agentPreset?: string }
          if (payload.agentPreset === 'standard') {
            return errRpc('agent-preset-locked', 'session has already produced turns')
          }
          return okRpc({ agentPreset: 'minimal' })
        },
      },
    }
    const { server } = await boot(api)
    const switched = await request(server, 'POST', '/api/session/s1/agent', { agent: 'minimal' })
    expect(switched.status).toBe(204)
    expect(calls[0]).toMatchObject({
      method: 'agentPreset.select',
      payload: { sessionId: 's1', agentPreset: 'minimal' },
    })

    const locked = await request(server, 'POST', '/api/session/s1/agent', { agent: 'standard' })
    expect(locked.status).toBe(409)
    expect(locked.body).toMatchObject({ name: 'ConflictError' })
  })

  it('serves /preset list and switch through the command route', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: false },
            { id: 'standard', trust: 'system', isDefault: true },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async (request) => {
          calls.push({ method: 'agentPreset.select', payload: request.payload })
          return okRpc({ agentPreset: 'minimal' })
        },
      },
    }
    const { server } = await boot(api)
    const listed = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: '',
    })
    expect(listed.status).toBe(200)
    expect((listed.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('standard')
    expect((listed.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('(default)')

    const slashListed = await request(server, 'POST', '/session/s1/command', {
      command: '/preset',
      arguments: '',
    })
    expect(slashListed.status).toBe(200)

    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'minimal',
    })
    expect(switched.status).toBe(200)
    expect((switched.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      'Switched dsh agent preset to minimal',
    )
    expect(calls[0]).toMatchObject({
      method: 'agentPreset.select',
      payload: { sessionId: 's1', agentPreset: 'minimal' },
    })
  })

  it('inherits the last selected preset into newly created sessions', async () => {
    const base = fakeApi()
    const createCalls: Array<{ agentPreset?: string }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: true },
            { id: 'standard', trust: 'system', isDefault: false },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => okRpc({ agentPreset: 'standard' }),
      },
      sessions: {
        ...base.sessions,
        create: async (request) => {
          createCalls.push(request.payload as { agentPreset?: string })
          return okRpc({ sessionId: 's-new' as never })
        },
      },
    }
    const { server } = await boot(api)
    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'standard',
    })
    expect(switched.status).toBe(200)
    const created = await request(server, 'POST', '/session', {})
    expect(created.status).toBe(200)
    expect(createCalls.at(-1)?.agentPreset).toBe('standard')
  })

  it('broadcasts the new agent through session.updated after /preset switch', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: true },
            { id: 'standard', trust: 'system', isDefault: false },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => okRpc({ agentPreset: 'standard' }),
      },
    }
    const { server, router } = await boot(api)
    const hub = router.ctx.hub
    const originalBroadcast = hub.broadcast.bind(hub)
    const broadcasts: Array<{ type?: string; agent?: string }> = []
    ;(hub as unknown as {
      broadcast(events: Array<{ payload: { type?: string; properties?: { info?: { agent?: string } } } }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        broadcasts.push({
          type: event.payload.type,
          agent: event.payload.properties?.info?.agent,
        })
      }
      originalBroadcast(events as never)
    }
    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'standard',
    })
    expect(switched.status).toBe(200)
    expect(broadcasts).toContainEqual({ type: 'session.updated', agent: 'standard' })
  })

  it('captures /preset from prompt routes without triggering a model turn', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [
            { id: 'minimal', trust: 'system', isDefault: false },
            { id: 'standard', trust: 'system', isDefault: true },
          ],
          authorable: false,
          hasDocument: false,
        }),
        select: async (request) => {
          calls.push({ method: 'agentPreset.select', payload: request.payload })
          return okRpc({ agentPreset: 'minimal' })
        },
      },
      sessions: {
        ...base.sessions,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)

    const listed = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/preset' }],
    })
    expect(listed.status).toBe(200)
    expect((listed.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('standard')
    expect((listed.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('(default)')

    const switched = await request(server, 'POST', '/session/s1/prompt', {
      parts: [{ type: 'text', text: '/preset minimal' }],
    })
    expect(switched.status).toBe(200)
    expect((switched.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      'Switched dsh agent preset to minimal',
    )

    const v2Listed = await request(server, 'POST', '/api/session/s1/prompt', {
      parts: [{ type: 'text', text: '/preset' }],
    })
    expect(v2Listed.status).toBe(200)
    expect(v2Listed.body).toMatchObject({ data: { sessionID: 's1', delivery: 'queue' } })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'agentPreset.select',
      payload: { sessionId: 's1', agentPreset: 'minimal' },
    })
    expect(calls.some((call) => call.method === 'session.prompt')).toBe(false)
  })

  it('serves /help through the command route and prompt capture without a model turn', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)

    const cmd = await request(server, 'POST', '/session/s1/command', {
      command: 'help',
      arguments: '',
    })
    expect(cmd.status).toBe(200)
    const cmdText = (cmd.body as { parts: Array<{ text: string }> }).parts[0]?.text
    expect(cmdText).toContain('dsh-oc')
    expect(cmdText).toContain('docs/FEATURES.md')

    const slash = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/help' }],
    })
    expect(slash.status).toBe(200)
    expect((slash.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('核心能力')
    expect(calls).toHaveLength(0)
  })

  it('surfaces unknown /preset switches as command errors', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        list: async () => okRpc({
          presets: [{ id: 'minimal', trust: 'system', isDefault: true }],
          authorable: false,
          hasDocument: false,
        }),
        select: async () => okRpc({ agentPreset: 'minimal' }),
      },
      sessions: {
        ...base.sessions,
        prompt: async () => {
          throw new Error('session.prompt must not be called for /preset')
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/preset nope' }],
    })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      name: 'BadRequest',
      message: 'agent "nope" is not a switchable dsh preset',
      data: { code: 'command-error' },
    })
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

  it('answers the SDK permission alias route with the response field', async () => {
    const responses: ClientResponse[] = []
    const base = fakeApi({ respond: async (message) => {
      responses.push(message)
      return { accepted: true }
    } })
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p4',
      rpcId: 'rpc-p4',
      sessionId: 's1',
      approvalId: 'a4',
      toolName: 'bash',
    })
    const replied = await request(server, 'POST', '/session/s1/permissions/p4', { response: 'always' })
    expect(replied.status).toBe(200)
    expect(replied.body).toBe(true)
    expect(responses[0]?.result).toMatchObject({ ok: true, value: { outcome: 'allowed-once' } })
    const saved = await request(server, 'GET', '/api/permission/saved')
    expect((saved.body as { data: Array<{ id: string; sessionID: string; action: string; resource: string }> }).data)
      .toMatchObject([{
        id: 's1:bash',
        projectID: expect.any(String),
        action: 'bash',
        resource: 'bash',
        sessionID: 's1',
      }])
  })

  it('lists permission/question requests with location on the v2 aliases', async () => {
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p5',
      rpcId: 'rpc-p5',
      sessionId: 's1',
      approvalId: 'a5',
      toolName: 'bash',
    })
    router.ctx.state.registerQuestion({
      opencodeId: 'q5',
      rpcId: 'rpc-q5',
      sessionId: 's1',
      items: [{ id: 'dq5', question: 'Go?', options: [{ label: 'Yes' }] }],
    })
    const permissions = await request(server, 'GET', '/api/permission/request')
    expect(permissions.status).toBe(200)
    expect(permissions.body).toMatchObject({
      location: { directory: '/work' },
      data: [{ id: 'p5', sessionID: 's1', action: 'bash' }],
    })
    const questions = await request(server, 'GET', '/api/question/request')
    expect(questions.status).toBe(200)
    expect(questions.body).toMatchObject({
      location: { directory: '/work' },
      data: [{ id: 'q5', sessionID: 's1', questions: [{ question: 'Go?' }] }],
    })
  })

  it('gets one session permission by request id and 404s on mismatch', async () => {
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.registerApproval({
      opencodeId: 'p6',
      rpcId: 'rpc-p6',
      sessionId: 's1',
      approvalId: 'a6',
      toolName: 'edit',
    })
    const found = await request(server, 'GET', '/api/session/s1/permission/p6')
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({ data: { id: 'p6', sessionID: 's1', action: 'edit' } })
    expect((await request(server, 'GET', '/api/session/s2/permission/p6')).status).toBe(404)
    expect((await request(server, 'GET', '/api/session/s1/permission/nope')).status).toBe(404)
  })

  it('removes saved permissions via DELETE and 404s for unknown ids', async () => {
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.savePermission('s1', 'bash')
    router.ctx.state.savePermission('s1', 'edit')
    const removed = await request(server, 'DELETE', '/api/permission/saved/s1:bash')
    expect(removed.status).toBe(204)
    const saved = await request(server, 'GET', '/api/permission/saved')
    expect((saved.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id))
      .toEqual(['s1:edit'])
    expect((await request(server, 'DELETE', '/api/permission/saved/s1:bash')).status).toBe(404)
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

describe('bridge router: /goal command and goal todo merge', () => {
  const activeGoal = {
    goal: {
      id: 'g1',
      revision: 1,
      objective: 'ship goal support',
      phase: 'active',
      maxGoalRounds: 5,
    },
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
  }

  function commandApi(lines: string[], texts: Record<string, string> = {}) {
    const base = fakeApi()
    return {
      ...base,
      agents: {
        get: () => ({ id: 's1' }),
      },
      commands: {
        execute: async (_agent: unknown, line: string) => {
          lines.push(line)
          const text = texts[line]
            ?? (line === '/goal'
              ? 'No goal is currently set.\nUsage: /goal [<objective>|clear|edit <objective>|pause|resume]'
              : `Goal created: ${line.slice('/goal '.length)}`)
          return { commandId: 'cmd-goal', result: { kind: 'success' as const, text } }
        },
      },
    }
  }

  it('runs /goal list and create through the command registry', async () => {
    const lines: string[] = []
    const { server } = await boot(commandApi(lines))

    const listed = await request(server, 'POST', '/session/s1/command', {
      command: 'goal',
      arguments: '',
    })
    expect(listed.status).toBe(200)
    expect((listed.body as { parts: Array<{ text: string }> }).parts[0]?.text).toContain('No goal')

    const created = await request(server, 'POST', '/session/s1/command', {
      command: '/goal',
      arguments: 'ship goal support',
    })
    expect(created.status).toBe(200)
    expect((created.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      'Goal created: ship goal support',
    )
    expect(lines).toEqual(['/goal', '/goal ship goal support'])
  })

  it('appends a queue backlog hint to slash outcomes', async () => {
    const lines: string[] = []
    const { server, router } = await boot(commandApi(lines))
    router.ctx.state.applyInboxSplice('s1', 'next-turn', 0, 0, [{
      id: 'queued-x',
      content: [{ type: 'text', text: 'older queued prompt' }],
      source: { kind: 'user' },
    }], 1000)

    const created = await request(server, 'POST', '/session/s1/command', {
      command: 'goal',
      arguments: 'ship queue hint',
    })
    expect(created.status).toBe(200)
    expect((created.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      'Goal created: ship queue hint\n\n[dsh-oc] 队列中还有 1 条消息待处理，将按原顺序继续执行',
    )
  })

  it('completes the current goal through the goals API', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [],
          hasMore: false,
          projections: { asOfSeq: 1, values: { goal: activeGoal } },
        } as never),
      },
      goals: {
        ...base.goals,
        complete: async (request) => {
          calls.push({ method: 'goal.complete', payload: request.payload })
          return okRpc({ ref: { id: 'g1' as never, revision: 2 } })
        },
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/command', {
      command: 'goal',
      arguments: 'complete',
    })
    expect(result.status).toBe(200)
    expect((result.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe('Goal completed')
    expect(calls[0]).toMatchObject({
      method: 'goal.complete',
      payload: { sessionId: 's1', ref: { id: 'g1', revision: 1 } },
    })
  })

  it('captures /goal from prompt routes without triggering a model turn', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const lines: string[] = []
    const api: BridgeApi = {
      ...base,
      sessions: {
        ...base.sessions,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request.payload })
          return okRpc({ accepted: true })
        },
      },
      agents: {
        get: () => ({ id: 's1' }),
      },
      commands: {
        execute: async (_agent: unknown, line: string) => {
          lines.push(line)
          return { commandId: 'cmd-goal', result: { kind: 'success' as const, text: `Goal created: ${line.slice('/goal '.length)}` } }
        },
      },
    }
    const { server } = await boot(api)

    const created = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/goal ship goal support' }],
    })
    expect(created.status).toBe(200)
    expect((created.body as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      'Goal created: ship goal support',
    )
    expect(lines).toEqual(['/goal ship goal support'])
    expect(calls).toHaveLength(0)
  })

  it('surfaces /goal command errors as 400 command errors', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: { get: () => ({ id: 's1' }) },
      commands: {
        execute: async () => ({
          commandId: 'cmd-goal',
          result: { kind: 'error' as const, text: 'Goal editing requires a replacement objective.' },
        }),
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/command', {
      command: 'goal',
      arguments: 'edit',
    })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      name: 'BadRequest',
      data: { code: 'command-error' },
    })
  })

  it('returns goal-first todos from the goal projection', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [
            { event: sessionEvent('todo/write', { todos: [{ content: 'step 1', status: 'in_progress' }] }, 1, 100) },
          ],
          hasMore: false,
          projections: {
            asOfSeq: 1,
            values: {
              goal: activeGoal,
              todos: [{ content: 'step 1', status: 'in_progress' }],
            } as never,
          },
        }),
      },
    }
    const { server } = await boot(api)
    const todo = await request(server, 'GET', '/session/s1/todo')
    expect(todo.status).toBe(200)
    expect(todo.body).toMatchObject([
      { id: 'goal:g1', content: 'Goal: ship goal support', status: 'in_progress', priority: 'high' },
      { content: 'step 1', status: 'in_progress', priority: 'medium' },
    ])
  })

  it('folds the latest goal/change when no projection exists and clears with a tombstone', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessions: {
        ...base.sessions,
        history: async () => okRpc({
          events: [
            { event: sessionEvent('todo/write', { todos: [{ content: 'step 1', status: 'pending' }] }, 1, 100) },
            { event: sessionEvent('goal/change', { operation: 'create', goal: activeGoal.goal }, 2, 200) },
            { event: sessionEvent('goal/change', {
              operation: 'edit',
              goal: { ...activeGoal.goal, revision: 2, objective: 'ship goal support v2' },
            }, 3, 300) },
          ],
          hasMore: false,
        }),
      },
    }
    const { server } = await boot(api)
    const todo = await request(server, 'GET', '/session/s1/todo')
    expect(todo.body).toMatchObject([
      { content: 'Goal: ship goal support v2', status: 'in_progress' },
      { content: 'step 1', status: 'pending' },
    ])

    const clearedApi = {
      ...fakeApi(),
      sessions: {
        ...fakeApi().sessions,
        history: async () => okRpc({
          events: [
            { event: sessionEvent('goal/change', {
              operation: 'clear',
              cleared: { id: 'g1', revision: 3 },
              clearedAt: 400,
            }, 4, 400) },
          ],
          hasMore: false,
        }),
      },
    }
    const cleared = await boot(clearedApi)
    expect((await request(cleared.server, 'GET', '/session/s1/todo')).body).toEqual([])
  })
})

describe('bridge router: projection state seed', () => {
  it('seeds goals and todos from durable history and keeps live state', async () => {
    const api = fakeApi({
      sessions: {
        ...fakeApi().sessions,
        history: async () => okRpc({
          events: [{
            event: sessionEvent('todo/write', {
              todos: [{ content: 'step one', status: 'pending' as const }],
            }, 1, 100),
          }],
          hasMore: false,
          projections: {
            asOfSeq: 100,
            values: {
              goal: {
                goal: {
                  id: 'g-seed',
                  objective: 'ship seeded goal',
                  phase: 'active',
                  maxGoalRounds: 5,
                },
              },
            },
          },
        } as never),
      },
    })
    const { router } = await boot(api)
    const state = { todos: new Map<string, unknown>(), goals: new Map<string, unknown>() }
    await seedProjectionState(router.ctx, state, 's1')
    expect(state.todos.get('s1')).toEqual([{ content: 'step one', status: 'pending' }])
    expect(state.goals.get('s1')).toMatchObject({
      goal: { id: 'g-seed', objective: 'ship seeded goal', phase: 'active' },
    })

    // Live projection state wins over the historical seed.
    state.goals.set('s1', { goal: { id: 'g-live', objective: 'live', phase: 'active' } })
    await seedProjectionState(router.ctx, state, 's1')
    expect(state.goals.get('s1')).toMatchObject({ goal: { id: 'g-live' } })
  })
})

describe('bridge router: prompt queue delivery', () => {
  it('delivers every submit to the dsh queue, including identical texts', async () => {
    const calls: string[] = []
    const api = fakeApi({
      sessions: {
        ...fakeApi().sessions,
        prompt: async (request) => {
          const payload = request.payload as { content: Array<{ type: string; text?: string }> }
          calls.push(String(payload.content[0]?.text ?? ''))
          return okRpc({ accepted: true })
        },
      },
    })
    const { server } = await boot(api)
    const submit = (text: string) => request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text }],
    })
    await submit('same')
    await submit('same')
    expect(calls).toEqual(['same', 'same'])
    await submit('different')
    expect(calls).toEqual(['same', 'same', 'different'])
  })
})
