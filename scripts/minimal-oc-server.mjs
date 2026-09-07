#!/usr/bin/env node
// Minimal OpenCode-compatible server for the renderer-attribution repro
// (experiment 1c): serves the full bridge route surface with a scripted
// dsh event feed (a replay-corpus fixture) instead of a real dsh backend.
// The official opencode 1.18.18 TUI can attach with `-s <sid>` and observe
// exactly the event sequence we control — no dsh, no real model, no timing
// jitter beyond the configurable per-event delay.
//
// Usage: node scripts/minimal-oc-server.mjs [fixture.jsonl] [session-id] [delay-ms]
//        node scripts/minimal-oc-server.mjs --sse <trace.raw> [session-id] [delay-ms]
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBridgeRouter, startBridgeServer } from '../lib/bridge/router-entry.js'

const args = process.argv.slice(2)
const sseIndex = args.indexOf('--sse')
const rawSsePath = sseIndex === -1 ? undefined : args[sseIndex + 1]
const fixturePath = sseIndex === -1
  ? resolve(args[0] ?? 'tests/fixtures/replay/queued-mid-followup.jsonl')
  : resolve('tests/fixtures/replay/queued-mid-followup.jsonl')
const sessionId = sseIndex === -1
  ? (args[1] ?? 'session-11111111-1111-4111-8111-111111111111')
  : (args[sseIndex + 2] ?? 'session-11111111-1111-4111-8111-111111111111')
const delayMs = sseIndex === -1 ? Number(args[2] ?? '120') : Number(args[sseIndex + 3] ?? '20')

const events = readFileSync(fixturePath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const rawEvents = rawSsePath === undefined
  ? undefined
  : readFileSync(resolve(rawSsePath), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event && event.payload)

// Derive the replay context from the recorded trace so the TUI sees the
// same directory/project as the original attach.
const replayContext = rawEvents === undefined
  ? undefined
  : (() => {
      const first = rawEvents.find((event) => event.payload?.type === 'session.updated')
      const info = first?.payload?.properties?.info ?? {}
      return {
        directory: first?.directory ?? info.directory ?? process.cwd(),
        project: first?.project ?? info.projectID ?? 'replay-project',
      }
    })()

const item = {
  sessionId,
  updatedAt: 2000,
  running: true,
  blank: false,
  cwd: replayContext?.directory ?? process.cwd(),
  agentPreset: 'build',
  projections: {
    asOfSeq: 0,
    values: { title: replayContext === undefined ? 'Minimal Server Session' : 'Replay Session' },
  },
}

const api = {
  sessionController: {
    list: async () => ({ items: [item] }),
    search: async () => ({ items: [], hasMore: false }),
    create: async () => ({ sessionId }),
    fork: async () => ({ sessionId }),
    // Empty durable history: the scripted session/event feed below is the
    // only conversation source, so the TUI must build the surface from the
    // exact SSE order we control.
    history: async () => ({ events: [], hasMore: false }),
    models: async () => ({
      current: { provider: 'deepseek-official', model: 'mock-model' },
    }),
    modelCatalog: async () => ({
      default: { provider: 'deepseek-official', model: 'mock-model' },
      routableProviders: ['deepseek-official'],
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'mock-model', name: 'Mock Model' }],
      }],
      failures: [],
    }),
    rename: async () => ({ title: 't', seq: 1 }),
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
    selectModel: async () => ({
      selected: { provider: 'deepseek-official', model: 'mock-model', reasoningEffort: 'off' },
    }),
    page: async () => ({ records: [], hasMore: false }),
    follow: async function* () {
      yield {
        type: 'snapshot',
        header: {},
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      }
    },
    control: async function* () {},
    resolveAgent: async () => ({ agent: { id: session } }),
  },
  agentPresets: {
    list: async () => [],
    select: async () => 'standard',
    defaultId: 'standard',
  },
  goals: {
    create: async () => ({ id: 'g1', revision: 1 }),
    edit: async () => ({ id: 'g1', revision: 2 }),
    pause: async () => ({ id: 'g1', revision: 3 }),
    resume: async () => ({ id: 'g1', revision: 4 }),
    complete: async () => ({ id: 'g1', revision: 5 }),
    clear: async () => ({ cleared: true }),
  },
  sessionSkillCatalog: { list: async () => ({ skills: [] }) },
  commands: undefined,
  agents: undefined,
  sessions: undefined,
  sessionProjections: undefined,
}

const router = createBridgeRouter(api, {
  cwd: replayContext?.directory ?? process.cwd(),
  sseRetryBaseMs: 10,
})
const server = await startBridgeServer(router)
process.stdout.write(`READY ${server.url}\n`)

const feedScriptedEvents = async () => {
  if (rawEvents !== undefined) return
  // The official TUI opens SSE after its bootstrap HTTP calls. Wait for that
  // client before emitting the scripted live feed; otherwise a shared-host
  // pump would legitimately broadcast before any observer exists and this
  // renderer-attribution harness would test startup loss instead of ordering.
  const clientDeadline = Date.now() + 30_000
  while (router.ctx.hub.size === 0 && Date.now() < clientDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  // Give the client time to finish the attach/session hydration after opening
  // SSE. This keeps the renderer repro about message ordering, not whether
  // the first live frame raced the TUI's initial sync.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(delayMs, 1000)))
  await router.feed({
    type: 'session/event',
    sessionId,
    event: {
      type: 'session',
      seq: -1,
      time: Date.now(),
      data: { createdAt: Date.now(), cwd: process.cwd(), title: 'Minimal Server Session' },
    },
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  for (const event of events) {
    await router.feed({
      type: 'session/event',
      sessionId,
      event,
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }
}

void feedScriptedEvents()

if (rawEvents !== undefined) {
  // Raw replay mode: broadcast the recorded bridge SSE events verbatim to
  // every connected client, in the exact recorded order and timing. Events
  // enqueued before the first client connects are buffered by the hub and
  // flushed on subscribe, so late-connecting clients miss nothing.
  void (async () => {
    if (replayContext !== undefined) {
      router.ctx.hub.enqueue([{
        directory: replayContext.directory,
        project: replayContext.project,
        payload: {
          id: 'replay-session-updated',
          type: 'session.updated',
          properties: {
            sessionID: sessionId,
            info: {
              id: sessionId,
              directory: replayContext.directory,
              projectID: replayContext.project,
              title: 'Replay Session',
            },
          },
        },
      }])
    }
    for (const source of rawEvents) {
      const event = {
        ...source,
        directory: replayContext?.directory ?? source.directory,
        project: replayContext?.project ?? source.project,
        payload: {
          ...source.payload,
          properties: {
            ...source.payload.properties,
            ...(replayContext === undefined ? {} : { sessionID: sessionId }),
          },
        },
      }
      router.ctx.hub.enqueue([event])
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
    }
  })()
}

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
await new Promise(() => {})
