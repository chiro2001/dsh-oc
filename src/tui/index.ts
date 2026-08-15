/**
 * oc-tui Cordis plugin: resolve the opencode binary, spawn
 * `opencode attach <bridge-url>` with an isolated data home, forward parent
 * signals, and request a bounded dsh exit when the child exits.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { DSH_OC_VERSION, OPENCODE_VERSION, type OcBridgeService } from '../index.js'
import {
  verifyOpenCodeVersion,
  resolveOpenCodeBinary as resolveBinaryFromDeps,
  type BinaryResolverDeps,
  type ResolvedBinary,
} from './binary.js'

export type { BinaryResolverDeps, BinarySource, ResolvedBinary } from './binary.js'
export { resolveAssetUrl } from './download.js'

/** Environment variable that seeds the opencode TUI with timestamps shown. */
export const DSH_OC_TUI_TIMESTAMPS = 'DSH_OC_TUI_TIMESTAMPS'

/** TUI config file name under OPENCODE_CONFIG_DIR. */
export const OPENCODE_TUI_FILE = 'tui.json'

/** Main opencode config file name under OPENCODE_CONFIG_DIR. */
export const OPENCODE_CONFIG_FILE = 'opencode.json'

/** KV state file used by the opencode TUI for per-feature signals. */
export const OPENCODE_KV_FILE = 'kv.json'

/**
 * Verified opencode 1.18.18 switches that disable background update checks,
 * remote model catalog fetches and LSP binary downloads. Set before the child
 * process spawns; the values are read from the process environment.
 */
export const OPENCODE_NETWORK_SAFETY_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
}

/**
 * Whether timestamps should be enabled for the opencode TUI child.
 * Accepts `1`, `true`, `yes` and `on` (case-insensitive).
 */
export function tuiTimestampsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DSH_OC_TUI_TIMESTAMPS]?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Seed the isolated opencode state so `DSH_OC_TUI_TIMESTAMPS=1` takes effect
 * on the next TUI boot.
 *
 * The opencode 1.18.18 TUI stores the timestamps toggle in its KV state file
 * (`$XDG_STATE_HOME/opencode/kv.json`), so this writes that state and also
 * writes a minimal `tui.json` with `session_toggle_timestamps` /
 * `messages_toggle_timestamps` bound to `ctrl+shift+t` for toggling at runtime.
 * Existing config/state values are preserved by merging.
 */
export function prepareOpenCodeTuiState(
  dshHome: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!tuiTimestampsEnabled(env)) return

  const configDir = join(dshHome, 'opencode', 'config')
  const tuiConfigPath = join(configDir, OPENCODE_TUI_FILE)
  const kvPath = join(dshHome, 'opencode', 'state', 'opencode', OPENCODE_KV_FILE)

  mkdirSync(configDir, { recursive: true })
  mkdirSync(dirname(kvPath), { recursive: true })

  const tuiConfig = readJsonObject(tuiConfigPath)
  const keybinds = typeof tuiConfig.keybinds === 'object' && tuiConfig.keybinds !== null && !Array.isArray(tuiConfig.keybinds)
    ? tuiConfig.keybinds as Record<string, unknown>
    : {}
  writeFileSync(
    tuiConfigPath,
    `${JSON.stringify({
      ...tuiConfig,
      keybinds: {
        ...keybinds,
        session_toggle_timestamps: 'ctrl+shift+t',
        messages_toggle_timestamps: 'ctrl+shift+t',
      },
    }, null, 2)}\n`,
  )

  const kv = readJsonObject(kvPath)
  writeFileSync(
    kvPath,
    `${JSON.stringify({ ...kv, timestamps: 'show' }, null, 2)}\n`,
  )
}

/**
 * Seed the isolated opencode config with `autoupdate: false`, preserving any
 * existing values. This is the config-level counterpart of
 * `OPENCODE_DISABLE_AUTOUPDATE` and keeps the attach child from downloading or
 * hot-replacing itself even if a future opencode version changes the env flag.
 */
