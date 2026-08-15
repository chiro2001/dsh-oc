import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenCodeBinary } from '../../src/tui/binary.ts'
import type { PlatformSelection } from '../../src/tui/platform.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-oc-tui-${label}-`))
  dirs.push(dir)
  return dir
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

function writeOpenCodePackage(packageDir: string): void {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'opencode-ai', version: '1.18.18', bin: { opencode: './bin/opencode.exe' } }),
  )
}

function writeNpmPlatformPackage(home: string, key: string, executable = 'opencode'): string {
  const bin = join(
    home,
    'opencode',
    'packages',
    key,
    'node_modules',
    `opencode-${key}`,
    'bin',
    executable,
  )
  touch(bin)
  return bin
}

const versionProbe = async (): Promise<string> => 'opencode 1.18.18'

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

describe('resolveOpenCodeBinary', () => {
  it('prefers DSH_OC_OPENCODE_BIN when it matches', async () => {
    const root = tmpDir('env')
    const bin = join(root, 'opencode')
    touch(bin)
    const result = await resolveOpenCodeBinary({
      env: { DSH_OC_OPENCODE_BIN: bin, PATH: '' },
      home: join(root, 'home'),
      probe: versionProbe,
    })
    expect(result).toEqual({ bin, source: 'env' })
  })

  it('rejects a relative DSH_OC_OPENCODE_BIN', async () => {
    const root = tmpDir('relative')
    await expect(
      resolveOpenCodeBinary({
        env: { DSH_OC_OPENCODE_BIN: 'opencode', PATH: '' },
        home: join(root, 'home'),
        probe: versionProbe,
      }),
    ).rejects.toThrow(/must be an absolute path/)
  })

  it('uses the versioned cache next', async () => {
    const root = tmpDir('cache')
    const home = join(root, 'home')
    const bin = join(home, 'opencode', 'bin', '1.18.18', 'opencode')
    touch(bin)
    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home,
      probe: versionProbe,
    })
    expect(result).toEqual({ bin, source: 'cache' })
  })

  it('falls back to opencode on PATH', async () => {
    const root = tmpDir('path')
    const pathDir = join(root, 'bin')
    const bin = join(pathDir, 'opencode')
    touch(bin)
    const result = await resolveOpenCodeBinary({
      env: { PATH: pathDir },
      home: join(root, 'home'),
      probe: versionProbe,
    })
    expect(result).toEqual({ bin, source: 'path' })
  })

  it('runs the opencode-ai postinstall and uses its binary', async () => {
    const root = tmpDir('package')
    const packageDir = join(root, 'profile', 'node_modules', 'opencode-ai')
    writeOpenCodePackage(packageDir)
    const bin = join(packageDir, 'bin', 'opencode.exe')
    touch(bin)
    const runPostinstall = vi.fn(async () => {})

    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home: join(root, 'home'),
      packageRoots: [packageDir],
      probe: versionProbe,
      runPackagePostinstall: runPostinstall,
      installNpmPackage: async () => false,
    })

    expect(runPostinstall).toHaveBeenCalledWith(packageDir)
    expect(result).toEqual({ bin, source: 'package' })
  })

  it('continues past a version mismatch on a higher-priority source', async () => {
    const root = tmpDir('mismatch')
    const envBin = join(root, 'env', 'opencode')
    const cacheBin = join(root, 'home', 'opencode', 'bin', '1.18.18', 'opencode')
    touch(envBin)
    touch(cacheBin)

    const result = await resolveOpenCodeBinary({
      env: { DSH_OC_OPENCODE_BIN: envBin, PATH: '' },
      home: join(root, 'home'),
      probe: async bin => (bin === envBin ? 'opencode 0.0.0' : 'opencode 1.18.18'),
    })
    expect(result).toEqual({ bin: cacheBin, source: 'cache' })
  })

  it('continues from a wrong PATH binary to an installed package', async () => {
    const root = tmpDir('path-to-package')
    const pathBin = join(root, 'bin', 'opencode')
    const packageDir = join(root, 'profile', 'node_modules', 'opencode-ai')
    const packageBin = join(packageDir, 'bin', 'opencode.exe')
    touch(pathBin)
    writeOpenCodePackage(packageDir)
    touch(packageBin)

    const result = await resolveOpenCodeBinary({
      env: { PATH: join(root, 'bin') },
      home: join(root, 'home'),
      packageRoots: [packageDir],
      probe: async bin => (bin === pathBin ? 'opencode 0.0.0' : 'opencode 1.18.18'),
      runPackagePostinstall: async () => {},
      installNpmPackage: async () => false,
    })
    expect(result).toEqual({ bin: packageBin, source: 'package' })
  })

  it('uses a preinstalled official npm platform package after PATH misses', async () => {
    const root = tmpDir('npm-preinstalled')
    const home = join(root, 'home')
    const pathBin = join(root, 'bin', 'opencode')
    const packageBin = writeNpmPlatformPackage(home, 'linux-x64')
    touch(pathBin)
    const download = vi.fn(async () => join(root, 'downloaded', 'opencode'))

    const result = await resolveOpenCodeBinary({
      env: { PATH: join(root, 'bin') },
      home,
      platform: linuxPlatform,
      probe: async bin => (bin === pathBin ? 'opencode 0.0.0' : 'opencode 1.18.18'),
      installNpmPackage: async () => false,
      download,
    })

    expect(result).toEqual({ bin: packageBin, source: 'package' })
    expect(download).not.toHaveBeenCalled()
  })

  it('tries npm platform packages in official candidate order and installs the first match', async () => {
    const root = tmpDir('npm-candidates')
    const home = join(root, 'home')
    const calls: string[] = []
    const install = vi.fn(async (packageName: string) => {
      calls.push(packageName)
      if (packageName === 'opencode-linux-x64') {
        writeNpmPlatformPackage(home, 'linux-x64')
      }
      return true
    })
    const platform: PlatformSelection = {
      ...linuxPlatform,
      key: 'linux-x64-baseline',
      candidates: ['linux-x64-baseline', 'linux-x64'],
    }

    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home,
      platform,
      probe: versionProbe,
      installNpmPackage: install,
    })

    expect(calls).toEqual(['opencode-linux-x64-baseline', 'opencode-linux-x64'])
    expect(result.source).toBe('package')
    expect(result.bin).toBe(writeNpmPlatformPackage(home, 'linux-x64'))
  })

  it('continues to the GitHub download when no npm platform package matches', async () => {
    const root = tmpDir('npm-download')
    const download = vi.fn(async () => join(root, 'downloaded', 'opencode'))
    const install = vi.fn(async () => true)

    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home: join(root, 'home'),
      platform: linuxPlatform,
      probe: async () => undefined,
      installNpmPackage: install,
      download,
    })

    expect(install).toHaveBeenCalledWith('opencode-linux-x64', '1.18.18', expect.stringContaining('packages/linux-x64'))
    expect(download).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ bin: join(root, 'downloaded', 'opencode'), source: 'download' })
  })

  it('calls the injected download function only after every cache-style miss', async () => {
    const root = tmpDir('download')
    const download = vi.fn(async () => join(root, 'downloaded', 'opencode'))

    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home: join(root, 'home'),
      probe: async () => undefined,
      installNpmPackage: async () => false,
      download,
    })

    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '1.18.18',
        home: join(root, 'home'),
      }),
    )
    expect(result).toEqual({ bin: join(root, 'downloaded', 'opencode'), source: 'download' })
  })
})
