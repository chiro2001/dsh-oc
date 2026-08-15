/**
 * Platform/asset selection for the official opencode release binaries.
 *
 * This mirrors the platform-selection semantics of the official
 * `opencode-ai` postinstall script: the same platform/arch mapping, the same
 * musl and AVX2 probes, and the same candidate ordering. The returned keys
 * are `opencode-assets.json` keys (without the `opencode-` prefix used by the
 * npm platform packages).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** Result shape accepted from the injectable command probe. */
export interface ExecFileSyncResult {
  status: number | null
  stdout: string | Buffer
  stderr: string | Buffer
}

/** Command-probe signature shared by the default and injected probes. */
export type ExecFileSyncProbe = (
  file: string,
  args: readonly string[],
  options?: { encoding?: BufferEncoding; timeout?: number; windowsHide?: boolean },
) => ExecFileSyncResult

/** Probe injection points, so tests never read the host machine. */
export interface PlatformProbeDeps {
  /** `process.platform` replacement. Defaults to the real process platform. */
  platform?: string
  /** `process.arch` replacement. Defaults to the real process arch. */
  arch?: string
  /** `fs.readFileSync` replacement (used for `/proc/cpuinfo`). */
  readFile?: (path: string) => string
  /** `fs.existsSync` replacement (used for `/etc/alpine-release`). */
  exists?: (path: string) => boolean
  /** `spawnSync` replacement for `sysctl`, `ldd` and PowerShell probes. */
  execFileSync?: ExecFileSyncProbe
}

/** The resolved platform facts the rest of oc-tui consumes. */
export interface PlatformSelection {
  readonly platform: string
  readonly arch: string
  readonly musl: boolean
  readonly avx2: boolean
  /** Candidate asset keys in official fallback priority order. */
  readonly candidates: readonly string[]
  /** The first (highest-priority) candidate asset key. */
  readonly key: string
  /** Release archive extension. */
  readonly extension: '.tar.gz' | '.zip'
  /** The executable name inside the archive/cache. */
  readonly executableName: 'opencode' | 'opencode.exe'
}

const PLATFORM_MAP: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
}

const ARCH_MAP: Record<string, string> = {
  x64: 'x64',
  arm64: 'arm64',
  arm: 'arm',
}

const AVX2_CPUINFO = /(^|\s)avx2(\s|$)/i

const WINDOWS_AVX2_COMMAND =
  '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

const WINDOWS_EXECUTABLES = ['powershell.exe', 'pwsh.exe', 'pwsh', 'powershell']

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8')
}

function defaultExists(path: string): boolean {
  return existsSync(path)
}

function defaultExecFileSync(
  file: string,
  args: readonly string[],
  options: { encoding?: BufferEncoding; timeout?: number; windowsHide?: boolean } = {},
): ExecFileSyncResult {
  return spawnSync(file, args as string[], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
    ...options,
  })
}

/**
 * Resolve the platform selection with injectable probes.
 * @param deps - optional probe overrides; defaults read the real host.
 * @returns the selected asset key and platform facts.
 */
export function resolvePlatform(deps: PlatformProbeDeps = {}): PlatformSelection {
  const rawPlatform = deps.platform ?? process.platform
  const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform
  const arch = ARCH_MAP[deps.arch ?? process.arch] ?? deps.arch ?? process.arch
  const readFile = deps.readFile ?? defaultReadFile
  const exists = deps.exists ?? defaultExists
  const execFileSync = deps.execFileSync ?? defaultExecFileSync
  const avx2 = supportsAvx2(platform, arch, readFile, execFileSync)
  const musl = isMusl(platform, exists, execFileSync)
  const candidates = candidateKeys(platform, arch, musl, avx2)
  return {
    platform,
    arch,
    musl,
    avx2,
    candidates,
    key: candidates[0] ?? '',
    extension: platform === 'linux' ? '.tar.gz' : '.zip',
    executableName: rawPlatform === 'win32' ? 'opencode.exe' : 'opencode',
  }
}

function supportsAvx2(
  platform: string,
  arch: string,
  readFile: (path: string) => string,
  execFileSync: ExecFileSyncProbe,
): boolean {
  if (arch !== 'x64') return false

  if (platform === 'linux') {
    try {
      return AVX2_CPUINFO.test(readFile('/proc/cpuinfo'))
    } catch {
      return false
    }
  }

  if (platform === 'darwin') {
    try {
      const result = execFileSync('sysctl', ['-n', 'hw.optional.avx2_0'], { encoding: 'utf8', timeout: 1500 })
      if (result.status !== 0) return false
      return String(result.stdout ?? '').trim() === '1'
    } catch {
      return false
    }
  }

  if (platform === 'windows') {
    for (const executable of WINDOWS_EXECUTABLES) {
      try {
        const result = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_AVX2_COMMAND], {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = String(result.stdout ?? '').trim().toLowerCase()
        if (output === 'true' || output === '1') return true
        if (output === 'false' || output === '0') return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl(
  platform: string,
  exists: (path: string) => boolean,
  execFileSync: ExecFileSyncProbe,
): boolean {
  if (platform !== 'linux') return false

  try {
    if (exists('/etc/alpine-release')) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = execFileSync('ldd', ['--version'], { encoding: 'utf8' })
    return `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.toLowerCase().includes('musl')
  } catch {
    return false
  }
}

function candidateKeys(
  platform: string,
  arch: string,
  musl: boolean,
  avx2: boolean,
): readonly string[] {
  const base = `${platform}-${arch}`
  const baseline = arch === 'x64' && !avx2

  if (platform === 'linux') {
    if (musl) {
      if (arch === 'x64') {
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      }
      return [`${base}-musl`, base]
    }

    if (arch === 'x64') {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    }
    return [base, `${base}-musl`]
  }

  if (arch === 'x64') return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}
