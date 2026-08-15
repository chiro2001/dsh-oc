/**
 * Lazy GitHub Release download for the official opencode binary: fetch,
 * sha256 verification with one retry, extraction, executable mode, version
 * verification and an atomic rename into the dsh opencode cache.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { OPENCODE_BIN_ENV, OPENCODE_VERSION } from '../index.js'
import type { OpenCodeAssetsManifest } from '../types.js'
import { resolvePlatform, type PlatformSelection } from './platform.js'

const GITHUB_PREFIX = 'https://github.com/'
const MIRROR_ENV = 'DSH_OC_OPENCODE_MIRROR'
const MANIFEST_URL = new URL('../../opencode-assets.json', import.meta.url)

/** Response subset needed by the downloader; lets tests inject a fake fetch. */
export interface FetchLikeResponse {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Fetch injection; the default is Node's global fetch with proxy support. */
export type FetchLike = (
  input: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<FetchLikeResponse>

/** Injectable filesystem/command operations for tests. */
export interface DownloadOpenCodeOptions {
  env?: Record<string, string | undefined>
  home?: string
  version?: string
  platform?: PlatformSelection
  manifest?: OpenCodeAssetsManifest
  key?: string
  fetchImpl?: FetchLike
  spawnSyncImpl?: typeof spawnSync
  probe?: (bin: string) => string | undefined
}

/** A download whose integrity check failed; this is the retryable failure. */
class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrityError'
  }
}

/**
 * Rewrite a GitHub asset URL through `DSH_OC_OPENCODE_MIRROR` when set.
 * @param url - the manifest asset URL.
 * @param env - environment mapping.
 * @returns the URL to request.
 */
export function resolveAssetUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const mirror = env[MIRROR_ENV]
  if (mirror === undefined || mirror.trim().length === 0 || !url.startsWith(GITHUB_PREFIX)) return url
  return `${mirror.replace(/\/+$/, '')}/${url.slice(GITHUB_PREFIX.length)}`
}

/**
 * Download, verify and cache the opencode binary.
 * @param options - overrides for tests and non-default homes.
 * @returns the absolute path of the cached executable.
 */
export async function downloadOpenCode(options: DownloadOpenCodeOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const home = options.home ?? resolveDshHome(undefined, env)
  const version = options.version ?? OPENCODE_VERSION
  const platform = options.platform ?? resolvePlatform()
  const manifest = options.manifest ?? readAssetsManifest()
  const key = options.key ?? platform.key
  const asset = manifest.assets[key]
  if (asset === undefined) {
    throw new Error(
      `opencode ${version}: no release asset for ${JSON.stringify(key)} (available: ${Object.keys(manifest.assets).join(', ')})`,
    )
  }

  const target = join(home, 'opencode', 'bin', version, platform.executableName)
  if (existsSync(target)) {
    try {
      verifyVersion(target, version, options.probe)
      return target
    } catch {
      // Existing cache is wrong/stale; replace it below.
    }
  }

  const tmpBase = join(home, 'opencode', 'tmp')
  const archivePath = join(tmpBase, randomUUID())
  let lastError: unknown
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = resolveAssetUrl(asset.url, env)
        const buffer = await fetchBuffer(url, options.fetchImpl)
        const digest = createHash('sha256').update(buffer).digest('hex')
        if (digest !== asset.sha256 || buffer.length !== asset.size) {
          throw new IntegrityError(
            `sha256 mismatch for ${url}: expected ${asset.sha256} (${asset.size} bytes), got ${digest} (${buffer.length} bytes)`,
          )
        }

        mkdirSync(tmpBase, { recursive: true })
        writeFileSync(archivePath, buffer)
        const extractDir = extractArchive(archivePath, platform, options.spawnSyncImpl)
        const extracted = findExecutable(extractDir, platform.executableName)
        if (extracted === undefined) {
          throw new Error(`archive did not contain ${platform.executableName}`)
        }
        chmodSync(extracted, 0o755)
        verifyVersion(extracted, version, options.probe)

        mkdirSync(dirname(target), { recursive: true })
        if (existsSync(target)) rmSync(target, { force: true })
        renameSync(extracted, target)
        return target
      } catch (error) {
        lastError = error
        rmSync(tmpBase, { recursive: true, force: true })
        if (attempt === 0 && error instanceof IntegrityError) continue
        break
      }
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true })
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Failed to download opencode ${version} (asset ${key}): ${message}\n`
      + `You can recover by:\n`
      + `  - setting ${OPENCODE_BIN_ENV} to an absolute path of a working opencode binary,\n`
      + `  - running: dsh plugin --profile oc add opencode-ai@1.18.18\n`
      + `  - or manually downloading ${asset.url} and placing the executable at ${target}`,
  )
}

function readAssetsManifest(): OpenCodeAssetsManifest {
  return JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as OpenCodeAssetsManifest
}

async function fetchBuffer(url: string, fetchImpl?: FetchLike): Promise<Buffer> {
  const impl: FetchLike = fetchImpl ?? defaultFetch
  const response = await impl(url, {})
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function defaultFetch(input: string, init?: RequestInit & { dispatcher?: unknown }): Promise<FetchLikeResponse> {
  try {
    const { EnvHttpProxyAgent } = await import('node:undici')
    if (typeof EnvHttpProxyAgent === 'function') {
      const options = {
        ...init,
        dispatcher: new EnvHttpProxyAgent() as never,
      } as Parameters<typeof fetch>[1]
      return await fetch(input, options)
    }
  } catch {
    // Node versions without EnvHttpProxyAgent fall back to plain fetch.
  }
  return await fetch(input, init)
}

function extractArchive(
  archivePath: string,
  platform: PlatformSelection,
  spawnImpl: DownloadOpenCodeOptions['spawnSyncImpl'] = spawnSync,
): string {
  const extractDir = `${archivePath}-x`
  mkdirSync(extractDir, { recursive: true })

  let result: ReturnType<typeof spawnSync>
  if (platform.extension === '.zip') {
    if (platform.platform === 'win32') {
      result = spawnImpl(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
        ],
        { stdio: 'pipe', windowsHide: true },
      )
    } else {
      result = spawnImpl('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'pipe', windowsHide: true })
    }
  } else {
    result = spawnImpl('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe', windowsHide: true })
  }

  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`archive extraction failed (${platform.extension}): ${String(result.stderr ?? '')}`)
  }
  return extractDir
}

function findExecutable(root: string, name: string): string | undefined {
  const entries = readdirSync(root, { recursive: true }) as string[]
  for (const entry of entries) {
    const full = join(root, entry)
    if (basename(full) === name) {
      try {
        if (statSync(full).isFile()) return resolve(full)
      } catch {
        // Not a file (broken symlink etc.); keep searching.
      }
    }
  }
  return undefined
}

function verifyVersion(bin: string, version: string, probe?: (bin: string) => string | undefined): void {
  const probeImpl = probe ?? defaultProbe
  let output: string | undefined
  try {
    output = probeImpl(bin)
  } catch {
    output = undefined
  }
  if (output === undefined || !output.includes(version)) {
    throw new Error(
      `extracted binary at ${bin} did not report opencode ${version} (got ${JSON.stringify(output)})`,
    )
  }
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
