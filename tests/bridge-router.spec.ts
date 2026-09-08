import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createBridgeRouter, hostSessionAddedEvents, recordSessionSummaries, type BridgeRouter } from '../src/bridge/router.js'
import { installSessionEventsCompat, installSessionEventsOnLiveSessions } from '../src/bridge/index.js'
import {
  extractParams,
  historyCacheKey,
  matchPattern,
  seedDerivedHistoryPage,
  seedProjectionState,
} from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import type { BridgeApi } from '../src/bridge/rpc.js'
import { expandRecord } from '../src/bridge/rpc.js'
import type { BridgeHostFrame, ToolEventView } from '../src/bridge/dsh-types.js'
import { InteractionState } from '../src/bridge/state.js'
import { SHELL_CONTEXT_WARNING_LIMIT_BYTES } from '../src/bridge/shell.js'
import {
  errRpc,
  fakeApi,
  makeAssistantEvent,
  makeUserEvent,
  okRpc,
  sessionEvent,
} from './helpers.js'

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
  it('does not seed a 100-message cache from a partial default history window', () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    seedDerivedHistoryPage(router.ctx, 's-partial', {
      events: Array.from({ length: 50 }, () => ({ event: sessionEvent('turn/start', { turn: 1 }) })) as never,
      hasMore: true,
    }, {})
    expect(router.ctx.state.getHistoryCache(historyCacheKey('s-partial', 100), 1000)).toBeUndefined()
  })

  it('expands packed chunk rows with the final dt end time', () => {
    const [entry] = expandRecord({
      type: 'chunks',
      event: {
        type: 'chunkrow/text-chunks',
        seq: 10,
        time: 100,
        data: { turn: 1, step: 1, index: 0, dt: [10, 20], texts: ['a', 'b', 'c'] },
      },
    } as never)
    expect(entry?.event.time).toBe(130)
    expect((entry?.event as { time0?: number }).time0).toBe(100)
  })

  it('bridges the removed Session.events getter for older profile plugins', () => {
    class SessionFixture {
      snapshotEvents(): readonly unknown[] {
        return [{ type: 'turn/start' }]
      }
    }
    const session = new SessionFixture()
    expect(installSessionEventsCompat(session)).toBe(true)
    expect((session as unknown as { events: unknown[] }).events).toEqual([{ type: 'turn/start' }])
    expect(installSessionEventsCompat(session)).toBe(false)
  })

  it('installs the compatibility getter on every live session during bridge init', () => {
    class SessionFixture {
      snapshotEvents(): readonly unknown[] { return [] }
    }
    const sessions = { list: () => [new SessionFixture(), new SessionFixture()] }
    expect(installSessionEventsOnLiveSessions(sessions)).toBe(1)
    expect((sessions.list()[0] as unknown as { events: unknown[] }).events).toEqual([])
  })

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
      sessionController: {
        ...base.sessionController,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request })
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
      agentPresets: {
        ...base.agentPresets,
        defaultId: undefined as never,
      },
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
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
        model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      },
    ])
    const v2 = await request(server, 'GET', '/api/agent')
    expect(v2.status).toBe(200)
    expect(v2.body).toMatchObject({
      location: { directory: '/work' },
      data: [{ id: 'build', mode: 'primary', hidden: false, model: { id: 'deepseek-chat', providerID: 'deepseek' } }],
    })
  })

  it('advertises the configured default preset first so the fresh TUI shows it', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => 'minimal',
      },
    }
    const { server } = await boot(api)
    const v1 = await request(server, 'GET', '/agent')
    const names = (v1.body as Array<{ name: string }>).map((agent) => agent.name)
    expect(names[0]).toBe('minimal')
    expect(names).not.toContain('build')
    expect(names).toEqual(['minimal', 'standard'])
    const v2 = await request(server, 'GET', '/api/agent')
    expect((v2.body as { data: Array<{ id: string }> }).data.map((agent) => agent.id)).toEqual([
      'minimal',
      'standard',
    ])
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
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item] }) },
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

  it('serves repeated status polls from memory instead of rescanning the corpus', async () => {
    let listCalls = 0
    const items = Array.from({ length: 1000 }, (_, index) => ({
      ...item,
      sessionId: `s-${index}` as never,
      cwd: index % 2 === 0 ? '/work' : '/other',
      running: index === 6,
      updatedAt: index,
    }))
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        list: async () => {
          listCalls++
          return okRpc({ items })
        },
      },
    }
    const { server, router } = await boot(api)
    for (let index = 0; index < 100; index++) {
      const result = await request(server, 'GET', '/session/status?directory=/work')
      expect(result.status).toBe(200)
      expect((result.body as Record<string, unknown>)['s-6']).toEqual({ type: 'busy' })
    }
    expect(listCalls).toBe(1)
    expect(router.ctx.state.sessionStatusRequests).toBe(100)
    expect(router.ctx.state.sessionStatusSeeds).toBe(1)

    router.feedHostFrame({ type: 'host/session-status', sessionId: 's-6', running: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const idle = await request(server, 'GET', '/session/status?directory=/work')
    expect((idle.body as Record<string, unknown>)['s-6']).toEqual({ type: 'idle' })
    expect(listCalls).toBe(1)
  })

  it('tracks turn start/end edges in the authoritative status map', async () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    await router.feed({
      type: 'session/event',
      sessionId: 's-turn',
      event: sessionEvent('turn/start', { turn: 1 }, 10, 100),
    })
    expect(router.ctx.state.sessionRunningFor('s-turn')).toBe(true)
    await router.feed({
      type: 'session/event',
      sessionId: 's-turn',
      event: sessionEvent('turn/end', { turn: 1 }, 11, 200),
    })
    expect(router.ctx.state.sessionRunningFor('s-turn')).toBe(false)
    expect(router.ctx.state.sessionStatusUpdatedAtFor('s-turn')).toBe(200)
  })

  it('broadcasts one live status edge when turn and host sources overlap', async () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    const writes: string[] = []
    const fakeRes = {
      write: (chunk: string) => { writes.push(chunk); return true },
      on: () => fakeRes,
      destroyed: false,
    }
    const client = router.ctx.hub.add(fakeRes as never)

    await router.feed({
      type: 'session/event',
      sessionId: 's-status-dedupe',
      event: sessionEvent('turn/start', { turn: 1 }, 10, 100),
    })
    router.feedHostFrame({
      type: 'host/session-status',
      sessionId: 's-status-dedupe',
      running: true,
      updatedAt: 100,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await router.feed({
      type: 'session/event',
      sessionId: 's-status-dedupe',
      event: sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 11, 200),
    })
    router.feedHostFrame({
      type: 'host/session-status',
      sessionId: 's-status-dedupe',
      running: false,
      updatedAt: 200,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const statuses = writes
      .map((wire) => wire.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(6)) as { payload: { type: string; properties: { status?: { type?: string } } } })
      .filter((event) => event.payload.type === 'session.status')
      .map((event) => event.payload.properties.status?.type)
    expect(statuses).toEqual(['busy', 'idle'])

    router.feedHostFrame({ type: 'host/session-removed', sessionId: 's-status-dedupe' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await router.feed({
      type: 'session/event',
      sessionId: 's-status-dedupe',
      event: sessionEvent('turn/start', { turn: 2 }, 20, 300),
    })
    const afterRemoval = writes
      .map((wire) => wire.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(6)) as { payload: { type: string; properties: { status?: { type?: string } } } })
      .filter((event) => event.payload.type === 'session.status')
      .map((event) => event.payload.properties.status?.type)
    expect(afterRemoval).toEqual(['busy', 'idle', 'busy'])
    router.ctx.hub.remove(client)
  })

  it('rejects stale host status edges but lets a later equal-time edge win', async () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    await router.feed({
      type: 'session/event',
      sessionId: 's-race',
      event: sessionEvent('turn/start', { turn: 1 }, 10, 200),
    })

    router.feedHostFrame({ type: 'host/session-status', sessionId: 's-race', running: false, updatedAt: 100 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(router.ctx.state.sessionRunningFor('s-race')).toBe(true)
    expect(router.ctx.state.sessionStatusUpdatedAtFor('s-race')).toBe(200)

    // Strictly older edges are ignored; equal timestamps preserve the
    // serialized queue order, so this later edge is authoritative.
    router.feedHostFrame({ type: 'host/session-status', sessionId: 's-race', running: false, updatedAt: 200 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(router.ctx.state.sessionRunningFor('s-race')).toBe(false)
    expect(router.ctx.state.sessionStatusUpdatedAtFor('s-race')).toBe(200)

    router.feedHostFrame({
      type: 'host/session-added',
      sessionId: 's-race',
      summary: { sessionId: 's-race', running: true, cwd: '/work' } as never,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(router.ctx.state.sessionRunningFor('s-race')).toBe(false)
  })

  it('warms real session titles from history projections into the list', async () => {
    let historyCalls = 0
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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

  it('serves v2 session history with an after cursor and limit', async () => {
    const base = fakeApi()
    const events = [
      { event: sessionEvent('user/message', {
        id: 'm1' as never,
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }, 2, 1000) },
      { event: sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'm2' as never,
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
        },
      }, 3, 1100) },
      { event: sessionEvent('user/message', {
        id: 'm3' as never,
        content: [{ type: 'text', text: 'bye' }],
        source: { kind: 'user' },
      }, 4, 1200) },
    ]
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: async (request) => {
          const payload = request as { maxMessages?: number; beforeSeq?: number }
          let window = events
          const beforeSeq = payload.beforeSeq
          if (beforeSeq !== undefined) {
            window = events.filter((entry) => entry.event.seq < beforeSeq)
          }
          const max = payload.maxMessages ?? events.length
          const tail = window.slice(-max)
          return okRpc({
            events: tail,
            hasMore: window.length > tail.length,
          })
        },
      },
    }
    const { server } = await boot(api)

    const all = await request(server, 'GET', '/api/session/s1/history')
    expect(all.status).toBe(200)
    const allBody = all.body as { data?: unknown[]; hasMore?: boolean; next?: number }
    expect(allBody).toMatchObject({ hasMore: false })
    expect(allBody.data).toHaveLength(3)
    expect(allBody.next).toBeNull()

    const page = await request(server, 'GET', '/api/session/s1/history?limit=1')
    expect(page.status).toBe(200)
    const pageBody = page.body as { data?: unknown[]; hasMore?: boolean; next?: number }
    expect(pageBody.data).toHaveLength(1)
    expect(pageBody.hasMore).toBe(true)
    expect(pageBody.next).toBe(4)

    const older = await request(server, 'GET', '/api/session/s1/history?after=3')
    expect(older.status).toBe(200)
    const olderBody = older.body as { data?: unknown[]; hasMore?: boolean }
    expect(olderBody.data).toHaveLength(1)
    expect(olderBody.hasMore).toBe(false)

    const empty = await request(server, 'GET', '/api/session/s1/history?after=2')
    expect(empty.status).toBe(200)
    expect((empty.body as { data?: unknown[] }).data).toHaveLength(0)

    const bad = await request(server, 'GET', '/api/session/s1/history?after=-1')
    expect(bad.status).toBe(400)
  })

  it('merges same-bridge-id tool and follow-up steps in history responses', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: async () => okRpc({
          events: [
            { event: makeUserEvent('hello', 'm-user', 1000) },
            {
              event: makeAssistantEvent([
                { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
              ], 'dsh-tool', 1100),
            },
            {
              event: makeAssistantEvent([
                { type: 'text', text: 'follow-up' },
              ], 'dsh-text', 1200),
            },
          ],
          hasMore: false,
        }),
      },
    }
    const { server, router } = await boot(api)
    router.ctx.state.recordAssistantId('s1', 'dsh-tool', 'msg_turn_1')
    router.ctx.state.recordAssistantId('s1', 'dsh-text', 'msg_turn_1')

    const v1 = await request(server, 'GET', '/session/s1/message')
    expect(v1.status).toBe(200)
    const v1Body = v1.body as Array<{ info: { id?: string; role?: string }; parts: Array<{ type?: string }> }>
    const assistants = v1Body.filter((entry) => entry.info.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.info.id).toBe('msg_turn_1')
    expect(assistants[0]?.parts.map((part) => part.type)).toEqual(['tool', 'text'])

    const v2 = await request(server, 'GET', '/api/session/s1/message')
    expect(v2.status).toBe(200)
    const v2Body = v2.body as { data?: Array<{ id?: string; type?: string; content?: Array<{ type?: string }> }> }
    const v2Assistants = v2Body.data?.filter((entry) => entry.type === 'assistant') ?? []
    expect(v2Assistants).toHaveLength(1)
    expect(v2Assistants[0]?.id).toBe('msg_turn_1')
    expect(v2Assistants[0]?.content?.map((part) => part.type)).toEqual(['tool', 'text'])
  })

  it('resolves tool calls across history page boundaries', async () => {
    const withSeq = (event: SessionEvent, seq: number): SessionEvent =>
      ({ ...event, seq }) as SessionEvent
    const events = [
      { event: withSeq(makeUserEvent('u1', 'm1', 1000), 1) },
      {
        event: withSeq(makeAssistantEvent([
          { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
        ], 'asst-tool', 1100), 2),
      },
      { event: withSeq(sessionEvent('tool/call', {
        turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}',
      }, 3, 1200), 3) },
      { event: withSeq(sessionEvent('tool/result', {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{
            type: 'tool-result', toolCallId: 'c1',
            content: [{ type: 'text', text: 'out' }],
          }],
          role: 'assistant',
          id: 'r1',
        },
      }, 4, 1300), 4) },
      { event: withSeq(makeUserEvent('u2', 'm2', 1400), 5) },
      { event: withSeq(makeAssistantEvent([{ type: 'text', text: 'reply2' }], 'asst-text', 1500), 6) },
    ]
    const api: BridgeApi = {
      ...fakeApi(),
      sessionController: {
        ...fakeApi().sessionController,
        history: async (request) => {
          const payload = request as { maxMessages?: number; beforeSeq?: number }
          let window = events
          const beforeSeq = payload.beforeSeq
          if (beforeSeq !== undefined) {
            window = events.filter((entry) => entry.event.seq < beforeSeq)
          }
          const max = payload.maxMessages ?? events.length
          const tail = window.slice(-max)
          return okRpc({ events: tail, hasMore: window.length > tail.length })
        },
      },
    }
    const { server } = await boot(api)

    // limit=4 cuts the boundary inside the tool turn: the newest page holds
    // tool/call + tool/result + u2 + reply2, the older page holds u1 + the
    // assistant tool-call message.
    const newer = await request(server, 'GET', '/api/session/s1/history?limit=4')
    expect(newer.status).toBe(200)
    const newerBody = newer.body as { data?: Array<{ type: string; content?: Array<{ type: string }> }>; hasMore?: boolean; next?: number }
    expect(newerBody.hasMore).toBe(true)

    const older = await request(server, 'GET', `/api/session/s1/history?after=${newerBody.next}`)
    expect(older.status).toBe(200)
    const olderBody = older.body as { data?: Array<{ type: string; content?: Array<{ type: string }> }>; hasMore?: boolean }
    expect(olderBody.hasMore).toBe(false)

    // Combined pages must contain the tool part exactly once and completed.
    const combined = [...(olderBody.data ?? []), ...(newerBody.data ?? [])]
    const toolParts = combined.flatMap((m) => (m.content ?? []).filter((p) => p.type === 'tool'))
    expect(toolParts).toHaveLength(1)
    expect((toolParts[0] as { state?: { status?: string } }).state?.status).toBe('completed')
    expect(combined.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('keeps pagination stable when messages append between pages', async () => {
    const withSeq = (event: SessionEvent, seq: number): SessionEvent =>
      ({ ...event, seq }) as SessionEvent
    const events = [
      { event: withSeq(makeUserEvent('u1', 'm1', 1000), 1) },
      { event: withSeq(makeAssistantEvent([{ type: 'text', text: 'a1' }], 'a1', 1100), 2) },
      { event: withSeq(makeUserEvent('u2', 'm2', 1200), 3) },
      { event: withSeq(makeAssistantEvent([{ type: 'text', text: 'a2' }], 'a2', 1300), 4) },
    ]
    const api: BridgeApi = {
      ...fakeApi(),
      sessionController: {
        ...fakeApi().sessionController,
        history: async (request) => {
          const payload = request as { maxMessages?: number; beforeSeq?: number }
          let window = events
          const beforeSeq = payload.beforeSeq
          if (beforeSeq !== undefined) {
            window = events.filter((entry) => entry.event.seq < beforeSeq)
          }
          const max = payload.maxMessages ?? events.length
          const tail = window.slice(-max)
          return okRpc({ events: tail, hasMore: window.length > tail.length })
        },
      },
    }
    const { server } = await boot(api)

    const page = await request(server, 'GET', '/api/session/s1/history?limit=1')
    const pageBody = page.body as { data?: Array<{ text?: string }>; hasMore?: boolean; next?: number }
    const textOf = (m: { text?: string; content?: Array<{ text?: string }> }): string =>
      m.text ?? m.content?.[0]?.text ?? ''
    expect(pageBody.data?.[0] && textOf(pageBody.data[0])).toBe('a2')
    expect(pageBody.next).toBe(4)

    // A new turn is appended after the first page was fetched.
    events.push(
      { event: withSeq(makeUserEvent('u3', 'm3', 1400), 5) },
      { event: withSeq(makeAssistantEvent([{ type: 'text', text: 'a3' }], 'a3', 1500), 6) },
    )

    const older = await request(server, 'GET', `/api/session/s1/history?after=${pageBody.next}`)
    const olderBody = older.body as { data?: Array<{ text?: string }>; hasMore?: boolean }
    expect(olderBody.data?.map(textOf)).toEqual(['u1', 'a1', 'u2'])
    expect(olderBody.hasMore).toBe(false)

    // A fresh full read sees each message exactly once, including the append.
    const all = await request(server, 'GET', '/api/session/s1/history')
    const allBody = all.body as { data?: Array<{ text?: string }> }
    expect(allBody.data?.map(textOf)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })

  it('remaps v1 parentIDs to surface ids in warm history', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: async () => okRpc({
          events: [
            { event: makeUserEvent('hello', 'dsh-user-1', 1000) },
            {
              event: makeAssistantEvent([
                { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
              ], 'dsh-tool', 1100),
            },
            {
              event: makeAssistantEvent([
                { type: 'text', text: 'follow-up' },
              ], 'dsh-text', 1200),
            },
          ],
          hasMore: false,
        }),
      },
    }
    const { server, router } = await boot(api)
    router.ctx.state.registerPromptMessageId('s1', 'msg_user_1', 900)
    expect(router.ctx.state.takePromptMessageId('s1', 'dsh-user-1')).toBe('msg_user_1')
    router.ctx.state.recordAssistantId('s1', 'dsh-tool', 'msg_tool_1')
    router.ctx.state.recordAssistantId('s1', 'dsh-text', 'msg_text_1')
    router.ctx.state.setAssistantMessageCreatedAt('s1', 'msg_tool_1', 1050)
    router.ctx.state.setAssistantMessageCreatedAt('s1', 'msg_text_1', 1150)
    router.ctx.state.markAssistantPending('s1', 'msg_tool_1')

    const v1 = await request(server, 'GET', '/session/s1/message')
    expect(v1.status).toBe(200)
    const v1Body = v1.body as Array<{ info: { id: string; role: string; parentID?: string; time?: { created?: number } } }>
    expect(v1Body[0]?.info.id).toBe('msg_user_1')
    expect(v1Body[1]?.info.parentID).toBe('msg_user_1')
    expect(v1Body[2]?.info.parentID).toBe('msg_tool_1')
    expect((v1Body[0]?.info.time as { created?: number }).created).toBe(900)
    expect((v1Body[1]?.info.time as { created?: number }).created).toBe(1050)
    expect((v1Body[2]?.info.time as { created?: number }).created).toBe(1150)
    expect((v1Body[1]?.info.time as { completed?: number }).completed).toBeUndefined()

    const v2 = await request(server, 'GET', '/api/session/s1/message')
    const v2Body = v2.body as { data: Array<{ id: string; type?: string; time?: { created?: number; completed?: number } }> }
    expect(v2Body.data.find((entry) => entry.id === 'msg_tool_1')).toMatchObject({
      type: 'assistant',
      time: { created: 1050 },
    })
    expect(v2Body.data.find((entry) => entry.id === 'msg_text_1')).toMatchObject({
      type: 'assistant',
      time: { created: 1150 },
    })
    expect(v2Body.data.find((entry) => entry.id === 'msg_tool_1')?.time?.created).toBe(1050)
    expect(v2Body.data.find((entry) => entry.id === 'msg_tool_1')?.time?.completed).toBeUndefined()

    const ids = new Set(v1Body.map((entry) => entry.info.id))
    for (const entry of v1Body) {
      if (entry.info.parentID !== undefined) {
        expect(ids.has(entry.info.parentID)).toBe(true)
      }
    }
  })

  it('filters session lists by the directory query', async () => {
    const base = fakeApi()
    const other = { ...item, sessionId: 's2' as never, cwd: '/other' }
    const api = {
      ...base,
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item, other] }) },
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
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item, sub] }) },
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item, s2, s3, s4, s5, s6] }),
        history: async (request) => {
          historyCalls.push(String((request as { sessionId?: string }).sessionId))
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
        history: async (request) => {
          const maxMessages = (request as { maxMessages?: number }).maxMessages
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item] }),
      },
      sessionSkillCatalog: {
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
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
          return okRpc({ accepted: true })
        },
      },
      sessionSkillCatalog: {
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
        mode: 'steer',
        content: [{ type: 'text', text: '/code-review strict' }],
      },
    })
  })

  it('executes OpenCode shell mode through Agent maintenance and hydrates the synthetic tool card', async () => {
    const base = fakeApi()
    const inboxSession = Session.create(SessionId('s1'))
    const inbox = new Inbox(inboxSession, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    const injected: Array<{
      role: string
      source: { kind: string; plugin?: string; form?: string; summary?: string }
      content: Array<{ type: string; text?: string }>
    }> = []
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          id: 'live-s1',
          inject: (message: typeof injected[number]) => {
            injected.push(message)
            inbox.append('next-step', message as never)
          },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server, router } = await boot(api, process.cwd())
    const liveEvents: Array<{ payload: { type?: string } }> = []
    const originalBroadcast = router.ctx.hub.broadcast.bind(router.ctx.hub)
    ;(router.ctx.hub as unknown as {
      broadcast(events: Array<{ payload: { type?: string } }>): void
    }).broadcast = (events) => {
      liveEvents.push(...events)
      originalBroadcast(events as never)
    }
    const result = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      model: { providerID: 'deepseek-official', modelID: 'mock-model' },
      command: 'printf shell-ok',
    })
    expect(result.status).toBe(200)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({
      role: 'user',
      source: {
        kind: 'plugin',
        plugin: 'dsh-oc',
        form: 'notice',
        summary: 'The user manually executed a shell command',
      },
    })
    expect(injected[0]?.content[0]?.text).toContain('The user manually executed a shell command')
    expect(injected[0]?.content[0]?.text).toContain('Command:\nprintf shell-ok')
    expect(injected[0]?.content[0]?.text).toContain('Output:\nshell-ok')
    expect(injected[0]?.content[0]?.text).toContain('not a model-requested tool call')
    expect(inbox.nextStep).toHaveLength(1)
    expect(inboxSession.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'agent/inbox/spliced',
      data: expect.objectContaining({
        target: 'next-step',
        inserted: [expect.objectContaining({
          role: 'user',
          source: expect.objectContaining({ kind: 'plugin', plugin: 'dsh-oc', form: 'notice' }),
        })],
      }),
    }))
    expect(result.body).toMatchObject({
      info: { role: 'assistant', parentID: expect.stringMatching(/^msg_shell:user:/) },
      parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }],
    })
    expect(liveEvents.filter((event) => event.payload.type === 'session.status')).toHaveLength(2)
    expect(liveEvents.filter((event) => event.payload.type === 'session.idle')).toHaveLength(1)

    const history = await request(server, 'GET', '/session/s1/message')
    const entries = history.body as Array<{
      info: { id: string; role: string }
      parts: Array<{ type: string; tool?: string; state?: { status?: string; output?: string } }>
    }>
    expect(entries).toHaveLength(2)
    expect(entries[0]?.info).toMatchObject({ role: 'user' })
    expect(entries[0]?.info.id).toMatch(/^msg_shell:user:/)
    expect(entries[1]?.info).toMatchObject({ role: 'assistant' })
    expect(entries[1]?.info.id).toMatch(/^msg_shell:/)
    expect(entries[1]?.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: 'shell-ok' },
    })
    const v2 = await request(server, 'GET', '/api/session/s1/message')
    const v2Messages = (v2.body as { data: Array<{ type?: string; content?: Array<{ type?: string; name?: string; state?: { status?: string } }> }> }).data
    const v2Assistant = v2Messages.find((message) => message.type === 'assistant' && message.content?.some((part) => part.type === 'tool'))
    expect(v2Assistant?.content?.[0]).toMatchObject({ type: 'tool', name: 'bash', state: { status: 'completed' } })
  })

  it('rejects shell mode when the host Agent maintenance seam is unavailable', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: { get: () => ({ id: 'live-s1' }) },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'id' })
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ name: 'InternalServerError', message: expect.stringContaining('runMaintenance') })
  })

  it('uses an independent UTF-8 budget for model shell context while retaining the larger TUI output', async () => {
    const base = fakeApi()
    const injected: Array<{ content: Array<{ text?: string }> }> = []
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: (message: typeof injected[number]) => { injected.push(message) },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    // A long argument to the no-op builtin exercises the command budget while
    // remaining valid in both bash and zsh. Builtin printf then emits exactly
    // 90,000 bytes to each stream without relying on pipe/SIGPIPE behaviour.
    const command = [
      `: "${'x'.repeat(20 * 1024)}"`,
      'printf shell-budget-ok',
      'printf \'%090000d\' 0',
      'printf \'%090000d\' 0 >&2',
    ].join('; ')
    expect(Buffer.byteLength(command, 'utf8')).toBeGreaterThan(16 * 1024)
    const result = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      command,
    })
    expect(result.status).toBe(200)
    expect(injected).toHaveLength(1)
    const context = injected[0]?.content[0]?.text ?? ''
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(144 * 1024)
    expect(context).toContain('[command truncated for model context after 16384 UTF-8 bytes]')
    expect(context).toContain('[stdout truncated for model context after 65536 UTF-8 bytes]')
    expect(context).toContain('[stderr truncated for model context after 65536 UTF-8 bytes]')

    const history = await request(server, 'GET', '/session/s1/message')
    const output = (history.body as Array<{ parts: Array<{ state?: { output?: string } }> }>)[1]?.parts[0]?.state?.output ?? ''
    expect(output).toContain('shell-budget-ok')
    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(128 * 1024)
  })

  it('keeps provenance, exit status, and both stream truncation notices before large model output', async () => {
    const base = fakeApi()
    const injected: Array<{ content: Array<{ text?: string }> }> = []
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: (message: typeof injected[number]) => { injected.push(message) },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    const result = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      command: 'yes O | head -c 90000; yes E | head -c 90000 >&2; exit 7',
    })
    expect(result.status).toBe(200)
    const context = injected[0]?.content[0]?.text ?? ''
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(144 * 1024)
    expect(context).toContain('Source: user manually executed this command; it was not a model-requested tool call.')
    expect(context).toContain('[stdout truncated for model context after 65536 UTF-8 bytes]')
    expect(context).toContain('[stderr truncated for model context after 65536 UTF-8 bytes]')
    expect(context).toContain('[exit code: 7]')
    expect(context.indexOf('[exit code: 7]')).toBeLessThan(context.indexOf('Output:\n'))
  })

  it('keeps a completed shell card and surfaces a warning when context injection fails', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: () => { throw new Error(`inbox unavailable\n${'x'.repeat(2000)}`) },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    const result = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      command: 'printf context-injection-warning',
    })
    expect(result.status).toBe(200)
    const history = await request(server, 'GET', '/session/s1/message')
    const output = (history.body as Array<{ parts: Array<{ state?: { output?: string } }> }>)[1]?.parts[0]?.state?.output ?? ''
    expect(output).toContain('context-injection-warning')
    const warning = output.split('\n').find((line) => line.startsWith('[dsh-oc]'))
    expect(warning).toContain('[dsh-oc] shell command/output was not added to model context: inbox unavailable')
    expect(warning).toContain('[truncated]')
    expect(warning).not.toMatch(/[\r\n]/u)
    expect(Buffer.byteLength(warning ?? '', 'utf8')).toBeLessThanOrEqual(
      Buffer.byteLength('[dsh-oc] shell command/output was not added to model context: ', 'utf8')
        + SHELL_CONTEXT_WARNING_LIMIT_BYTES,
    )
  })

  it('resolves a cold session Agent through sessionController before shell execution', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: { get: () => undefined },
      sessionController: {
        ...base.sessionController,
        resolveAgent: async () => ({
          agent: {
            id: 'agent-1',
            inject: () => {},
            runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
          } as never,
        }),
      },
    }
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'printf cold-shell-ok' })
    expect(result.status).toBe(200)
  })

  it('rejects a concurrent shell on the same Agent before spawning a second child', async () => {
    const base = fakeApi()
    let active = false
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: () => {},
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => {
            if (active) throw new Error('agent already has active work')
            active = true
            try {
              return await task(new AbortController().signal)
            } finally {
              active = false
            }
          },
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    const first = request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'sleep 0.2' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'printf second' })
    expect(second.status).toBe(409)
    expect((await first).status).toBe(200)
  })

  it('maps shell body and missing-session failures to actionable HTTP errors', async () => {
    const missing = fakeApi()
    missing.sessionController = {
      ...missing.sessionController,
      resolveAgent: async () => errRpc('session-not-found', 'session missing'),
    }
    const missingServer = await boot(missing)
    expect((await request(missingServer.server, 'POST', '/session/s1/shell', { agent: 'build', command: 'id' })).status)
      .toBe(404)

    const { server } = await boot(fakeApi())
    expect((await request(server, 'POST', '/session/s1/shell', { command: 'id' })).status).toBe(400)
    expect((await request(server, 'POST', '/session/s1/shell', { agent: '   ', command: 'id' })).status).toBe(400)
  })

  it('keeps stderr/exit text and aborts only the owned shell process', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: () => {},
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    const failed = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      command: 'printf shell-stderr >&2; exit 7',
    })
    expect(failed.status).toBe(200)
    const failedHistory = await request(server, 'GET', '/session/s1/message')
    const failedPart = (failedHistory.body as Array<{ parts: Array<{ state?: { output?: string } }> }>)[1]?.parts[0]
    expect(failedPart?.state?.output).toContain('shell-stderr')
    expect(failedPart?.state?.output).toContain('[exit code: 7]')

    const pending = request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'sleep 10' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const aborted = await request(server, 'POST', '/session/s1/abort')
    expect(aborted.status).toBe(200)
    expect((await pending).status).toBe(200)
    const abortedHistory = await request(server, 'GET', '/session/s1/message')
    const abortedEntries = abortedHistory.body as Array<{
      parts: Array<{ state?: { status?: string; output?: string; metadata?: { output?: string } } }>
    }>
    const abortedPart = abortedEntries.at(-1)?.parts[0]
    expect(abortedPart?.state?.status).toBe('completed')
    expect(abortedPart?.state?.output).toContain('User aborted the command')
    const v2 = await request(server, 'GET', '/api/session/s1/message')
    const v2Data = (v2.body as { data: Array<{ type?: string; content?: Array<{ type?: string; name?: string; state?: { status?: string; content?: Array<{ text?: string }> } }> }> }).data
    const v2Shell = v2Data.findLast((message) => message.type === 'assistant'
      && message.content?.some((part) => part.type === 'tool'
        && part.state?.content?.some((item) => String(item.text ?? '').includes('User aborted the command'))))
    expect(v2Shell?.content?.[0]).toMatchObject({
      type: 'tool',
      name: 'bash',
      state: { status: 'completed', content: [{ text: expect.stringContaining('User aborted the command') }] },
    })
  })

  it('bounds stdout retention, marks truncation, and lets the child drain to exit', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: () => {},
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server } = await boot(api, process.cwd())
    const result = await request(server, 'POST', '/session/s1/shell', {
      agent: 'build',
      command: 'yes A | head -c 1200000',
    })
    expect(result.status).toBe(200)
    const history = await request(server, 'GET', '/session/s1/message')
    const part = (history.body as Array<{ parts: Array<{ state?: { status?: string; output?: string } }> }>)[1]?.parts[0]
    expect(part?.state?.status).toBe('completed')
    expect(part?.state?.output).toContain('[stdout truncated after 1048576 bytes]')
    expect((part?.state?.output?.length ?? 0)).toBeLessThan(1_100_000)
  })

  it('aborts and forgets an owned shell when the host removes its session', async () => {
    const base = fakeApi()
    const injected: unknown[] = []
    const api: BridgeApi = {
      ...base,
      agents: {
        get: () => ({
          inject: (message: unknown) => { injected.push(message) },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
        }),
      },
    }
    const { server, router } = await boot(api, process.cwd())
    const pending = request(server, 'POST', '/session/s1/shell', { agent: 'build', command: 'sleep 10' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    router.feedHostFrame({ type: 'host/session-removed', sessionId: 's1' })
    expect((await pending).status).toBe(200)
    expect(injected).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const history = await request(server, 'GET', '/session/s1/message')
    expect(history.body).toEqual([])
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
        sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item] }) },
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
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item, other] }),
        search: async (request) => {
          searchCalls.push({ method: 'session.search', payload: request })
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
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item, other] }) },
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
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [item, s2, s3] }) },
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
      sessionController: { ...base.sessionController, list: async () => okRpc({ items: [child, parent] }) },
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
        {
          id: 'child-1',
          parentID: 'parent-1',
          metadata: { origin: 'subagent' },
          location: { directory: '/work' },
        },
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

  it('labels messages with the dsh agentPreset learned from the session list', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({
          items: [{
            sessionId: 's1' as never,
            updatedAt: 2000,
            running: false,
            blank: false,
            cwd: '/work',
            agentPreset: 'minimal',
          }],
        }),
        history: async () => okRpc({
          events: [
            { event: makeUserEvent('hi', 'u1', 1100) },
            { event: makeAssistantEvent([{ type: 'text', text: 'hello' }], 'a1', 1200) },
          ],
          hasMore: false,
        }),
      },
    }
    const { server, router } = await boot(api)
    // dsh summaries carry `agentPreset`, not a TUI `agent` name; the list
    // must seed the per-session label so first replies do not fall back to
    // the hardcoded build agent.
    await request(server, 'GET', '/session')
    expect(router.ctx.state.sessionAgentFor('s1')).toBe('minimal')
    const messages = await request(server, 'GET', '/session/s1/message')
    const entries = messages.body as Array<{ info: { role: string; agent: string; mode?: string } }>
    const assistant = entries.find((entry) => entry.info.role === 'assistant')
    expect(assistant?.info.agent).toBe('minimal')
    // The TUI badge renders message.mode, so it must follow the preset too.
    expect(assistant?.info.mode).toBe('minimal')
    expect(entries.find((entry) => entry.info.role === 'user')?.info.agent).toBe('minimal')
  })

  it('tags a created session with its resolved agent before the first reply', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => 'minimal',
      },
      sessionController: {
        ...base.sessionController,
        create: async () => okRpc({ sessionId: 'fresh-1' as never }),
      },
    }
    const { server, router } = await boot(api)
    await request(server, 'POST', '/session', { agent: 'minimal', directory: '/work' })
    expect(router.ctx.state.sessionAgentFor('fresh-1')).toBe('minimal')
  })

  it('surfaces live subagent children with parentID for the TUI subagent panel', async () => {
    const { router } = await boot(fakeApi())
    const events = hostSessionAddedEvents(router.ctx, {
      sessionId: 'child-1',
      blank: true,
      cwd: '/work',
      origin: 'subagent',
      parentSessionId: 'parent-1',
      agentPreset: 'minimal',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.type).toBe('session.updated')
    expect(events[0]?.payload.properties.info).toMatchObject({
      id: 'child-1',
      parentID: 'parent-1',
      metadata: { origin: 'subagent' },
      agent: 'minimal',
    })
    expect(router.ctx.state.sessionParents.get('child-1')).toBe('parent-1')
    expect(router.ctx.state.sessionDirectories.get('child-1')).toBe('/work')
  })

  it('keeps subagent metadata in a v2 session fallback after list eviction', async () => {
    const { server, router } = await boot(fakeApi())
    hostSessionAddedEvents(router.ctx, {
      sessionId: 'child-fallback',
      cwd: '/work',
      origin: 'subagent',
      parentSessionId: 'parent-1',
    })
    const response = await request(server, 'GET', '/api/session/child-fallback')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      data: {
        id: 'child-fallback',
        parentID: 'parent-1',
        metadata: { origin: 'subagent' },
      },
    })
  })

  it('pushes host/session-added subagent children over the SSE stream', async () => {
    const { server, router } = await boot(fakeApi())
    const controller = new AbortController()
    const response = await fetch(server.url + '/global/event', { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 5000
    // dsh 0.1.2: host lifecycle frames are fed through feedHostFrame, which
    // broadcasts the derived `session.updated` to all SSE clients.
    router.feedHostFrame({
      type: 'host/session-added',
      sessionId: 'child-1',
      blank: true,
      cwd: '/work',
      origin: 'subagent',
      parentSessionId: 'parent-1',
      agentPreset: 'minimal',
    } as unknown as BridgeHostFrame)
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('session.updated')) break
    }
    controller.abort()
    expect(text).toContain('"type":"session.updated"')
    expect(text).toContain('"parentID":"parent-1"')
    expect(text).toContain('"metadata":{"origin":"subagent"}')
  })

  it('hydrates subagent task metadata in both v1 and v2 history', async () => {
    const parent = {
      sessionId: 'parent-task-history' as never,
      updatedAt: 5000,
      running: false,
      blank: false,
      cwd: '/work',
    }
    const child = {
      sessionId: 'child-task-history' as never,
      updatedAt: 4000,
      running: false,
      blank: false,
      parentSessionId: 'parent-task-history' as never,
      origin: 'subagent' as const,
      cwd: '/work',
      projections: {
        asOfSeq: 7,
        values: {
          subagent: { mode: 'one-shot', label: 'Inspect history' },
          title: 'Inspect history child',
          agentPreset: 'minimal',
        },
      },
    }
    const callArguments = JSON.stringify({
      description: 'Inspect history',
      prompt: 'Read the historical session',
      run_in_background: false,
    })
    const history = [
      { event: makeUserEvent('Inspect', 'history-user', 1000) },
      { event: makeAssistantEvent([
        { type: 'tool-call', id: 'history-call', name: 'subagent', arguments: callArguments },
      ], 'history-assistant', 1100) },
      { event: sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'history-call',
        name: 'subagent',
        arguments: callArguments,
      }, 4, 1110) },
      { event: sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'history-call' },
          content: [{
            type: 'tool-result',
            toolCallId: 'history-call',
            content: [{ type: 'text', text: 'child done' }],
            isError: false,
          }],
        },
      }, 5, 1120) },
    ]
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [parent, child] }),
        history: async () => okRpc({ events: history, hasMore: false }),
      },
    }
    const { server } = await boot(api)

    const v1 = await request(server, 'GET', '/session/parent-task-history/message')
    const v1Parts = (v1.body as Array<{ parts: Array<Record<string, unknown>> }> )
      .flatMap((entry) => entry.parts)
    const v1Task = v1Parts.find((part) => part.type === 'tool')
    expect(v1Task).toMatchObject({
      tool: 'task',
      state: {
        status: 'completed',
        input: {
          description: 'Inspect history',
          prompt: 'Read the historical session',
          subagent_type: 'spawn',
        },
        metadata: {
          sessionId: 'child-task-history',
          parentSessionId: 'parent-task-history',
          mode: 'one-shot',
        },
      },
    })

    const v2 = await request(server, 'GET', '/api/session/parent-task-history/message')
    const v2Task = (v2.body as { data: Array<{ content?: Array<Record<string, unknown>> }> }).data
      .flatMap((entry) => entry.content ?? [])
      .find((part) => part.type === 'tool')
    expect(v2Task).toMatchObject({
      name: 'task',
      state: {
        status: 'completed',
        input: {
          description: 'Inspect history',
          prompt: 'Read the historical session',
          subagent_type: 'spawn',
        },
        structured: { sessionId: 'child-task-history', parentSessionId: 'parent-task-history' },
      },
    })
  })

  it('binds same-parent historical tasks to distinct children in FIFO order', async () => {
    const parent = {
      sessionId: 'parent-task-fifo' as never,
      updatedAt: 5000,
      running: false,
      blank: false,
      cwd: '/work',
    }
    // Deliberately omit labels so the resolver must use durable child order;
    // both calls have the same description and must not reuse child-fifo-a.
    const childA = {
      sessionId: 'child-fifo-a' as never,
      updatedAt: 4000,
      running: false,
      blank: false,
      parentSessionId: 'parent-task-fifo' as never,
      origin: 'subagent' as const,
      cwd: '/work',
      projections: {
        asOfSeq: 7,
        values: { subagent: { mode: 'one-shot' } },
      },
    }
    const childB = {
      sessionId: 'child-fifo-b' as never,
      updatedAt: 3900,
      running: false,
      blank: false,
      parentSessionId: 'parent-task-fifo' as never,
      origin: 'subagent' as const,
      cwd: '/work',
      projections: {
        asOfSeq: 8,
        values: { subagent: { mode: 'continuable' } },
      },
    }
    const callArguments = JSON.stringify({
      description: 'same description',
      prompt: 'run one of the same-description children',
      run_in_background: false,
    })
    const history = [
      { event: makeUserEvent('Inspect', 'fifo-user', 1000) },
      { event: makeAssistantEvent([
        { type: 'tool-call', id: 'fifo-call-a', name: 'subagent', arguments: callArguments },
        { type: 'tool-call', id: 'fifo-call-b', name: 'subagent', arguments: callArguments },
      ], 'fifo-assistant', 1100) },
      { event: sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'fifo-call-a',
        name: 'subagent',
        arguments: callArguments,
      }, 4, 1110) },
      { event: sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'fifo-call-b',
        name: 'subagent',
        arguments: callArguments,
      }, 5, 1111) },
      { event: sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'fifo-call-a' },
          content: [{
            type: 'tool-result',
            toolCallId: 'fifo-call-a',
            content: [{ type: 'text', text: 'child a done' }],
            isError: false,
          }],
        },
      }, 6, 1120) },
      { event: sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'fifo-call-b' },
          content: [{
            type: 'tool-result',
            toolCallId: 'fifo-call-b',
            content: [{ type: 'text', text: 'child b done' }],
            isError: false,
          }],
        },
      }, 7, 1121) },
    ]
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [parent, childA, childB] }),
        history: async () => okRpc({ events: history, hasMore: false }),
      },
    }
    const { server, router } = await boot(api)

    const v1 = await request(server, 'GET', '/session/parent-task-fifo/message')
    const v1Tasks = (v1.body as Array<{ parts: Array<Record<string, unknown>> }>).flatMap((entry) => entry.parts)
      .filter((part) => part.type === 'tool' && part.tool === 'task')
    expect(v1Tasks.map((part) => (part.state as { metadata?: { sessionId?: string } }).metadata?.sessionId))
      .toEqual(['child-fifo-a', 'child-fifo-b'])
    expect(new Set(v1Tasks.map((part) => (part.state as { metadata?: { sessionId?: string } }).metadata?.sessionId)).size)
      .toBe(2)

    const v2 = await request(server, 'GET', '/api/session/parent-task-fifo/message')
    const v2Tasks = (v2.body as { data: Array<{ content?: Array<Record<string, unknown>> }> }).data
      .flatMap((entry) => entry.content ?? [])
      .filter((part) => part.type === 'tool' && part.name === 'task')
    expect(v2Tasks.map((part) => (part.state as { structured?: { sessionId?: string } }).structured?.sessionId))
      .toEqual(['child-fifo-a', 'child-fifo-b'])
    expect(router.ctx.state.subagentChildForCall('parent-task-fifo', 'fifo-call-a')?.sessionId)
      .toBe('child-fifo-a')
    expect(router.ctx.state.subagentChildForCall('parent-task-fifo', 'fifo-call-b')?.sessionId)
      .toBe('child-fifo-b')
  })

  it('gets a session and its messages for v1 and v2', async () => {
    const base = fakeApi()
    const history = [makeUserEvent('hello'), makeAssistantEvent([{ type: 'text', text: 'hi back' }])]
    const api = {
      ...base,
      sessionController: {
        ...base.sessionController,
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

  it('keeps durable message order while hydrating synthetic command cards', async () => {
    const base = fakeApi()
    const history = [
      { event: sessionEvent('turn/start', { turn: 1 }, 1, 1010) },
      { event: makeUserEvent('hello', 'm-user-order', 1010) },
      { event: makeAssistantEvent([{ type: 'text', text: 'answer' }], 'm-assistant-order', 1200) },
    ]
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: async () => okRpc({ events: history, hasMore: false }),
      },
    }
    const { server, router } = await boot(api)

    const v1 = await request(server, 'GET', '/session/s1/message')
    expect((v1.body as Array<{ info: { role: string; time: { created: number } } }>).map((entry) => entry.info.role))
      .toEqual(['user', 'assistant'])
    expect((v1.body as Array<{ info: { time: { created: number } } }>)[1]?.info.time.created).toBe(1011)

    const v2 = await request(server, 'GET', '/api/session/s1/message')
    expect((v2.body as { data: Array<{ type: string }> }).data.map((entry) => entry.type))
      .toEqual(['user', 'assistant'])

    // Bridge-only command cards are inserted by timestamp, while the two
    // durable entries above remain in their converter order.
    router.ctx.state.recordCommandResult('s1', {
      info: {
        id: 'msg_cmd:order-check',
        sessionID: 's1',
        role: 'assistant',
        time: { created: 1100, completed: 1100 },
        agent: 'build',
        modelID: 'deepseek-chat',
        providerID: 'deepseek',
        mode: 'build',
        path: { cwd: '/work', root: '/work' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as never,
      parts: [{
        id: 'prt_cmd:order-check',
        sessionID: 's1',
        messageID: 'msg_cmd:order-check',
        type: 'text',
        text: 'command result',
        time: { start: 1100, end: 1100 },
      } as never],
    })

    const mergedV1 = await request(server, 'GET', '/session/s1/message')
    expect((mergedV1.body as Array<{ info: { id: string; role: string } }>).map((entry) => [entry.info.id, entry.info.role]))
      .toEqual([
        ['m-user-order', 'user'],
        ['m-assistant-order', 'assistant'],
        ['msg_cmd:order-check', 'assistant'],
      ])

    const mergedV2 = await request(server, 'GET', '/api/session/s1/message')
    const mergedV2Data = (mergedV2.body as {
      data: Array<{ id: string; type: string; time?: { created?: number; completed?: number } }>
    }).data
    expect(mergedV2Data.map((entry) => [entry.id, entry.type]))
      .toEqual([
        ['m-user-order', 'user'],
        ['m-assistant-order', 'assistant'],
        ['msg_cmd:order-check', 'assistant'],
      ])
    // v2 hydration must keep the completion marker.  Dropping it here makes
    // the OpenCode TUI reconstruct the preset command assistant as in-flight
    // after refresh/reconnect and leaves the preceding echo QUEUED.
    expect(mergedV2Data.find((entry) => entry.id === 'msg_cmd:order-check')?.time)
      .toMatchObject({ created: 1100, completed: 1100 })
  })

  it('hydrates v1/v2 history with the immutable optimistic message keys', async () => {
    const base = fakeApi()
    const history = [
      { event: sessionEvent('turn/start', { turn: 1 }, 1, 1000) },
      { event: makeUserEvent('hello', 'dsh-user-order', 1100) },
      { event: makeAssistantEvent([{ type: 'text', text: 'answer' }], 'dsh-assistant-order', 1200) },
    ]
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: async () => okRpc({ events: history, hasMore: false }),
      },
    }
    const { server, router } = await boot(api)
    router.ctx.state.registerPromptMessageId('s1', 'prompt-user-order', 990)
    router.ctx.state.registerAssistantIdForUser('s1', 'prompt-user-order', 'prompt-assistant-order')
    expect(router.ctx.state.takePromptMessageId('s1', 'dsh-user-order')).toBe('prompt-user-order')
    router.ctx.state.recordAssistantId('s1', 'dsh-assistant-order', 'prompt-assistant-order')
    // Simulate the exact key already published by turn/start before the
    // durable user row arrives.
    router.ctx.state.setAssistantMessageCreatedAt('s1', 'prompt-assistant-order', 1000)

    const v1 = await request(server, 'GET', '/session/s1/message')
    const v1Body = v1.body as Array<{ info: { id: string; role: string; time: { created: number } } }>
    const v1User = v1Body.find((entry) => entry.info.role === 'user')
    const v1Assistant = v1Body
      .find((entry) => entry.info.role === 'assistant')
    expect(v1User?.info).toMatchObject({ id: 'prompt-user-order', time: { created: 990 } })
    expect(v1Assistant?.info).toMatchObject({ id: 'prompt-assistant-order', time: { created: 1000 } })

    const v2 = await request(server, 'GET', '/api/session/s1/message')
    const v2Body = (v2.body as { data: Array<{ id: string; type: string; time: { created: number } }> }).data
    const v2User = v2Body.find((entry) => entry.type === 'user')
    const v2Assistant = v2Body
      .find((entry) => entry.type === 'assistant')
    expect(v2User).toMatchObject({ id: 'prompt-user-order', time: { created: 990 } })
    expect(v2Assistant).toMatchObject({ id: 'prompt-assistant-order', time: { created: 1000 } })
  })

  it('closes the rc.1 follow iterator after reading the history snapshot', async () => {
    let returned = false
    const base = fakeApi()
    const item = {
      sessionId: 's-follow' as never,
      updatedAt: 1,
      running: false,
      blank: true,
      cwd: '/work',
      projections: undefined,
    }
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item] }),
        history: undefined,
        follow: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({
                done: false,
                value: {
                  type: 'snapshot',
                  header: {},
                  cursor: 0,
                  records: [],
                  hasMore: false,
                  projections: { asOfSeq: 0, values: {} },
                },
              }),
              return: async () => {
                returned = true
                return { done: true, value: undefined }
              },
            }
          },
        } as never),
      },
    }
    const { server } = await boot(api)
    const response = await request(server, 'GET', '/session/s-follow')
    expect(response.status).toBe(200)
    expect(returned).toBe(true)
  })

  it('uses a subagent address for child history reads', async () => {
    let address: unknown
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: undefined,
        follow: (request) => {
          address = request.address
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'snapshot',
                header: {},
                cursor: -1,
                records: [],
                hasMore: false,
                projections: { asOfSeq: -1, values: {} },
              }
            },
          } as never
        },
      },
    }
    const { server, router } = await boot(api)
    recordSessionSummaries(router.ctx, [{
      sessionId: 'child-1' as never,
      updatedAt: 1,
      running: false,
      blank: false,
      origin: 'subagent',
      parentSessionId: 'parent-1' as never,
      projections: { asOfSeq: 0, values: { subagent: { mode: 'one-shot' } } } as never,
    }])
    const result = await request(server, 'GET', '/session/child-1/message')
    expect(result.status).toBe(200)
    expect(address).toEqual({
      kind: 'subagent',
      parentSessionId: 'parent-1',
      childSessionId: 'child-1',
      mode: 'one-shot',
    })
  })

  it('uses page when the backward cursor equals the follow snapshot cursor', async () => {
    let pageCalled = false
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        history: undefined,
        follow: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'snapshot', header: {}, cursor: 5, records: [], hasMore: true,
              projections: { asOfSeq: 5, values: {} },
            }
          },
        } as never),
        page: async (request) => {
          pageCalled = request.beforeSeq === 5
          return { records: [], hasMore: false }
        },
      },
    }
    const { server } = await boot(api)
    const cursor = Buffer.from(JSON.stringify({ v: 1, beforeSeq: 5 }), 'utf8').toString('base64url')
    const result = await request(server, 'GET', `/api/session/s-page/message?cursor=${cursor}`)
    expect(result.status).toBe(200)
    expect(pageCalled).toBe(true)
  })

  it('reports the active session through /api/session/active', async () => {
    const base = fakeApi()
    const api = {
      ...base,
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'mock-model', name: 'Mock Model' }],
          }],
          failures: [],
        }),
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

  it('stamps message history with the session model, not the catalog-first default', async () => {
    // Regression: the TUI restores its prompt model from the last user
    // message when the session changes. The bridge stamped every user
    // message with the FIRST catalog model (deepseek-v4-flash), so after the
    // first turn the TUI draft reverted to flash even though the session was
    // explicitly running deepseek-v4-pro.
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
              { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            ],
          }],
          failures: [],
        }),
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [{ event: makeUserEvent('hello') }], hasMore: false }),
        models: async () => okRpc({
          current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        }),
      },
    }
    const { server } = await boot(api)
    const v1 = await request(server, 'GET', '/session/s1/message')
    expect(v1.status).toBe(200)
    expect((v1.body as Array<{ info: { role: string; model?: unknown } }>)[0]?.info).toMatchObject({
      role: 'user',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' },
    })
  })

  it('stamps the queued prompt echo with the model carried in the prompt body', async () => {
    // Regression: the TUI reads the last user message's model to restore its
    // draft. The queued user card broadcast for a prompt must name the model
    // the user actually submitted (deepseek-v4-pro), never the catalog-first
    // default (deepseek-v4-flash), or the next prompt reverts to flash.
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
              { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            ],
          }],
          failures: [],
        }),
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server, router } = await boot(api)
    const hub = router.ctx.hub
    const originalBroadcast = hub.broadcast.bind(hub)
    const userCards: Array<{ role?: string; model?: unknown }> = []
    ;(hub as unknown as {
      broadcast(events: Array<{
        payload: { type?: string; properties?: { info?: { role?: string; model?: unknown } } }
      }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        if (event.payload.type === 'message.updated') {
          const info = event.payload.properties?.info
          if (info?.role === 'user') userCards.push(info)
        }
      }
      originalBroadcast(events as never)
    }

    const prompted = await request(server, 'POST', '/session/s1/message', {
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' },
      parts: [{ type: 'text', text: 'hello' }],
    })
    expect(prompted.status).toBe(200)
    expect(userCards).toHaveLength(1)
    expect(userCards[0]).toMatchObject({
      role: 'user',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' },
    })
  })

  it('recovers the optimistic prompt card when POST wins the first SSE race', async () => {
    const base = fakeApi()
    const { server, router } = await boot({
      ...base,
      sessionController: {
        ...base.sessionController,
        prompt: async () => okRpc({ accepted: true }),
      },
    })
    const prompted = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'cold attach prompt' }],
    })
    expect(prompted.status).toBe(200)

    const written: string[] = []
    const fakeRes = {
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      on: () => fakeRes,
      destroyed: false,
    }
    const client = router.ctx.hub.add(fakeRes as never)
    expect(written.join('')).toContain('cold attach prompt')
    router.ctx.hub.remove(client)
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
      sessionController: {
        ...base.sessionController,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request })
          return okRpc({ sessionId: 'new-session' as never })
        },
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request })
          forkCreated = true
          return okRpc({ sessionId: 'fork-session' as never })
        },
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request })
          return okRpc({ title: request.title, seq: 3 })
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
      sessionController: {
        ...base.sessionController,
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request })
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
          calls.push({ method: 'session.rename', payload: request })
          return okRpc({ title: request.title, seq: 3 })
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

  it('resolves bridge message ids when forking at a user message', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request })
          return okRpc({ sessionId: 'fork-session' as never })
        },
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request })
          return okRpc({ title: request.title, seq: 3 })
        },
        list: async () => okRpc({ items: [] }),
        history: async () => okRpc({
          events: [{ event: makeUserEvent('hello', 'dsh-user-1', 1000) }],
          hasMore: false,
        }),
      },
    }
    const { server, router } = await boot(api)
    router.ctx.state.registerPromptMessageId('s1', 'msg_bridge_user_1')
    expect(router.ctx.state.takePromptMessageId('s1', 'dsh-user-1')).toBe('msg_bridge_user_1')

    const response = await request(server, 'POST', '/session/s1/fork', {
      messageID: 'msg_bridge_user_1',
    })
    expect(response.status).toBe(200)
    expect(calls[0]).toMatchObject({
      method: 'session.fork',
      payload: { sessionId: 's1', atSeq: 2 },
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
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
        rename: async (request) => {
          calls.push({ method: 'session.rename', payload: request })
          return okRpc({ title: 'renamed', seq: 3 })
        },
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
          return okRpc({ accepted: true })
        },
        cancel: (request) => {
          calls.push({ method: 'session.cancel', payload: request })
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
      payload: { sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(prompt.body).toMatchObject({ info: { role: 'assistant' }, parts: [] })

    const promptAlias = await request(server, 'POST', '/session/s1/prompt', {
      parts: [{ type: 'text', text: 'via alias' }],
    })
    expect(promptAlias.status).toBe(200)
    expect(calls[2]).toMatchObject({
      method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'via alias' }] },
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
      payload: { sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'via v2' }] },
    })

    const slashPrompt = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: '/compact' }],
    })
    expect(slashPrompt.status).toBe(200)
    expect(calls[4]).toMatchObject({
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'steer',
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
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
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
        mode: 'steer',
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
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
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
      sessionController: {
        ...base.sessionController,
        history: async (request) => {
          calls.push({ method: 'session.history', payload: request })
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
      sessionController: {
        ...base.sessionController,
        history: async (request) => {
          calls.push({ method: 'session.history', payload: request })
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
    const api = {
      ...base,
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
          groups,
          failures: [],
        }),
      },
    }
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
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => okRpc({
          default: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routableProviders: ['deepseek-official'],
          groups,
          failures: [],
        }),
      },
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => 'minimal',
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
      'minimal',
      'standard',
    ])
    const v2Agents = await request(server, 'GET', '/api/agent')
    expect((v2Agents.body as { data: Array<{ id: string }> }).data.map((agent) => agent.id)).toEqual([
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
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item] }),
        history: async () => okRpc({ events: [], hasMore: false }),
        models: async () => okRpc({
          current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
          routable: true,
          groups: [],
          failures: [],
        }),
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
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
      sessionController: {
        ...fakeApi().sessionController,
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
          calls.push({ method: 'session.selectModel', payload: request })
          currentVariant = (request as { reasoningEffort?: string }).reasoningEffort
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

  it('resets max to the backend default when Default omits the variant', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    let currentModel = 'mock-model'
    let currentVariant: string | undefined = 'off'
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        models: async () => okRpc({
          current: {
            provider: 'deepseek-official',
            model: currentModel,
            ...(currentVariant === undefined ? {} : { reasoningEffort: currentVariant }),
          },
          routable: true,
          groups: [],
          failures: [],
        }),
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
          const selected = request as { provider: string; model: string; reasoningEffort?: string }
          currentModel = selected.model
          currentVariant = selected.reasoningEffort
          return okRpc({ selected: {
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          } })
        },
      },
    })
    const { server } = await boot(api)
    await request(server, 'POST', '/api/session/s1/model', {
      model: { providerID: 'deepseek', id: 'mock-model', variant: 'max' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toMatchObject({ reasoningEffort: 'max' })
    // Official OpenCode prompt shape: nested model identity, top-level
    // variant omitted means the user selected Default. It must re-select the
    // backend default instead of preserving max from the previous prompt.
    const prompted = await request(server, 'POST', '/api/session/s1/prompt', {
      model: { providerID: 'deepseek', id: 'mock-model' },
      parts: [{ type: 'text', text: 'follow-up' }],
    })
    expect(prompted.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.payload).not.toHaveProperty('reasoningEffort')
    expect(currentVariant).toBeUndefined()
    const session = await request(server, 'GET', '/api/session/s1')
    expect(session.body).toMatchObject({
      data: { model: { id: 'mock-model', providerID: 'deepseek' } },
    })
  })

  it('passes explicit max on every official prompt round', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
          return okRpc({ selected: {
            provider: 'deepseek-official',
            model: 'mock-model',
            reasoningEffort: 'max',
          } })
        },
      },
    })
    const { server } = await boot(api)
    const body = {
      variant: 'max',
      model: { providerID: 'deepseek', modelID: 'mock-model' },
      parts: [{ type: 'text', text: 'max round' }],
    }
    expect((await request(server, 'POST', '/session/s1/message', body)).status).toBe(200)
    expect((await request(server, 'POST', '/api/session/s1/prompt', body)).status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => (call.payload as { reasoningEffort?: string }).reasoningEffort === 'max')).toBe(true)
  })

  it('echoes top-level max/off variants on optimistic user cards', async () => {
    const base = fakeApi()
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        selectModel: async (request) => okRpc({
          selected: {
            provider: 'deepseek-official',
            model: 'mock-model',
            ...(typeof request.reasoningEffort === 'string'
              ? { reasoningEffort: request.reasoningEffort }
              : {}),
          },
        }),
      },
    }
    const { server, router } = await boot(api)
    const cards: Array<{ model?: { providerID?: string; modelID?: string; variant?: string } }> = []
    const originalBroadcast = router.ctx.hub.broadcast.bind(router.ctx.hub)
    ;(router.ctx.hub as unknown as {
      broadcast(events: Array<{ payload: { type?: string; properties?: { info?: { role?: string; model?: typeof cards[number]['model'] } } } }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        const info = event.payload.properties?.info
        if (event.payload.type === 'message.updated' && info?.role === 'user' && info.model !== undefined) {
          cards.push({ model: info.model })
        }
      }
      originalBroadcast(events as never)
    }

    await request(server, 'POST', '/session/s1/message', {
      variant: 'max',
      model: { providerID: 'deepseek', id: 'mock-model' },
      parts: [{ type: 'text', text: 'max card' }],
    })
    await request(server, 'POST', '/api/session/s1/prompt', {
      variant: 'off',
      model: { providerID: 'deepseek', modelID: 'mock-model' },
      parts: [{ type: 'text', text: 'off card' }],
    })
    expect(cards).toHaveLength(2)
    expect(cards.map((card) => card.model?.variant)).toEqual(['max', 'off'])
    expect(cards.every((card) => card.model?.providerID === 'deepseek' && card.model?.modelID === 'mock-model')).toBe(true)
  })

  it('accepts the official top-level off variant and keeps it visible', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
          return okRpc({ selected: {
            provider: 'deepseek-official',
            model: 'mock-model',
            reasoningEffort: 'off',
          } })
        },
      },
    })
    const { server } = await boot(api)
    const prompted = await request(server, 'POST', '/session/s1/message', {
      variant: 'off',
      // OpenCode sends variant at the top level; top-level must win even if a
      // stale nested model object still carries the previous max variant.
      model: { providerID: 'deepseek', id: 'mock-model', variant: 'max' },
      parts: [{ type: 'text', text: 'think with effort off' }],
    })
    expect(prompted.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toMatchObject({ reasoningEffort: 'off' })
    const second = await request(server, 'POST', '/api/session/s1/prompt', {
      variant: 'off',
      model: { providerID: 'deepseek', modelID: 'mock-model' },
      parts: [{ type: 'text', text: 'off again' }],
    })
    expect(second.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.payload).toMatchObject({ reasoningEffort: 'off' })
    const session = await request(server, 'GET', '/session/s1')
    expect(session.body).toMatchObject({
      model: { id: 'mock-model', providerID: 'deepseek', variant: 'off' },
    })
  })

  it('passes agentPreset into session.create and selects the create model', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([{ id: 'minimal', name: 'Minimal' }]),
        select: async () => 'minimal',
      },
      sessionController: {
        ...base.sessionController,
        create: async (request) => {
          calls.push({ method: 'session.create', payload: request })
          return okRpc({ sessionId: 'new-session' as never })
        },
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
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
      sessionController: {
        ...base.sessionController,
        selectModel: async (request) => {
          calls.push({ method: 'session.selectModel', payload: request })
          return okRpc({
            selected: {
              provider: 'deepseek-official',
              model: 'mock-model',
              reasoningEffort: 'off',
            },
          })
        },
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
          return okRpc({ accepted: true })
        },
      },
    }
    const { server } = await boot(api)
    const prompted = await request(server, 'POST', '/session/s1/message', {
      variant: 'off',
      model: { providerID: 'deepseek', id: 'mock-model' },
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
      payload: { sessionId: 's1', mode: 'steer' },
    })
  })

  it('applies the Tab-selected agent carried in prompt bodies', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async (_agent, agentPreset) => {
          calls.push({ method: 'agentPreset.select', payload: { agentPreset } })
          return agentPreset
        },
      },
      sessionController: {
        ...base.sessionController,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server } = await boot(api)
    const message = await request(server, 'POST', '/session/s1/message', {
      agent: 'standard',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(message.status).toBe(200)
    const prompt = await request(server, 'POST', '/session/s1/prompt', {
      agent: 'minimal',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(prompt.status).toBe(200)
    const v2 = await request(server, 'POST', '/api/session/s1/prompt', {
      agent: 'standard',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(v2.status).toBe(200)
    const asyncResult = await request(server, 'POST', '/session/s1/prompt_async', {
      agent: 'minimal',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(asyncResult.status).toBe(204)
    // A later prompt carrying an already-effective agent must not re-select
    // (dsh locks the preset after the first turn; re-applying only warns).
    const repeat = await request(server, 'POST', '/session/s1/message', {
      agent: 'minimal',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(repeat.status).toBe(200)
    const selects = calls.filter((call) => call.method === 'agentPreset.select')
    expect(selects).toHaveLength(4)
    expect(selects.map((call) => (call.payload as { agentPreset?: string }).agentPreset))
      .toEqual(['standard', 'minimal', 'standard', 'minimal'])
  })

  it('does not switch agents when the prompt carries the default build agent', async () => {
    const base = fakeApi()
    let selects = 0
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([{ id: 'minimal', name: 'Minimal' }]),
        select: async () => {
          selects += 1
          return 'minimal'
        },
      },
      sessionController: {
        ...base.sessionController,
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
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => errRpc('agent-preset/locked', 'agent preset is fixed'),
      },
      sessionController: {
        ...base.sessionController,
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

  it('skips re-selecting and does not warn when the prompt agent already matches the session preset', async () => {
    // Regression: a preset switched while the session was still blank (Tab /
    // /preset) is already the session's active preset. dsh refuses ANY
    // agentPreset.select on a session that produced turns, so re-applying it
    // on every later prompt only produced a spurious "Agent switch locked"
    // warning even though the switch had already taken effect.
    const base = fakeApi()
    let selects = 0
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'router-standard', name: 'Router Standard' },
        ]),
        select: async () => {
          selects += 1
          // The first (blank-session) switch succeeds; any later re-select on
          // a started session is refused by dsh.
          if (selects === 1) return 'router-standard'
          return errRpc('agent-preset/locked', 'session has already produced turns')
        },
      },
      sessionController: {
        ...base.sessionController,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server, router } = await boot(api)

    const switched = await request(server, 'POST', '/api/session/s1/agent', {
      agent: 'router-standard',
    })
    expect(switched.status).toBe(204)

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
        agent: 'router-standard',
        parts: [{ type: 'text', text: 'continue' }],
      })
      expect(result.status).toBe(200)
    }

    expect(selects).toBe(1)
    expect(notices.filter((text) => text.includes('Agent switch locked'))).toHaveLength(0)
  })

  it('does not warn when the session list already reports the requested preset (out-of-band adoption)', async () => {
    // A routing plugin can adopt a preset for a session without the bridge
    // switching it (e.g. the session was created with that preset). The
    // session list then reports the real preset; re-selecting the same one
    // on every prompt must not warn.
    const base = fakeApi()
    let selects = 0
    const item = {
      sessionId: 's1' as never,
      updatedAt: 2000,
      running: false,
      blank: false,
      cwd: '/work',
      agentPreset: 'router-standard',
      projections: { asOfSeq: 0, values: { title: 'Session One' } as never },
    }
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'router-standard', name: 'Router Standard' },
        ]),
        select: async () => {
          selects += 1
          return errRpc('agent-preset/locked', 'session has already produced turns')
        },
      },
      sessionController: {
        ...base.sessionController,
        list: async () => okRpc({ items: [item] }),
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server, router } = await boot(api)

    const listed = await request(server, 'GET', '/session')
    expect(listed.status).toBe(200)

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

    const result = await request(server, 'POST', '/session/s1/message', {
      agent: 'router-standard',
      parts: [{ type: 'text', text: 'continue' }],
    })
    expect(result.status).toBe(200)

    expect(selects).toBe(0)
    expect(notices.filter((text) => text.includes('Agent switch locked'))).toHaveLength(0)
  })

  it('switches blank-session agents and maps agent-preset/locked to 409', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async (_agent, agentPreset) => {
          calls.push({ method: 'agentPreset.select', payload: { sessionId: 's1', agentPreset } })
          if (agentPreset === 'standard') {
            return errRpc('agent-preset/locked', 'session has already produced turns')
          }
          return agentPreset
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
        ...base.agentPresets,
        defaultId: 'standard',
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async (_agent, agentPreset) => {
          calls.push({ method: 'agentPreset.select', payload: { sessionId: 's1', agentPreset } })
          return agentPreset
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

  it('suppresses only the matching stale /preset prompt, then permits a later Tab switch', async () => {
    const base = fakeApi()
    const selects: string[] = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async (_agent, agentPreset) => {
          selects.push(agentPreset)
          return agentPreset
        },
      },
      sessionController: {
        ...base.sessionController,
        prompt: async () => okRpc({ accepted: true }),
      },
    }
    const { server, router } = await boot(api)
    router.ctx.state.setSessionAgent('s1', 'minimal')
    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'standard',
    })
    expect(switched.status).toBe(200)

    const stale = await request(server, 'POST', '/session/s1/message', {
      agent: 'minimal',
      parts: [{ type: 'text', text: 'first prompt' }],
    })
    expect(stale.status).toBe(200)
    expect(selects).toEqual(['standard'])

    const laterTab = await request(server, 'POST', '/session/s1/message', {
      agent: 'minimal',
      parts: [{ type: 'text', text: 'later Tab selection' }],
    })
    expect(laterTab.status).toBe(200)
    expect(selects).toEqual(['standard', 'minimal'])
  })

  it('inherits the last selected preset into newly created sessions', async () => {
    const base = fakeApi()
    const createCalls: Array<{ agentPreset?: string }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => 'standard',
      },
      sessionController: {
        ...base.sessionController,
        create: async (request) => {
          createCalls.push(request as { agentPreset?: string })
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
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async () => 'standard',
      },
    }
    const { server, router } = await boot(api)
    const hub = router.ctx.hub
    const originalBroadcast = hub.broadcast.bind(hub)
    const broadcasts: Array<{ type?: string; agent?: string }> = []
    const commandCards: Array<{
      type?: string
      info?: { id?: string; role?: string; time?: { created?: number; completed?: number } }
      part?: { messageID?: string; time?: { start?: number; end?: number } }
    }> = []
    ;(hub as unknown as {
      broadcast(events: Array<{
        payload: {
          type?: string
          properties?: {
            info?: { id?: string; role?: string; agent?: string; time?: { created?: number; completed?: number } }
            part?: { messageID?: string; time?: { start?: number; end?: number } }
          }
        }
      }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        broadcasts.push({
          type: event.payload.type,
          agent: event.payload.properties?.info?.agent,
        })
        if (event.payload.properties?.info?.id?.startsWith('msg_cmd:')) {
          commandCards.push({
            type: event.payload.type,
            info: event.payload.properties.info,
          })
        }
        if (event.payload.properties?.part?.messageID?.startsWith('msg_cmd:')) {
          commandCards.push({
            type: event.payload.type,
            part: event.payload.properties.part,
          })
        }
      }
      originalBroadcast(events as never)
    }
    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'standard',
    })
    expect(switched.status).toBe(200)
    expect(broadcasts).toContainEqual({ type: 'session.updated', agent: 'standard' })

    const finishedInfo = commandCards.find((card) =>
      card.type === 'message.updated' && card.info?.time?.completed !== undefined)
    expect(finishedInfo?.info?.time?.completed).toBe(finishedInfo?.info?.time?.created)
    const finishedPart = commandCards.find((card) =>
      card.type === 'message.part.updated' && card.part?.time?.end !== undefined)
    expect(finishedPart?.part?.time?.end).toBe(finishedPart?.part?.time?.start)
  })

  it('uses the session model for live and hydrated /preset cards', async () => {
    const base = fakeApi()
    let currentModel = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    }
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        models: async () => okRpc({ current: currentModel }),
      },
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([{ id: 'liangshen', name: 'Liangshen' }]),
        select: async () => {
          currentModel = {
            provider: 'deepseek-official',
            model: 'deepseek-v4-pro-next',
            reasoningEffort: 'max',
          }
          return 'liangshen'
        },
      },
    }
    const { server, router } = await boot(api)
    const cards: Array<{
      type?: string
      info?: {
        id?: string
        role?: string
        time?: { created?: number; completed?: number }
        model?: { providerID?: string; modelID?: string; variant?: string }
        modelID?: string
        providerID?: string
        variant?: string
      }
    }> = []
    const originalBroadcast = router.ctx.hub.broadcast.bind(router.ctx.hub)
    ;(router.ctx.hub as unknown as {
      broadcast(events: Array<{
        payload: {
          type?: string
          properties?: { info?: typeof cards[number]['info'] }
        }
      }>): void
    }).broadcast = (events) => {
      for (const event of events) {
        if (event.payload.type === 'message.updated' && event.payload.properties?.info !== undefined) {
          cards.push({ type: event.payload.type, info: event.payload.properties.info })
        }
      }
      originalBroadcast(events as never)
    }

    const switched = await request(server, 'POST', '/session/s1/command', {
      command: 'preset',
      arguments: 'liangshen',
    })
    expect(switched.status).toBe(200)
    const beforeModel = { providerID: 'deepseek', modelID: 'deepseek-v4-pro', variant: 'high' }
    const model = { providerID: 'deepseek', modelID: 'deepseek-v4-pro-next', variant: 'max' }
    const livePreset = cards.find((card) => card.info?.id?.startsWith('msg_preset:'))
    expect(livePreset?.info).toMatchObject({ role: 'user', agent: 'liangshen', model })
    const liveCommands = cards.filter((card) => card.info?.id?.startsWith('msg_cmd:'))
    expect(liveCommands).toHaveLength(2)
    const busyCommand = liveCommands.find((card) => card.info?.time?.completed === undefined)
    expect(busyCommand?.info?.time?.completed).toBeUndefined()
    expect(busyCommand?.info).toMatchObject({
      modelID: beforeModel.modelID,
      providerID: beforeModel.providerID,
      variant: beforeModel.variant,
    })
    const finalCommand = liveCommands.find((card) => card.info?.time?.completed !== undefined)
    expect(finalCommand?.info).toMatchObject({
      time: { completed: expect.any(Number) },
      modelID: model.modelID,
      providerID: model.providerID,
      variant: model.variant,
    })
    const finalCommandID = finalCommand?.info?.id
    expect(finalCommandID).toMatch(/^msg_cmd:/)

    const v1 = await request(server, 'GET', '/session/s1/message')
    const v1Entries = v1.body as Array<{
      info: {
        id: string
        role: string
        modelID?: string
        providerID?: string
        variant?: string
        time?: { completed?: number }
      }
    }>
    const v1Final = v1Entries.find((entry) => entry.info.id === finalCommandID)
    expect(v1Final?.info).toMatchObject({
      role: 'assistant',
      modelID: 'deepseek-v4-pro-next',
      providerID: 'deepseek',
      variant: 'max',
      time: { completed: expect.any(Number) },
    })

    const v2 = await request(server, 'GET', '/api/session/s1/message')
    const v2Preset = (v2.body as {
      data: Array<{ id: string; type?: string; model?: unknown }>
    }).data.find((entry) => entry.id.startsWith('msg_preset:'))
    expect(v2Preset).toMatchObject({
      type: 'user',
      model: { id: 'deepseek-v4-pro-next', providerID: 'deepseek', variant: 'max' },
    })
    const v2Final = (v2.body as {
      data: Array<{ id: string; type?: string; time?: { completed?: number }; model?: unknown }>
    }).data.find((entry) => entry.id === finalCommandID)
    expect(v2Final).toMatchObject({
      type: 'assistant',
      time: { completed: expect.any(Number) },
      model: { id: 'deepseek-v4-pro-next', providerID: 'deepseek', variant: 'max' },
    })

    // A later bridge-only command must consume the successful host read from
    // state instead of reverting to the pre-switch model cached at startup.
    const help = await request(server, 'POST', '/session/s1/command', {
      command: 'help',
      arguments: '',
    })
    expect(help.status).toBe(200)
    const latestCommand = cards.filter((card) => card.info?.id?.startsWith('msg_cmd:')).at(-1)
    expect(latestCommand?.info).toMatchObject({
      modelID: model.modelID,
      providerID: model.providerID,
      variant: model.variant,
    })
  })

  it('captures /preset from prompt routes without triggering a model turn', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const api: BridgeApi = {
      ...base,
      agentPresets: {
        ...base.agentPresets,
        list: async () => okRpc([
          { id: 'minimal', name: 'Minimal' },
          { id: 'standard', name: 'Standard' },
        ]),
        select: async (_agent, agentPreset) => {
          calls.push({ method: 'agentPreset.select', payload: { sessionId: 's1', agentPreset } })
          return agentPreset
        },
      },
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
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
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
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
        ...base.agentPresets,
        list: async () => okRpc([{ id: 'minimal', name: 'Minimal' }]),
        select: async () => 'minimal',
      },
      sessionController: {
        ...base.sessionController,
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
      sessionController: { ...base.sessionController, history: async () => errRpc('session-not-found', 'missing', { sessionId: 'x' }) },
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
      sessionController: { ...base.sessionController, prompt: async () => errRpc('agent-busy', 'busy', { reason: 'x' }) },
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
      sessionController: { ...base.sessionController, rename: async () => errRpc('title-invalid', 'bad title', { sessionId: 's1' }) },
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
  it('uses the dsh cancellation outcome when pending approval state is stopped', () => {
    const state = new InteractionState()
    const outcomes: string[] = []
    state.pendingApprovals.set('rpc-stop', (outcome) => { outcomes.push(outcome) })
    state.registerApproval({
      opencodeId: 'p-stop', rpcId: 'rpc-stop', sessionId: 's1', approvalId: 'a-stop', toolName: 'bash',
    })
    state.registerQuestion({
      opencodeId: 'q-stop', rpcId: 'q-rpc-stop', sessionId: 's1',
      items: [{ id: 'q1', question: 'stop?', options: [] }],
    })
    state.clearPendingInteractions()
    expect(outcomes).toEqual(['cancelled'])
    expect(state.pendingApprovals.size).toBe(0)
    expect(state.permissions.size).toBe(0)
    expect(state.questions.size).toBe(0)
  })

  it('lists, replies, and removes pending permissions', async () => {
    const outcomes: string[] = []
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.pendingApprovals.set('rpc-p1', (outcome) => { outcomes.push(outcome) })
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
    expect(outcomes).toEqual(['allowed-once'])
    expect((await request(server, 'GET', '/permission')).body).toEqual([])
  })

  it('degrades always to allowed-once', async () => {
    const outcomes: string[] = []
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.pendingApprovals.set('rpc-p2', (outcome) => { outcomes.push(outcome) })
    router.ctx.state.registerApproval({
      opencodeId: 'p2',
      rpcId: 'rpc-p2',
      sessionId: 's1',
      approvalId: 'a2',
      toolName: 'edit',
    })
    await request(server, 'POST', '/permission/p2/reply', { reply: 'always' })
    expect(outcomes).toEqual(['allowed-once'])
  })

  it('answers v2 permission reply with 204', async () => {
    const outcomes: string[] = []
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.pendingApprovals.set('rpc-p3', (outcome) => { outcomes.push(outcome) })
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
    expect(outcomes).toEqual(['rejected'])
  })

  it('answers the SDK permission alias route with the response field', async () => {
    const outcomes: string[] = []
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.pendingApprovals.set('rpc-p4', (outcome) => { outcomes.push(outcome) })
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
    expect(outcomes).toEqual(['allowed-once'])
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
    const answers: unknown[] = []
    const base = fakeApi()
    const { server, router } = await boot(base)
    router.ctx.state.pendingQuestions.set('rpc-q1', (answer) => { answers.push(answer) })
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
    expect(answers[0]).toMatchObject([{ id: 'dq1', selected: ['Yes'] }])

    router.ctx.state.pendingQuestions.set('rpc-q2', (answer) => { answers.push(answer) })
    router.ctx.state.registerQuestion({
      opencodeId: 'q2',
      rpcId: 'rpc-q2',
      sessionId: 's1',
      items: [{ id: 'dq2', question: 'Again?', options: [{ label: 'Y' }] }],
    })
    const reject = await request(server, 'POST', '/question/q2/reject')
    expect(reject.status).toBe(200)
    expect(answers[1]).toBeUndefined()

    router.ctx.state.pendingQuestions.set('rpc-q3', (answer) => { answers.push(answer) })
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
    expect(answers[2]).toMatchObject([{ id: 'dq3', selected: ['Y'] }])

    router.ctx.state.pendingQuestions.set('rpc-q4', (answer) => { answers.push(answer) })
    router.ctx.state.registerQuestion({
      opencodeId: 'q4',
      rpcId: 'rpc-q4',
      sessionId: 's1',
      items: [{ id: 'dq4', question: 'V2 reject?', options: [{ label: 'Y' }] }],
    })
    const v2Reject = await request(server, 'POST', '/api/session/s1/question/q4/reject')
    expect(v2Reject.status).toBe(204)
    expect(answers[3]).toBeUndefined()
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
      sessionController: {
        ...base.sessionController,
        history: async () => okRpc({
          events: [],
          hasMore: false,
          projections: { asOfSeq: 1, values: { goal: activeGoal } },
        } as never),
      },
      goals: {
        ...base.goals,
        complete: async (agent, ref) => {
          calls.push({ method: 'goal.complete', payload: { agent, ref } })
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
      payload: { agent: { id: 'agent-1' }, ref: { id: 'g1', revision: 1 } },
    })
  })

  it('captures /goal from prompt routes without triggering a model turn', async () => {
    const base = fakeApi()
    const calls: Array<{ method: string; payload: unknown }> = []
    const lines: string[] = []
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        prompt: async (request) => {
          calls.push({ method: 'session.prompt', payload: request })
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...base.sessionController,
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
      sessionController: {
        ...fakeApi().sessionController,
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
      sessionController: {
        ...fakeApi().sessionController,
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
      sessionController: {
        ...fakeApi().sessionController,
        prompt: async (request) => {
          const payload = request as unknown as { content: Array<{ type: string; text?: string }> }
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

  it('submits prompts with steer mode so a running turn sees an inserted message at the next step', async () => {
    // Regression (real session e0336d8b): a mid-turn insertion ("标题是…")
    // sat in dsh's next-turn queue for minutes while the model kept
    // searching, because the bridge hardcoded mode 'queue'. The official
    // opencode server appends the message to the running session and the
    // loop picks it up at the next step; dsh's equivalent is mode 'steer'
    // (next-step inbox), not 'queue' (next-turn).
    const calls: Array<{ mode?: string }> = []
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        prompt: async (request) => {
          calls.push({ mode: String((request as { mode?: unknown }).mode ?? '') })
          return okRpc({ accepted: true })
        },
      },
    })
    const { server } = await boot(api)
    const result = await request(server, 'POST', '/session/s1/message', {
      parts: [{ type: 'text', text: 'inserted while busy' }],
    })
    expect(result.status).toBe(200)
    expect(calls).toEqual([{ mode: 'steer' }])
  })
})
