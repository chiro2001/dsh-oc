#!/usr/bin/env node
// Real-session feature coverage scan (experiment 1c): walks a dsh sessions
// directory, computes per-session event-type and feature statistics, and
// reports which synthetic replay-corpus features are covered by real
// sessions. No session content, ids or paths are emitted — only counts.
//
// Usage: node scripts/replay-corpus-manifest.mjs [sessions-dir] [corpus-manifest]
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sessionRoot = resolve(process.argv[2] ?? `${process.env.HOME ?? ''}/.dsh/sessions`)
const corpusManifestPath = resolve(
  process.argv[3] ?? join(repoRoot, 'tests', 'fixtures', 'replay', 'manifest.json'),
)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name === 'session.jsonl.zstd') out.push(full)
  }
  return out
}

function featuresOf(types, events) {
  const features = new Set()
  if (types['reasoning-chunks'] > 0) features.add('reasoning')
  if (types['text-chunks'] > 0) features.add('text')
  if (types['tool/call'] > 0) features.add('tool')
  if (types['agent/inbox/spliced'] > 0) features.add('queue')
  if (types['compaction/start'] > 0 || types['compaction/summary'] > 0 || types['compaction/end'] > 0) {
    features.add('compaction')
  }
  if (types['goal/change'] > 0) features.add('goal')
  if (types['session/title'] > 0) features.add('session-title')
  if (events.length >= 10000) features.add('long-session')

  const toolCallsByTurn = new Map()
  let toolError = false
  let interrupted = false
  let pluginContext = false
  for (const event of events) {
    if (event.type === 'tool/call') {
      const turn = String(event.data?.turn ?? '')
      toolCallsByTurn.set(turn, (toolCallsByTurn.get(turn) ?? 0) + 1)
    } else if (event.type === 'tool/result' && event.data?.error !== undefined) {
      toolError = true
    } else if (event.type === 'turn/end') {
      const kind = String(event.data?.reason?.kind ?? '')
      if (!['completed', 'stop'].includes(kind)) interrupted = true
    } else if (event.type === 'user/message') {
      const text = JSON.stringify(event.data?.content ?? '')
      if (text.includes('Current runtime context')) pluginContext = true
    }
  }
  if ([...toolCallsByTurn.values()].some((count) => count >= 2)) features.add('multi-tool')
  if (toolError) features.add('tool-error')
  if (interrupted) features.add('interrupt')
  if (pluginContext) features.add('plugin-context')
  if (types['turn/start'] > types['turn/end']) features.add('unfinished-turn')
  return features
}

if (!existsSync(sessionRoot)) {
  console.error(`replay-corpus-manifest: sessions dir not found: ${sessionRoot}`)
  process.exit(2)
}

const files = walk(sessionRoot)
const totals = { sessions: 0, events: 0 }
const eventTypes = {}
const featureSessions = {}
const perSession = []
const START = Date.now()

for (const file of files) {
  let raw
  try {
    raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8')
  } catch (error) {
    console.error(`replay-corpus-manifest: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const events = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((event) => event !== null)
  if (events.length === 0) continue
  totals.sessions += 1
  totals.events += events.length
  const types = {}
  for (const event of events) {
    const type = String(event.type ?? 'unknown')
    types[type] = (types[type] ?? 0) + 1
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }
  for (const feature of featuresOf(types, events)) {
    featureSessions[feature] = (featureSessions[feature] ?? 0) + 1
  }
  perSession.push({
    events: events.length,
    types,
    features: [...featuresOf(types, events)].sort(),
  })
}

const corpus = existsSync(corpusManifestPath)
  ? JSON.parse(readFileSync(corpusManifestPath, 'utf8'))
  : null
const corpusFeatures = new Set(
  (corpus?.fixtures ?? []).flatMap((fixture) => fixture.features ?? []),
)
const realFeatures = Object.keys(featureSessions)

const report = {
  generatedAt: new Date().toISOString(),
  sessionRoot,
  sessionCount: totals.sessions,
  eventCount: totals.events,
  eventTypes: Object.fromEntries(
    Object.entries(eventTypes).sort((a, b) => Number(b[1]) - Number(a[1])),
  ),
  featureSessions: Object.fromEntries(
    Object.entries(featureSessions).sort((a, b) => Number(b[1]) - Number(a[1])),
  ),
  corpus: corpus === null
    ? null
    : {
        fixtures: corpus.fixtures.length,
        features: [...corpusFeatures].sort(),
        covered: realFeatures.filter((feature) => corpusFeatures.has(feature)).sort(),
        missingInCorpus: realFeatures.filter((feature) => !corpusFeatures.has(feature)).sort(),
        corpusOnly: [...corpusFeatures].filter((feature) => !realFeatures.includes(feature)).sort(),
      },
  elapsedMs: Date.now() - START,
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
