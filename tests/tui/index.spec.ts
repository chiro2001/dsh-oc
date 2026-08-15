import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChildEnv,
  DSH_OC_TUI_TIMESTAMPS,
  filterSupportedArgs,
  helpRequested,
  installSignalForwarding,
  OcTuiConfig,
  ocHelp,
  OPENCODE_CONFIG_FILE,
  OPENCODE_NETWORK_SAFETY_ENV,
  prepareOpenCodeConfig,
  prepareOpenCodeTuiState,
  requestExit,
  startOpenCodeTui,
  tuiTimestampsEnabled,
  type RunningTui,
  type TimerHandle,
  type TuiChild,
} from '../../src/tui/index.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-oc-tui-${label}-`))
  tmpDirs.push(dir)
  return dir
}

describe('oc-tui config schema', () => {
  it('defaults to an empty config when the patch row carries no config', () => {
    expect(OcTuiConfig.parse(undefined)).toEqual({})
  })

  it('accepts binary and args overrides', () => {
    expect(OcTuiConfig.parse({ binary: '/bin/opencode', args: ['--print-logs'] })).toEqual({
      binary: '/bin/opencode',
      args: ['--print-logs'],
    })
  })
})

function fakeChild(): {
  child: TuiChild
  kill: ReturnType<typeof vi.fn>
  emitExit(code: number | null, signal: NodeJS.Signals | null): void
  emitError(error: Error): void
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const kill = vi.fn(() => true)
  const child: TuiChild = {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: unknown[]) => void)
      listeners.set(event, list)
      return child
    },
  }
  return {
    child,
    kill,
    emitExit(code, signal) {
      for (const listener of listeners.get('exit') ?? []) {
        listener(code, signal)
      }
    },
    emitError(error) {
      for (const listener of listeners.get('error') ?? []) {
        listener(error)
      }
    },
  }
}

describe('filterSupportedArgs', () => {
  it('passes supported attach flags and reports the rest', () => {
    const { pass, ignored } = filterSupportedArgs([
      '--continue',
      '-c',
      '--session',
      'abc',
      '--session=xyz',
      '--fork',
      '--dir',
      '/tmp/work',
      '--mini',
      '--print-logs',
      '--log-level',
      'DEBUG',
      '--model',
      'gpt-5',
      '--prompt',
      'hello',
    ])
    expect(pass).toEqual([
      '--continue',
      '-c',
      '--session',
      'abc',
      '--session=xyz',
      '--fork',
      '--dir',
      '/tmp/work',
      '--mini',
      '--print-logs',
      '--log-level',
      'DEBUG',
    ])
    expect(ignored).toEqual(['--model', 'gpt-5', '--prompt', 'hello'])
  })

  it('does not crash or consume a following flag as a missing value', () => {
    const { pass, ignored } = filterSupportedArgs(['--session', '--mini'])
    expect(pass).toEqual(['--mini'])
    expect(ignored).toEqual(['--session'])
  })

  it('supports --log-level=DEBUG and -s value forms', () => {
    const { pass, ignored } = filterSupportedArgs(['--log-level=DEBUG', '-s', 'id-1'])
    expect(pass).toEqual(['--log-level=DEBUG', '-s', 'id-1'])
    expect(ignored).toEqual([])
  })
})

describe('ocHelp', () => {
  it('includes version, attach args, capability summary and docs entry', () => {
    const text = ocHelp('9.9.9')
    expect(text).toContain('dsh-oc 9.9.9')
    expect(text).toContain('opencode 1.18.18')
    expect(text).toContain('--continue/-c')
    expect(text).toContain('--session/-s')
    expect(text).toContain('核心能力')
    expect(text).toContain('docs/FEATURES.md')
    expect(text).toContain('docs/PROTOCOL.md')
  })
})

describe('helpRequested', () => {
  it('recognizes --help and -h anywhere in the arg list', () => {
    expect(helpRequested([])).toBe(false)
    expect(helpRequested(['--session', 'x'])).toBe(false)
    expect(helpRequested(['--help'])).toBe(true)
    expect(helpRequested(['--session', 'x', '--help'])).toBe(true)
    expect(helpRequested(['-h'])).toBe(true)
  })
})

