#!/usr/bin/env node
// Isolated dsh-oc e2e run lifecycle.
//
//   node tests/e2e/env.mjs new-run [--label NAME] [--runid ID] \
//     [--permission danger-full-access|ask] [--sequence a,b] \
//     [--repeat-last 0|1] [--success-text TEXT] \
//     [--tool-name NAME] [--tool-arguments JSON]
//   node tests/e2e/env.mjs info <runid>
//   node tests/e2e/env.mjs stop <runid>
//
// `new-run` prints one JSON object with all facts needed by the shell
// drivers. Each run lives under <repo>/.e2e/<runid>/ and owns:
//   - dsh-home (DSH_HOME for the run)
//   - work/    (empty git workdir, cwd for dsh and the TUI)
//   - settings.yaml + agent-model.patch.yml
//   - a profile "oc" with the dsh-oc bundle and the mock server dependency
//   - one running mock LLM on an OS-assigned port
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const mockScript = join(repoRoot, 'tests', 'e2e', 'mock-llm.mjs')
const e2eRoot = join(repoRoot, '.e2e')

const HELP = `usage:
  new-run [--label NAME] [--runid ID] [--permission MODE] [--sequence CSV]
          [--repeat-last 0|1] [--success-text TEXT] [--tool-name NAME]
          [--tool-arguments JSON]
  info <runid>
  stop <runid>`

