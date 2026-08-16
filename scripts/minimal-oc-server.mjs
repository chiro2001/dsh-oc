#!/usr/bin/env node
// Minimal OpenCode-compatible server for the renderer-attribution repro
// (experiment 1c): serves the full bridge route surface with a scripted
// dsh event feed (a replay-corpus fixture) instead of a real dsh backend.
// The official opencode 1.18.18 TUI can attach with `-s <sid>` and observe
// exactly the event sequence we control — no dsh, no real model, no timing
// jitter beyond the configurable per-event delay.
//
// Usage: node scripts/minimal-oc-server.mjs [fixture.jsonl] [session-id] [delay-ms]
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBridgeRouter, startBridgeServer } from '../lib/bridge/router-entry.js'

const fixturePath = resolve(process.argv[2] ?? 'tests/fixtures/replay/queued-mid-followup.jsonl')
const sessionId = process.argv[3] ?? 'session-11111111-1111-4111-8111-111111111111'
const delayMs = Number(process.argv[4] ?? '120')

const events = readFileSync(fixturePath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const ok = (value) => ({ rpcId: 'rpc-1', result: { ok: true, value } })
const item = {
  sessionId,
  updatedAt: 2000,
  running: true,
  blank: false,
  cwd: process.cwd(),
  agentPreset: 'build',
  projections: { asOfSeq: 0, values: { title: 'Minimal Server Session' } },
}

const api = {
  sessions: {
    list: async () => ok({ items: [item] }),
    search: async () => ok({ items: [], hasMore: false }),
    create: async () => ok({ sessionId }),
    fork: async () => ok({ sessionId }),
    // Empty durable history: the live mux feed below is the only source, so
    // the TUI must build the conversation from streaming events (this is
    // where the transient render-order race lives).
    history: async () => ok({ events: [], hasMore: false }),
    models: async () => ok({
      current: { provider: 'deepseek-official', model: 'mock-model' },
      routable: true,
      groups: [],
      failures: [],
    }),
    rename: async () => ok({ title: 't', seq: 1 }),
    prompt: async () => ok({ accepted: true }),
    cancel: async () => ok({ accepted: true }),
    selectModel: async () => ok({
      selected: { provider: 'deepseek-official', model: 'mock-model', reasoningEffort: 'off' },
    }),
  },
  host: {
    describe: async () => ok({
      version: '0.1.0-rc.6',
      cwd: process.cwd(),
      attachedSessions: 0,
      canOpenPath: false,
    }),
  },
  agentPresets: {
    list: async () => ok({ presets: [], authorable: false, hasDocument: false }),
    select: async () => ok({ agentPreset: 'standard' }),
  },
  goals: {
    create: async () => ok({ ref: { id: 'g1', revision: 1 } }),
    edit: async () => ok({ ref: { id: 'g1', revision: 2 } }),
    pause: async () => ok({ ref: { id: 'g1', revision: 3 } }),
    resume: async () => ok({ ref: { id: 'g1', revision: 4 } }),
    complete: async () => ok({ ref: { id: 'g1', revision: 5 } }),
    clear: async () => ok({ cleared: true }),
  },
  skills: { list: async () => ok({ skills: [] }) },
  llm: { models: async () => ok({ groups: [], failures: [] }) },
  events: {
    mux: async function* () {
      // The TUI validates the attached session from its first session.updated.
      yield {
        rpcId: 'rpc-session',
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'session',
            seq: -1,
            time: Date.now(),
            createdAt: Date.now(),
            cwd: process.cwd(),
            title: 'Minimal Server Session',
          },
        },
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
      for (const event of events) {
        yield {
          rpcId: `rpc-${event.seq ?? 0}`,
          payload: { type: 'session/event', sessionId, event },
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
      }
    },
    host: async function* () {},
  },
  respond: async () => ({ accepted: true }),
}

const router = createBridgeRouter(api, { cwd: process.cwd(), sseRetryBaseMs: 10 })
const server = await startBridgeServer(router)
process.stdout.write(`READY ${server.url}\n`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
await new Promise(() => {})
