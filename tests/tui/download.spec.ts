import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { downloadOpenCode, resolveAssetUrl } from '../../src/tui/download.ts'
import type { OpenCodeAssetsManifest } from '../../src/types.ts'
import type { PlatformSelection } from '../../src/tui/platform.ts'

const linuxPlatform: PlatformSelection = {
  platform: 'linux',
  arch: 'x64',
  musl: false,
  avx2: true,
  candidates: ['linux-x64'],
  key: 'linux-x64',
  extension: '.tar.gz',
  executableName: 'opencode',
}

let fixtureDir: string
let archive: Buffer
let server: Server
let requests: string[]
let handler: (requestPath: string, response: import('node:http').ServerResponse) => void

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-download-'))
  const bin = join(fixtureDir, 'opencode')
  writeFileSync(bin, '#!/bin/sh\nprintf "opencode 1.18.18\\n"\n')
  chmodSync(bin, 0o755)
  const archivePath = join(fixtureDir, 'fixture.tar.gz')
  const packed = spawnSync('tar', ['-czf', archivePath, '-C', fixtureDir, 'opencode'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(`fixture tar failed: ${String(packed.stderr)}`)
  archive = readFileSync(archivePath)

  requests = []
  handler = (_path, response) => {
    response.writeHead(404)
    response.end()
  }
  server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    handler(path, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)))
  })
  rmSync(fixtureDir, { recursive: true, force: true })
})

const homes: string[] = []

beforeEach(() => {
  requests = []
  handler = (_path, response) => {
    response.writeHead(404)
    response.end()
  }
})

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function baseUrl(): string {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function manifestFor(path: string, bytes = archive): OpenCodeAssetsManifest {
  return {
    version: '1.18.18',
    assets: {
      'linux-x64': {
        url: `${baseUrl()}${path}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    },
  }
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-home-'))
  homes.push(home)
  return home
}

describe('downloadOpenCode', () => {
  it('downloads, verifies sha256, extracts and caches with mode 0755', async () => {
    const home = newHome()
    handler = (_path, response) => {
      response.writeHead(200)
      response.end(archive)
    }

    const target = await downloadOpenCode({
      env: { DSH_HOME: home },
      version: '1.18.18',
      platform: linuxPlatform,
      manifest: manifestFor('/asset.tar.gz'),
      fetchImpl: fetch,
    })

    expect(target).toBe(join(home, 'opencode', 'bin', '1.18.18', 'opencode'))
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })

  it('retries once after a sha256 failure and then reports the failure', async () => {
    const home = newHome()
    handler = (_path, response) => {
      response.writeHead(200)
      response.end('not-the-archive')
    }

    await expect(
      downloadOpenCode({
        env: { DSH_HOME: home },
        version: '1.18.18',
        platform: linuxPlatform,
        manifest: manifestFor('/bad.tar.gz'),
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/sha256 mismatch/)
    expect(requests).toHaveLength(2)
  })

  it('succeeds when only the first response is corrupt', async () => {
    const home = newHome()
    handler = (_path, response) => {
      response.writeHead(200)
      response.end(requests.length === 1 ? 'corrupt' : archive)
    }

    const target = await downloadOpenCode({
      env: { DSH_HOME: home },
      version: '1.18.18',
      platform: linuxPlatform,
      manifest: manifestFor('/flaky.tar.gz'),
      fetchImpl: fetch,
    })
    expect(existsSync(target)).toBe(true)
    expect(requests).toHaveLength(2)
  })

  it('rewrites GitHub URLs through DSH_OC_OPENCODE_MIRROR', async () => {
    const home = newHome()
    handler = (_path, response) => {
      response.writeHead(200)
      response.end(archive)
    }
    const githubUrl = 'https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-linux-x64.tar.gz'
    const manifest: OpenCodeAssetsManifest = {
      version: '1.18.18',
      assets: {
        'linux-x64': {
          url: githubUrl,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
      },
    }

    await downloadOpenCode({
      env: { DSH_HOME: home, DSH_OC_OPENCODE_MIRROR: baseUrl() },
      version: '1.18.18',
      platform: linuxPlatform,
      manifest,
      fetchImpl: fetch,
    })

    expect(requests[0]).toBe('/anomalyco/opencode/releases/download/v1.18.18/opencode-linux-x64.tar.gz')
  })

  it('includes all three recovery suggestions in the error', async () => {
    const home = newHome()
    handler = (_path, response) => {
      response.writeHead(200)
      response.end('bad')
    }

    await expect(
      downloadOpenCode({
        env: { DSH_HOME: home },
        version: '1.18.18',
        platform: linuxPlatform,
        manifest: manifestFor('/bad.tar.gz'),
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/DSH_OC_OPENCODE_BIN/)
    await expect(
      downloadOpenCode({
        env: { DSH_HOME: home },
        version: '1.18.18',
        platform: linuxPlatform,
        manifest: manifestFor('/bad.tar.gz'),
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/dsh plugin --profile oc add opencode-ai@1\.18\.18/)
    await expect(
      downloadOpenCode({
        env: { DSH_HOME: home },
        version: '1.18.18',
        platform: linuxPlatform,
        manifest: manifestFor('/bad.tar.gz'),
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/manually downloading/)
  })
})

describe('resolveAssetUrl', () => {
  it('leaves non-GitHub and unmirrored URLs unchanged', () => {
    expect(resolveAssetUrl('https://example.com/x.tar.gz', {})).toBe('https://example.com/x.tar.gz')
    expect(resolveAssetUrl('https://github.com/a/b', { DSH_OC_OPENCODE_MIRROR: '' })).toBe('https://github.com/a/b')
  })

  it('normalizes a trailing slash on the mirror base', () => {
    expect(resolveAssetUrl('https://github.com/a/b', { DSH_OC_OPENCODE_MIRROR: 'https://mirror/' }))
      .toBe('https://mirror/a/b')
  })
})
