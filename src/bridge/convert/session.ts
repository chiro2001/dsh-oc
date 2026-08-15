import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Session, SessionV2Info } from '@opencode-ai/sdk/v2'
import {
  DEFAULT_AGENT,
  externalProviderId,
  OPENCODE_VERSION,
  projectIdFor,
} from './common.js'

export interface SessionConvertOptions {
  cwd: string
  /** Fallback creation timestamp; dsh summaries do not expose header.createdAt. */
  createdAt?: number
  /** Current dsh model selection, mapped to the opencode-facing provider. */
  model?: {
    id: string
    providerID: string
    variant?: string
  }
}

export function sessionTitleFrom(summary: SessionSummary): string {
  const values = summary.projections?.values as Partial<Record<string, unknown>> | undefined
  const title = values?.title
  if (typeof title === 'string' && title.length > 0) return title
  return summary.origin === 'subagent' ? 'Subagent session' : ''
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
  const title = sessionTitleFrom(summary)
  return {
    id: String(summary.sessionId),
    slug: String(summary.sessionId),
    projectID: projectIdFor(directory),
    directory,
    ...(summary.origin === 'subagent' && summary.parentSessionId !== undefined
      ? { parentID: String(summary.parentSessionId) }
      : {}),
    title,
    agent: summary.agentPreset ?? DEFAULT_AGENT,
    ...(options.model === undefined ? {} : { model: options.model }),
    version: OPENCODE_VERSION,
    ...(sessionMetadataFrom(summary) === undefined
      ? {}
      : { metadata: sessionMetadataFrom(summary) }),
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
): SessionV2Info {
  const directory = summary.cwd ?? options.cwd
  const createdAt = options.createdAt ?? summary.updatedAt
  return {
    id: String(summary.sessionId),
    ...(summary.origin === 'subagent' && summary.parentSessionId !== undefined
      ? { parentID: String(summary.parentSessionId) }
      : {}),
    projectID: projectIdFor(directory),
    agent: summary.agentPreset ?? DEFAULT_AGENT,
    ...(options.model === undefined ? {} : { model: options.model }),
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
    title: sessionTitleFrom(summary),
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
    agent: DEFAULT_AGENT,
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
): SessionV2Info {
  const directory = options.cwd
  const created = options.createdAt ?? Date.now()
  return {
    id: sessionId,
    ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
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
  }
}

/** Model reference used in session headers when dsh advertises one. */
export function modelRef(provider: string, model: string) {
  return {
    id: model,
    providerID: externalProviderId(provider),
  }
}
