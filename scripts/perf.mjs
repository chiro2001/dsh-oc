#!/usr/bin/env node
/**
 * dsh-oc session performance harness (Roadmap N4).
 *
 * Generates a synthetic dsh session home, boots the real `dsh --profile oc`
 * bridge (with a fake opencode child), and measures:
 *   - GET /session            (v1 list) and GET /api/session (v2 list)
 *   - GET /session/:id/message (v1/v2 message pagination)
 *   - SSE /global/event first-event latency
 *   - dsh process RSS at each scale
 *
 * CLI:
 *   pnpm run perf -- --sessions 1000 --messages-per-session 6 --tools
 *   node scripts/perf.mjs --sessions 200 --no-boot
 *   node scripts/perf.mjs --sessions 5000 --tools --todos --children 10 --keep
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSessionHome } from './perf-session-gen.mjs'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const fakeBin = join(repoRoot, 'tests', 'e2e', 'fake-opencode.sh')
const mockScript = join(repoRoot, 'tests', 'e2e', 'mock-llm.mjs')

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

function hasFlag(argv, name) {
  return argv.includes(name)
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function waitForFile(path, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim().length > 0) return true
    if (Date.now() % 1000 < 10) process.stderr.write(`perf: waiting for ${label}...\n`)
    const until = Math.min(Date.now() + 200, deadline)
    const sleep = new Int32Array(new SharedArrayBuffer(4))
    // eslint-disable-next-line no-empty
    Atomics.wait(sleep, 0, 0, until - Date.now())
  }
  return false
}

function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = fn()
    if (last) return last
    const sleep = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(sleep, 0, 0, Math.min(200, deadline - Date.now()))
  }
  throw new Error(`timed out waiting for ${label} (last=${String(last)})`)
}

async function timeRequest(url, method = 'GET', body) {
  const start = performance.now()
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  const text = await response.text()
  return { ms: performance.now() - start, status: response.status, bytes: Buffer.byteLength(text) }
}

async function measureSseFirstEvent(bridgeUrl, sessionId) {
  const controller = new AbortController()
  const start = performance.now()
  const response = await fetch(`${bridgeUrl}/global/event`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstEventMs
  try {
    // Trigger an event after the stream is established.
    await timeRequest(`${bridgeUrl}/session`, 'POST', { directory: undefined, title: `perf-sse-${sessionId}` })
    const triggerAt = performance.now()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('data:')) {
        firstEventMs = performance.now() - triggerAt
        break
      }
    }
  } finally {
    controller.abort()
  }
  return { firstEventMs: firstEventMs ?? null, connectMs: performance.now() - start, bytes: Buffer.byteLength(buffer) }
}

function rssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function main() {
  const argv = process.argv.slice(2)
  const sessions = Number(argValue(argv, '--sessions', '200'))
  const messagesPerSession = Number(argValue(argv, '--messages-per-session', '3'))
  const children = Number(argValue(argv, '--children', '0'))
  const tools = hasFlag(argv, '--tools')
  const todos = hasFlag(argv, '--todos')
  const noBoot = hasFlag(argv, '--no-boot')
  const keep = hasFlag(argv, '--keep')
  const quiet = hasFlag(argv, '--quiet')
  const repeats = Number(argValue(argv, '--repeats', '5'))
  const seed = argValue(argv, '--seed', undefined)
  const reportPath = argValue(argv, '--report', join(repoRoot, '.perf', `report-${Date.now()}.json`))

  const dshHome = argValue(argv, '--dsh-home')
  const ownHome = dshHome === undefined
  const home = dshHome ?? (() => {
    mkdirSync(join(repoRoot, '.perf'), { recursive: true })
    return join(repoRoot, '.perf', `home-${Date.now()}`)
  })()
  const workdir = argValue(argv, '--cwd', join(home, 'work'))
  mkdirSync(home, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  run('git', ['init', '-q'], { cwd: workdir })

  const generated = generateSessionHome({
    dshHome: home,
    cwd: workdir,
    sessions,
    messagesPerSession,
    tools,
    todos,
    children,
    seed,
    quiet,
  })

  const report = {
    generated: {
      ...generated,
      bytesMiB: Number((generated.bytes / 1024 / 1024).toFixed(2)),
    },
    measurements: {},
    memoryRssKb: null,
  }

  if (noBoot) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(JSON.stringify(report, null, 2))
    return
  }

  const dshEnv = {
    ...process.env,
    DSH_HOME: home,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:14514',
    HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:14514',
  }

  // Install the dsh-oc profile from this checkout plus the mock LLM server.
  run('dsh', ['plugin', '--profile', 'oc', 'add', repoRoot], { env: dshEnv })
  run('dsh', ['plugin', '--profile', 'oc', 'add', '@deepseek-ai/dsh-llm-mock-server@0.1.0-rc.6'], { env: dshEnv })

  const profileDir = join(home, 'profiles', 'oc')
  const overlay = join(home, 'agent-model.patch.yml')
  writeFileSync(overlay, [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: mock-model',
    '',
  ].join('\n'))

  // Start the mock LLM server (same pattern as tests/e2e/env.mjs).
  const mockPortFile = join(home, 'mock.port')
  const mockLog = openSync(join(home, 'mock.out'), 'w')
  const mockErr = openSync(join(home, 'mock.err'), 'w')
  const mock = spawn(process.execPath, [
    mockScript,
    '--profile-dir', profileDir,
    '--sequence', 'success',
    '--repeat-last', '1',
    '--success-text', 'mock response recovered',
    '--port-file', mockPortFile,
  ], { env: dshEnv, stdio: ['ignore', mockLog, mockErr] })
  if (!waitForFile(mockPortFile, 30_000, 'mock LLM server')) {
    throw new Error(`mock LLM server did not become ready; see ${join(home, 'mock.err')}`)
  }

  // Boot dsh --profile oc with a fake opencode child that records the bridge URL.
  const fakeLog = join(home, 'fake-opencode.log')
  const bootStart = performance.now()
  const childEnv = {
    ...dshEnv,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_OC_E2E_MOCK_API_KEY: 'mock-key',
    DSH_OC_OPENCODE_BIN: fakeBin,
    DSH_OC_FAKE_LOG: fakeLog,
  }
  const dshLog = openSync(join(home, 'dsh.out'), 'w')
  const dshErr = openSync(join(home, 'dsh.err'), 'w')
  const dsh = spawn('dsh', ['--profile', 'oc', '--patch', overlay], {
    cwd: workdir,
    env: childEnv,
    stdio: ['ignore', dshLog, dshErr],
  })

  let bridgeUrl
  try {
    bridgeUrl = await waitFor(() => {
      if (dsh.exitCode !== null) return null
      if (!existsSync(fakeLog)) return null
      const match = readFileSync(fakeLog, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+/)
      return match ? match[0] : null
    }, 120_000, 'bridge URL')
    report.boot = { ms: performance.now() - bootStart }
    if (!quiet) process.stderr.write(`perf: bridge ready in ${report.boot.ms.toFixed(0)}ms at ${bridgeUrl}\n`)

    // Session list: cold (first request) + hot repeats (v1 + v2).
    const listV1 = [await timeRequest(`${bridgeUrl}/session`)]
    const listV2 = [await timeRequest(`${bridgeUrl}/api/session`)]
    for (let i = 0; i < repeats - 1; i++) {
      listV1.push(await timeRequest(`${bridgeUrl}/session`))
      listV2.push(await timeRequest(`${bridgeUrl}/api/session`))
    }
    report.measurements.listV1 = summarize(listV1.map((x) => x.ms))
    report.measurements.listV2 = summarize(listV2.map((x) => x.ms))
    report.measurements.listV1.status = listV1.at(-1)?.status
    report.measurements.listV2.status = listV2.at(-1)?.status
    if (!quiet) {
      process.stderr.write(`perf: GET /session cold=${listV1[0].ms.toFixed(1)}ms hotP95=${report.measurements.listV1.p95.toFixed(1)}ms (${listV1.at(-1)?.bytes} bytes)\n`)
    }

    // Message pagination: sample up to 5 sessions, v1 + v2.
    const messageV1 = []
    const messageV2 = []
    for (const id of generated.sessionIds.slice(0, 5)) {
      for (const path of [`/session/${id}/message`, `/api/session/${id}/message`]) {
        const result = await timeRequest(`${bridgeUrl}${path}?limit=50`)
        if (path.includes('/api/')) messageV2.push(result)
        else messageV1.push(result)
      }
    }
    report.measurements.messageV1 = summarize(messageV1.map((x) => x.ms))
    report.measurements.messageV2 = summarize(messageV2.map((x) => x.ms))
    report.measurements.messageV1.status = messageV1.at(-1)?.status
    report.measurements.messageV2.status = messageV2.at(-1)?.status
    if (!quiet) {
      process.stderr.write(`perf: GET /session/:id/message p50=${report.measurements.messageV1.p50.toFixed(1)}ms p95=${report.measurements.messageV1.p95.toFixed(1)}ms\n`)
    }

    // SSE first-event latency.
    const sse = await measureSseFirstEvent(bridgeUrl, generated.sessionIds[0])
    report.measurements.sseFirstEvent = sse
    if (!quiet) process.stderr.write(`perf: SSE first event after trigger=${sse.firstEventMs?.toFixed(1)}ms\n`)

    report.memoryRssKb = rssKb(dsh.pid)
    if (!quiet) process.stderr.write(`perf: dsh RSS=${report.memoryRssKb} kB\n`)
  } finally {
    await stopChild(dsh)
    await stopChild(mock)
  }

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (!quiet) process.stderr.write(`perf: report written to ${reportPath}\n`)
  process.stdout.write(JSON.stringify(report, null, 2))

  if (ownHome && !keep) {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

export { summarize }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`perf: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
