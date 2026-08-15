#!/usr/bin/env node
/**
 * dsh-oc perf session generator.
 *
 * Synthesizes a dsh session home directly on disk using the same
 * `@deepseek-ai/dsh-session` detached `Session` API that the harness uses for
 * its durable logs, then serializes with the JSONL backend layout and zstd
 * compression (`node:zlib`). No LLM calls are involved, so thousands of
 * sessions can be generated in seconds.
 *
 * Layout (mirrors @deepseek-ai/dsh-session-persistence-jsonl):
 *   $DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl.zstd
 *
 * CLI:
 *   node scripts/perf-session-gen.mjs \
 *     --sessions 1000 --messages-per-session 6 \
 *     [--tools] [--todos] [--children 5] \
 *     --dsh-home <path> [--cwd <path>] [--seed 42] [--quiet]
 */

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'

/** Encode one path segment exactly like dsh-session-persistence-jsonl. */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Build the readable project directory key for a cwd (dsh layout). */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Small deterministic PRNG for reproducible session ids. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic uuid-like string when a seeded rng is supplied. */
function makeId(prefix, rng = Math.random) {
  const hex = () => Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0')
  return `${prefix}-${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-${hex().slice(0, 4)}-${hex()}`
}

const SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'
/** Match dsh-session-persistence-jsonl's checksummed frame encoding. */
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const TOOL_SCHEMAS = [
  {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
      },
      required: ['command'],
    },
  },
]

function requestHeader(reason) {
  return {
    header: {
      config: {
        provider: 'deepseek-official',
        model: 'mock-model',
        maxTokens: 8192,
        reasoningEffort: 'off',
      },
      adapterDefaults: { reasoningEffort: true, maxTokens: true },
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
    },
    reason,
  }
}

/**
 * Build one validated session log using the detached dsh Session API.
 * @returns {{ id: string, header: object, events: object[], text: string, bytes: number }}
 */