describe('buildChildEnv', () => {
  it('inherits the parent env and isolates opencode state under DSH_HOME', () => {
    const env = buildChildEnv({ FOO: 'bar' }, '/home/dsh')
    expect(env.FOO).toBe('bar')
    expect(env).toMatchObject({
      ...OPENCODE_NETWORK_SAFETY_ENV,
      OPENCODE_CONFIG_DIR: '/home/dsh/opencode/config',
      XDG_CONFIG_HOME: '/home/dsh/opencode/config',
      XDG_DATA_HOME: '/home/dsh/opencode/data',
      XDG_STATE_HOME: '/home/dsh/opencode/state',
      XDG_CACHE_HOME: '/home/dsh/opencode/cache',
    })
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('overrides parent-provided auto-update switches with the hardcoded safe values', () => {
    const env = buildChildEnv(
      {
        OPENCODE_DISABLE_AUTOUPDATE: '0',
        OPENCODE_DISABLE_MODELS_FETCH: 'false',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '',
      },
      '/home/dsh',
    )
    expect(env).toMatchObject(OPENCODE_NETWORK_SAFETY_ENV)
  })

  it('never passes OPENCODE_CONFIG_CONTENT even when the parent set it', () => {
    const env = buildChildEnv({ OPENCODE_CONFIG_CONTENT: '{"provider":"deepseek"}' }, '/home/dsh')
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('points OPENCODE_TUI_CONFIG at the seeded tui.json when timestamps are enabled', () => {
    const env = buildChildEnv({ [DSH_OC_TUI_TIMESTAMPS]: '1' }, '/home/dsh')
    expect(env.OPENCODE_TUI_CONFIG).toBe('/home/dsh/opencode/config/tui.json')
  })

  it('does not set OPENCODE_TUI_CONFIG without the timestamp switch', () => {
    const env = buildChildEnv({ FOO: 'bar' }, '/home/dsh')
    expect(env.OPENCODE_TUI_CONFIG).toBeUndefined()
  })
})

describe('tuiTimestampsEnabled', () => {
  it('accepts 1/true/yes/on case-insensitively and rejects everything else', () => {
    expect(tuiTimestampsEnabled({ [DSH_OC_TUI_TIMESTAMPS]: '1' })).toBe(true)
    expect(tuiTimestampsEnabled({ [DSH_OC_TUI_TIMESTAMPS]: 'TRUE' })).toBe(true)
    expect(tuiTimestampsEnabled({ [DSH_OC_TUI_TIMESTAMPS]: 'yes' })).toBe(true)
    expect(tuiTimestampsEnabled({ [DSH_OC_TUI_TIMESTAMPS]: 'on' })).toBe(true)
    expect(tuiTimestampsEnabled({ [DSH_OC_TUI_TIMESTAMPS]: '0' })).toBe(false)
    expect(tuiTimestampsEnabled({})).toBe(false)
  })
})

describe('prepareOpenCodeTuiState', () => {
  it('writes kv.json with timestamps shown and a tui.json keybind, preserving existing values', () => {
    const home = tmpDir('timestamps')
    const configDir = join(home, 'opencode', 'config')
    const stateDir = join(home, 'opencode', 'state', 'opencode')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(configDir, 'tui.json'), JSON.stringify({ theme: 'dark', keybinds: { session_rename: 'ctrl+r' } }))
    writeFileSync(join(stateDir, 'kv.json'), JSON.stringify({ sidebar: 'hide' }))

    prepareOpenCodeTuiState(home, { [DSH_OC_TUI_TIMESTAMPS]: '1' })

    const tui = JSON.parse(readFileSync(join(configDir, 'tui.json'), 'utf8'))
    expect(tui).toMatchObject({
      theme: 'dark',
      keybinds: {
        session_rename: 'ctrl+r',
        session_toggle_timestamps: 'ctrl+shift+t',
        messages_toggle_timestamps: 'ctrl+shift+t',
      },
    })
    const kv = JSON.parse(readFileSync(join(stateDir, 'kv.json'), 'utf8'))
    expect(kv).toEqual({ sidebar: 'hide', timestamps: 'show' })
  })

  it('does nothing when timestamps are not enabled', () => {
    const home = tmpDir('timestamps-off')
    prepareOpenCodeTuiState(home, {})
    expect(existsSync(join(home, 'opencode', 'state', 'opencode', 'kv.json'))).toBe(false)
    expect(existsSync(join(home, 'opencode', 'config', 'tui.json'))).toBe(false)
  })
})

describe('prepareOpenCodeConfig', () => {
  it('writes autoupdate:false into the isolated opencode.json, preserving existing keys', () => {
    const home = tmpDir('config')
    const configPath = join(home, 'opencode', 'config', OPENCODE_CONFIG_FILE)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ theme: 'dark', model: 'deepseek-chat' }))

    prepareOpenCodeConfig(home)

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      theme: 'dark',
      model: 'deepseek-chat',
      autoupdate: false,
    })
  })

  it('creates the config directory when missing', () => {
    const home = tmpDir('config-missing')
    prepareOpenCodeConfig(home)
    expect(JSON.parse(readFileSync(join(home, 'opencode', 'config', OPENCODE_CONFIG_FILE), 'utf8'))).toEqual({
      autoupdate: false,
    })
  })
})

