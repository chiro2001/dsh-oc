import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const gen = require('../scripts/perf-session-gen.mjs') as {
  encodeSegment: (raw: string) => string
  projectKey: (cwd: string) => string
  makeSessionLog: (options: Record<string, unknown>) => {
    id: string
    header: { id: string; version: number; cwd?: string; delegationDepth?: number; agentPreset?: string }
    events: Array<{ type: string; seq: number; surfaceOp?: string }>
    text: string
    bytes: number
  }
  writeSessionLog: (root: string, options: { id: string; cwd: string; text: string }) => { path: string; bytes: number }
  generateSessionHome: (options: Record<string, unknown>) => {
    sessions: number
    bytes: number
    sessionIds: string[]
  }
}

const { encodeSegment, generateSessionHome, makeSessionLog, projectKey, writeSessionLog } = gen

const { summarize } = require('../scripts/perf.mjs') as {
  summarize: (values: number[]) => { n: number; p50: number; p95: number; max: number; min: number }
}

/**
 * Locate complete zstd frames without decompressing their blocks — a compact
 * port of dsh-session-persistence-jsonl's scanZstdFrames so the round-trip
 * test validates the exact frame layout the harness reads.
 */
function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('invalid zstd frame magic')
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved block type')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

function decompressAllFrames(buffer: Buffer): Buffer {
  return Buffer.concat(scanZstdFrames(buffer).map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end))))
}

describe('perf session generator', () => {
  it('encodes project keys and session ids like the dsh jsonl backend', () => {
    expect(projectKey('/tmp/project/work'))
      .toBe('--tmp-project-work--')
    expect(encodeSegment('session-9954f803-06e0-419a-a804-4dfb2eaed0de'))
      .toBe('session-9954f803-06e0-419a-a804-4dfb2eaed0de')
    expect(encodeSegment('weird/name~')).toBe('weird~002Fname~007E')
    expect(projectKey('/')).toBe('--root--')
  })

  it('builds a validated session log with contiguous seq and balanced turns', () => {
    const log = makeSessionLog({
      id: 'session-perf-test-1',
      cwd: '/tmp/perf-work',
      createdAt: 1_700_000_000_000,
      turns: 3,
      tools: true,
      todos: true,
      rng: () => 0.5,
    })

    expect(log.header.id).toBe('session-perf-test-1')
    expect(log.header.version).toBe(0)
    expect(log.header.cwd).toBe('/tmp/perf-work')
    expect(log.header.delegationDepth).toBe(0)
    expect(log.header.agentPreset).toBe('minimal')

    const events = log.events
    expect(events.map((event: { seq: number }) => event.seq)).toEqual(events.map((_: unknown, index: number) => index))

    const byType = (type: string) => events.filter((event) => event.type === type)
    expect(byType('turn/start')).toHaveLength(3)
    expect(byType('turn/end')).toHaveLength(3)
    expect(byType('user/message').every((event: { surfaceOp?: string }) => event.surfaceOp === 'append')).toBe(true)
    expect(byType('assistant/message').every((event: { surfaceOp?: string }) => event.surfaceOp === 'append')).toBe(true)
    expect(byType('tool/call')).toHaveLength(1)
    expect(byType('tool/result').every((event: { surfaceOp?: string }) => event.surfaceOp === 'append')).toBe(true)
    expect(byType('todo/write')).toHaveLength(2)

    // The detached dsh Session API itself accepts the log back (restore path).
    expect(() => Session.fromRestore(SessionId(log.id), log.events as never, log.header as never)).not.toThrow()
  })

  it('serializes header-first JSONL and round-trips through zstd', async () => {
    const log = makeSessionLog({ id: 'session-perf-roundtrip', cwd: '/work', turns: 2 })
    const lines = log.text.trimEnd().split('\n')
    expect(JSON.parse(lines[0] ?? '').type).toBe('session')
    expect(lines.length - 1).toBe(log.events.length)
    for (let index = 1; index < lines.length; index++) {
      const event = JSON.parse(lines[index] ?? '') as { seq: number }
      expect(event.seq).toBe(index - 1)
    }
    expect(log.text.endsWith('\n')).toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-perf-'))
    try {
      const cwd = log.header.cwd ?? '/work'
      const written = writeSessionLog(dir, { id: log.id, cwd, text: log.text })
      expect(existsSync(written.path)).toBe(true)
      const decoded = decompressAllFrames(readFileSync(written.path)).toString('utf8')
      expect(decoded).toBe(log.text)
      expect(written.path).toContain(join(projectKey(cwd), encodeSegment(log.id)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates a session home with subagent children and reports sizes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-perf-home-'))
    try {
      const stats = generateSessionHome({
        dshHome: dir,
        cwd: '/work',
        sessions: 4,
        messagesPerSession: 2,
        children: 2,
        seed: 7,
        quiet: true,
      })
      expect(stats.sessions).toBe(6)
      expect(stats.sessionIds).toHaveLength(4)
      expect(stats.bytes).toBeGreaterThan(0)
      const sessionDir = join(dir, 'sessions', projectKey('/work'))
      expect(existsSync(sessionDir)).toBe(true)
      const sessionEntries = readdirSync(sessionDir)
      expect(sessionEntries).toHaveLength(6)
      for (const entry of sessionEntries) {
        expect(existsSync(join(sessionDir, entry, 'session.jsonl.zstd'))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('perf report math', () => {
  it('computes p50/p95/max on latency samples', () => {
    const result = summarize([5, 3, 8, 1, 2, 7, 4, 9, 6, 10])
    expect(result.p50).toBe(5)
    expect(result.p95).toBe(10)
    expect(result.max).toBe(10)
    expect(result.min).toBe(1)
    expect(result.n).toBe(10)
  })
})