export function prepareOpenCodeConfig(dshHome: string): void {
  const configDir = join(dshHome, 'opencode', 'config')
  const configPath = join(configDir, OPENCODE_CONFIG_FILE)
  mkdirSync(configDir, { recursive: true })
  const config = readJsonObject(configPath)
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, autoupdate: false }, null, 2)}\n`,
  )
}

/** oc-tui configuration schema; both fields are optional. */
export const OcTuiConfig = z.object({
  /** Absolute path override for the opencode binary (test/debug friendly). */
  binary: z.string().optional(),
  /** Extra arguments appended before the dsh command line arguments. */
  args: z.array(z.string()).optional(),
}).default({})

export type OcTuiConfig = z.infer<typeof OcTuiConfig>

/** `dsh --profile oc --help` output; kept deliberately static for offline use. */
export function ocHelp(version: string = DSH_OC_VERSION): string {
  return `dsh-oc ${version} — DeepSeek Harness × OpenCode TUI (opencode ${OPENCODE_VERSION})

用法:
  dsh --profile oc [attach 参数]

支持的 attach 参数:
  --continue/-c, --session/-s, --fork, --dir, --mini, --print-logs, --log-level

核心能力:
  ✅ 会话列表/新建/续聊/fork/compact，SSE 流式消息
  ✅ dsh 模型目录、reasoning effort、agent preset 切换
  ✅ 工具卡片（bash/read/write/edit）、diff 与 Modified Files
  ✅ 权限/提问流、子代理会话树
  ✅ 自动更新关闭、二进制版本锁定 ${OPENCODE_VERSION}
  🟡 文件附件仅文本/data image；"Allow always" 降级为 once
  ❌ MCP/LSP/formatter/skills/integration 等外围路由为 stub

完整能力矩阵: docs/FEATURES.md（仓库内）
协议与路由: docs/PROTOCOL.md
下一阶段需求: docs/ROADMAP.md
`
}

/** Whether the raw dsh args request the dsh-oc help screen. */
export function helpRequested(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

/** Minimal child-process surface used by the spawn helper (test friendly). */
export interface TuiChild {
  readonly killed: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnTui = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => TuiChild

/** Timer handle exposed by the injectable timer (Node Timeout structurally). */
export interface TimerHandle {
  unref?(): unknown
}

export type TimerSetter = (callback: () => void, ms: number) => TimerHandle
export type TimerClearer = (handle: TimerHandle | undefined) => void

/** Options for {@link startOpenCodeTui}. */
export interface StartTuiOptions {
  bin: string
  bridge: OcBridgeService
  tuiArgs: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnTui
  onExit?: (code: number) => void
  onError?: (error: Error) => void
  killTimeoutMs?: number
  setTimeoutImpl?: TimerSetter
  clearTimeoutImpl?: TimerClearer
}

/** A running attach child with forwarding and bounded termination helpers. */
export interface RunningTui {
  readonly child: TuiChild
  /** Forward one parent signal to the child. */
  forward(signal: NodeJS.Signals): void
  /** SIGTERM the child, then SIGKILL after the configured grace period. */
  terminate(): void
}

/** Spawn `opencode attach` with stdio inherit and signal/termination helpers. */
export function startOpenCodeTui(options: StartTuiOptions): RunningTui {
  const bridgeUrl = options.bridge.url.length > 0
    ? options.bridge.url
    : `http://127.0.0.1:${options.bridge.port}`
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const spawnImpl: SpawnTui = options.spawn ?? defaultSpawn
  const setTimeoutImpl: TimerSetter = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimeoutImpl: TimerClearer = options.clearTimeoutImpl ?? (handle => {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout)
  })
  const killTimeoutMs = options.killTimeoutMs ?? 5000

  const child = spawnImpl(options.bin, ['attach', bridgeUrl, ...options.tuiArgs], {
    cwd,
    stdio: 'inherit',
    env,
  })

  let exited = false
  let killTimer: TimerHandle | undefined

  child.on('error', (error: Error) => {
    if (exited) return
    exited = true
    clearTimeoutImpl(killTimer)
    options.onError?.(error)
  })

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return
    exited = true
    clearTimeoutImpl(killTimer)
    const exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
    options.onExit?.(exitCode)
  })

  return {
    child,
    forward(signal: NodeJS.Signals): void {
      if (!exited) child.kill(signal)
    },
    terminate(): void {
      if (exited) return
      child.kill('SIGTERM')
      killTimer = setTimeoutImpl(() => {
        if (!exited) child.kill('SIGKILL')
      }, killTimeoutMs)
    },
  }
}

