import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  convertSessionSummary,
  convertSessionSummaryV2,
  minimalSession,
  sessionTitleFrom,
} from '../../src/bridge/convert/session.js'

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1' as never,
    updatedAt: 2000,
    running: false,
    blank: false,
    cwd: '/work',
    agentPreset: 'build',
    projections: {
      asOfSeq: 1,
      values: { title: 'My Session' } as never,
    },
    ...overrides,
  }
}

describe('convert/session', () => {
  it('maps every summary field onto the opencode Session', () => {
    const session = convertSessionSummary(summary(), { cwd: '/fallback', createdAt: 1500 })
    expect(session.id).toBe('session-1')
    expect(session.slug).toBe('session-1')
    expect(session.directory).toBe('/work')
    expect(session.projectID).toMatch(/^[0-9a-f]{16}$/)
    expect(session.title).toBe('My Session')
    expect(session.agent).toBe('build')
    expect(session.version).toBe('1.18.18')
    expect(session.time.created).toBe(1500)
    expect(session.time.updated).toBe(2000)
  })

  it('falls back to cwd, empty title and updatedAt when fields are missing', () => {
    const session = convertSessionSummary(summary({ cwd: undefined, projections: undefined }), {
      cwd: '/fallback',
    })
    expect(session.directory).toBe('/fallback')
    expect(session.title).toBe('')
    expect(session.time.created).toBe(2000)
    expect(session.projectID).toBe(
      convertSessionSummary(summary({ cwd: undefined }), { cwd: '/fallback' }).projectID,
    )
  })

  it('maps to the v2 SessionV2Info shape', () => {
    const v2 = convertSessionSummaryV2(summary(), { cwd: '/fallback', createdAt: 1500 })
    expect(v2.id).toBe('session-1')
    expect(v2.location.directory).toBe('/work')
    expect(v2.location.workspaceID).toBeUndefined()
    expect(v2.cost).toBe(0)
    expect(v2.tokens.cache.read).toBe(0)
    expect(v2.time.created).toBe(1500)
    expect(v2.title).toBe('My Session')
  })

  it('reads the title projection', () => {
    expect(sessionTitleFrom(summary())).toBe('My Session')
    expect(sessionTitleFrom(summary({ projections: undefined }))).toBe('')
  })

  it('builds a minimal session for SSE', () => {
    const session = minimalSession('s-9', { cwd: '/work', title: 'T', createdAt: 42 })
    expect(session.id).toBe('s-9')
    expect(session.directory).toBe('/work')
    expect(session.title).toBe('T')
    expect(session.time.created).toBe(42)
  })
})
