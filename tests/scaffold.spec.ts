import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, root), 'utf8')

interface TestAsset {
  url: string
  sha256: string
  size: number
  platform: { os: string; arch: string; baseline: boolean; musl: boolean }
  npm: string
  npmIntegrity: string
}

interface TestAssetManifest {
  version: string
  assets: Record<string, TestAsset>
}

const requiredAssetKeys = [
  'linux-x64',
  'linux-x64-baseline',
  'linux-x64-musl',
  'linux-x64-baseline-musl',
  'linux-arm64',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-x64-baseline',
  'darwin-arm64',
  'windows-x64',
  'windows-x64-baseline',
  'windows-arm64',
]

describe('opencode-version.json', () => {
  it('pins the scaffold release', () => {
    const manifest = JSON.parse(read('opencode-version.json'))
    expect(manifest).toMatchObject({
      version: '1.18.18',
      commit: '4643e65',
      npm: 'opencode-ai@1.18.18',
    })
  })
})

describe('opencode-assets.json', () => {
  it('matches the pinned version and covers every required platform', () => {
    const manifest = JSON.parse(
      read('opencode-assets.json'),
    ) as TestAssetManifest
    expect(manifest.version).toBe('1.18.18')
    for (const key of requiredAssetKeys) {
      expect(manifest.assets).toHaveProperty(key)
    }
  })

  it('has valid urls, sha256 digests and sizes', () => {
    const manifest = JSON.parse(
      read('opencode-assets.json'),
    ) as TestAssetManifest
    for (const [key, asset] of Object.entries(manifest.assets)) {
      expect(asset.platform).toBeDefined()
      expect(asset.platform.os).toMatch(/^(linux|darwin|windows)$/)
      expect(asset.platform.arch).toMatch(/^(x64|arm64)$/)
      expect(asset.platform.baseline).toBeTypeOf('boolean')
      expect(asset.platform.musl).toBeTypeOf('boolean')
      expect(asset.npm).toBe(`opencode-${key}`)
      expect(asset.npmIntegrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.size).toBeTypeOf('number')
      expect(Number.isInteger(asset.size)).toBe(true)
      expect(asset.size).toBeGreaterThan(0)
      expect(asset.url).toMatch(
        /^https:\/\/github\.com\/anomalyco\/opencode\/releases\/download\/v1\.18\.18\//,
      )
      expect(`${key}: ${asset.sha256}`).toMatch(/: [0-9a-f]{64}$/)
    }
  })
})

describe('cordis.patch.yml', () => {
  it('contains the ten bundle plugins in order', () => {
    const yaml = read('cordis.patch.yml')
    const ids = [...yaml.matchAll(/^\s*- id:\s*(\S+)/gm)].map(
      (match) => match[1],
    )
    expect(ids).toEqual([
      'storage',
      'storage-json',
      'storage-domain',
      'webserver',
      'agent-presets',
      'workspace',
      'directory-picker',
      'api-proxy',
      'oc-bridge',
      'oc-tui',
    ])
  })

  it('wires oc-tui to oc-bridge and oc-bridge to api-proxy', () => {
    const yaml = read('cordis.patch.yml')
    expect(yaml).toMatch(/id: oc-bridge[\s\S]*?inject: \[apiProxy\]/)
    expect(yaml).toMatch(/id: oc-tui[\s\S]*?inject: \[ocBridge\]/)
  })
})

describe('package.json', () => {
  it('points dsh.bundle.patch at the cordis patch', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('@deepseek-ai/dsh-oc')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })
})

describe('src constants', () => {
  it('exports the pinned opencode version and commit', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.OPENCODE_VERSION).toBe('1.18.18')
    expect(mod.OPENCODE_COMMIT).toBe('4643e65')
  })
})
