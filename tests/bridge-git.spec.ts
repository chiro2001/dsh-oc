import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterGitTrackedDiffs } from '../src/bridge/git.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-git-filter-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@dsh-oc.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'dsh-oc e2e'], { cwd: dir })
  tempDirs.push(dir)
  return dir
}

function track(repo: string, path: string, content: string): void {
  const full = join(repo, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  execFileSync('git', ['add', '--', path], { cwd: repo })
}

describe('filterGitTrackedDiffs', () => {
  it('keeps tracked modified diffs and drops untracked and out-of-workdir deletions', () => {
    const work = gitRepo()
    track(work, 'src/tracked.txt', 'one\n')
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: work })
    writeFileSync(join(work, 'src', 'tracked.txt'), 'two\n')

    const untrackedPath = join(work, 'src', 'untracked.txt')
    mkdirSync(join(untrackedPath, '..'), { recursive: true })
    writeFileSync(untrackedPath, 'never committed\n')
    rmSync(join(work, 'src', 'untracked.txt'))

    const outside = mkdtempSync(join(tmpdir(), 'dsh-oc-outside-'))
    tempDirs.push(outside)
    execFileSync('git', ['init', '-q'], { cwd: outside })
    execFileSync('git', ['config', 'user.email', 'e2e@dsh-oc.test'], { cwd: outside })
    execFileSync('git', ['config', 'user.name', 'dsh-oc e2e'], { cwd: outside })
    const outsideFile = join(outside, 'gone.txt')
    writeFileSync(outsideFile, 'outside\n')
    execFileSync('git', ['add', '-A'], { cwd: outside })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: outside })
    rmSync(outsideFile)

    const tracked = {
      file: join(work, 'src', 'tracked.txt'),
      additions: 1,
      deletions: 1,
      status: 'modified' as const,
    }
    const untrackedDeleted = {
      file: 'src/untracked.txt',
      additions: 0,
      deletions: 1,
      status: 'deleted' as const,
    }
    const outsideDeleted = {
      file: outsideFile,
      additions: 0,
      deletions: 1,
      status: 'deleted' as const,
    }

    expect(filterGitTrackedDiffs(work, [tracked, untrackedDeleted, outsideDeleted])).toEqual([
      tracked,
    ])
  })
})
