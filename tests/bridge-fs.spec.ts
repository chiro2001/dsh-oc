import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contentTypeFor,
  findWithin,
  listDirWithin,
  readFileWithin,
  resolveWithin,
} from '../src/bridge/fs.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-fs-'))
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'readme.txt'), 'hello fs\n')
  writeFileSync(join(dir, 'src', 'main.ts'), 'export {}\n')
  writeFileSync(join(dir, 'src', 'nested', 'deep.txt'), 'deep\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
  tempDirs.push(dir)
  return dir
}

describe('workspace fs helpers', () => {
  it('infers content types by extension', () => {
    expect(contentTypeFor('readme.txt')).toBe('text/plain; charset=utf-8')
    expect(contentTypeFor('src/main.ts')).toBe('text/plain; charset=utf-8')
    expect(contentTypeFor('photo.PNG')).toBe('image/png')
    expect(contentTypeFor('favicon.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('archive.bin')).toBe('application/octet-stream')
  })

  it('resolves paths inside the workspace and rejects escapes', () => {
    const work = workspace()
    expect(resolveWithin(work, 'readme.txt')).toBe(join(work, 'readme.txt'))
    expect(resolveWithin(work, '')).toBe(work)
    expect(() => resolveWithin(work, '../outside.txt')).toThrow(/path escapes/)
    expect(() => resolveWithin(work, '/etc/passwd')).toThrow(/path escapes/)
  })

  it('reads files and rejects missing paths or directories', () => {
    const work = workspace()
    expect(readFileWithin(work, 'readme.txt').toString()).toBe('hello fs\n')
    expect(() => readFileWithin(work, 'missing.txt')).toThrow(/file not found/)
    expect(() => readFileWithin(work, 'src')).toThrow(/not a file/)
  })

  it('lists direct children sorted with directories first', () => {
    const work = workspace()
    const entries = listDirWithin(work, '')
    expect(entries.map((entry) => entry.path)).toEqual([
      'node_modules',
      'src',
      'readme.txt',
    ])
    expect(entries[0]).toMatchObject({ type: 'directory' })
    expect(entries[2]).toMatchObject({ type: 'file' })
  })

  it('finds files by name, honors type, skips dependency dirs and bounds results', () => {
    const work = workspace()
    const files = findWithin(work, '.txt', 'file')
    expect(files.map((entry) => entry.path)).toEqual([
      'readme.txt',
      'src/nested/deep.txt',
    ])
    const dirs = findWithin(work, 'src', 'directory')
    expect(dirs.map((entry) => entry.path)).toEqual(['src', 'src/nested'])
    expect(findWithin(work, 'ignored', 'file')).toEqual([])
    expect(findWithin(work, '.txt', 'file', 1)).toHaveLength(1)
    expect(findWithin(work, '')).toEqual([])
  })
})
