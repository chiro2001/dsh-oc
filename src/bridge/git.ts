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

/** `/vcs` shape (SDK `VcsInfo`). */
export interface VcsInfo {
  branch?: string
  default_branch?: string
}

/** `/vcs/status` row (SDK `VcsFileStatus`). */
export interface VcsFileStatus {
  file: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

/** `/vcs/diff` row (SDK `VcsFileDiff`). */
export interface VcsFileDiff {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/** Current branch plus the configured origin default branch, if resolvable. */
export function vcsInfo(cwd: string): VcsInfo {
  const branch = git(cwd, ['branch', '--show-current'])
  const head = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const info: VcsInfo = {}
  const branchName = branch.stdout.trim()
  if (branch.status === 0 && branchName !== '') info.branch = branchName
  const defaultRef = head.stdout.trim()
  if (head.status === 0 && defaultRef !== '') {
    info.default_branch = defaultRef.replace(/^refs\/remotes\/origin\//, '')
  }
  return info
}

/** Parse one `git status --porcelain=v1` line into a file status row. */
function statusFromPorcelain(line: string): VcsFileStatus | undefined {
  if (line.length < 3) return undefined
  const xy = line.slice(0, 2)
  if (xy === '??') return undefined
  let file = line.slice(3)
  if (file.includes(' -> ')) {
    file = file.split(' -> ').pop() ?? file
  }
  const x = xy[0] as string
  const y = xy[1] as string
  let status: VcsFileStatus['status']
  if (x === 'A' || y === 'A') status = 'added'
  else if (x === 'D' || y === 'D') status = 'deleted'
  else status = 'modified'
  return { file, additions: 0, deletions: 0, status }
}

/** Parse `git diff --numstat` lines (tab-separated, rename-safe). */
function countsFromNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [addRaw, delRaw, ...pathParts] = line.split('\t')
    if (pathParts.length === 0) continue
    let file = pathParts.join('\t')
    if (file.includes(' => ')) file = file.split(' => ').pop() ?? file
    const additions = Number(addRaw)
    const deletions = Number(delRaw)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    counts.set(file, { additions, deletions })
  }
  return counts
}

/**
 * Working-tree + staged file statuses relative to `cwd`. Untracked files are
 * intentionally omitted (the SDK status type has no untracked variant).
 */
export function vcsFileStatuses(cwd: string): VcsFileStatus[] {
  const status = git(cwd, ['status', '--porcelain=v1'])
  if (status.status !== 0) return []
  const rows = status.stdout
    .split('\n')
    .map(statusFromPorcelain)
    .filter((row): row is VcsFileStatus => row !== undefined)
  const staged = countsFromNumstat(git(cwd, ['diff', '--cached', '--numstat']).stdout)
  const unstaged = countsFromNumstat(git(cwd, ['diff', '--numstat']).stdout)
  for (const row of rows) {
    const stagedCounts = staged.get(row.file)
    const unstagedCounts = unstaged.get(row.file)
    row.additions = (stagedCounts?.additions ?? 0) + (unstagedCounts?.additions ?? 0)
    row.deletions = (stagedCounts?.deletions ?? 0) + (unstagedCounts?.deletions ?? 0)
  }
  return rows
}

/** Diff args for one mode; branch mode compares against the origin default. */
function diffArgs(cwd: string, mode: 'git' | 'branch', context: number): string[] {
  const unified = Number.isFinite(context) ? Math.max(0, Math.min(context, 20)) : 3
  const base = ['diff', '--no-ext-diff', `--unified=${unified}`]
  if (mode !== 'branch') return [...base, 'HEAD', '--']
  const info = vcsInfo(cwd)
  if (info.default_branch !== undefined) {
    return [...base, `${info.default_branch}...HEAD`, '--']
  }
  return [...base, 'HEAD', '--']
}

/** Per-file diffs (SDK `VcsFileDiff[]`) for the requested mode. */
export function vcsDiff(
  cwd: string,
  mode: 'git' | 'branch' = 'git',
  context?: number,
): VcsFileDiff[] {
  const args = diffArgs(cwd, mode, context === undefined ? 3 : context)
  const nameStatus = git(cwd, [...args.slice(0, args.length - 1), '--name-status'])
  if (nameStatus.status !== 0) return []
  const numstat = git(cwd, [...args.slice(0, args.length - 1), '--numstat'])
  const counts = countsFromNumstat(numstat.status === 0 ? numstat.stdout : '')
  const diffs: VcsFileDiff[] = []
  for (const line of nameStatus.stdout.split('\n')) {
    if (line === '') continue
    const statusRaw = line.slice(0, 1)
    const rest = line.slice(1).trim()
    if (rest === '') continue
    let file = rest
    if (file.includes(' => ')) file = file.split(' => ').pop() ?? file
    let status: VcsFileDiff['status']
    if (statusRaw === 'A') status = 'added'
    else if (statusRaw === 'D') status = 'deleted'
    else status = 'modified'
    const patch = git(cwd, [...args, '--', file]).stdout
    diffs.push({
      file,
      ...(patch === '' ? {} : { patch }),
      additions: counts.get(file)?.additions ?? 0,
      deletions: counts.get(file)?.deletions ?? 0,
      status,
    })
  }
  return diffs
}

/** Raw unified diff text for the requested mode. */
export function vcsDiffRaw(
  cwd: string,
  mode: 'git' | 'branch' = 'git',
  context?: number,
): string {
  const result = git(cwd, diffArgs(cwd, mode, context === undefined ? 3 : context))
  return result.status === 0 ? result.stdout : ''
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
