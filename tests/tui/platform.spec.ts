import { describe, expect, it } from 'vitest'
import { resolvePlatform, type PlatformSelection, type ExecFileSyncResult } from '../../src/tui/platform.ts'

function platformFor(options: {
  platform: string
  arch: string
  avx2?: boolean
  musl?: boolean
}): PlatformSelection {
  return resolvePlatform({
    platform: options.platform,
    arch: options.arch,
    readFile: () => (options.avx2 === true ? 'flags : fpu avx2 v2' : 'flags : fpu'),
    exists: path => path === '/etc/alpine-release' && options.musl === true,
    execFileSync: (file): ExecFileSyncResult => {
      if (file === 'ldd') {
        return { status: 0, stdout: options.musl === true ? 'musl libc' : 'glibc', stderr: '' }
      }
      if (file === 'sysctl') {
        return { status: 0, stdout: options.avx2 === true ? '1' : '0', stderr: '' }
      }
      if (options.platform === 'windows') {
        return { status: 0, stdout: options.avx2 === true ? 'true' : 'false', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
}

describe('resolvePlatform', () => {
  it('selects linux x64 AVX2 (non-musl) first', () => {
    const selected = platformFor({ platform: 'linux', arch: 'x64', avx2: true })
    expect(selected).toMatchObject({
      platform: 'linux',
      arch: 'x64',
      musl: false,
      avx2: true,
      key: 'linux-x64',
      extension: '.tar.gz',
      executableName: 'opencode',
    })
    expect(selected.candidates).toEqual([
      'linux-x64',
      'linux-x64-baseline',
      'linux-x64-musl',
      'linux-x64-baseline-musl',
    ])
  })

  it('selects the baseline first on linux x64 without AVX2', () => {
    const selected = platformFor({ platform: 'linux', arch: 'x64', avx2: false })
    expect(selected.key).toBe('linux-x64-baseline')
    expect(selected.candidates).toEqual([
      'linux-x64-baseline',
      'linux-x64',
      'linux-x64-baseline-musl',
      'linux-x64-musl',
    ])
  })

  it('orders musl candidates before glibc on linux x64 musl', () => {
    const withAvx2 = platformFor({ platform: 'linux', arch: 'x64', avx2: true, musl: true })
    expect(withAvx2.key).toBe('linux-x64-musl')
    expect(withAvx2.candidates).toEqual([
      'linux-x64-musl',
      'linux-x64-baseline-musl',
      'linux-x64',
      'linux-x64-baseline',
    ])

    const baseline = platformFor({ platform: 'linux', arch: 'x64', avx2: false, musl: true })
    expect(baseline.key).toBe('linux-x64-baseline-musl')
    expect(baseline.candidates).toEqual([
      'linux-x64-baseline-musl',
      'linux-x64-musl',
      'linux-x64-baseline',
      'linux-x64',
    ])
  })

  it('handles linux arm64 with and without musl', () => {
    const glibc = platformFor({ platform: 'linux', arch: 'arm64' })
    expect(glibc.key).toBe('linux-arm64')
    expect(glibc.candidates).toEqual(['linux-arm64', 'linux-arm64-musl'])

    const musl = platformFor({ platform: 'linux', arch: 'arm64', musl: true })
    expect(musl.key).toBe('linux-arm64-musl')
    expect(musl.candidates).toEqual(['linux-arm64-musl', 'linux-arm64'])
  })

  it('selects darwin x64 by AVX2 with zip archives', () => {
    const withAvx2 = platformFor({ platform: 'darwin', arch: 'x64', avx2: true })
    expect(withAvx2.key).toBe('darwin-x64')
    expect(withAvx2.candidates).toEqual(['darwin-x64', 'darwin-x64-baseline'])
    expect(withAvx2.extension).toBe('.zip')

    const baseline = platformFor({ platform: 'darwin', arch: 'x64', avx2: false })
    expect(baseline.key).toBe('darwin-x64-baseline')
    expect(baseline.candidates).toEqual(['darwin-x64-baseline', 'darwin-x64'])
  })

  it('selects windows x64 baseline without AVX2 and uses .exe/.zip', () => {
    const selected = platformFor({ platform: 'win32', arch: 'x64', avx2: false })
    expect(selected.key).toBe('windows-x64-baseline')
    expect(selected.candidates).toEqual(['windows-x64-baseline', 'windows-x64'])
    expect(selected.extension).toBe('.zip')
    expect(selected.executableName).toBe('opencode.exe')
  })

  it('handles windows arm64 and other single-candidate arches', () => {
    const selected = platformFor({ platform: 'win32', arch: 'arm64' })
    expect(selected.key).toBe('windows-arm64')
    expect(selected.candidates).toEqual(['windows-arm64'])
  })
})
