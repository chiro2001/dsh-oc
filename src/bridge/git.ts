import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

/** A diff entry with an optional file path, shared by all bridge diff shapes. */
export interface GitFilterableDiff {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

/**
 * Keep only diffs whose path is inside `cwd` and is tracked by git. Calls
 * `git ls-files --error-unmatch` through an argv array so paths can never be
 * interpreted as shell syntax.
 */
export function filterGitTrackedDiffs<T extends GitFilterableDiff>(
  cwd: string,
  diffs: readonly T[],
): T[] {
  const root = resolve(cwd)
  return diffs.filter((diff) => {
    if (diff.file === undefined || diff.file === '') return false
    const resolved = resolve(root, diff.file)
    const rel = relative(root, resolved)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
    const result = spawnSync(
      'git',
      ['-C', root, 'ls-files', '--error-unmatch', '--', rel],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    return result.status === 0
  })
}
