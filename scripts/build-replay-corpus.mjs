#!/usr/bin/env node
// Deterministic synthetic replay corpus (experiment 1c). Generates small
// JSONL fixtures shaped like real dsh session events, covering the bridge's
// feature matrix (reasoning, single/multi tool, queued user, tool error,
// compaction, interrupt, goal change). No real session content is copied;
// all texts/ids are synthetic and reproducible.
//
// Usage: node scripts/build-replay-corpus.mjs [out-dir]
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] ?? join(here, '..', 'tests', 'fixtures', 'replay'))
if (existsSync(outDir)) rmSync(outDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

let seq = 0
let turn = 0
const baseTime = 1_000_000

const nextSeq = () => ++seq
const t = () => baseTime + seq * 1000

function ev(type, data, extra = {}) {
  return { type, seq: nextSeq(), time: t(), data, ...extra }
}

function chunkRow(type, texts, index, data = {}, time0 = t(), step = 1) {
  return {
    type,
    seq0: nextSeq(),
    time0,
    data: { turn, step, index, dt: [], texts, ...data },
  }
}

function toolChunkRow(args, index, callId, time0 = t(), step = 1) {
  return {
    type: 'tool-call-chunks',
    seq0: nextSeq(),
    time0,
    data: { turn, step, index, dt: [], id: callId, name: 'bash', args },
  }
}

function user(text = 'synthetic user prompt', id = `msg-user-${nextSeq()}`) {
  return ev('user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    role: 'user',
    id,
  })
}

function assistantChunk(blockType, text, index = 0, step = 1) {
  return ev('assistant/chunk', {
    turn,
    step,
    chunk: { type: 'text-delta', index, blockType, text },
  })
}

function toolCall(callId, name = 'bash', args = '{"command":"echo synthetic"}') {
  return ev('tool/call', { turn, step: 1, callId, name, arguments: args })
}

function toolResult(callId, text = 'synthetic tool output', error) {
  const message = {
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    role: 'assistant',
    id: `msg-tool-${nextSeq()}`,
  }
  if (error !== undefined) message.content[0].content = [{ type: 'text', text: error }]
  return ev('tool/result', { turn, step: 1, message, ...(error !== undefined ? { error } : {}) }, { sourceEventSeqs: [seq - 1] })
}

