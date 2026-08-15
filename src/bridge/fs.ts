// Workspace-scoped filesystem helpers for the /api/fs/* bridge routes.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { badRequest, notFound } from './errors.js'

/** SDK `FileSystemEntry`. */
export interface FileSystemEntry {
  path: string
  type: 'file' | 'directory'
}

const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_FIND_RESULTS = 500
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.e2e',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.dsh',
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json',
  'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'py', 'sh', 'bash',
  'zsh', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'sql', 'log', 'ini',
  'cfg', 'env', 'csv', 'tsv',
])

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

/** Content-Type for one workspace file path (best effort by extension). */
export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8'
  return IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Resolve a user-supplied relative path inside `cwd`; any path that escapes
 * the workspace is rejected before touching the filesystem.
 */
export function resolveWithin(cwd: string, raw: string): string {
  const root = resolve(cwd)
  const target = resolve(root, raw === '' ? '.' : raw)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw badRequest('path escapes the workspace', { path: raw })
  }
  return target
}

/** Read one file inside the workspace as raw bytes (bounded size). */
export function readFileWithin(cwd: string, raw: string): Buffer {
  const target = resolveWithin(cwd, raw)
  let stat
  try {
    stat = statSync(target)
  } catch {
    throw notFound('file not found', { path: raw })
  }
  if (!stat.isFile()) throw badRequest('not a file', { path: raw })
  if (stat.size > MAX_READ_BYTES) {
    throw badRequest('file exceeds the 5 MiB read limit', { path: raw, size: stat.size })
  }
  try {
    return readFileSync(target)
  } catch (error) {
    throw badRequest('file unreadable', { path: raw, reason: error instanceof Error ? error.message : String(error) })
  }
}

function entryPath(root: string, target: string): string {
  return relative(root, target).split('\\').join('/')
}

/** List direct children of one workspace-relative directory. */
export function listDirWithin(cwd: string, raw: string): FileSystemEntry[] {
  const root = resolve(cwd)
  const target = resolveWithin(cwd, raw)
  let stat
  try {
    stat = statSync(target)
  } catch {
    throw notFound('directory not found', { path: raw })
  }
  if (!stat.isDirectory()) throw badRequest('not a directory', { path: raw })
  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    throw badRequest('directory unreadable', { path: raw, reason: error instanceof Error ? error.message : String(error) })
  }
  return entries
    .map((entry): FileSystemEntry => ({
      path: entryPath(root, join(target, entry.name)),
      type: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.path.localeCompare(b.path)
    })
}

/**
 * Recursive name/path search inside the workspace. Skips common dependency
 * and build directories and hard-bounds the result count.
 */
export function findWithin(
  cwd: string,
  query: string,
  type?: 'file' | 'directory',
  limit = 100,
): FileSystemEntry[] {
  const root = resolve(cwd)
  const needle = query.trim().toLowerCase()
  const max = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, MAX_FIND_RESULTS))
  const results: FileSystemEntry[] = []
  if (needle === '') return results
  const walk = (dir: string): boolean => {
    if (results.length >= max) return false
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of ordered) {
      if (results.length >= max) return false
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      const entryType: FileSystemEntry['type'] = entry.isDirectory() ? 'directory' : 'file'
      const path = entryPath(root, join(dir, entry.name))
      if ((type === undefined || entryType === type) && path.toLowerCase().includes(needle)) {
        results.push({ path, type: entryType })
      }
      if (entry.isDirectory() && !walk(join(dir, entry.name))) return false
    }
    return true
  }
  walk(root)
  return results
}
