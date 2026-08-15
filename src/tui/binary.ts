/**
 * opencode binary resolver for oc-tui.
 *
 * Priority:
 * 1. `DSH_OC_OPENCODE_BIN` (absolute path only)
 * 2. `$DSH_HOME/opencode/bin/<version>/opencode(.exe)`
 * 3. `opencode` on `PATH`
 * 4. an installed `opencode-ai` package (its official postinstall is run first)
 * 5. lazy GitHub Release download
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { OPENCODE_BIN_ENV, OPENCODE_VERSION } from '../index.js'
import type { OpenCodeAssetsManifest } from '../types.js'
import { downloadOpenCode, type DownloadOpenCodeOptions } from './download.js'
import { resolvePlatform, type PlatformSelection } from './platform.js'

/** Where a resolved binary came from. */
export type BinarySource = 'env' | 'cache' | 'path' | 'package' | 'download'

/** A successfully resolved binary and its provenance. */
export interface ResolvedBinary {
  readonly bin: string
  readonly source: BinarySource
}

/** Injectable operations for unit tests. */
export interface BinaryResolverDeps {
  env?: Record<string, string | undefined>
  home?: string
  version?: string
  platform?: PlatformSelection
  assets?: OpenCodeAssetsManifest
  /** Config-level binary override; takes precedence over the environment. */
  binaryOverride?: string
  probe?: (bin: string) => string | undefined | Promise<string | undefined>
  exists?: (path: string) => boolean
  readFile?: (path: string) => string
  readdir?: (path: string) => readonly { name: string; isDirectory(): boolean }[]
  packageRoots?: readonly string[]
  runPackagePostinstall?: (packageDir: string) => Promise<void>
  download?: (options: DownloadOpenCodeOptions) => Promise<string>
}

/**
 * Resolve the opencode binary with the documented priority.
 * @param deps - overrides for tests and non-default environments.
 * @returns the selected executable and its source.
 */
export async function resolveOpenCodeBinary(deps: BinaryResolverDeps = {}): Promise<ResolvedBinary> {
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveDshHome(undefined, env)
  const version = deps.version ?? OPENCODE_VERSION
  const platform = deps.platform ?? resolvePlatform()
  const exists = deps.exists ?? existsSync
  const probe = deps.probe ?? defaultProbe
  const matches = async (bin: string): Promise<boolean> => {
    try {
      const output = await probe(bin)
      return typeof output === 'string' && output.includes(version)
    } catch {
      return false
    }
  }

  const override = deps.binaryOverride ?? env[OPENCODE_BIN_ENV]
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(`${OPENCODE_BIN_ENV} must be an absolute path, got ${JSON.stringify(override)}`)
    }
    if (exists(override) && await matches(override)) return { bin: override, source: 'env' }
  }

  const cacheBin = join(home, 'opencode', 'bin', version, platform.executableName)
  if (exists(cacheBin) && await matches(cacheBin)) return { bin: cacheBin, source: 'cache' }

  for (const dir of pathEntries(env.PATH ?? '')) {
    const candidate = join(dir, platform.executableName)
    if (exists(candidate) && await matches(candidate)) return { bin: candidate, source: 'path' }
  }

  for (const packageDir of findPackageDirs(home, deps)) {
    const manifestPath = join(packageDir, 'package.json')
    if (!exists(manifestPath)) continue
    const runPostinstall = deps.runPackagePostinstall ?? runOfficialPostinstall
    try {
      await runPostinstall(packageDir)
    } catch {
      // A broken postinstall only loses this candidate; later priorities remain.
    }
    const binaryPath = packageBinaryPath(packageDir, platform, exists, deps.readFile)
    if (binaryPath === undefined) continue
    if (await matches(binaryPath)) return { bin: binaryPath, source: 'package' }
  }

  const download = deps.download ?? downloadOpenCode
  const bin = await download({ env, home, version, platform, manifest: deps.assets })
  return { bin, source: 'download' }
}

function defaultProbe(bin: string): string | undefined {
  try {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.error !== undefined || result.status !== 0) return undefined
    return String(result.stdout ?? '')
  } catch {
    return undefined
  }
}

function pathEntries(pathValue: string): readonly string[] {
  return pathValue
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

function findPackageDirs(home: string, deps: BinaryResolverDeps): readonly string[] {
  const dirs: string[] = [...(deps.packageRoots ?? [])]
  const profilesDir = join(home, 'profiles')
  dirs.push(join(profilesDir, 'node_modules', 'opencode-ai'))
  try {
    for (const entry of deps.readdir?.(profilesDir) ?? readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(profilesDir, entry.name, 'node_modules', 'opencode-ai'))
    }
  } catch {
    // No profiles directory yet.
  }
  dirs.push(join(home, 'node_modules', 'opencode-ai'))

  const seen = new Set<string>()
  return dirs.filter(dir => {
    const normalized = resolve(dir)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return (deps.exists ?? existsSync)(normalized)
  })
}

function packageBinaryPath(
  packageDir: string,
  platform: PlatformSelection,
  exists: (path: string) => boolean,
  readFile?: (path: string) => string,
): string | undefined {
  let manifest: { bin?: string | Record<string, string> }
  try {
    const reader = readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    manifest = JSON.parse(reader(join(packageDir, 'package.json'))) as typeof manifest
  } catch {
    return undefined
  }

  const bin = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.[platform.executableName] ?? manifest.bin?.opencode
  const candidates = [
    bin !== undefined ? join(packageDir, bin) : undefined,
    join(packageDir, 'bin', platform.executableName),
    join(packageDir, 'bin', 'opencode.exe'),
  ].filter((candidate): candidate is string => candidate !== undefined)

  return candidates.find(candidate => exists(candidate))
}

async function runOfficialPostinstall(packageDir: string): Promise<void> {
  const result = spawnSync('node', ['postinstall.mjs'], {
    cwd: packageDir,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`opencode-ai postinstall failed with exit code ${String(result.status)}`)
  }
}