function option(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function fail(message) {
  process.stderr.write(`env: ${message}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  } catch (error) {
    const stderr = String(error.stderr ?? '')
    fail(`${command} ${args.join(' ')} failed: ${error.message}\n${stderr.slice(-2000)}`)
  }
}

function assertBranch() {
  const branch = run('git', ['branch', '--show-current'], { cwd: repoRoot }).trim()
  if (branch !== 'feat-e2e') fail(`branch must be feat-e2e, got ${branch}`)
}

async function newRun(argv) {
  assertBranch()
  mkdirSync(e2eRoot, { recursive: true })

  const label = option(argv, '--label') ?? 'run'
  const runid = option(argv, '--runid') ?? `${Date.now()}-${label}`
  const permissionMode = option(argv, '--permission') ?? 'danger-full-access'
  const sequence = option(argv, '--sequence') ?? 'success'
  const repeatLast = option(argv, '--repeat-last') ?? '1'
  const successText = option(argv, '--success-text') ?? 'mock response recovered'
  const toolName = option(argv, '--tool-name') ?? 'bash'
  const toolArguments = option(argv, '--tool-arguments')
    ?? '{"command":"echo dsh-oc-e2e-tool","description":"e2e tool call","sandbox_permissions":"danger-full-access","justification":"e2e approval flow"}'

  const runDir = join(e2eRoot, runid)
  if (existsSync(runDir)) fail(`run already exists: ${runid}`)
  const dshHome = join(runDir, 'dsh-home')
  const workdir = join(runDir, 'work')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(workdir, { recursive: true })

  const dshEnv = { ...process.env, DSH_HOME: dshHome }
  run('git', ['init', '-q'], { cwd: workdir })

  run('dsh', ['plugin', '--profile', 'oc', 'add', repoRoot], { env: dshEnv })
  run('dsh', ['plugin', '--profile', 'oc', 'add', '@deepseek-ai/dsh-llm-mock-server@0.1.0-rc.6'], { env: dshEnv })

  const profileDir = join(dshHome, 'profiles', 'oc')
  const dump = run('dsh', ['--profile', 'oc', '--dump-config'], { env: dshEnv })
  const ocBlock = dump.split('# == @deepseek-ai/dsh-oc')[1]
  if (!ocBlock) fail('dump-config: missing @deepseek-ai/dsh-oc bundle block')
  for (const id of ['workspace', 'directory-picker', 'api-proxy', 'oc-bridge', 'oc-tui']) {
    if (!ocBlock.includes(`- id: ${id}`)) fail(`dump-config: missing id ${id}`)
  }
  if (!ocBlock.includes('inject:\n    - apiProxy')) fail('dump-config: oc-bridge must inject apiProxy')
  if (!ocBlock.includes('inject:\n    - ocBridge')) fail('dump-config: oc-tui must inject ocBridge')

  const overlay = join(runDir, 'agent-model.patch.yml')
  writeFileSync(
    overlay,
    [
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: mock-model',
      '',
    ].join('\n'),
  )

  // The oc bundle relies on web-app host rows (storage backend + loopback
  // webserver) that dsh-base does not mount. The e2e supplies them as a
  // runtime overlay until the bundle's own patch layer grows them.
  const hostOverlay = join(runDir, 'oc-host.patch.yml')
  writeFileSync(
    hostOverlay,
    [
      '- insert:',
      '    - id: storage',
      "      name: '@deepseek-ai/dsh-storage'",
      '',
      '    - id: storage-json',
      "      name: '@deepseek-ai/dsh-storage-json'",
      '      config:',
      "        root: !!js dshHomePath('storages')",
      '',
      '    - id: storage-domain',
      "      name: '@deepseek-ai/dsh-storage-domain'",
      '      config:',
      '        backend: json',
      '',
      '    - id: webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      '        host: 127.0.0.1',
      '        port: 0',
      '',
    ].join('\n'),
  )

  const mockLog = join(runDir, 'mock.out')
  const mockErr = join(runDir, 'mock.err')
  const mockPortFile = join(runDir, 'mock.port')
  const mockOutFd = openSync(mockLog, 'w')
  const mockErrFd = openSync(mockErr, 'w')
  const mock = spawn(
    process.execPath,
    [
      mockScript,
      '--profile-dir', profileDir,
      '--sequence', sequence,
      '--repeat-last', repeatLast,
      '--success-text', successText,
      '--tool-name', toolName,
      '--tool-arguments', toolArguments,
      '--port-file', mockPortFile,
    ],
    {
      env: dshEnv,
      stdio: ['ignore', mockOutFd, mockErrFd],
    },
  )
  mock.on('error', (error) => fail(`mock server failed to start: ${error.message}`))

  const mockPort = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      mock.kill('SIGKILL')
      reject(new Error(`mock server did not become ready; see ${mockErr}`))
    }, 30000)
    const poll = setInterval(() => {
      if (existsSync(mockPortFile)) {
        clearTimeout(timer)
        clearInterval(poll)
        resolvePromise(Number(readFileSync(mockPortFile, 'utf8').trim()))
      }
    }, 100)
    mock.on('exit', (code) => {
      clearTimeout(timer)
      clearInterval(poll)
      reject(new Error(`mock server exited early with ${String(code)}`))
    })
  })
  mock.unref()

  const settings = [
    'llm-deepseek:',
    `  baseURL: http://127.0.0.1:${mockPort}`,
    '  apiKeyEnv: DSH_OC_E2E_MOCK_API_KEY',
    '  thinking: disabled',
    '  models:',
    '    - id: mock-model',
    '      name: Mock Model',
    '      description: dsh-oc e2e mock model',
    '      contextWindow: 128000',
    '      maxTokens: 8192',
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'settings.yaml'), settings)

  const facts = {
    runid,
    runDir,
    dshHome,
    workdir,
    profileDir,
    overlay,
    hostOverlay,
    settings: join(dshHome, 'settings.yaml'),
    mockPort,
    mockPid: mock.pid,
    mockLog,
    mockErr,
    permissionMode,
    sequence,
    repeatLast,
    successText,
  }
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(facts, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(facts)}\n`)
}

function info(argv) {
  const runid = argv[0]
  if (!runid) fail('info requires a runid')
  const file = join(e2eRoot, runid, 'run.json')
  if (!existsSync(file)) fail(`no run ${runid}`)
  process.stdout.write(readFileSync(file, 'utf8'))
}

function stop(argv) {
  const runid = argv[0]
  if (!runid) fail('stop requires a runid')
  const file = join(e2eRoot, runid, 'run.json')
  if (!existsSync(file)) fail(`no run ${runid}`)
  const facts = JSON.parse(readFileSync(file, 'utf8'))
  try {
    process.kill(Number(facts.mockPid), 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.stdout.write(`stopped mock ${facts.mockPid}\n`)
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'new-run':
    await newRun(rest)
    break
  case 'info':
    info(rest)
    break
  case 'stop':
    stop(rest)
    break
  case '--help':
  case '-h':
    process.stdout.write(`${HELP}\n`)
    break
  default:
    fail(`unknown command ${JSON.stringify(command)}\n${HELP}`)
}