const defaultSpawn: SpawnTui = (command, args, options) => {
  return spawn(command, args as string[], options)
}

/** Listener shape accepted by the injectable process object. */
export type SignalListener = () => void

/** Minimal process surface for signal-forwarding tests. */
export interface SignalProcessLike {
  on(event: string, listener: SignalListener): unknown
  removeListener(event: string, listener: SignalListener): unknown
}

/**
 * Forward parent SIGINT/SIGTERM to the running child without force-killing.
 * @param processLike - process or fake process.
 * @param getRunning - returns the current running TUI, if any.
 * @param signals - signals to forward.
 * @returns a disposer removing the listeners.
 */
export function installSignalForwarding(
  processLike: SignalProcessLike,
  getRunning: () => RunningTui | undefined,
  signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): () => void {
  const handlers: { signal: NodeJS.Signals; listener: SignalListener }[] = []
  for (const signal of signals) {
    const listener: SignalListener = () => getRunning()?.forward(signal)
    processLike.on(signal, listener)
    handlers.push({ signal, listener })
  }
  return () => {
    for (const { signal, listener } of handlers.splice(0)) {
      processLike.removeListener(signal, listener)
    }
  }
}

/** Supported `opencode attach` flags passed through unchanged. */
const BOOLEAN_TUI_ARGS = new Set(['--continue', '-c', '--fork', '--mini', '--print-logs'])
const VALUE_TUI_ARGS = new Set(['--session', '-s', '--dir', '--log-level'])

/**
 * Filter dsh app arguments into opencode `attach` arguments.
 * Unknown/malformed arguments are reported, never silently dropped.
 */
export function filterSupportedArgs(args: readonly string[]): { pass: string[]; ignored: string[] } {
  const pass: string[] = []
  const ignored: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const equalsAt = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg
    if (BOOLEAN_TUI_ARGS.has(name)) {
      pass.push(arg)
      continue
    }
    if (VALUE_TUI_ARGS.has(name)) {
      if (equalsAt >= 0) {
        pass.push(arg)
        continue
      }
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        pass.push(arg, value)
        index++
        continue
      }
      ignored.push(arg)
      continue
    }
    ignored.push(arg)
  }
  return { pass, ignored }
}

/**
 * Build the child environment: inherit the parent and isolate opencode state
 * under `$DSH_HOME/opencode`. `OPENCODE_CONFIG_CONTENT` is intentionally
 * never introduced.
 */
export function buildChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  dshHome: string = resolveDshHome(),
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...OPENCODE_NETWORK_SAFETY_ENV,
    OPENCODE_CONFIG_DIR: join(dshHome, 'opencode', 'config'),
    XDG_CONFIG_HOME: join(dshHome, 'opencode', 'config'),
    XDG_DATA_HOME: join(dshHome, 'opencode', 'data'),
    XDG_STATE_HOME: join(dshHome, 'opencode', 'state'),
    XDG_CACHE_HOME: join(dshHome, 'opencode', 'cache'),
  }
  if (tuiTimestampsEnabled(env)) {
    childEnv.OPENCODE_TUI_CONFIG = join(dshHome, 'opencode', 'config', OPENCODE_TUI_FILE)
  }
  // Never leak an existing provider/key config into the opencode child.
  delete childEnv.OPENCODE_CONFIG_CONTENT
  return childEnv
}