export function makeSessionLog({
  id,
  cwd,
  createdAt = Date.now(),
  turns = 3,
  tools = false,
  todos = false,
  agentPreset = 'minimal',
  parentSession,
  delegationDepth,
  origin,
  rng = Math.random,
}) {
  const session = Session.create(
    SessionId(id),
    undefined,
    {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
      delegationDepth: delegationDepth ?? 0,
      ...(origin === undefined ? {} : { origin }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
  )

  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
  session.append('approval/policy', { policy: 'never' })

  let turn = 0
  let titleSeq
  for (turn = 1; turn <= turns; turn++) {
    const step = 1
    const userText = `perf turn ${turn}: fix the TODO and verify`
    const userMessage = {
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user', rpcId: makeId('rpc', rng) },
      role: 'user',
      id: makeId('msg-user', rng),
    }
    session.append('turn/start', { turn })
    const userEvent = session.append('user/message', userMessage, { surfaceOp: 'append' })
    if (turn === 1) {
      titleSeq = userEvent.seq
      session.append('session/title', {
        title: `perf session ${turn}`,
        messageSeqs: [titleSeq],
        source: { kind: 'fallback' },
      })
    }
    session.append('request/header', requestHeader(turn === 1 ? 'initial' : 'resume'))
    session.append('step/start', { turn, step })
    if (todos && turn % 2 === 1) {
      session.append('todo/write', {
        todos: [
          { content: 'write the fixture', status: turn === 1 ? 'in_progress' : 'pending' },
          { content: 'verify with tests', status: 'pending' },
        ],
      })
    }

    if (tools && turn % 2 === 0) {
      const callId = makeId('call', rng)
      const argumentsJson = JSON.stringify({ command: 'echo perf-tool-output' })
      const assistantId = makeId('msg-assistant', rng)
      session.append('assistant/message', {
        turn,
        step,
        message: {
          id: MessageId(assistantId),
          role: 'assistant',
          content: [{ type: 'tool-call', id: CallId(callId), name: 'bash', arguments: argumentsJson }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'mock-model' },
        },
        usage: { inputTokens: 160, outputTokens: 24 },
      }, { surfaceOp: 'append' })
      session.append('tool/call', {
        turn,
        step,
        callId: CallId(callId),
        name: 'bash',
        arguments: argumentsJson,
      })
      session.append('tool/result', {
        turn,
        step,
        message: {
          id: MessageId(makeId('msg-tool', rng)),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: CallId(callId),
            content: [{ type: 'text', text: 'perf-tool-output\n' }],
            isError: false,
          }],
          source: { kind: 'tool', callId: CallId(callId) },
        },
      }, { surfaceOp: 'append' })
    } else {
      session.append('assistant/message', {
        turn,
        step,
        message: {
          id: MessageId(makeId('msg-assistant', rng)),
          role: 'assistant',
          content: [{ type: 'text', text: `perf assistant reply ${turn}` }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'mock-model' },
        },
        usage: { inputTokens: 160, outputTokens: 80 },
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  const header = session.header
  const events = session.events
  const headerLine = { type: 'session', ...header }
  const text = `${JSON.stringify(headerLine)}\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  return { id, header, events, text, bytes: Buffer.byteLength(text) }
}

/**
 * Write one session log under a dsh home.
 * @returns {{ path: string, bytes: number }}
 */
export function writeSessionLog(root, { id, cwd, text }) {
  const dir = join(root, projectKey(cwd), encodeSegment(id))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'session.jsonl.zstd')
  const newline = text.indexOf('\n')
  const header = Buffer.from(text.slice(0, newline + 1))
  const body = Buffer.from(text.slice(newline + 1))
  const frames = Buffer.concat([
    zstdCompressSync(header, ZSTD_CHECKSUM_OPTIONS),
    zstdCompressSync(body, ZSTD_CHECKSUM_OPTIONS),
  ])
  writeFileSync(path, frames, { mode: 0o600 })
  chmodSync(dir, 0o700)
  return { path, bytes: Buffer.byteLength(text) }
}

/** Generate a full session home; returns stats. */
export function generateSessionHome({
  dshHome,
  cwd,
  sessions = 100,
  messagesPerSession = 3,
  tools = false,
  todos = false,
  children = 0,
  seed,
  quiet = false,
}) {
  const rng = seed === undefined ? Math.random : mulberry32(seed)
  const root = join(dshHome, 'sessions')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let files = 0
  let bytes = 0
  const sessionIds = []

  for (let i = 1; i <= sessions; i++) {
    const id = makeId('session', rng)
    sessionIds.push(id)
    const log = makeSessionLog({
      id,
      cwd,
      createdAt: Date.now() - (sessions - i) * 60_000,
      turns: messagesPerSession,
      tools,
      todos,
      rng,
    })
    const written = writeSessionLog(root, { id, cwd, text: log.text })
    files += 1
    bytes += written.bytes
    if (children > 0 && i % Math.ceil(sessions / children) === 0) {
      const childId = makeId('session', rng)
      const childLog = makeSessionLog({
        id: childId,
        cwd,
        createdAt: Date.now() - 10_000,
        turns: 2,
        tools,
        todos,
        parentSession: id,
        delegationDepth: 1,
        origin: 'subagent',
        rng,
      })
      const writtenChild = writeSessionLog(root, { id: childId, cwd, text: childLog.text })
      files += 1
      bytes += writtenChild.bytes
    }
    if (!quiet && (i % 250 === 0 || i === sessions)) {
      process.stderr.write(`perf: generated ${i}/${sessions} sessions (${(bytes / 1024 / 1024).toFixed(1)} MiB)\n`)
    }
  }
  return { sessions: files, bytes, sessionIds }
}

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

function hasFlag(argv, name) {
  return argv.includes(name)
}

if (process.argv[1] && process.argv[1].endsWith('perf-session-gen.mjs')) {
  const argv = process.argv.slice(2)
  const dshHome = argValue(argv, '--dsh-home')
  if (!dshHome) {
    console.error('usage: perf-session-gen.mjs --dsh-home <path> [--sessions N] [--messages-per-session N] [--tools] [--todos] [--children N] [--cwd PATH] [--seed N] [--quiet]')
    process.exit(2)
  }
  const stats = generateSessionHome({
    dshHome,
    cwd: argValue(argv, '--cwd', process.cwd()),
    sessions: Number(argValue(argv, '--sessions', '100')),
    messagesPerSession: Number(argValue(argv, '--messages-per-session', '3')),
    tools: hasFlag(argv, '--tools'),
    todos: hasFlag(argv, '--todos'),
    children: Number(argValue(argv, '--children', '0')),
    seed: argValue(argv, '--seed', undefined),
    quiet: hasFlag(argv, '--quiet'),
  })
  console.log(JSON.stringify(stats))
}
