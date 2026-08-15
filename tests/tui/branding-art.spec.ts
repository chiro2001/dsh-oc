import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const artPath = join(repoRoot, 'tui-branding', 'art.ts')

function parseArtArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`))
  expect(match, `${name} array missing from generated art`).not.toBeNull()
  const rows = [...(match?.[1] ?? '').matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map(
    (row) => row[1]?.replace(/\\(.)/g, '$1') ?? '',
  )
  expect(rows.length, `${name} must contain glyph rows`).toBeGreaterThan(0)
  return rows
}

describe('tui-branding generated art', () => {
  const source = readFileSync(artPath, 'utf8')
  const dsh = parseArtArray(source, 'DSH')
  const oc = parseArtArray(source, 'OC')

  it('is generated from a registered figlet font and covers both words', () => {
    expect(source).toContain('scripts/generate-tui-branding-art.mjs')
    expect(source).toContain('DSH OC')
    expect(source).toMatch(/BRANDING_FONT = "(Standard|Slant|Big|Doom|ANSI Shadow|Speed)"/)
  })

  it('has aligned, non-empty rows and fits the home screen', () => {
    expect(dsh.length).toBe(oc.length)
    for (const column of [dsh, oc]) {
      const widths = new Set(column.map((row) => row.length))
      expect(widths.size, 'all rows must share the same width').toBe(1)
      for (const row of column) expect(row.trim().length).toBeGreaterThan(0)
    }
    const combined = Math.max(...dsh.map((row) => row.length)) + 3 + Math.max(...oc.map((row) => row.length))
    expect(combined).toBeLessThanOrEqual(60)
  })

  it('does not contain the OpenCode wordmark glyphs', () => {
    for (const row of [...dsh, ...oc]) {
      expect(row).not.toMatch(/[█▀▄▌▐]/)
      expect(row).not.toMatch(/opencode/i)
    }
  })
})