/**
 * Request a bounded process exit through `ctx.appExit` when available.
 * @param ctx - context with an optional `appExit`.
 * @param code - desired exit code.
 * @param fallback - exit-code setter used when no `appExit` exists.
 * @returns true when `ctx.appExit` handled the request.
 */
export function requestExit(
  ctx: Pick<Context, 'get'>,
  code: number,
  fallback: (code: number) => void = value => {
    process.exitCode = value
  },
): boolean {
  const exit = ctx.get('appExit')
  if (typeof exit === 'function') {
    exit(code)
    return true
  }
  fallback(code)
  return false
}

/** Input accepted by {@link resolveOpenCodeBinary}. */
export type ResolveBinaryInput = BinaryResolverDeps & { config?: { binary?: string } }

/**
 * Test/debug helper resolving the binary without spawning the TUI.
 * Accepts either resolver deps or a context-like object carrying `config.binary`.
 */
export async function resolveOpenCodeBinary(input: ResolveBinaryInput = {}): Promise<ResolvedBinary> {
  const combined = input as BinaryResolverDeps & { config?: { binary?: string } }
  const { config, ...deps } = combined
  return resolveBinaryFromDeps({
    ...deps,
    ...(config?.binary !== undefined ? { binaryOverride: config.binary } : {}),
  })
}

/**
 * The oc-tui Cordis service. Mounts after `ocBridge` and owns the child's
 * lifetime, signal forwarding, and exit handoff.
 */
export class OcTuiService extends Service {
  static inject = ['ocBridge']

  static Config = OcTuiConfig

  private running: RunningTui | undefined
  private readonly removeSignalForwarding: () => void

  constructor(ctx: Context, public config: OcTuiConfig) {
    super(ctx, 'ocTui')
    this.removeSignalForwarding = installSignalForwarding(process, () => this.running)
    ctx.effect(() => () => this.running?.terminate(), 'ocTui.childTeardown')
    ctx.effect(() => () => this.removeSignalForwarding(), 'ocTui.signalDisposer')
  }

  protected async [Service.init](): Promise<void> {
    const bridge = this.ctx.get('ocBridge') as OcBridgeService | undefined
    if (bridge === undefined) throw new Error('oc-tui: ocBridge service is unavailable')

    const rawArgs = [...(this.config.args ?? []), ...(this.ctx.cmdlineArgs?.get() ?? [])]
    if (helpRequested(rawArgs)) {
      process.stdout.write(ocHelp())
      requestExit(this.ctx, 0)
      return
    }

    let resolved: ResolvedBinary
    try {
      resolved = await resolveOpenCodeBinary({
        env: process.env,
        binaryOverride: this.config.binary,
      })
      await verifyOpenCodeVersion(resolved.bin)
    } catch (error) {
      this.fail(error)
      return
    }

    const { pass: tuiArgs, ignored } = filterSupportedArgs(rawArgs)
    for (const arg of ignored) process.stderr.write(`[dsh-oc] ignored unsupported arg: ${arg}\n`)

    const dshHome = resolveDshHome()
    const childEnv = buildChildEnv(process.env, dshHome)
    for (const dir of [
      join(dshHome, 'opencode', 'config'),
      join(dshHome, 'opencode', 'data'),
      join(dshHome, 'opencode', 'state'),
      join(dshHome, 'opencode', 'cache'),
    ]) {
      mkdirSync(dir, { recursive: true })
    }
    prepareOpenCodeConfig(dshHome)
    prepareOpenCodeTuiState(dshHome, process.env)

    try {
      this.running = startOpenCodeTui({
        bin: resolved.bin,
        bridge,
        tuiArgs,
        cwd: process.cwd(),
        env: childEnv,
        onExit: code => requestExit(this.ctx, code),
        onError: error => {
          this.ctx.logger.error(error)
          requestExit(this.ctx, 1)
        },
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger.error(message)
    // Keep startup failures visible even when the dsh logger is not attached
    // to the console (e.g. version-lock rejections during `--profile oc`).
    process.stderr.write(`[dsh-oc] ${message}\n`)
    requestExit(this.ctx, 1)
  }
}

export default OcTuiService
