#!/usr/bin/env node
// Normalize a raw bridge SSE trace into a structural golden baseline for
// the official opencode version lane (experiment 1c). Random ids and
// timing fields are replaced deterministically so two runs of the same
// scenario can be diffed structurally.
//
// Usage: node scripts/normalize-golden-trace.mjs <raw.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [rawPath, outPath] = process.argv.slice(2)
if (!rawPath || !outPath) {
  console.error('usage: normalize-golden-trace.mjs <raw.jsonl> <out.jsonl>')
  process.exit(2)
}

const idMap = new Map()
let nextId = 0
const ID_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^msg_pending:/,
  /^prt_stream:/,
  /^msg_[0-9a-f-]+(:\d+)?$/,
  /^tool:[A-Za-z0-9-]+$/,
  /^session-[0-9a-f-]+$/,
  /^call-[0-9]+$/,
  /^mock-call-[0-9]+$/,
  /^rpc-[0-9a-f-]+$/,
  /^pending:session-/,
]

function token(value) {
  if (idMap.has(value)) return idMap.get(value)
  const next = `id-${nextId++}`
  idMap.set(value, next)
  return next
}

function normalizeValue(value, key) {
  if (typeof value === 'string') {
    if (ID_PATTERNS.some((pattern) => pattern.test(value))) return token(value)
    if (/\/home\/|\/Users\/|C:\\/.test(value)) {
      return value.replace(/\/home\/[^\s"]*|\/Users\/[^\s"]*|C:\\[^\s"]*/g, '/workspace')
    }
    return value
  }
  if (typeof value === 'number') {
    // Timing fields are dropped entirely (golden-trace convention: keep
    // structure and references, not absolute or relative times).
    if (['time', 'time0', 'timestamp', 'created', 'completed', 'start', 'end', 'dt'].includes(key)) {
      return undefined
    }
    return value
  }
  return value
}

function normalize(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, key))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, normalize(v, k)])
        .filter(([, v]) => v !== undefined),
    )
  }
  return normalizeValue(value, key)
}

const raw = readFileSync(resolve(rawPath), 'utf8')
// Accept both raw JSONL and SSE framing (id:/data: blocks).
const lines = []
for (const line of raw.split('\n')) {
  const trimmed = line.trim()
  if (trimmed.startsWith('data: ')) {
    lines.push(trimmed.slice(6))
  } else if (trimmed.startsWith('{')) {
    lines.push(trimmed)
  }
}
const events = lines
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((event) => event !== null)

const normalized = events.map((event) => {
  const payload = event.payload ?? event
  return {
    type: payload.type ?? 'unknown',
    props: normalize(payload.properties ?? payload.data ?? {}),
  }
})

writeFileSync(resolve(outPath), `${normalized.map((event) => JSON.stringify(event)).join('\n')}\n`)
const serialized = JSON.stringify(normalized)
for (const pattern of [/\/home\//, /\/Users\//, /C:\\\\/, /sk-[A-Za-z0-9]{16,}/, /-----BEGIN/]) {
  if (pattern.test(serialized)) {
    console.error(`normalize-golden-trace: output still contains ${pattern}`)
    process.exit(1)
  }
}
process.stdout.write(
  `normalized ${normalized.length} events -> ${outPath}\n`,
)
