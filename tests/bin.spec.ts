import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const binPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-oc.mjs')
const tempDirs: string[] = []
const pkgVersion = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version as string

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeDshBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-bin-'))
  mkdirSync(join(dir, 'empty'), { recursive: true })
  writeFileSync(join(dir, 'dsh'), [
    '#!/usr/bin/env bash',
    'if [[ "$1" == "--version" ]]; then',
    '  printf "0.1.0-rc.6\\n"',
    '  exit 0',
    'fi',
    'printf "%s\\n" "$*" >> "$DSH_OC_ARGS_LOG"',
    'exit "${DSH_OC_FAKE_EXIT:-0}"',
    '',
  ].join('\n'))
  chmodSync(join(dir, 'dsh'), 0o755)
  tempDirs.push(dir)
  return dir
}

describe('dsh-oc bin', () => {
  it('forwards every argument to dsh --profile oc and mirrors the exit code', () => {
    const dir = fakeDshBin()
    const log = join(dir, 'args.txt')
    const result = spawnSync(process.execPath, [binPath, '--mini', '--session', 's1'], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        DSH_OC_ARGS_LOG: log,
        DSH_OC_FAKE_EXIT: '3',
      },
    })
    expect(result.status).toBe(3)
    expect(readFileSync(log, 'utf8').trim()).toBe('--profile oc --mini --session s1')
  })

  it('passes the terminal through without extra output', () => {
    const dir = fakeDshBin()
    const result = spawnSync(process.execPath, [binPath], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        DSH_OC_ARGS_LOG: join(dir, 'args.txt'),
      },
    })
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toBe('')
    expect(String(result.stderr)).toBe('')
  })

  it('prints the dsh-oc version alongside the dsh version for --version', () => {
    const dir = fakeDshBin()
    const result = spawnSync(process.execPath, [binPath, '--version'], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        DSH_OC_ARGS_LOG: join(dir, 'args.txt'),
      },
    })
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe(`dsh-oc ${pkgVersion} (dsh 0.1.0-rc.6)`)
  })

  it('exits 127 with a hint when dsh is missing for --version', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-oc-nodsh-version-'))
    tempDirs.push(empty)
    const result = spawnSync(process.execPath, [binPath, '--version'], {
      env: { ...process.env, PATH: empty },
    })
    expect(result.status).toBe(127)
    expect(String(result.stderr)).toContain('failed to run dsh')
  })

  it('exits 127 with a hint when dsh is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-oc-nodsh-'))
    tempDirs.push(empty)
    const result = spawnSync(process.execPath, [binPath], {
      env: { ...process.env, PATH: empty },
    })
    expect(result.status).toBe(127)
    expect(String(result.stderr)).toContain('failed to run dsh')
  })
})
