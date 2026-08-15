import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..')
const probe = join(repoRoot, 'scripts', 'probe-opencode.mjs')
const fixture = join(repoRoot, 'tests', 'fixtures', 'opencode', 'routes.json')
const fakeBin = join(repoRoot, 'tests', 'e2e', 'fake-opencode.sh')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-oc-probe-${label}-`))
  dirs.push(dir)
  return dir
}

function runProbe(routesPath: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [probe, '--routes', routesPath, '--bin', fakeBin],
    { encoding: 'utf8', cwd: repoRoot },
  )
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

describe('protocol probe', () => {
  it('passes against the recorded 1.18.18 route fixture', () => {
    const { status, stdout } = runProbe(fixture)
    expect(status).toBe(0)
    expect(stdout).toContain('PASSED')
  })

  it('reports a missing route with a concrete fix suggestion', () => {
    const dir = tmpDir('missing')
    const manifest = JSON.parse(readFileSync(fixture, 'utf8')) as {
      routes: Array<{ method: string; path: string; kind: string }>
    }
    const routes = [
      ...manifest.routes,
      { method: 'GET', path: '/session/:id/foo', kind: 'json' },
    ]
    const broken = join(dir, 'routes.json')
    writeFileSync(broken, `${JSON.stringify({ version: '1.18.18', routes }, null, 2)}\n`)

    const { status, stdout } = runProbe(broken)
    expect(status).toBe(1)
    expect(stdout).toContain('FAIL missing-route')
    expect(stdout).toContain('GET /session/:p/foo')
    expect(stdout).toContain('src/bridge/router.ts')
  })
})