describe('requestExit', () => {
  it('falls back to a settable exit code when ctx.appExit is missing', () => {
    const fallback = vi.fn()
    const handled = requestExit({ get: () => undefined }, 7, fallback)
    expect(handled).toBe(false)
    expect(fallback).toHaveBeenCalledWith(7)
  })

  it('prefers ctx.appExit when available', () => {
    const appExit = vi.fn()
    const fallback = vi.fn()
    const handled = requestExit({ get: () => appExit }, 3, fallback)
    expect(handled).toBe(true)
    expect(appExit).toHaveBeenCalledWith(3)
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('startOpenCodeTui', () => {
  it('spawns attach with the bridge URL and inherit stdio', () => {
    const fake = fakeChild()
    const spawn = vi.fn(() => fake.child)
    const onExit = vi.fn()
    const running = startOpenCodeTui({
      bin: '/x/opencode',
      bridge: { url: 'http://127.0.0.1:4096', port: 4096 },
      tuiArgs: ['--mini'],
      cwd: '/work',
      env: { FOO: 'bar' },
      spawn,
      onExit,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/x/opencode',
      ['attach', 'http://127.0.0.1:4096', '--mini'],
      { cwd: '/work', stdio: 'inherit', env: { FOO: 'bar' } },
    )
    expect(running.child).toBe(fake.child)
  })

  it('forwards signals and escalates SIGTERM to SIGKILL after the grace period', () => {
    const fake = fakeChild()
    let killTimer: (() => void) | undefined
    const running = startOpenCodeTui({
      bin: '/x/opencode',
      bridge: { url: '', port: 4096 },
      tuiArgs: [],
      spawn: () => fake.child,
      setTimeoutImpl: (callback): TimerHandle => {
        killTimer = callback
        return { unref: vi.fn() }
      },
      clearTimeoutImpl: vi.fn(),
    })

    running.forward('SIGINT')
    expect(fake.kill).toHaveBeenCalledWith('SIGINT')

    running.terminate()
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
    expect(killTimer).toBeTypeOf('function')
    killTimer?.()
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports child exit through onExit', () => {
    const fake = fakeChild()
    const onExit = vi.fn()
    startOpenCodeTui({
      bin: '/x/opencode',
      bridge: { url: 'http://127.0.0.1:1', port: 1 },
      tuiArgs: [],
      spawn: () => fake.child,
      onExit,
      clearTimeoutImpl: vi.fn(),
    })
    fake.emitExit(4, null)
    expect(onExit).toHaveBeenCalledWith(4)
  })

  it('reports spawn errors without an exit callback', () => {
    const fake = fakeChild()
    const onError = vi.fn()
    const onExit = vi.fn()
    startOpenCodeTui({
      bin: '/x/opencode',
      bridge: { url: 'http://127.0.0.1:1', port: 1 },
      tuiArgs: [],
      spawn: () => fake.child,
      onError,
      onExit,
      clearTimeoutImpl: vi.fn(),
    })
    fake.emitError(new Error('spawn failed'))
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onExit).not.toHaveBeenCalled()
  })
})

describe('installSignalForwarding', () => {
  it('forwards SIGINT/SIGTERM and removes listeners on dispose', () => {
    const on = vi.fn()
    const removeListener = vi.fn()
    const processLike = { on, removeListener }
    const forward = vi.fn()
    const running = { forward, terminate: vi.fn(), child: {} as TuiChild } as RunningTui
    const dispose = installSignalForwarding(processLike, () => running)

    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

    const sigintListener = on.mock.calls.find(call => call[0] === 'SIGINT')?.[1] as () => void
    sigintListener()
    expect(forward).toHaveBeenCalledWith('SIGINT')

    dispose()
    expect(removeListener).toHaveBeenCalledWith('SIGINT', sigintListener)
  })
})