function assistantMessage(blocks, id = `msg-asst-${nextSeq()}`, step = 1) {
  return ev('assistant/message', {
    turn,
    step,
    message: {
      id,
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider: 'deepseek-official', model: 'mock-model' },
    },
    usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
}

function startTurn() {
  turn += 1
  return ev('turn/start', { turn })
}

function endTurn(kind = 'stop', reason = {}) {
  return ev('turn/end', { turn, reason: { kind, ...reason } })
}

function inboxSpliced(insertedUser, id = `msg-queued-${nextSeq()}`) {
  return ev('agent/inbox/spliced', {
    target: 'session-1',
    start: 0,
    inserted: [{
      content: [{ type: 'text', text: insertedUser }],
      source: { kind: 'user' },
      role: 'user',
      id,
    }],
  })
}

function compactionStart(key = 'c-1') {
  return ev('compaction/start', { compactionId: key })
}

function compactionSummary(key = 'c-1', text = 'synthetic compaction summary') {
  return ev('compaction/summary', {
    compactionId: key,
    summary: [{ type: 'text', text }],
  })
}

function compactionEnd(key = 'c-1') {
  return ev('compaction/end', { compactionId: key })
}

function goalChange(goal) {
  return ev('goal/change', { goal })
}

function fixture(name, features, build, equivalence = true) {
  seq = 0
  turn = 0
  const events = build()
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const file = `${name}.jsonl`
  writeFileSync(join(outDir, file), lines)
  return { file, eventCount: events.length, features, equivalence, bytes: Buffer.byteLength(lines) }
}

const fixtures = [
  fixture('plain-text-reasoning', ['reasoning', 'text'], () => [
    startTurn(),
    user('synthetic user prompt'),
    chunkRow('reasoning-chunks', ['synthetic reason']),
    chunkRow('text-chunks', ['synthetic answer']),
    assistantMessage([
      { type: 'reasoning', text: 'synthetic reason' },
      { type: 'text', text: 'synthetic answer' },
    ]),
    endTurn(),
  ]),
  fixture('single-tool-followup', ['tool', 'streamed-args', 'followup-text'], () => [
    startTurn(),
    user('run synthetic tool'),
    toolChunkRow(['{"command":"echo synth', 'etic"}'], 0, 'call-1'),
    assistantMessage([
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"echo synthetic"}' },
    ], 'msg-tool-call-1'),
    toolCall('call-1', 'bash', '{"command":"echo synthetic"}'),
    toolResult('call-1', 'synthetic tool output'),
    chunkRow('text-chunks', ['follow-up after tool'], 0, {}, t(), 2),
    assistantMessage([{ type: 'text', text: 'follow-up after tool' }], 'msg-followup-1', 2),
    endTurn(),
  ]),
  fixture('multi-tool-queued', ['multi-tool', 'queue', 'followup-text'], () => [
    startTurn(),
    user('run two tools'),
    toolChunkRow(['{"command":"echo first"}'], 0, 'call-1'),
    assistantMessage([
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"echo first"}' },
    ], 'msg-tool-call-1'),
    toolCall('call-1', 'bash', '{"command":"echo first"}'),
    toolResult('call-1', 'first output'),
    inboxSpliced('queued while busy', 'msg-queued-1'),
    toolChunkRow(['{"command":"echo second"}'], 0, 'call-2', t(), 2),
    assistantMessage([
      { type: 'tool-call', id: 'call-2', name: 'bash', arguments: '{"command":"echo second"}' },
    ], 'msg-tool-call-2', 2),
    toolCall('call-2', 'bash', '{"command":"echo second"}'),
    toolResult('call-2', 'second output'),
    chunkRow('text-chunks', ['both tools done'], 0, {}, t(), 3),
    assistantMessage([{ type: 'text', text: 'both tools done' }], 'msg-followup-1', 3),
    user('queued while busy', 'msg-queued-1'),
    endTurn(),
  ]),
  fixture('tool-error', ['tool-error'], () => [
    startTurn(),
    user('run failing tool'),
    assistantMessage([
      { type: 'tool-call', id: 'call-err', name: 'bash', arguments: '{"command":"false"}' },
    ], 'msg-tool-call-err'),
    toolCall('call-err', 'bash', '{"command":"false"}'),
    toolResult('call-err', 'synthetic error message', { name: 'ToolError', code: 'E_TOOL' }),
    endTurn(),
  ]),
  fixture('compaction', ['compaction', 'text'], () => [
    compactionStart('c-1'),
    compactionSummary('c-1', 'synthetic compaction summary'),
    startTurn(),
    user('post-compaction prompt'),
    assistantChunk('text-delta', 'post-compaction answer', 0),
    assistantMessage([{ type: 'text', text: 'post-compaction answer' }]),
    endTurn(),
    compactionEnd('c-1'),
  ]),
  fixture('interrupted', ['interrupt'], () => [
    startTurn(),
    user('interrupt me'),
    assistantChunk('text-delta', 'partial', 0),
    endTurn('interrupted', { message: 'synthetic interrupt' }),
  ], false),
  fixture('goal-change', ['goal'], () => [
    startTurn(),
    goalChange({ text: 'synthetic goal', status: 'active' }),
    user('work on goal'),
    assistantChunk('text-delta', 'goal acknowledged', 0),
    assistantMessage([{ type: 'text', text: 'goal acknowledged' }]),
    endTurn(),
  ]),
]

const manifest = {
  generator: 'scripts/build-replay-corpus.mjs',
  version: 1,
  generatedAt: new Date().toISOString(),
  note: 'Synthetic structure-preserving fixtures; no real session content.',
  fixtures,
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

for (const f of fixtures) {
  console.log(`wrote ${f.file} (${f.bytes} bytes, features: ${f.features.join(',')})`)
}
console.log(`replay corpus: ${fixtures.length} fixtures -> ${outDir}`)
