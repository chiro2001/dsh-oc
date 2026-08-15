#!/usr/bin/env node
// Start the dsh-llm-mock-server from a profile's node_modules and print the
// bound port on stdout as `READY <port>`. The parent env script keeps this
// process alive and stops it by SIGTERM.
import { existsSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1]
}

const profileDir = option('--profile-dir', '')
const sequence = String(option('--sequence', 'success'))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const repeatLast = option('--repeat-last', '0') === '1'
const successText = option('--success-text', process.env.DSH_OC_E2E_SUCCESS_TEXT ?? 'mock response recovered')
const toolName = option('--tool-name', 'bash')
const chunkDelayMs = option('--chunk-delay-ms', process.env.DSH_OC_E2E_CHUNK_DELAY_MS ?? '')
const chunkSize = option('--chunk-size', process.env.DSH_OC_E2E_CHUNK_SIZE ?? '')
const toolArguments = option(
  '--tool-arguments',
  '{"command":"echo dsh-oc-e2e-tool","description":"e2e tool call","sandbox_permissions":"danger-full-access","justification":"e2e approval flow"}',
)
const portFile = option('--port-file', '')

const candidates = [
  profileDir === '' ? '' : join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-llm-mock-server', 'lib', 'index.js'),
  join(here, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-llm-mock-server', 'lib', 'index.js'),
].filter(Boolean)

const entry = candidates.find((path) => existsSync(path))
if (!entry) {
  process.stderr.write(`mock-llm: cannot locate @deepseek-ai/dsh-llm-mock-server (tried ${candidates.join(', ')})\n`)
  process.exit(2)
}

const { startMockLlmServer } = await import(pathToFileURL(entry).href)
const server = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0,
  sequence,
  ...(repeatLast ? { repeatLast: true } : {}),
  successText,
  ...(chunkDelayMs === '' ? {} : { chunkDelayMs: Number(chunkDelayMs) }),
  ...(chunkSize === '' ? {} : { chunkSize: Number(chunkSize) }),
  toolName,
  toolArguments,
  onEvent(event) {
    if (event.type === 'result') {
      process.stderr.write(`mock-llm: ${event.attempt} ${event.behavior} ${event.outcome} ${event.chunksSent}\n`)
    }
  },
})

process.stdout.write(`READY ${server.port}\n`)
if (portFile !== '') {
  writeFileSync(portFile, `${server.port}\n`)
}

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await new Promise(() => {})
