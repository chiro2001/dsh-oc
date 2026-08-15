import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenCodeBinary } from '../../src/tui/binary.ts'

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

const versionProbe = async (): Promise<string> => 'opencode 1.18.18'

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
    })
    expect(result).toEqual({ bin: packageBin, source: 'package' })
  })

  it('calls the injected download function only after every cache-style miss', async () => {
    const root = tmpDir('download')
    const download = vi.fn(async () => join(root, 'downloaded', 'opencode'))

    const result = await resolveOpenCodeBinary({
      env: { PATH: '' },
      home: join(root, 'home'),
      probe: async () => undefined,
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
