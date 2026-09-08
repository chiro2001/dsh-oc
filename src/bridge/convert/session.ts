import type { SessionSummary } from '../dsh-types.js'
import type { Session, SessionV2Info } from '@opencode-ai/sdk/v2'
import {
  DEFAULT_AGENT,
  externalProviderId,
  OPENCODE_VERSION,
  projectIdFor,
} from './common.js'

export interface SessionConvertOptions {
  cwd: string
  /** Real durable title learned from a history projection / title event. */
  title?: string
  /** Fallback creation timestamp; dsh summaries do not expose header.createdAt. */
  createdAt?: number
  /** Current dsh model selection, mapped to the opencode-facing provider. */
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  /**
   * Live per-session agent (user preset switch / Tab). When present it wins
   * over the summary's header default ("build"), which dsh keeps on a fresh
   * session even after the preset was switched.
   */
  agent?: string
  /** Optional lineage metadata learned from the live bridge state. */
  metadata?: Record<string, unknown>
}

/** OpenCode SDK v2 1.18.18 omits metadata from its generated type, but the TUI accepts
 * the same lineage marker carried by the v1 Session shape. */
export type SessionV2InfoWithMetadata = SessionV2Info & {
  metadata?: Record<string, unknown>
}

export function sessionTitleFrom(summary: SessionSummary, override?: string): string {
  const values = summary.projections?.values as Partial<Record<string, unknown>> | undefined
  const title = values?.title
  if (typeof title === 'string' && title.length > 0) return title
  if (override !== undefined && override.length > 0) return override
  if (summary.origin === 'subagent') return 'Subagent session'
  const cwd = summary.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
    if (base.length > 0) return base
  }
  return String(summary.sessionId)
}

/** Metadata marker opencode surfaces use to identify dsh subagent children. */
export function sessionMetadataFrom(summary: SessionSummary): Record<string, unknown> | undefined {
  if (summary.origin !== 'subagent') return undefined
  return { origin: 'subagent' }
}

/**
 * Convert a dsh `SessionSummary` into the opencode v2 `Session` shape
 * (a structural superset of the v1 `Session`).
 */
export function convertSessionSummary(
  summary: SessionSummary,
  options: SessionConvertOptions,
): Session {
  const directory = summary.cwd ?? options.cwd
  const createdAt = options.createdAt ?? summary.updatedAt
  const title = sessionTitleFrom(summary, options.title)
  const metadata = options.metadata ?? sessionMetadataFrom(summary)
  return {
    id: String(summary.sessionId),
    slug: String(summary.sessionId),
    projectID: projectIdFor(directory),
    directory,
    ...(summary.origin === 'subagent' && summary.parentSessionId !== undefined
      ? { parentID: String(summary.parentSessionId) }
      : {}),
    title,
    agent: options.agent ?? summary.agentPreset ?? DEFAULT_AGENT,
    ...(options.model === undefined ? {} : { model: options.model }),
    version: OPENCODE_VERSION,
    ...(metadata === undefined ? {} : { metadata }),
    time: {
      created: createdAt,
      updated: summary.updatedAt,
    },
  }
}

/** Convert a summary into the v2 `/api/session` `SessionV2Info` shape. */
export function convertSessionSummaryV2(
  summary: SessionSummary,
  options: SessionConvertOptions,
): SessionV2InfoWithMetadata {
  const directory = summary.cwd ?? options.cwd
  const createdAt = options.createdAt ?? summary.updatedAt
  const metadata = options.metadata ?? sessionMetadataFrom(summary)
  return {
    id: String(summary.sessionId),
    ...(summary.origin === 'subagent' && summary.parentSessionId !== undefined
      ? { parentID: String(summary.parentSessionId) }
      : {}),
    projectID: projectIdFor(directory),
    agent: options.agent ?? summary.agentPreset ?? DEFAULT_AGENT,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(metadata === undefined ? {} : { metadata }),
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: createdAt,
      updated: summary.updatedAt,
    },
    title: sessionTitleFrom(summary, options.title),
    location: {
      directory,
    },
  }
}

/** Minimal session view used by SSE when only the session id is known. */
export function minimalSession(
  sessionId: string,
  options: SessionConvertOptions & {
    title?: string
    createdAt?: number
    parentID?: string
    metadata?: Record<string, unknown>
    agent?: string
  },
): Session {
  const directory = options.cwd
  const created = options.createdAt ?? Date.now()
  return {
    id: sessionId,
    slug: sessionId,
    projectID: projectIdFor(directory),
    directory,
    title: options.title ?? '',
    agent: options.agent ?? DEFAULT_AGENT,
    ...(options.model === undefined ? {} : { model: options.model }),
    version: OPENCODE_VERSION,
    ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    time: { created, updated: Date.now() },
  }
}

/** Minimal v2 session view used when only the session id is known. */
export function minimalSessionV2(
  sessionId: string,
  options: SessionConvertOptions & {
    title?: string
    createdAt?: number
    parentID?: string
  },
): SessionV2InfoWithMetadata {
  const directory = options.cwd
  const created = options.createdAt ?? Date.now()
  return {
    id: sessionId,
    ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    projectID: projectIdFor(directory),
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created, updated: Date.now() },
    title: options.title ?? '',
    location: { directory },
    ...(options.model === undefined ? {} : { model: options.model }),
  }
}

/** Model reference used in session headers when dsh advertises one. */
export function modelRef(provider: string, model: string) {
  return {
    id: model,
    providerID: externalProviderId(provider),
  }
}
