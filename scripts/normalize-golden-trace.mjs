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
  /^[0-9a-f]{16}$/,
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
    if (['time', 'time0', 'timestamp', 'created', 'completed', 'updated', 'start', 'end', 'dt'].includes(key)) {
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

const filtered = events
  // Tool streaming is timing-sensitive: the coalescing flush timer races with
  // fast tool results, so intermediate `session.next.tool.*` frames and the
  // pending tool `message.part.updated` rows appear in some runs and not
  // others. Drop them so the golden trace compares the stable message graph
  // (message.updated + text parts + the final completed tool part), not
  // scheduler jitter.
  .filter((event) => {
    const payload = event.payload ?? event
    const type = payload.type ?? 'unknown'
    if (typeof type !== 'string') return true
    if (type.startsWith('session.next.tool.')) return false
    if (type === 'session.updated') return false
    // `finish:"tool-calls"` assistant rows mark the moment the tool-call step
    // committed, which the tool streaming flush can duplicate across runs.
    if (type === 'message.updated') {
      const info = (payload.properties ?? {}).info
      if (info && info.finish === 'tool-calls') return false
      // Provisional assistant placeholder rows (all-zero tokens, no finish)
      // are emitted at turn start and can be dropped by a fast first chunk,
      // so their presence is timing-dependent. Filter them out.
      if (info && info.role === 'assistant' && info.finish === undefined) {
        const tokens = info.tokens
        const zeroTokens = tokens === undefined
          || (tokens.input === 0 && tokens.output === 0 && tokens.reasoning === 0)
        if (zeroTokens) return false
      }
    }
    if (type === 'message.part.updated') {
      const props = payload.properties ?? {}
      const part = props.part
      if (part && part.type === 'tool') return false
    }
    return true
  })

// Sort before tokenizing: `normalize` assigns ids by first-seen order, so a
// nondeterministic arrival order would give the same semantic events
// different ids across runs. Sorting first makes the assignment (and thus the
// golden comparison) order-independent.
// Structural sort key: type + content with all random-id values blanked, so
// two runs of the same scenario sort identically and `token()` (which assigns
// ids by first-seen order) yields the same mapping regardless of the raw ids
// that arrived first.
function structuralKey(value) {
  if (Array.isArray(value)) return value.map(structuralKey).join('\u0001')
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().map((k) => `${k}=${structuralKey(value[k])}`).join('\u0001')
  }
  if (typeof value === 'string') {
    if (ID_PATTERNS.some((pattern) => pattern.test(value))) return ''
    if (/\/home\/|\/Users\/|C:\\/.test(value)) {
      return value.replace(/\/home\/[^\s"]*|\/Users\/[^\s"]*|C:\\[^\s"]*/g, '/workspace')
    }
    return value
  }
  return String(value)
}

const normalized = [...filtered]
  .sort((a, b) => {
    const at = (a.payload ?? a).type ?? ''
    const bt = (b.payload ?? b).type ?? ''
    if (at !== bt) return at < bt ? -1 : 1
    const ak = structuralKey(a)
    const bk = structuralKey(b)
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
  .map((event) => {
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
