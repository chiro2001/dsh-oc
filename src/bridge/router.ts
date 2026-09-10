import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BridgeControlBaseline,
  BridgeFrame,
  BridgeHostFrame,
  HistoryEntry,
  SessionProjectionsBlock,
  SessionSummary,
  QueuedInboxItem,
} from './dsh-types.js'
import type { ModelProviderGroup, PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ToolResultBlock } from '@deepseek-ai/dsh-llm/types'
import type {
  Command as V1Command,
  FileDiff as V1FileDiff,
} from '@opencode-ai/sdk/client'
import type {
  CommandV2Info,
  LocationInfo,
  Session as V2Session,
  SessionMessagesResponse,
  SessionStatus,
} from '@opencode-ai/sdk/v2/types'
import type { Agent as V2Agent, AgentV2Info } from '@opencode-ai/sdk/v2/types'
import type { BridgeApi, BridgeCommandExecution } from './rpc.js'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller'
import { call, RpcCallError } from './rpc.js'
import {
  badRequest,
  conflict,
  internalError,
  notFound,
  rpcErrorToHttp,
} from './errors.js'
import {
  convertSessionSummary,
  convertSessionSummaryV2,
  minimalSession,
  minimalSessionV2,
  sessionTitleFrom,
  type SessionV2InfoWithMetadata,
} from './convert/session.js'
import {
  convertMessagesV1,
  convertMessagesV2,
  type V1MessageEntry,
} from './convert/message.js'
import {
  convertToProviderCatalog,
  convertToV1Providers,
  convertToV2Models,
  convertToV2Providers,
} from './convert/model.js'
import { toPermissionRequest, toPermissionV2 } from './convert/permission.js'
import { answersToDsh, toQuestionRequest, toQuestionV2 } from './convert/question.js'
import { convertGoalTodos } from './convert/goal.js'
import {
  completedToolPart,
  errorToolPart,
  fileChangesFromToolResult,
  isSubagentToolName,
  runningToolPart,
  subagentTypeFromToolName,
  type FileChange,
  type ToolCallInfo,
} from './convert/tool.js'
import { agentErrorEvents, commandResultMessage, convertProducedFiles, makeEvent, toSnapshotFileDiffs } from './events.js'
import { filterGitTrackedDiffs } from './git.js'
import { DEFAULT_AGENT, dshProviderId, externalProviderId, projectIdFor, safeJsonParse } from './convert/common.js'
import { ocHelp } from '../help.js'
import {
  InteractionState,
  type CachedHistory,
  type SubagentCallRecord,
  type SubagentChildRecord,
} from './state.js'
import { registerRoutes } from './routes.js'
import { SseHub, type SseClient } from './sse.js'
import { MuxEventTranslator } from './events.js'
import type { BridgeGlobalEvent } from './events.js'
import { stubRoutes } from './stubs.js'
import { runShellCommand } from './shell.js'

export { runShellCommand } from './shell.js'

/** Abort only user shell calls started by this bridge/session. */
export function abortShellCommand(ctx: BridgeRouteContext, sessionId: string): boolean {
  return ctx.state.abortShell(sessionId)
}

export interface BridgeRequest {
  method: string
  pathname: string
  query: URLSearchParams
  params: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

export interface BridgeRouteContext {
  api: BridgeApi
  cwd: string
  state: InteractionState
  log(message: string): void
  hub: SseHub
}

export interface HandlerResult {
  status: number
  body?: unknown
  /** Raw (non-JSON) response body, written verbatim when present. */
  raw?: string | Buffer
  headers?: Record<string, string>
}

export interface Route {
  method: string
  pattern: string
  kind: 'json' | 'sse'
  handler: (req: BridgeRequest, ctx: BridgeRouteContext) => Promise<HandlerResult>
}

export interface BridgeRouter {
  ctx: BridgeRouteContext
  match(method: string, pathname: string): Route | undefined
  startSse(req: BridgeRequest, res: ServerResponse): void
  /** Feed one translated bridge frame to all SSE clients (host-side pump). */
  feed(frame: BridgeFrame): Promise<void>
  /** Feed one host lifecycle frame to all SSE clients. */
  feedHostFrame(frame: BridgeHostFrame): void
  /** Change the bridge working directory (e.g. from an attach `--dir`). */
  setCwd(directory: string): void
  /** Warm the session-list cache in the background after startup. */
  prefetchSessionList(): void
  /** Warm one session's tail history in the background. */
  prefetchSession(sessionId: string): void
  /** Whether this bridge run accepted new user input. */
  hasNewActivity(): boolean
  /** Whether the mini/full TUI exit banner is likely printed (needs a hint). */
  exitNoteNeeded(): Promise<boolean>
}

export interface RouterOptions {
  cwd?: string
  log?: (message: string) => void
  /** Initial SSE mux retry backoff (doubles up to 8s). */
  sseRetryBaseMs?: number
  /** Maximum SSE mux re-subscription attempts before giving up. */
  sseRetryMaxAttempts?: number
}

export function json(status: number, body?: unknown): HandlerResult {
  return { status, body }
}

export function sid(id: string): never {
  return id as never
}

export async function rpc<T = unknown>(
  ctx: BridgeRouteContext,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await call(ctx.api, method, payload, signal) as T
  } catch (error) {
    if (error instanceof RpcCallError) throw rpcErrorToHttp(error)
    throw internalError(error instanceof Error ? error.message : String(error))
  }
}

export function bodyAsRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }
  return body as Record<string, unknown>
}

export function locationInfo(ctx: BridgeRouteContext): LocationInfo {
  return {
    directory: ctx.cwd,
    project: { id: projectIdFor(ctx.cwd), directory: ctx.cwd },
  }
}

export function v2LocationBody(ctx: BridgeRouteContext): { location: LocationInfo; data: unknown[] } {
  return { location: locationInfo(ctx), data: [] }
}

interface SessionView {
  summary?: SessionSummary
  events: HistoryEntry[]
  createdAt?: number
  model?: { id: string; providerID: string; variant?: string }
  cwd?: string
}

export function sessionDirectoryFrom(
  items: readonly SessionSummary[],
  summary: SessionSummary | undefined,
  fallback: string,
): string {
  if (summary?.cwd) return summary.cwd
  if (summary?.parentSessionId !== undefined) {
    const parent = items.find((item) => String(item.sessionId) === String(summary.parentSessionId))
    if (parent?.cwd) return parent.cwd
  }
  return fallback
}

function projectionValuesFor(item: SessionSummary): Record<string, unknown> {
  return (item.projections?.values as Record<string, unknown> | undefined) ?? {}
}

function stringProjection(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Convert one dsh list row into the child facts needed by Task rendering. */
export function subagentChildFromSummary(
  item: SessionSummary,
  fallbackCwd: string,
  addedAt = Date.now(),
  allowFifo = false,
): SubagentChildRecord | undefined {
  if (item.origin !== 'subagent' || item.parentSessionId === undefined) return undefined
  const values = projectionValuesFor(item)
  const identity = values.subagent as { mode?: unknown; label?: unknown } | null | undefined
  const mode = identity?.mode === 'one-shot' || identity?.mode === 'continuable'
    ? identity.mode
    : values.mode === 'one-shot' || values.mode === 'continuable'
      ? values.mode
      : undefined
  const label = typeof identity?.label === 'string' && identity.label.length > 0
    ? identity.label
    : undefined
  const title = stringProjection(values, 'title')
  const agent = typeof item.agentPreset === 'string' && item.agentPreset.length > 0
    ? item.agentPreset
    : stringProjection(values, 'agentPreset')
  return {
    sessionId: String(item.sessionId),
    parentSessionId: String(item.parentSessionId),
    ...(label === undefined ? {} : { label }),
    ...(mode === undefined ? {} : { mode }),
    ...(title === undefined ? {} : { title }),
    ...(agent === undefined ? {} : { agent }),
    cwd: item.cwd ?? fallbackCwd,
    addedAt,
    ...(allowFifo ? { allowFifo: true } : {}),
  }
}

/** Lineage fields that every replacement `session.updated` must retain. */
export function sessionLineageOptions(
  ctx: BridgeRouteContext,
  sessionId: string,
): { parentID?: string; metadata?: Record<string, unknown> } {
  const parentID = ctx.state.sessionParents.get(sessionId)
  if (parentID === undefined) return {}
  return {
    parentID,
    ...(ctx.state.isSubagentSession(sessionId) ? { metadata: { origin: 'subagent' } } : {}),
  }
}

/** Resolve a historical dsh delegation against cached child summaries. */
export function subagentMetadataForHistory(
  ctx: BridgeRouteContext,
  parentSessionId: string,
  call: ToolCallInfo,
): Record<string, unknown> | undefined {
  if (!isSubagentToolName(call.name)) return undefined
  const existing = ctx.state.subagentChildForCall(parentSessionId, call.callId)
  const record = subagentCallRecord(
    parentSessionId,
    call,
    `history:${call.callId}`,
    0,
  )
  // History conversion can see an assistant tool-call before its explicit
  // tool/call row, and v1 then runs before v2 on the same bridge state. Bind
  // both passes through the shared parent-local resolver so same-description
  // children are consumed once in label/FIFO order instead of reusing child 0.
  const child = existing ?? (record === undefined
    ? undefined
    : ctx.state.bindSubagentCallForHistory(record))
  if (child === undefined) return undefined
  return {
    sessionId: child.sessionId,
    parentSessionId,
    ...(child.mode === undefined ? {} : { mode: child.mode }),
    ...(bodyAsRecord(safeJsonParse(call.arguments)).run_in_background === true ? { background: true } : {}),
  }
}

/** Whether a history page contains a dsh delegation whose child can be linked. */
export function historyNeedsSubagentContext(events: readonly HistoryEntry[]): boolean {
  return events.some((entry) => {
    const event = entry.event as unknown as { type?: unknown; data?: unknown }
    if (event.type === 'tool/call') {
      return isSubagentToolName(String((event.data as { name?: unknown } | undefined)?.name ?? ''))
    }
    if (event.type !== 'assistant/message') return false
    const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
    return Array.isArray(content) && content.some((block) => {
      const value = block as { type?: unknown; name?: unknown } | null
      return value?.type === 'tool-call' && isSubagentToolName(String(value.name ?? ''))
    })
  })
}

/** Lazily seed child summaries for direct history requests that skipped /session. */
export async function ensureSubagentHistoryContext(
  ctx: BridgeRouteContext,
  sessionId: string,
  events: readonly HistoryEntry[],
): Promise<void> {
  if (!historyNeedsSubagentContext(events)) return
  if ([...ctx.state.subagentChildren.values()].some((child) => child.parentSessionId === sessionId)) return
  try {
    const list = await cachedSessionList(ctx)
    recordSessionSummaries(ctx, list)
  } catch (error) {
    ctx.log(`[bridge/subagent] history child seed failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Build the shared record used by live and host-side delegation correlation. */
export function subagentCallRecord(
  parentSessionId: string,
  call: ToolCallInfo,
  messageId: string,
  time: number,
  turn?: number,
  step?: number,
): SubagentCallRecord | undefined {
  if (!isSubagentToolName(call.name)) return undefined
  const input = safeJsonParse(call.arguments)
  const description = typeof input.description === 'string' ? input.description : call.name
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const subagentType = typeof input.subagent_type === 'string' && input.subagent_type.trim() !== ''
    ? input.subagent_type
    : subagentTypeFromToolName(call.name)
  return {
    parentSessionId,
    callId: call.callId,
    toolName: call.name,
    messageId,
    description,
    prompt,
    subagentType,
    ...(input.run_in_background === true ? { background: true } : {}),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    createdAt: time,
    arguments: call.arguments,
  }
}

/**
 * Record child cwd and parent lineage from a session list. A subagent child
 * without its own cwd inherits the nearest parent's cwd so the TUI opens and
 * filters its events in the same project directory.
 */
export function recordSessionSummaries(
  ctx: BridgeRouteContext,
  items: readonly SessionSummary[],
  allowSubagentFifo = false,
): void {
  const directories = new Map<string, string>()
  for (const item of items) {
    if (item.cwd) directories.set(String(item.sessionId), item.cwd)
  }
  for (const item of items) {
    const id = String(item.sessionId)
    if (!directories.has(id)) {
      const parentId = item.parentSessionId === undefined
        ? undefined
        : String(item.parentSessionId)
      directories.set(id, (parentId === undefined ? undefined : directories.get(parentId)) ?? ctx.cwd)
    }
  }
  for (const item of items) {
    const id = String(item.sessionId)
    ctx.state.markSessionPresent(id)
    ctx.state.sessionDirectories.set(id, directories.get(id) ?? ctx.cwd)
    // `session.list` is the bounded cold-start source for the status map.
    // Once a live api-session/status edge has arrived, never overwrite it
    // with a potentially stale list snapshot.
    if (ctx.state.sessionRunningFor(id) === undefined) {
      ctx.state.setSessionRunning(id, item.running, item.updatedAt)
    }
    // dsh `SessionSummary` carries the composed preset as `agentPreset`
    // (header passthrough), not a TUI-facing `agent` name. Reading the wrong
    // field left the per-session label unset, so every message fell back to
    // the hardcoded "build" agent even after a Tab switch to another preset.
    const projectionValues = projectionValuesFor(item)
    const projectedTitle = stringProjection(projectionValues, 'title')
    if (projectedTitle !== undefined && ctx.state.sessionTitleFor(id) === undefined) {
      ctx.state.setSessionTitle(id, projectedTitle)
    }
    const projectedAgent = projectionValues.agentPreset
    const agent = (item as { agentPreset?: unknown; agent?: unknown }).agentPreset
      ?? (item as { agent?: unknown }).agent
      ?? projectedAgent
    // Only seed the agent when the state has none yet. The summary's agent
    // is the session-header default ("build") for a freshly created session
    // even after the user switched preset — clobbering the live selection
    // here reverts the TUI label (and message.mode) to the default.
    if (typeof agent === 'string' && agent.length > 0 && ctx.state.sessionAgentFor(id) === undefined) {
      ctx.state.setSessionAgent(id, agent)
    }
    if (item.origin === 'subagent' && item.parentSessionId !== undefined) {
      const child = subagentChildFromSummary(item, directories.get(id) ?? ctx.cwd, Date.now(), allowSubagentFifo)
      if (child !== undefined) {
        ctx.state.associateSubagentChild(child)
      } else {
        ctx.state.sessionOrigins.add(id)
        ctx.state.sessionParents.set(id, String(item.parentSessionId))
      }
    }
  }
}

/** Filter dsh session summaries by a TUI-provided `directory` query. */
export function filterSessionsByDirectory(
  items: readonly SessionSummary[],
  directory: string | undefined,
  base: string,
): SessionSummary[] {
  if (directory === undefined || directory.length === 0) return [...items]
  const normalized = resolve(base, directory)
  return items.filter((item) => {
    if (typeof item.cwd !== 'string') return true
    return resolve(base, item.cwd) === normalized
  })
}

export async function sessionView(ctx: BridgeRouteContext, id: string): Promise<SessionView> {
  ctx.state.setCurrentSession(id)
  const list = await cachedSessionList(ctx)
  const summary = list.find((item) => String(item.sessionId) === id)
  recordSessionSummaries(ctx, list)
  const cwd = sessionDirectoryFrom(list, summary, ctx.cwd)
  const history = await cachedSessionHistory(ctx, id)
  let model: SessionView['model']
  try {
    const selection = await sessionModelSelectionRef(ctx, id)
    model = {
      id: selection.modelID,
      providerID: selection.providerID,
      ...(selection.variant === undefined
        ? {}
        : { variant: selection.variant }),
    }
  } catch (error) {
    ctx.log(`[bridge/session] model selection unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    summary,
    events: history.events,
    createdAt: history.events[0]?.event.time,
    ...(model === undefined ? {} : { model }),
    cwd,
  }
}

/** Encode an opaque v2 message cursor pointing before a surface event seq. */
export function encodeMessageCursor(beforeSeq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, beforeSeq }), 'utf8').toString('base64url')
}

/** Decode an opaque v2 message cursor produced by {@link encodeMessageCursor}. */
export function decodeMessageCursor(raw: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown
      beforeSeq?: unknown
    }
    if (parsed.v === 1 && typeof parsed.beforeSeq === 'number' && Number.isFinite(parsed.beforeSeq)) {
      return parsed.beforeSeq
    }
  } catch {
    // fall through to the invalid-cursor error
  }
  throw badRequest('invalid message cursor')
}

/** Encode an opaque v2 session-list cursor for the next page offset. */
export function encodeSessionCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url')
}

/** Decode an opaque v2 session-list cursor produced by {@link encodeSessionCursor}. */
export function decodeSessionCursor(raw: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown
      offset?: unknown
    }
    if (parsed.v === 1 && typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset
    }
  } catch {
    // fall through to the invalid-cursor error
  }
  throw badRequest('invalid session cursor')
}

/** Oldest surface-message seq in a history page (pagination anchor). */
export function oldestSurfaceSeq(events: readonly HistoryEntry[]): number | undefined {
  let oldest: number | undefined
  for (const entry of events) {
    const type = entry.event.type as string
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      if (oldest === undefined || entry.event.seq < oldest) oldest = entry.event.seq
    }
  }
  return oldest
}

export const SESSION_LIST_CACHE_MS = 1000
export const HISTORY_CACHE_MS = 500
export const RECENT_HISTORY_PREFETCH = 5
export const LIST_TITLE_WARM_CONCURRENCY = 2
export const LIST_TITLE_WARM_ALL_MAX = 40
export const LIST_TITLE_WARM_BACKGROUND_MAX = 24
export const SSE_RETRY_BASE_MS = 250
export const SSE_RETRY_MAX_ATTEMPTS = 3

export function historyCacheKey(sessionId: string, maxMessages?: number, beforeSeq?: number): string {
  return `${sessionId}:${maxMessages ?? 'tail'}:${beforeSeq ?? 'tail'}`
}

/** Read session.list through a short-lived cache (invalidated by mutations/SSE). */
export async function cachedSessionList(ctx: BridgeRouteContext): Promise<SessionSummary[]> {
  const cached = ctx.state.getSessionListCache(SESSION_LIST_CACHE_MS)
  if (cached !== undefined) {
    recordSessionSummaries(ctx, cached)
    ctx.state.markSessionStatusSeeded()
    return cached
  }
  const existing = ctx.state.sessionListLoading
  if (existing !== undefined) return existing
  const generation = ctx.state.listGeneration()
  ctx.state.sessionListRpcCalls++
  const promise = rpc<{ items: SessionSummary[] }>(ctx, 'session.list', {}).then((list) => list.items)
  ctx.state.sessionListLoading = promise
  try {
    const items = await promise
    // Only publish to the shared cache if no invalidation happened while the
    // scan was in flight; concurrent callers still get this same snapshot.
    if (ctx.state.listGeneration() === generation) {
      ctx.state.setSessionListCache(items)
    }
    recordSessionSummaries(ctx, items)
    ctx.state.markSessionStatusSeeded()
    return items
  } finally {
    if (ctx.state.sessionListLoading === promise) ctx.state.sessionListLoading = undefined
  }
}

/**
 * Seed the authoritative status map at most once when a status poll arrives
 * before the first session list. OpenCode polls `/session/status` every
 * 250ms while a turn is waiting; a failed seed must not turn that poll into a
 * full-corpus disk scan forever.
 */
export async function ensureSessionStatusSeed(ctx: BridgeRouteContext): Promise<void> {
  if (ctx.state.sessionStatusSeeded || ctx.state.sessionStatusSeedAttempted) {
    const loading = ctx.state.sessionStatusLoading
    if (loading !== undefined) await loading
    return
  }
  ctx.state.sessionStatusSeedAttempted = true
  ctx.state.sessionStatusSeeds++
  const loading = cachedSessionList(ctx).then(() => undefined).catch((error: unknown) => {
    ctx.log(`[bridge/status] initial status seed failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.state.sessionStatusLoading = loading
  try {
    await loading
  } finally {
    if (ctx.state.sessionStatusLoading === loading) ctx.state.sessionStatusLoading = undefined
  }
}

/** Build an in-memory OpenCode v1 status map without touching persistence. */
export function sessionStatusSnapshot(
  ctx: BridgeRouteContext,
  directory?: string,
): Record<string, SessionStatus> {
  const normalized = directory === undefined || directory.length === 0 ? undefined : resolve(ctx.cwd, directory)
  const ids = new Set([...ctx.state.sessionRunning.keys(), ...ctx.state.sessionDirectories.keys()])
  const status: Record<string, SessionStatus> = {}
  for (const id of ids) {
    const sessionDirectory = ctx.state.sessionDirectories.get(id) ?? ctx.cwd
    if (normalized !== undefined && resolve(ctx.cwd, sessionDirectory) !== normalized) continue
    const running = ctx.state.sessionRunningFor(id)
    if (running === undefined) continue
    status[id] = running ? { type: 'busy' } : { type: 'idle' }
  }
  return status
}

/** Read a history page through a short-lived per-page cache. */
export async function cachedSessionHistory(
  ctx: BridgeRouteContext,
  sessionId: string,
  options: { maxMessages?: number; beforeSeq?: number } = {},
): Promise<CachedHistory> {
  const key = historyCacheKey(sessionId, options.maxMessages, options.beforeSeq)
  const cached = ctx.state.getHistoryCache(key, HISTORY_CACHE_MS)
  if (cached !== undefined) return cached
  const existing = ctx.state.getHistoryLoading(key)
  if (existing !== undefined) return existing
  const generation = ctx.state.historyGeneration(key)
  const promise = rpc(ctx, 'session.history', {
    sessionId: sid(sessionId),
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
  }).then((history): CachedHistory => ({
    events: (history as { events: HistoryEntry[] }).events,
    hasMore: (history as { hasMore: boolean }).hasMore,
    ...((history as { projections?: SessionProjectionsBlock }).projections === undefined ? {} : { projections: (history as { projections: SessionProjectionsBlock }).projections }),
  }))
  ctx.state.setHistoryLoading(key, promise)
  try {
    const value = await promise
    if (ctx.state.historyGeneration(key) === generation) {
      ctx.state.setHistoryCache(key, value)
      const title = value.projections === undefined
        ? undefined
        : (value.projections.values as Partial<Record<string, unknown>>).title
      ctx.state.setSessionTitle(sessionId, title)
      seedDerivedHistoryPage(ctx, sessionId, value, options)
    }
    return value
  } finally {
    ctx.state.clearHistoryLoading(key, promise)
  }
}

/**
 * dsh's `session.list` rows carry no projections, so real titles only come
 * from each session's history tail. Warm the first few visible sessions
 * (bounded, parallel) so the list shows durable titles instead of directory
 * basenames; blank sessions have no title and are skipped.
 */
export async function warmListTitles(ctx: BridgeRouteContext, items: readonly SessionSummary[]): Promise<void> {
  const missing = items
    .filter((item) => !item.blank && ctx.state.sessionTitleFor(String(item.sessionId)) === undefined)
  if (missing.length === 0) return
  if (missing.length <= LIST_TITLE_WARM_ALL_MAX) {
    // Small homes get every title on the first list open.
    await warmTitles(ctx, missing)
    return
  }
  // Large homes must never block the list request on per-session history
  // reads; warm the most recent page in the background instead.
  void warmTitles(ctx, missing.slice(0, LIST_TITLE_WARM_BACKGROUND_MAX))
}

/** Read the title-bearing history tail for candidates with bounded concurrency. */
export async function warmTitles(ctx: BridgeRouteContext, candidates: readonly SessionSummary[]): Promise<void> {
  if (candidates.length === 0) return
  let next = 0
  const workers = Array.from({ length: Math.min(LIST_TITLE_WARM_CONCURRENCY, candidates.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= candidates.length) return
      const id = String(candidates[index]!.sessionId)
      try {
        await cachedSessionHistory(ctx, id, { maxMessages: 1 })
      } catch (error) {
        ctx.log(`[bridge/session-title] warm failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  await Promise.allSettled(workers)
}

/**
 * The TUI opens a session through `/session/:id` (full tail) and then fetches
 * `/session/:id/message` (default limit 100). Those are different cache keys,
 * so without seeding the second read would repeat the same dsh history RPC.
 * Seed the derived page when the loaded window provably covers it (and vice
 * versa when a 100-message page is the whole history).
 */
export function seedDerivedHistoryPage(
  ctx: BridgeRouteContext,
  sessionId: string,
  value: CachedHistory,
  options: { maxMessages?: number; beforeSeq?: number },
): void {
  if (options.beforeSeq !== undefined) return
  if (options.maxMessages === undefined && !value.hasMore) {
    const pageKey = historyCacheKey(sessionId, 100, undefined)
    if (ctx.state.getHistoryCache(pageKey, HISTORY_CACHE_MS) === undefined) {
      ctx.state.setHistoryCache(pageKey, {
        events: value.events,
        hasMore: false,
        ...(value.projections === undefined ? {} : { projections: value.projections }),
      })
    }
  } else if (options.maxMessages === 100 && !value.hasMore) {
    const tailKey = historyCacheKey(sessionId, undefined, undefined)
    if (ctx.state.getHistoryCache(tailKey, HISTORY_CACHE_MS) === undefined) {
      ctx.state.setHistoryCache(tailKey, value)
    }
  }
}

/** Pick a session for a directory query (or the most recent one). */
export async function sessionForDirectory(
  ctx: BridgeRouteContext,
  directory: string | undefined,
): Promise<SessionSummary | undefined> {
  const items = await cachedSessionList(ctx)
  if (directory !== undefined && directory.length > 0) {
    const normalized = resolve(ctx.cwd, directory)
    return items.find((item) => typeof item.cwd === 'string' && resolve(ctx.cwd, item.cwd) === normalized)
  }
  return items[0]
}

/** Resolve the dsh skill catalog for the session matching a directory query. */
export async function skillList(
  ctx: BridgeRouteContext,
  directory: string | undefined,
): Promise<Array<{ name: string; description: string; whenToUse?: string }>> {
  const session = await sessionForDirectory(ctx, directory)
  const skills: Array<{ name: string; description: string; whenToUse?: string }> = []
  if (session !== undefined) {
    try {
      const result = await rpc<{ skills: Array<{ name: string; description: string; whenToUse?: string }> }>(ctx, 'skill.list', { sessionId: sid(String(session.sessionId)) })
      skills.push(...result.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      })))
    } catch (error) {
      ctx.log(`[bridge] skill.list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  skills.push(...fakeSkillEntries())
  return skills
}

/** dsh skills exposed as opencode v1 slash commands. */
export async function skillCommandsV1(
  ctx: BridgeRouteContext,
  directory: string | undefined,
): Promise<V1Command[]> {
  return (await skillList(ctx, directory)).map((skill) => ({
    name: skill.name,
    description: skill.description,
    template: skill.name,
  }))
}

/** dsh skills exposed as opencode v2 slash commands. */
export async function skillCommandsV2(
  ctx: BridgeRouteContext,
  directory: string | undefined,
): Promise<CommandV2Info[]> {
  return (await skillList(ctx, directory)).map((skill) => ({
    name: skill.name,
    template: skill.name,
    description: skill.description,
  }))
}

/** Skill catalog for one specific session (used by the command route). */
export async function skillListForSession(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<Array<{ name: string; description: string }>> {
  const skills: Array<{ name: string; description: string }> = []
  try {
    const result = await rpc<{ skills: Array<{ name: string; description: string }> }>(ctx, 'skill.list', { sessionId: sid(sessionId) })
    skills.push(...result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    })))
  } catch (error) {
    ctx.log(`[bridge] skill.list failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
  skills.push(...fakeSkillEntries())
  return skills
}

/** Test-only fake skills injected via `DSH_OC_E2E_FAKE_SKILLS=name1,name2`. */
export function fakeSkillEntries(): Array<{ name: string; description: string; whenToUse?: string }> {
  const raw = process.env.DSH_OC_E2E_FAKE_SKILLS
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean).map((name) => ({
    name,
    description: `e2e fake skill ${name}`,
    whenToUse: `Use ${name} in e2e`,
  }))
}

export function toV1Session(view: SessionView, id: string, ctx: BridgeRouteContext): V2Session {
  if (view.summary) {
    return convertSessionSummary(view.summary, {
      cwd: view.cwd ?? ctx.cwd,
      createdAt: view.createdAt,
      ...(view.model === undefined ? {} : { model: view.model }),
      ...(ctx.state.sessionAgentFor(id) === undefined
        ? {}
        : { agent: ctx.state.sessionAgentFor(id) }),
    })
  }
  return minimalSession(id, {
    cwd: view.cwd ?? ctx.cwd,
    createdAt: view.createdAt,
    ...(view.model === undefined ? {} : { model: view.model }),
    ...(ctx.state.sessionAgentFor(id) === undefined
      ? {}
      : { agent: ctx.state.sessionAgentFor(id) }),
    ...(ctx.state.sessionParents.get(id) === undefined
      ? {}
      : { parentID: ctx.state.sessionParents.get(id) }),
    ...sessionLineageOptions(ctx, id),
  })
}

export function toV2Session(view: SessionView, id: string, ctx: BridgeRouteContext): SessionV2InfoWithMetadata {
  if (view.summary) {
    const lineage = sessionLineageOptions(ctx, id)
    return convertSessionSummaryV2(view.summary, {
      cwd: view.cwd ?? ctx.cwd,
      createdAt: view.createdAt,
      ...(view.model === undefined ? {} : { model: view.model }),
      ...(ctx.state.sessionAgentFor(id) === undefined
        ? {}
        : { agent: ctx.state.sessionAgentFor(id) }),
      ...(lineage.metadata === undefined ? {} : { metadata: lineage.metadata }),
    })
  }
  return minimalSessionV2(id, {
    cwd: view.cwd ?? ctx.cwd,
    createdAt: view.createdAt,
    ...(view.model === undefined ? {} : { model: view.model }),
    ...(ctx.state.sessionAgentFor(id) === undefined
      ? {}
      : { agent: ctx.state.sessionAgentFor(id) }),
    ...(ctx.state.sessionParents.get(id) === undefined
      ? {}
      : { parentID: ctx.state.sessionParents.get(id) }),
    ...sessionLineageOptions(ctx, id),
  })
}

export async function modelGroups(ctx: BridgeRouteContext) {
  const catalog = await rpc<{ groups: ModelProviderGroup[] }>(ctx, 'llm.models', {})
  return catalog.groups
}

interface PromptPartInput {
  type?: unknown
  text?: unknown
  url?: unknown
  mime?: unknown
  name?: unknown
  source?: { path?: unknown; type?: unknown }
}

export const TEXT_MIME_PREFIXES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-python',
])

export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.sh', '.py', '.rs',
  '.go', '.c', '.h', '.cpp', '.hpp', '.java', '.sql', '.css', '.html',
  '.xml', '.csv', '.log',
])

export function isTextMime(mime: string): boolean {
  const normalized = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  return normalized.startsWith('text/') || TEXT_MIME_PREFIXES.has(normalized)
}

export function isTextFile(path: string, mime: string): boolean {
  return isTextMime(mime) || TEXT_EXTENSIONS.has(extname(path).toLowerCase())
}

export function filePartToContent(part: PromptPartInput, cwd: string): PromptContentPart {
  const url = typeof part.url === 'string' ? part.url : ''
  const mime = typeof part.mime === 'string' ? part.mime : ''
  if (url.length === 0 || mime.length === 0) {
    throw badRequest('file part requires url and mime')
  }

  const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url)
  if (dataMatch) {
    const [, mediaType, data] = dataMatch
    if (!mediaType || !data) throw badRequest('invalid file data URL')
    if (mediaType.startsWith('image/')) {
      return { type: 'image', mediaType: mediaType as never, data }
    }
    if (isTextMime(mediaType)) {
      return { type: 'text', text: Buffer.from(data, 'base64').toString('utf8') }
    }
    throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`)
  }

  // Local file: file:// URL, absolute path, or cwd-relative path.
  let filePath: string
  if (url.startsWith('file://')) {
    try {
      filePath = fileURLToPath(url)
    } catch {
      throw badRequest(`invalid file part url: ${url}`)
    }
  } else {
    filePath = url
  }
  const resolved = resolve(cwd, filePath)
  const rel = relative(cwd, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw badRequest('file part path must be inside the session cwd')
  }
  let stat
  try {
    stat = statSync(resolved)
  } catch {
    throw badRequest(`file part path not readable: ${filePath}`)
  }
  if (!stat.isFile()) throw badRequest('file part path must be a file')

  const mediaType = mime.split(';')[0]?.trim() ?? ''
  if (mediaType.startsWith('image/')) {
    return { type: 'image', mediaType: mediaType as never, data: readFileSync(resolved).toString('base64') }
  }
  if (isTextFile(resolved, mediaType)) {
    return { type: 'text', text: readFileSync(resolved, 'utf8') }
  }
  throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`)
}

export function parsePromptParts(raw: unknown, cwd: string): PromptContentPart[] {
  if (!Array.isArray(raw)) throw badRequest('prompt body requires a parts array')
  const parts: PromptContentPart[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') throw badRequest('invalid prompt part')
    const part = entry as PromptPartInput
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw badRequest('text part requires a string text')
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'file') {
      parts.push(filePartToContent(part, cwd))
      continue
    }
    throw badRequest(`unsupported prompt part type "${String(part.type)}"`)
  }
  return parts
}

export function pendingAssistantPlaceholder(
  sessionID: string,
  cwd: string,
  text?: string,
  options: { id?: string; parentID?: string } = {},
): V1MessageEntry {
  const info: V1MessageEntry['info'] = {
    id: options.id ?? `pending:${randomUUID()}`,
    sessionID,
    role: 'assistant',
    time: { created: Date.now() },
    parentID: options.parentID ?? `pending:${randomUUID()}`,
    modelID: 'deepseek-chat',
    providerID: 'deepseek',
    mode: 'build',
    path: { cwd, root: cwd },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
  return {
    info,
    parts: text === undefined
      ? []
      : [{
          id: `pending:${randomUUID()}`,
          sessionID,
          messageID: info.id,
          type: 'text',
          text,
          time: { start: Date.now() },
        }],
  }
}

/** Count user messages still pending in the dsh inbox queue for a session. */
export function queuedPromptCount(ctx: BridgeRouteContext, sessionId: string): number {
  const projection = ctx.state.inboxProjections.get(sessionId)
  if (projection === undefined) return 0
  return [...projection.nextTurn, ...projection.nextStep]
    .filter((message) => message.source.kind === 'user')
    .length
}

/**
 * Append a queue-backlog hint to a slash command outcome so the user sees why
 * older prompts keep running after e.g. `/goal` completes.
 */
export function slashOutcomeText(ctx: BridgeRouteContext, sessionId: string, text: string): string {
  const pending = queuedPromptCount(ctx, sessionId)
  if (pending === 0) return text
  return `${text}\n\n[dsh-oc] 队列中还有 ${pending} 条消息待处理，将按原顺序继续执行`
}

/** The dsh-oc bridge exposes one primary agent so the TUI prompt stays usable. */
export const DEFAULT_AGENT_NAME = 'build'

export const PRESET_COMMAND_V1: V1Command = {
  name: 'preset',
  description: 'List or switch the session dsh agent preset',
  template: 'preset',
}

export const PRESET_COMMAND_V2: CommandV2Info = {
  name: 'preset',
  template: 'preset',
  description: 'List or switch the session dsh agent preset',
}

export const GOAL_COMMAND_V1: V1Command = {
  name: 'goal',
  description: 'Set or view the goal for a long-running task',
  template: 'goal',
}

export const GOAL_COMMAND_V2: CommandV2Info = {
  name: 'goal',
  template: 'goal',
  description: 'Set or view the goal for a long-running task',
}

export const HELP_COMMAND_V1: V1Command = {
  name: 'help',
  description: 'Show the dsh-oc capability summary and documentation entry points',
  template: 'help',
}

export const HELP_COMMAND_V2: CommandV2Info = {
  name: 'help',
  template: 'help',
  description: 'Show the dsh-oc capability summary and documentation entry points',
}

export async function defaultAgents(ctx: BridgeRouteContext): Promise<{
  providerID: string
  modelID: string
}> {
  try {
    const catalog = await rpc<{
      default: { provider: string; model: string }
      groups: ModelProviderGroup[]
    }>(ctx, 'llm.models', {})
    // dsh 0.1.2's catalog.default is the resolved deployment choice. The
    // first provider/model is merely catalog ordering and may be different
    // from the model used by a fresh Session.
    if (typeof catalog.default?.provider === 'string' && typeof catalog.default.model === 'string') {
      return {
        providerID: externalProviderId(catalog.default.provider),
        modelID: catalog.default.model,
      }
    }
    const first = catalog.groups[0]
    const firstModel = first?.models[0]
    if (first !== undefined && firstModel !== undefined) {
      return { providerID: externalProviderId(first.id), modelID: firstModel.id }
    }
  } catch (error) {
    ctx.log(`[bridge] default agent model fallback: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { providerID: 'deepseek', modelID: 'deepseek-chat' }
}

export async function defaultModelRef(ctx: BridgeRouteContext): Promise<{ providerID: string; modelID: string }> {
  return defaultAgents(ctx)
}

export interface SessionModelSelectionRef {
  providerID: string
  modelID: string
  variant?: string
}

/**
 * Resolve the model currently attached to one dsh session.  The bridge-level
 * default is only a last-resort fallback: a blank session may already have a
 * model selected by the TUI, and a preset command must show that selection in
 * its synthetic cards.  Keep a cached explicit variant when the host's read
 * does not return one but still reports the same provider/model; this avoids
 * making a preset switch look like it silently changed reasoning effort.
 */
export async function sessionModelSelectionRef(
  ctx: BridgeRouteContext,
  sessionId: string,
  fallback?: SessionModelSelectionRef,
): Promise<SessionModelSelectionRef> {
  const cached = ctx.state.sessionModelSelectionFor(sessionId)
  try {
    const selection = await rpc<{
      current: { provider: string; model: string; reasoningEffort?: string }
    }>(ctx, 'session.models', { sessionId: sid(sessionId) })
    const providerID = externalProviderId(selection.current.provider)
    const variant = selection.current.reasoningEffort
    let resolved: SessionModelSelectionRef
    if (variant !== undefined) {
      resolved = { providerID, modelID: selection.current.model, variant }
    } else if (cached !== undefined
      && cached.providerID === providerID
      && cached.modelID === selection.current.model
      && cached.variant !== undefined) {
      resolved = { ...cached }
    } else {
      resolved = { providerID, modelID: selection.current.model }
    }
    // A successful host read is authoritative for subsequent synthetic
    // command cards. Keep the variant when the host omits it but the same
    // explicit provider/model is already cached (dsh can temporarily omit
    // reasoningEffort during preset/model transitions).
    ctx.state.setSessionModelSelection(sessionId, resolved)
    return resolved
  } catch (error) {
    ctx.log(`[bridge] session model selection unavailable for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    if (cached !== undefined) return { ...cached }
    if (fallback !== undefined) return { ...fallback }
    return defaultAgents(ctx)
  }
}

/**
 * The opencode-facing model ref a session is actually running. The TUI
 * restores its prompt model from the last user message when the session
 * changes, so user cards and history must name the session's real selection
 * (e.g. deepseek-v4-pro), not the first catalog model (deepseek-v4-flash) —
 * stamping the catalog default made the next prompt silently revert to flash.
 */
export async function sessionModelRef(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<SessionModelSelectionRef> {
  return sessionModelSelectionRef(ctx, sessionId)
}

/**
 * Resolve the model ref for an optimistic prompt card after model selection
 * has been applied. The selectModel response is authoritative for a prompt
 * whose variant was omitted (OpenCode's Default), while explicit max/off is
 * copied directly from the official top-level field.
 */
export function promptModelRef(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: unknown,
): { providerID: string; modelID: string; variant?: string } | undefined {
  const input = modelInputFromBody(body)
  const cached = ctx.state.sessionModelSelectionFor(sessionId)
  if (input === undefined) return cached === undefined ? undefined : { ...cached }
  if (input.variantSpecified) {
    return {
      providerID: input.providerID,
      modelID: input.modelID,
      variant: input.variant,
    }
  }
  if (cached !== undefined
    && cached.providerID === input.providerID
    && cached.modelID === input.modelID) return { ...cached }
  return { providerID: input.providerID, modelID: input.modelID }
}

/**
 * The agent list the TUI cycles with Tab and shows on a fresh prompt. The
 * first entry is the TUI's default selection, so it must be the deployment's
 * configured default preset — not the hardcoded "build" placeholder — or a
 * fresh session claims a preset the harness never runs.
 */
export async function v1AgentList(ctx: BridgeRouteContext): Promise<V2Agent[]> {
  const { providerID, modelID } = await defaultAgents(ctx)
  const presets = await presetRoster(ctx)
  const defaultId = await defaultPresetId(ctx)
  const defaultName = defaultId ?? DEFAULT_AGENT_NAME
  return [
    {
      name: defaultName,
      description: defaultName === DEFAULT_AGENT_NAME
        ? 'dsh-oc default build agent'
        : 'dsh-oc default agent (dsh default preset)',
      mode: 'primary',
      permission: [],
      options: {},
      model: { providerID, modelID },
    },
    ...presets
      .filter((preset) => preset.id !== DEFAULT_AGENT_NAME && preset.id !== defaultId)
      .map((preset) => ({
        name: preset.id,
        description: preset.name ?? preset.description,
        mode: 'primary' as const,
        permission: [],
        options: {},
      })),
  ]
}

export async function v2AgentList(ctx: BridgeRouteContext): Promise<AgentV2Info[]> {
  const { providerID, modelID } = await defaultAgents(ctx)
  const presets = await presetRoster(ctx)
  const defaultId = await defaultPresetId(ctx)
  const defaultName = defaultId ?? DEFAULT_AGENT_NAME
  return [
    {
      id: defaultName,
      mode: 'primary',
      hidden: false,
      request: { headers: {}, body: {} },
      permissions: [],
      model: { id: modelID, providerID },
      description: defaultName === DEFAULT_AGENT_NAME
        ? 'dsh-oc default build agent'
        : 'dsh-oc default agent (dsh default preset)',
    },
    ...presets
      .filter((preset) => preset.id !== DEFAULT_AGENT_NAME && preset.id !== defaultId)
      .map((preset) => ({
        id: preset.id,
        description: preset.name ?? preset.description,
        mode: 'primary' as const,
        hidden: false,
        request: { headers: {}, body: {} },
        permissions: [],
      })),
  ]
}

export async function presetRoster(ctx: BridgeRouteContext) {
  const roster = await rpc<Array<{ broken?: string; id: string; name?: string; description?: string }>>(ctx, 'agentPreset.list', {})
  return roster.filter((preset) => preset.broken === undefined)
}

export async function defaultPresetId(ctx: BridgeRouteContext): Promise<string | undefined> {
  try {
    return ctx.api.agentPresets.defaultId
  } catch (error) {
    ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function presetIdForAgent(
  ctx: BridgeRouteContext,
  agentName: string,
): Promise<string | undefined> {
  if (agentName === DEFAULT_AGENT_NAME) return defaultPresetId(ctx)
  try {
    const presets = await presetRoster(ctx)
    return presets.find((preset) => preset.id === agentName)?.id
  } catch (error) {
    ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function switchAgentPreset(
  ctx: BridgeRouteContext,
  sessionId: string,
  agentName: string,
): Promise<string> {
  const presetId = await presetIdForAgent(ctx, agentName)
  if (presetId === undefined) {
    if (agentName === DEFAULT_AGENT_NAME) return agentName
    throw badRequest(`agent "${agentName}" is not a switchable dsh preset`)
  }
  const selected = await rpc<unknown>(ctx, 'agentPreset.select', {
    sessionId: sid(sessionId),
    agentPreset: presetId,
  })
  const resolved = typeof selected === 'string' && selected.length > 0 ? selected : presetId
  ctx.state.lastAgentPreset = resolved
  return resolved
}

/** All text parts of a prompt body, joined the way the TUI renders them. */
export function textFromPromptParts(content: readonly PromptContentPart[]): string {
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

interface SlashPromptCapture {
  name: 'preset' | 'goal' | 'help'
  argument: string
}

/**
 * A slash command typed with a trailing space (or after dismissing the slash
 * popup) reaches the prompt routes as a plain prompt. Commands handled by the
 * bridge are captured here so they never trigger a model turn.
 */
export function slashPromptCapture(content: readonly PromptContentPart[]): SlashPromptCapture | undefined {
  const text = textFromPromptParts(content).trim()
  if (/^\/preset(?:\s|$)/.test(text)) {
    return { name: 'preset', argument: text.slice('/preset'.length).trim() }
  }
  if (/^\/goal(?:\s|$)/.test(text)) {
    return { name: 'goal', argument: text.slice('/goal'.length).trim() }
  }
  if (/^\/help(?:\s|$)/.test(text)) {
    return { name: 'help', argument: text.slice('/help'.length).trim() }
  }
  return undefined
}

interface PresetCommandOutcome {
  kind: 'success' | 'error'
  text: string
  targetAgent?: string
}

export async function presetCommandOutcome(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<PresetCommandOutcome> {
  try {
    if (argument === '') {
      const roster = await presetRoster(ctx)
      const defaultId = await defaultPresetId(ctx)
      const text = roster.length === 0
        ? 'No switchable dsh agent presets'
        : roster.map((preset) => `${preset.id}${preset.id === defaultId ? ' (default)' : ''}`).join('\n')
      return { kind: 'success', text }
    }
    const targetAgent = await switchAgentPreset(ctx, sessionId, argument)
    return { kind: 'success', text: `Switched dsh agent preset to ${argument}`, targetAgent }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Broadcast one synthetic command-result message (with optional status). */
export function broadcastCommandResult(
  ctx: BridgeRouteContext,
  sessionId: string,
  text: string,
  status?: 'busy' | 'idle',
  model?: { providerID: string; modelID: string; variant?: string },
): void {
  const { events, entry } = commandResultMessage(
    { cwd: ctx.cwd, state: ctx.state, log: ctx.log },
    sessionId,
    text,
    {
      ...(status === undefined ? {} : { status }),
      ...(model === undefined ? {} : { model }),
    },
  )
  ctx.hub.broadcast(events)
  if (status !== 'busy') ctx.state.recordCommandResult(sessionId, entry)
}

/** Push a `session.updated` carrying the new agent so the TUI label refreshes. */
export function broadcastSessionAgent(
  ctx: BridgeRouteContext,
  sessionId: string,
  agent: string,
): void {
  ctx.state.setSessionAgent(sessionId, agent)
  const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd
  const project = projectIdFor(directory)
  ctx.hub.broadcast([
    makeEvent(directory, 'session.updated', {
      sessionID: sessionId,
      info: minimalSession(sessionId, {
        cwd: directory,
        title: ctx.state.sessionTitleFor(sessionId),
        agent,
        ...sessionLineageOptions(ctx, sessionId),
      }),
    }, project),
  ])
}

/** Persist an ephemeral `/preset` switch card so a fresh TUI sync keeps it. */
export async function broadcastPresetSwitchEcho(
  ctx: BridgeRouteContext,
  sessionId: string,
  agent: string,
  model?: { providerID: string; modelID: string; variant?: string },
): Promise<void> {
  const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd
  const project = projectIdFor(directory)
  const id = `msg_preset:${randomUUID()}`
  const partId = `prt_preset:${randomUUID()}`
  const created = Date.now()
  const resolvedModel = model ?? await sessionModelSelectionRef(ctx, sessionId)
  const info = {
    id,
    sessionID: sessionId,
    role: 'user' as const,
    agent,
    model: resolvedModel,
    time: { created },
  }
  const part = {
    id: partId,
    sessionID: sessionId,
    messageID: id,
    type: 'text' as const,
    text: `preset switched to ${agent}`,
    time: { start: created, end: created },
  }
  ctx.hub.broadcast([
    makeEvent(directory, 'message.updated', { sessionID: sessionId, info }, project),
    makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part }, project),
  ])
  ctx.state.recordCommandResult(sessionId, {
    info: info as never,
    parts: [part as never],
  })
}

/** Echo a submitted user prompt immediately (the official TUI's QUEUED card). */
export async function broadcastPromptUserMessage(
  ctx: BridgeRouteContext,
  sessionId: string,
  userId: string,
  text: string,
  created: number,
  model?: { providerID: string; modelID: string; variant?: string },
): Promise<void> {
  const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd
  const project = projectIdFor(directory)
  const resolved = model ?? await sessionModelRef(ctx, sessionId)
  const events = [
    makeEvent(directory, 'message.updated', {
      sessionID: sessionId,
      info: {
        id: userId,
        sessionID: sessionId,
        role: 'user',
        time: { created },
        agent: ctx.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT,
        model: resolved,
      },
    }, project),
    makeEvent(directory, 'message.part.updated', {
      sessionID: sessionId,
      part: {
        id: `${userId}:0`,
        sessionID: sessionId,
        messageID: userId,
        type: 'text',
        text,
        time: { start: created, end: created },
      },
    }, project),
  ]
  // The POST can win the race with the TUI's first global SSE connection.
  // Keep the optimistic card pending until that first client subscribes;
  // otherwise the durable user row is intentionally suppressed later as a
  // duplicate and the first prompt vanishes from a cold attach.  The helper
  // still remembers the batch in the Last-Event-ID ring exactly once.
  ctx.hub.broadcastAndBufferIfIdle(events)
}

/** Run a `/preset` list/switch with visible TUI progress and result. */
export async function runPresetCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<PresetCommandOutcome> {
  let model = await sessionModelSelectionRef(ctx, sessionId)
  broadcastCommandResult(ctx, sessionId, 'Running /preset…', 'busy', model)
  const previousAgent = ctx.state.sessionAgentFor(sessionId) ?? ctx.state.lastAgentPreset ?? DEFAULT_AGENT_NAME
  const outcome = await presetCommandOutcome(ctx, sessionId, argument)
  if (outcome.kind === 'success' && argument.trim() !== '') {
    // A host may derive the model from the newly selected preset. Re-read
    // after the selection so both the user echo and the completed command
    // card describe the model that is active for the next turn.
    model = await sessionModelSelectionRef(ctx, sessionId, model)
    const targetAgent = outcome.targetAgent ?? argument.trim()
    broadcastSessionAgent(ctx, sessionId, targetAgent)
    ctx.state.markStalePresetPrompt(sessionId, previousAgent, targetAgent)
    await broadcastPresetSwitchEcho(ctx, sessionId, targetAgent, model)
  }
  ctx.state.invalidateSession(sessionId)
  broadcastCommandResult(ctx, sessionId, outcome.text, 'idle', model)
  return outcome
}

interface RegistryCommandOutcome {
  kind: 'success' | 'error'
  text: string
}

/**
 * Run one dsh registered command (`/goal`, ...) through the live session
 * agent with visible busy/idle progress in the TUI. Infra failures (missing
 * agent/registry/command) throw; a command-level error becomes an outcome
 * the caller can turn into a 400.
 */
export async function runRegistryCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  commandLine: string,
  label: string,
): Promise<RegistryCommandOutcome> {
  broadcastCommandResult(ctx, sessionId, `Running ${label}…`, 'busy')
  const agent = ctx.api.agents?.get(sessionId)
  if (agent === undefined) {
    const text = `${label} unavailable: session is not attached`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw conflict(text, { sessionId })
  }
  if (!ctx.api.commands) {
    const text = `${label} unavailable: dsh command registry is missing`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw internalError(text, { sessionId })
  }
  let execution: BridgeCommandExecution | undefined
  try {
    execution = await ctx.api.commands.execute(agent, commandLine, [], new AbortController().signal)
  } catch (error) {
    const text = `${label} failed: ${error instanceof Error ? error.message : String(error)}`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw internalError(text, { sessionId })
  }
  ctx.state.invalidateSession(sessionId)
  if (execution === undefined) {
    const text = `${label} failed: unknown command ${commandLine.split(/\s+/)[0] ?? commandLine}`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw badRequest(text, { code: 'unknown-command', sessionId })
  }
  if (execution.result.kind === 'error') {
    const text = execution.result.text ?? `${label} failed`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    return { kind: 'error', text }
  }
  const text = execution.result.text ?? `${label} completed`
  broadcastCommandResult(ctx, sessionId, text, 'idle')
  ctx.log(`[bridge] ${commandLine}: ${text}`)
  return { kind: 'success', text }
}

/** Run `/goal` with an optional argument through the dsh command registry. */
export async function runGoalCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<RegistryCommandOutcome> {
  const trimmed = argument.trim()
  if (trimmed === 'complete') {
    return completeGoalCommand(ctx, sessionId)
  }
  const commandLine = trimmed === '' ? '/goal' : `/goal ${trimmed}`
  const outcome = await runRegistryCommand(ctx, sessionId, commandLine, '/goal')
  if (outcome.kind === 'success' && outcome.text.includes('Commands:')) {
    return { kind: 'success', text: `${outcome.text}, /goal complete` }
  }
  return outcome
}

/**
 * dsh's `/goal` command registry has no `complete` verb (completion is
 * normally automatic), so the bridge implements it directly through the
 * `goal.complete` RPC with the current projection ref.
 */
export async function completeGoalCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<RegistryCommandOutcome> {
  broadcastCommandResult(ctx, sessionId, 'Running /goal complete…', 'busy')
  try {
    const history = await cachedSessionHistory(ctx, sessionId)
    const current = goalFromHistory(history) as { goal?: { id: string; revision: number } } | null | undefined
    const ref = current?.goal
    if (current === undefined || ref === undefined) {
      const text = current === null
        ? 'No goal to complete.'
        : 'Goal state unavailable; run /goal to view the current goal.'
      broadcastCommandResult(ctx, sessionId, text, 'idle')
      return { kind: 'error', text }
    }
    await rpc(ctx, 'goal.complete', {
      sessionId: sid(sessionId),
      ref: { id: ref.id as never, revision: ref.revision },
    })
    ctx.state.invalidateSession(sessionId)
    const text = 'Goal completed'
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    return { kind: 'success', text }
  } catch (error) {
    const text = `/goal complete failed: ${error instanceof Error ? error.message : String(error)}`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    return { kind: 'error', text }
  }
}

/** Run `/help`: broadcast the shared capability summary without a model turn. */
export function runHelpCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  _argument: string,
): PresetCommandOutcome {
  const text = ocHelp()
  broadcastCommandResult(ctx, sessionId, text)
  return { kind: 'success', text }
}

/** Dispatch a captured slash command to its bridge-side implementation. */
export async function runSlashCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  slash: SlashPromptCapture,
): Promise<PresetCommandOutcome | RegistryCommandOutcome> {
  let outcome: PresetCommandOutcome | RegistryCommandOutcome
  if (slash.name === 'preset') outcome = await runPresetCommand(ctx, sessionId, slash.argument)
  else if (slash.name === 'goal') outcome = await runGoalCommand(ctx, sessionId, slash.argument)
  else if (slash.name === 'help') outcome = runHelpCommand(ctx, sessionId, slash.argument)
  else throw badRequest(`unsupported command /${slash.name}`)
  if (outcome.kind === 'success') {
    outcome = { ...outcome, text: slashOutcomeText(ctx, sessionId, outcome.text) }
  }
  return outcome
}

interface ModelInput {
  providerID: string
  modelID: string
  variant?: string
  /** Whether the prompt/model body explicitly carried a variant string. */
  variantSpecified: boolean
}

export function modelInputFromBody(body: unknown): ModelInput | undefined {
  const record = bodyAsRecord(body)
  const raw = record.model !== undefined && bodyAsRecord(record.model) ? record.model : body
  const input = bodyAsRecord(raw)
  const providerID = typeof input.providerID === 'string' ? input.providerID : undefined
  const modelID = typeof input.modelID === 'string'
    ? input.modelID
    : typeof input.id === 'string'
      ? input.id
      : undefined
  if (providerID === undefined || modelID === undefined) return undefined
  // OpenCode 1.18.18's prompt payload puts `variant` at the top level while
  // the nested `model` only carries provider/model.  Accept the nested form
  // used by the model endpoint as a fallback, but never let its absence mask
  // an explicit top-level `off`/`max`.
  const rawVariant = typeof record.variant === 'string' ? record.variant : input.variant
  const variantSpecified = typeof rawVariant === 'string' && rawVariant !== 'default'
  return {
    providerID,
    modelID,
    ...(typeof rawVariant === 'string' && rawVariant !== 'default' ? { variant: rawVariant } : {}),
    variantSpecified,
  }
}

export async function applyModelSelection(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: unknown,
): Promise<boolean> {
  const input = modelInputFromBody(body)
  if (input === undefined) return false

  const selected = await rpc<{
    selected?: { provider?: string; model?: string; reasoningEffort?: string }
  }>(ctx, 'session.selectModel', {
    sessionId: sid(sessionId),
    provider: dshProviderId(input.providerID),
    model: input.modelID,
    ...(input.variant === undefined ? {} : { reasoningEffort: input.variant }),
  })
  const resolved = selected.selected
  const providerID = typeof resolved?.provider === 'string'
    ? externalProviderId(resolved.provider)
    : input.providerID
  const modelID = typeof resolved?.model === 'string' ? resolved.model : input.modelID
  const reasoningEffort = typeof resolved?.reasoningEffort === 'string'
    ? resolved.reasoningEffort
    : input.variantSpecified
      ? input.variant
      : undefined
  ctx.state.setSessionModelSelection(sessionId, {
    providerID,
    modelID,
    ...(reasoningEffort === undefined ? {} : { variant: reasoningEffort }),
  })
  return true
}

/**
 * Self-heal an explicit variant selection: dsh can lose the reasoning effort
 * after some operations (model re-selection, preset switches). Before the next
 * prompt we compare the cached explicit selection with `session.models` and
 * re-apply it when the variant went missing.
 */
export async function reconcileModelSelection(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<void> {
  const cached = ctx.state.sessionModelSelectionFor(sessionId)
  if (cached === undefined || cached.variant === undefined) return
  let current
  try {
    current = await rpc<{ current: { reasoningEffort?: string; provider: string; model: string } }>(ctx, 'session.models', { sessionId: sid(sessionId) })
  } catch (error) {
    ctx.log(`[bridge] model selection check failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const currentVariant = current.current.reasoningEffort
  if (
    current.current.provider === dshProviderId(cached.providerID)
    && current.current.model === cached.modelID
    && currentVariant === cached.variant
  ) {
    return
  }
  try {
    await rpc(ctx, 'session.selectModel', {
      sessionId: sid(sessionId),
      provider: dshProviderId(cached.providerID),
      model: cached.modelID,
      reasoningEffort: cached.variant,
    })
    ctx.log(`[bridge] restored variant ${cached.variant} for session ${sessionId}`)
  } catch (error) {
    ctx.log(`[bridge] variant restore failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Apply the agent carried in a prompt body (Tab/agent picker selection). */
export async function applyAgentFromBody(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: unknown,
): Promise<void> {
  const record = bodyAsRecord(body)
  const agent = typeof record.agent === 'string' && record.agent.length > 0 ? record.agent : undefined
  if (agent === undefined) {
    ctx.state.consumeStalePresetPrompt(sessionId, undefined)
    return
  }
  // `/preset` updates the active Session immediately, while the official TUI
  // may submit one prompt carrying the editor's previous agent value. Consume
  // only that exact one stale value; a later Tab selection is handled normally.
  if (ctx.state.consumeStalePresetPrompt(sessionId, agent)) return
  // A session's preset is fixed at creation: dsh rejects ANY
  // agentPreset.select on a session that already produced turns, even when
  // re-selecting the preset it already runs. Presets adopted while the
  // session was still blank (Tab /preset) or out-of-band by a routing
  // plugin are already effective; re-applying them on every later prompt
  // only produced a spurious "Agent switch locked" warning. Treat the
  // already-effective preset as a no-op so the TUI keeps its label without
  // the lock noise.
  if (ctx.state.sessionAgentFor(sessionId) === agent) return
  if (agent === DEFAULT_AGENT_NAME) return
  try {
    const selected = await switchAgentPreset(ctx, sessionId, agent)
    broadcastSessionAgent(ctx, sessionId, selected)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`[bridge] prompt agent switch failed for ${sessionId}: ${message}`)
    const errorBody = (error as { body?: { data?: Record<string, unknown> } }).body
    const code = typeof errorBody?.data?.code === 'string'
      ? (errorBody.data.code as string)
      : ''
    if (code === 'agent-preset/locked' && !ctx.state.lockedAgentNoticeSeen(sessionId, agent)) {
      ctx.state.markLockedAgentNotice(sessionId, agent)
      broadcastCommandResult(
        ctx,
        sessionId,
        `Agent switch locked: 该会话已产生回复，agent preset 已固定；请新建会话后切换（Tab 或 /preset ${agent}）`,
        'idle',
      )
    }
  }
}

/**
 * dsh `session.fork` anchors on a completed-turn boundary by event seq.
 * opencode's fork payload names a message id, so translate it to the seq of
 * that message's user/assistant event (dsh documents message-fork buttons as
 * passing the message seq; the boundary then closes at the following
 * turn/end, which includes the whole turn).
 */
export async function atSeqForMessage(
  ctx: BridgeRouteContext,
  sessionId: string,
  messageId: string,
): Promise<number> {
  // Message lists expose bridge ids for prompts echoed by the route; resolve
  // them back to the durable dsh id before scanning history.
  const resolved = ctx.state.dshIdForPromptId(sessionId, messageId)
    ?? ctx.state.dshIdForAssistantId(sessionId, messageId)
    ?? messageId
  const history = await cachedSessionHistory(ctx, sessionId)
  for (const entry of history.events) {
    const event = entry.event
    const candidate = event.type === 'user/message'
      ? String(event.data.id)
      : event.type === 'assistant/message'
        ? String(event.data.message.id)
        : undefined
    if (candidate === resolved) return event.seq
  }
  throw badRequest('message not found for fork', { sessionId, messageId, resolved })
}

export async function forkSession(
  req: BridgeRequest,
  ctx: BridgeRouteContext,
  v2: boolean,
): Promise<HandlerResult> {
  const id = req.params.id ?? req.params.sessionID ?? ''
  const body = bodyAsRecord(req.body)
  const messageId = typeof body.messageID === 'string' ? body.messageID : undefined
  const atSeq = messageId === undefined ? undefined : await atSeqForMessage(ctx, id, messageId)
  const childId = await forkFromSource(ctx, id, atSeq)
  ctx.state.setCurrentSession(childId)
  const view = await sessionView(ctx, childId)
  return json(200, v2
    ? { data: toV2Session(view, childId, ctx) }
    : toV1Session(view, childId, ctx))
}

/**
 * dsh forks are independent conversations, not subagent children. Derive a
 * user-visible `(fork #N)` title from the source session and the number of
 * existing non-subagent forks before calling `session.rename`.
 */
export function forkChainBase(title: string): string {
  let base = title
  for (;;) {
    const match = /^(.*?)\s+\(fork #\d+\)$/.exec(base)
    if (!match?.[1]) return base
    base = match[1]
  }
}

export function forkNumberInTitle(title: string): number {
  let max = 0
  for (const match of title.matchAll(/\(fork #(\d+)\)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max
}

export async function forkTitleForSource(
  ctx: BridgeRouteContext,
  sourceId: string,
): Promise<string> {
  const list = await cachedSessionList(ctx)
  const source = list.find((item) => String(item.sessionId) === sourceId)
  const sourceTitle = source === undefined ? 'Session' : sessionTitleFrom(source) || 'Session'
  const base = forkChainBase(sourceTitle)
  const sourceForkNumber = forkNumberInTitle(sourceTitle)
  if (sourceForkNumber > 0) {
    return `${base} (fork #${sourceForkNumber + 1})`
  }
  const existingForks = list.filter(
    (item) =>
      String(item.sessionId) !== sourceId
      && String(item.parentSessionId) === sourceId
      && item.origin !== 'subagent',
  )
  return `${base} (fork #${existingForks.length + 1})`
}

export async function forkFromSource(
  ctx: BridgeRouteContext,
  sourceId: string,
  atSeq?: number,
): Promise<string> {
  const title = await forkTitleForSource(ctx, sourceId)
  const result = await rpc<{ sessionId: string }>(ctx, 'session.fork', {
    sessionId: sid(sourceId),
    ...(atSeq === undefined ? {} : { atSeq }),
  })
  const childId = String(result.sessionId)
  try {
    await rpc(ctx, 'session.rename', { sessionId: sid(childId), title })
  } catch (error) {
    ctx.log(`[bridge] rename of forked session ${childId} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.state.invalidateSession()
  return childId
}

/**
 * Run dsh's registered `/compact` command directly through the command
 * registry. The opencode TUI's slash command is `session.summarize`, which
 * posts `/session/{id}/summarize`; dsh owns the model-backed compaction
 * inside command-compact, so we address the live session agent here rather
 * than sending a slash prompt to the model. Every outcome is broadcast as a
 * synthetic assistant message plus busy/idle status so the TUI visibly moves
 * while the command runs, even when the mock LLM cannot produce a summary.
 */
export async function runCompactCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<void> {
  broadcastCommandResult(ctx, sessionId, 'Running /compact…', 'busy')
  const agent = ctx.api.agents?.get(sessionId)
  if (agent === undefined) {
    broadcastCommandResult(ctx, sessionId, 'Compaction unavailable: session is not attached', 'idle')
    throw conflict('session is not attached; cannot compact', { sessionId })
  }
  if (!ctx.api.commands) {
    broadcastCommandResult(ctx, sessionId, 'Compaction unavailable: dsh command registry is missing', 'idle')
    throw internalError('dsh command registry is unavailable; cannot compact', { sessionId })
  }
  let execution: BridgeCommandExecution | undefined
  try {
    execution = await ctx.api.commands.execute(agent, '/compact', [], new AbortController().signal)
  } catch (error) {
    const text = `Compaction failed: ${error instanceof Error ? error.message : String(error)}`
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw internalError(text, { sessionId })
  }
  if (execution === undefined) {
    broadcastCommandResult(ctx, sessionId, 'Compaction failed: unknown command /compact', 'idle')
    throw badRequest('unknown command /compact', { code: 'unknown-command', sessionId })
  }
  if (execution.result.kind === 'error') {
    const text = execution.result.text ?? 'Compaction failed'
    broadcastCommandResult(ctx, sessionId, text, 'idle')
    throw badRequest(text, {
      code: 'command-error',
      sessionId,
    })
  }
  const text = execution.result.text ?? 'Compaction completed'
  ctx.state.invalidateSession(sessionId)
  broadcastCommandResult(ctx, sessionId, text, 'idle')
  ctx.log(`[bridge] /compact: ${text}`)
}

export async function createSession(
  req: BridgeRequest,
  ctx: BridgeRouteContext,
  v2: boolean,
): Promise<HandlerResult> {
  const body = bodyAsRecord(req.body)
  const parentID = typeof body.parentID === 'string' ? body.parentID : undefined
  const sessionIdInput = typeof body.id === 'string' ? body.id : undefined
  const title = typeof body.title === 'string' ? body.title : undefined
  const agentName = typeof body.agent === 'string' ? body.agent : undefined
  // A new session inherits the last preset selected in this run so the
  // `/preset X` → `/new` flow keeps the chosen agent (and its tool set).
  const inheritedAgent = agentName ?? ctx.state.lastAgentPreset
  const agentPreset = inheritedAgent === undefined
    ? undefined
    : await presetIdForAgent(ctx, inheritedAgent)
  let id: string
  if (parentID) {
    id = await forkFromSource(ctx, parentID)
  } else {
    const location = body.location as { directory?: unknown } | undefined
    const queryDirectory = req.query.get('directory')
    const directory = typeof location?.directory === 'string'
      ? location.directory
      : queryDirectory ?? ctx.cwd
    const result = await rpc<{ sessionId: string }>(ctx, 'session.create', {
      cwd: directory,
      ...(sessionIdInput === undefined ? {} : { sessionId: sid(sessionIdInput) }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    id = String(result.sessionId)
    if (title) {
      try {
        await rpc(ctx, 'session.rename', { sessionId: sid(id), title })
      } catch (error) {
        ctx.log(`[bridge] rename of new session ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (body.model !== undefined) {
    await applyModelSelection(ctx, id, body)
  }
  if (agentName !== undefined) {
    ctx.state.lastAgentPreset = agentName
  }
  // The new session runs the resolved preset (a Tab-selected name, or the
  // deployment default when the TUI carried "build"); record it immediately
  // so the first reply is labeled with the preset the model actually ran.
  if (agentPreset !== undefined) {
    ctx.state.setSessionAgent(id, agentPreset)
  } else if (agentName !== undefined) {
    ctx.state.setSessionAgent(id, agentName)
  }
  ctx.state.setCurrentSession(id)
  ctx.state.invalidateSession()
  const view = await sessionView(ctx, id)
  return json(200, v2 ? { data: toV2Session(view, id, ctx) } : toV1Session(view, id, ctx))
}

/**
 * Translate one dsh `host/session-added` frame into the opencode
 * `session.updated` the TUI needs to learn about a session born mid-run.
 *
 * Subagent children are spawned inside dsh while the TUI's session list is
 * already loaded; without a live push the child never reaches
 * `sync.data.session`, so the TUI subagent panel (Ctrl+x ↓) stays empty.
 * The frame carries the full lineage fields, so the push also seeds the
 * bridge state (parent map, directory, agent) for later event translation.
 */
export function hostSessionAddedEvents(
  ctx: BridgeRouteContext,
  payload: {
    sessionId?: unknown
    blank?: unknown
    parentSessionId?: unknown
    origin?: unknown
    cwd?: unknown
    agentPreset?: unknown
    projections?: SessionSummary['projections']
  },
): BridgeGlobalEvent[] {
  const sessionId = String(payload.sessionId ?? '')
  if (sessionId === '') return []
  const summary: SessionSummary = {
    sessionId: sessionId as never,
    updatedAt: Date.now(),
    running: false,
    blank: payload.blank !== false,
    ...(payload.parentSessionId === undefined ? {} : { parentSessionId: String(payload.parentSessionId) as never }),
    ...(payload.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(payload.cwd === undefined ? {} : { cwd: String(payload.cwd) }),
    ...(payload.agentPreset === undefined ? {} : { agentPreset: String(payload.agentPreset) }),
    ...(payload.projections === undefined ? {} : { projections: payload.projections }),
  }
  recordSessionSummaries(ctx, [summary], true)
  const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd
  const project = projectIdFor(directory)
  const parentID = ctx.state.sessionParents.get(sessionId)
  const agent = ctx.state.sessionAgentFor(sessionId)
  const events: BridgeGlobalEvent[] = [
    makeEvent(directory, 'session.updated', {
      sessionID: sessionId,
      info: minimalSession(sessionId, {
        cwd: directory,
        title: ctx.state.sessionTitleFor(sessionId),
        createdAt: Date.now(),
        ...(agent === undefined ? {} : { agent }),
        ...(parentID === undefined ? {} : { parentID }),
        ...sessionLineageOptions(ctx, sessionId),
      }),
    }, project),
  ]
  const call = [...ctx.state.subagentCalls.values()]
    .find((candidate) => candidate.childSessionId === sessionId && candidate.partEmitted === true)
  if (call !== undefined) {
    const child: SubagentChildRecord = ctx.state.subagentChildren.get(sessionId) ?? {
      sessionId,
      parentSessionId: call.parentSessionId,
      addedAt: Date.now(),
    }
    const callInfo: ToolCallInfo = {
      callId: call.callId,
      name: call.toolName,
      arguments: call.arguments,
      subagent: {
        sessionId,
        parentSessionId: call.parentSessionId,
        ...((child.mode ?? call.childMode) === undefined ? {} : { mode: child.mode ?? call.childMode }),
        ...(call.background === undefined ? {} : { background: call.background }),
      },
    }
    const resultInfo = call.resultStatus === undefined
      ? undefined
      : {
          callId: call.callId,
          content: (call.resultContent ?? []) as never,
          time: call.resultTime ?? Date.now(),
          ...(call.resultError === undefined ? {} : { error: call.resultError }),
        }
    const part = resultInfo === undefined
      ? runningToolPart(callInfo, {
          sessionID: call.parentSessionId,
          messageID: call.messageId,
          time: call.createdAt,
        })
      : call.resultStatus === 'error'
        ? errorToolPart(callInfo, resultInfo, {
            sessionID: call.parentSessionId,
            messageID: call.messageId,
            time: call.createdAt,
          })
        : completedToolPart(callInfo, resultInfo, {
            sessionID: call.parentSessionId,
            messageID: call.messageId,
            time: call.createdAt,
          })
    events.push(makeEvent(
      ctx.state.sessionDirectories.get(call.parentSessionId) ?? ctx.cwd,
      'message.part.updated',
      {
        sessionID: call.parentSessionId,
        part,
        time: Date.now(),
      },
      projectIdFor(ctx.state.sessionDirectories.get(call.parentSessionId) ?? ctx.cwd),
    ))
  }
  return events
}

export async function permissionReply(
  ctx: BridgeRouteContext,
  requestID: string,
  body: unknown,
): Promise<void> {
  const entry = ctx.state.permissionByOpenCodeId(requestID)
  if (!entry) throw notFound('permission request not found', { requestID })
  const reply = bodyAsRecord(body).reply
  let outcome: 'allowed-once' | 'rejected'
  if (reply === 'once') {
    outcome = 'allowed-once'
  } else if (reply === 'reject') {
    outcome = 'rejected'
  } else if (reply === 'always') {
    // dsh has no persistent grant; keep a memory-scoped grant on the bridge so
    // later requests for the same session + tool auto-allow. The current
    // request still resolves as one-shot because dsh only knows allowed-once.
    ctx.state.savePermission(entry.sessionId, entry.toolName)
    ctx.log(`[bridge] permission "always" saved for ${entry.sessionId} ${entry.toolName} (memory scope)`)
    outcome = 'allowed-once'
  } else {
    throw badRequest('invalid permission reply', { reply })
  }
  const resolve = ctx.state.pendingApprovals.get(entry.rpcId)
  if (resolve === undefined) {
    throw conflict('permission request is no longer pending')
  }
  ctx.state.pendingApprovals.delete(entry.rpcId)
  resolve(outcome)
  ctx.state.removePermission(requestID)
  // dsh 0.1.2 has no mux stream, so no `approval/resolved` frame ever
  // arrives to close the TUI's permission dialog. The opencode TUI restores
  // its prompt only after `permission.replied`; without this broadcast the
  // dialog stays open and the next prompt's keystrokes land in the dialog.
  const directory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd
  ctx.hub.broadcast([makeEvent(directory, 'permission.replied', {
    sessionID: entry.sessionId,
    requestID: entry.opencodeId,
    reply: outcome === 'allowed-once' ? 'once' : 'reject',
  }, projectIdFor(directory))])
}

export async function questionReply(
  ctx: BridgeRouteContext,
  requestID: string,
  body: unknown,
): Promise<void> {
  const entry = ctx.state.questionByOpenCodeId(requestID)
  if (!entry) throw notFound('question request not found', { requestID })
  const answers = bodyAsRecord(body).answers
  if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((label) => typeof label === 'string'))) {
    throw badRequest('question reply requires answers: Array<Array<string>>')
  }
  const mapped = answersToDsh(entry, answers as Array<Array<string>>)
  const resolve = ctx.state.pendingQuestions.get(entry.rpcId)
  if (resolve === undefined) {
    throw conflict('question request is no longer pending')
  }
  ctx.state.pendingQuestions.delete(entry.rpcId)
  resolve(mapped)
  ctx.state.removeQuestion(requestID)
  // dsh 0.1.2 has no mux stream to carry `question/resolved`; without a
  // `question.replied` broadcast the opencode TUI never closes the dialog,
  // so the next prompt's keystrokes land in the still-open dialog.
  const qDirectory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd
  ctx.hub.broadcast([makeEvent(qDirectory, 'question.replied', {
    sessionID: entry.sessionId,
    requestID: entry.opencodeId,
    answers,
  }, projectIdFor(qDirectory))])
}

export async function questionReject(
  ctx: BridgeRouteContext,
  requestID: string,
): Promise<void> {
  const entry = ctx.state.questionByOpenCodeId(requestID)
  if (!entry) throw notFound('question request not found', { requestID })
  const resolve = ctx.state.pendingQuestions.get(entry.rpcId)
  if (resolve === undefined) {
    throw conflict('question request is no longer pending')
  }
  ctx.state.pendingQuestions.delete(entry.rpcId)
  resolve(undefined)
  ctx.state.removeQuestion(requestID)
  // Same as questionReply: broadcast the reject so the TUI closes the dialog.
  const qDirectory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd
  ctx.hub.broadcast([makeEvent(qDirectory, 'question.rejected', {
    sessionID: entry.sessionId,
    requestID: entry.opencodeId,
  }, projectIdFor(qDirectory))])
}

export function producedFilesV1(diffs: readonly { file?: string; additions: number; deletions: number }[]): V1FileDiff[] {
  return diffs.map((diff) => ({
    file: diff.file ?? '',
    before: '',
    after: '',
    additions: diff.additions,
    deletions: diff.deletions,
  }))
}

export function historyChanges(history: { events: HistoryEntry[] }): FileChange[] {
  const calls = new Map<string, ToolCallInfo>()
  const changes: FileChange[] = []
  for (const entry of history.events) {
    const event = entry.event
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), {
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
        ...(entry.view?.for === 'call' ? { view: entry.view } : {}),
      })
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0] as ToolResultBlock | undefined
      const callId = String(block?.toolCallId ?? event.data.message.source.callId)
      const call = calls.get(callId)
      if (!call) continue
      changes.push(...fileChangesFromToolResult(call, {
        callId,
        content: event.data.message.content,
        error: event.data.error,
        time: event.time,
        meta: event.data.meta,
        ...(entry.view?.for === 'result' ? { view: entry.view } : {}),
      }))
    }
  }
  return changes
}

export function historyFileDiffs(history: { events: HistoryEntry[]; projections?: { values?: Partial<Record<string, unknown>> } }): Array<{ file?: string; patch?: string; additions: number; deletions: number; status?: 'added' | 'deleted' | 'modified' }> {
  const values = history.projections?.values as Partial<Record<string, unknown>> | undefined
  if (values?.['produced-files'] !== undefined) {
    return convertProducedFiles(values['produced-files'])
  }
  return toSnapshotFileDiffs(historyChanges(history))
}

/**
 * Current goal for one session: prefer the durable `goal` projection, then
 * fold the latest `goal/change` event when the projection is unavailable.
 * `null` (clear tombstone) means no goal is rendered.
 */
export function goalFromHistory(history: {
  projections?: { values?: Partial<Record<string, unknown>> }
  events: readonly HistoryEntry[]
}): unknown {
  if (history.projections?.values?.goal !== undefined) {
    return history.projections.values.goal
  }
  for (let index = history.events.length - 1; index >= 0; index--) {
    const event = (history.events[index] as HistoryEntry).event
    if ((event.type as string) !== 'goal/change') continue
    const data = (event as unknown as { data: { goal?: unknown; cleared?: unknown } }).data
    if (data?.goal !== undefined) return { goal: data.goal }
    if (data?.cleared !== undefined) return null
    return undefined
  }
  return undefined
}

/**
 * Seed one SSE connection's shared goal/todo projection state from durable
 * history. Translators accumulate projections from live mux frames only, so
 * an attach to an existing session would otherwise miss the goal or todos and
 * emit partial `todo.updated` lists (one side replacing the other in the TUI
 * sidebar). History is authoritative here, and existing live state wins.
 */
export async function seedProjectionState(
  ctx: BridgeRouteContext,
  state: { todos: Map<string, unknown>; goals: Map<string, unknown> },
  sessionId: string,
): Promise<void> {
  const history = await cachedSessionHistory(ctx, sessionId)
  let todos: unknown
  for (const entry of history.events) {
    if (entry.event.type === 'todo/write') {
      todos = (entry.event.data as { todos: unknown }).todos
    }
  }
  const values = history.projections?.values as Partial<Record<string, unknown>> | undefined
  if (todos === undefined && values?.todos !== undefined) todos = values.todos
  const goal = goalFromHistory(history)
  if (!state.todos.has(sessionId) && todos !== undefined) {
    state.todos.set(sessionId, todos)
  }
  if (!state.goals.has(sessionId) && goal !== undefined) {
    state.goals.set(sessionId, goal)
  }
  const selection = history.projections?.values?.modelSelection as {
    next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
    lastUsed?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  } | undefined
  const current = selection?.next ?? selection?.lastUsed
  if (current !== null && current !== undefined
    && typeof current.provider === 'string' && typeof current.model === 'string'
    && ctx.state.sessionModelSelectionFor(sessionId) === undefined) {
    ctx.state.setSessionModelSelection(sessionId, {
      providerID: externalProviderId(current.provider),
      modelID: current.model,
      ...(typeof current.reasoningEffort === 'string' ? { variant: current.reasoningEffort } : {}),
    })
  }
}

export function createBridgeRouter(
  api: BridgeApi,
  options: RouterOptions = {},
): BridgeRouter {
  let cwd = options.cwd ?? process.cwd()
  const log = options.log ?? (() => {})
  const state = new InteractionState()
  const hub = new SseHub(log)
  const ctx: BridgeRouteContext = { api, cwd, state, log, hub }
  api.sessionAddress = (sessionId: string): SessionAddress => {
    const parentSessionId = state.sessionParents.get(sessionId)
    if (parentSessionId === undefined) return { kind: 'session', sessionId: sessionId as never }
    return {
      kind: 'subagent',
      parentSessionId: parentSessionId as never,
      childSessionId: sessionId as never,
      mode: state.sessionAddressModes.get(sessionId) ?? 'continuable',
    }
  }
  const routes: Route[] = []

  const register = (
    method: string,
    pattern: string,
    kind: Route['kind'],
    handler: Route['handler'],
  ): void => {
    routes.push({ method, pattern, kind, handler })
  }

  registerRoutes(register)

  for (const route of stubRoutes) routes.push(route)

  function match(method: string, pathname: string): Route | undefined {
    return routes.find(
      (route) =>
        route.method === method &&
        matchPattern(route.pattern, pathname),
    )
  }

  function startSse(req: BridgeRequest, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('retry: 3000\n\n')
    const sessionFilter = (req.params as Record<string, string | undefined>).sessionID
      ?? req.query.get('sessionID')
      ?? undefined
    const client = hub.add(res, (event) => {
      if (sessionFilter === undefined) return true
      const eventSession = (event.payload.properties as Record<string, unknown> | undefined)?.sessionID
      return eventSession === sessionFilter
    })
    const rawLastEventId = req.headers['last-event-id']
    const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId
    if (lastEventId !== undefined && lastEventId.length > 0) {
      if (!hub.replayAfter(client, lastEventId)) {
        log(`[bridge/sse] Last-Event-ID ${lastEventId} is outside the replay ring; using snapshots`)
      }
    }
    replaySessionStatusSnapshot(client)
    void replayControlSnapshot(client).catch((error) => {
      log(`[bridge/sse] control snapshot replay failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // ---- shared host-side event pump (dsh 0.1.2: no mux stream) ----

  let translator: MuxEventTranslator | undefined
  let translatorLoading: Promise<MuxEventTranslator> | undefined
  let listRefreshTimer: NodeJS.Timeout | undefined
  // Serialize session-event feeds per session: `feed` awaits translator
  // initialization and projection seeding, so without a per-session queue
  // two near-simultaneous frames can be translated out of order (e.g. a fast
  // tool/result overtaking the preceding assistant/message), making the SSE
  // event stream nondeterministic.
  const sessionFeedQueues = new Map<string, Promise<void>>()
  const replayGuard = {
    approvals: new Set<string>(),
    questions: new Set<string>(),
    chunks: new Set<string>(),
  }
  const sharedState = { todos: new Map<string, unknown>(), goals: new Map<string, unknown>() }
  const seededProjection = new Set<string>()
  const controlQueues = new Map<string, QueuedInboxItem[]>()
  const controlProjections = new Map<string, { asOfSeq: number; values: Record<string, unknown> }>()
  let translatorDefaultModel: { providerID: string; modelID: string } | undefined

  async function ensureTranslator(): Promise<MuxEventTranslator> {
    if (translator !== undefined) return translator
    const loading = translatorLoading
    if (loading !== undefined) return loading
    const next = (async () => {
      const defaultModel = await defaultModelRef(ctx)
      translatorDefaultModel = defaultModel
      const instance = new MuxEventTranslator({
        cwd,
        state,
        defaultModel,
        log,
        replayGuard,
        sharedState,
        onFlush: (events) => {
          hub.broadcast(events)
        },
      })
      translator = instance
      return instance
    })()
    translatorLoading = next
    try {
      return await next
    } finally {
      if (translatorLoading === next) translatorLoading = undefined
    }
  }

  function scheduleListRefresh(): void {
    if (listRefreshTimer !== undefined) return
    listRefreshTimer = setTimeout(() => {
      listRefreshTimer = undefined
      void (async () => {
        try {
          const list = await rpc<{ items: SessionSummary[] }>(ctx, 'session.list', {})
          ctx.state.setSessionListCache(list.items)
          recordSessionSummaries(ctx, list.items)
        } catch (error) {
          log(`[bridge/sse] session list refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }, 250)
  }

  function frameSessionId(frame: BridgeFrame): string | undefined {
    if (frame.type === 'session/event' || frame.type === 'session/queue'
      || frame.type === 'session/assistant-stream'
      || frame.type === 'session/jobs' || frame.type === 'session/projection'
      || frame.type === 'approval/requested' || frame.type === 'approval/resolved'
      || frame.type === 'question/requested' || frame.type === 'question/resolved') {
      return String(frame.sessionId)
    }
    return undefined
  }

  async function processFrame(frame: BridgeFrame): Promise<void> {
    const t = await ensureTranslator()
    if (frame.type === 'control/baseline') {
      controlQueues.clear()
      for (const [sessionId, items] of Object.entries(frame.value.queues ?? {})) {
        controlQueues.set(sessionId, items.map((item) => ({
          placement: item.placement,
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          message: item.message,
        })))
      }
      controlProjections.clear()
      for (const [sessionId, projection] of Object.entries(frame.value.projections ?? {})) {
        controlProjections.set(sessionId, {
          asOfSeq: projection.asOfSeq,
          values: { ...projection.values },
        })
      }
    } else if (frame.type === 'session/queue') {
      controlQueues.set(String(frame.sessionId), frame.items.map((item) => ({
        placement: item.placement,
        ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
        message: item.message,
      })))
    } else if (frame.type === 'session/projection') {
      const sessionId = String(frame.sessionId)
      const projection = controlProjections.get(sessionId) ?? { asOfSeq: frame.seq, values: {} }
      projection.asOfSeq = frame.seq
      projection.values[frame.key] = frame.value
      controlProjections.set(sessionId, projection)
    }
    if (frame.type === 'session/event') {
      const sessionId = String(frame.sessionId)
      if (!seededProjection.has(sessionId)) {
        seededProjection.add(sessionId)
        try {
          await seedProjectionState(ctx, sharedState, sessionId)
        } catch (error) {
          log(`[bridge/sse] projection seed failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const sessionEvent = frame.event as { type: string }
      ctx.state.invalidateHistory(sessionId)
      if (sessionEvent.type === 'turn/start') {
        ctx.state.setSessionRunning(sessionId, true, frame.event.time)
      } else if (sessionEvent.type === 'turn/end') {
        ctx.state.setSessionRunning(sessionId, false, frame.event.time)
      }
      if (sessionEvent.type === 'session' || sessionEvent.type === 'session/created' || sessionEvent.type === 'session/title') {
        ctx.state.invalidateSession()
        scheduleListRefresh()
      }
    }
    try {
      const translated = t.translate(frame)
      for (const event of translated) hub.broadcast([event])
    } catch (error) {
      log(`[bridge/sse] frame translate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function currentControlBaseline(): BridgeControlBaseline {
    const queues: Record<string, readonly QueuedInboxItem[]> = {}
    for (const [sessionId, items] of controlQueues) queues[sessionId] = items
    const projections: Record<string, { asOfSeq: number; values: Record<string, unknown> }> = {}
    for (const [sessionId, projection] of controlProjections) projections[sessionId] = {
      asOfSeq: projection.asOfSeq,
      values: { ...projection.values },
    }
    return { queues, projections }
  }

  async function replayControlSnapshot(client: SseClient): Promise<void> {
    if (controlQueues.size === 0 && controlProjections.size === 0) return
    const snapshotState = new InteractionState()
    state.copyPresentationContextTo(snapshotState)
    const snapshotTranslator = new MuxEventTranslator({
      cwd,
      state: snapshotState,
      defaultModel: translatorDefaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' },
      log,
      sharedState: {
        todos: new Map(sharedState.todos),
        goals: new Map(sharedState.goals),
      },
    })
    for (const event of snapshotTranslator.translate({
      type: 'control/baseline',
      value: currentControlBaseline(),
    })) hub.send(client, event)
  }

  /** Replay the authoritative status edge missed while an SSE client was away. */
  function replaySessionStatusSnapshot(client: SseClient): void {
    for (const [sessionId, running] of state.sessionRunning) {
      const directory = state.sessionDirectories.get(sessionId) ?? cwd
      hub.send(client, makeEvent(directory, 'session.status', {
        sessionID: sessionId,
        status: { type: running ? 'busy' : 'idle' },
      }, projectIdFor(directory)))
    }
  }

  function enqueueSessionTask(sessionId: string, task: () => Promise<void> | void): void {
    const previous = sessionFeedQueues.get(sessionId) ?? Promise.resolve()
    const current = previous
      .catch((error) => {
        log(`[bridge/sse] previous ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .then(task)
      .catch((error) => {
        log(`[bridge/sse] ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    sessionFeedQueues.set(sessionId, current)
    void current.finally(() => {
      if (sessionFeedQueues.get(sessionId) === current) sessionFeedQueues.delete(sessionId)
    })
  }

  async function feed(frame: BridgeFrame): Promise<void> {
    const sessionId = frameSessionId(frame)
    if (sessionId === undefined) {
      await processFrame(frame).catch((error) => {
        log(`[bridge/sse] frame processing failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    const previous = sessionFeedQueues.get(sessionId)
    const current = (previous ?? Promise.resolve())
      .catch((error) => {
        log(`[bridge/sse] previous ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .then(() => processFrame(frame))
      .catch((error) => {
        log(`[bridge/sse] ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    sessionFeedQueues.set(sessionId, current)
    await current
    if (sessionFeedQueues.get(sessionId) === current) sessionFeedQueues.delete(sessionId)
  }

  function feedHostFrame(frame: BridgeHostFrame): void {
    const sessionId = String(frame.sessionId)
    enqueueSessionTask(sessionId, () => {
      if (frame.type === 'host/session-status') {
        const updatedAt = frame.updatedAt ?? Date.now()
        ctx.state.setSessionRunning(sessionId, frame.running, updatedAt)
        if (!ctx.state.shouldBroadcastSessionStatus(sessionId, frame.running)) return
        const directory = ctx.state.sessionDirectories.get(sessionId) ?? cwd
        hub.broadcast([makeEvent(directory, 'session.status', {
          sessionID: sessionId,
          status: { type: frame.running ? 'busy' : 'idle' },
        }, projectIdFor(directory))])
        return
      }
      if (frame.type === 'host/session-activity') {
        ctx.state.markSessionActivity(sessionId, frame.updatedAt)
        return
      }
      if (frame.type === 'host/agent-error') {
        const directory = ctx.state.sessionDirectories.get(sessionId) ?? cwd
        for (const event of agentErrorEvents(sessionId, frame.message, directory)) hub.broadcast([event])
        return
      }
      ctx.state.invalidateSession()
      scheduleListRefresh()
      if (frame.type === 'host/session-removed') {
        ctx.state.clearSession(sessionId)
        seededProjection.delete(sessionId)
        for (const key of [...replayGuard.chunks]) if (key.startsWith(`${sessionId}:`)) replayGuard.chunks.delete(key)
        translator?.disposeSession(sessionId)
        return
      }
      if (frame.type === 'host/session-added') {
        const summary = frame.summary ?? (frame as unknown as {
          blank?: unknown
          parentSessionId?: unknown
          origin?: unknown
          cwd?: unknown
          agentPreset?: unknown
        })
        if (typeof (summary as { running?: unknown }).running === 'boolean') {
          const updatedAt = (summary as { updatedAt?: unknown }).updatedAt
          // A lifecycle summary without an edge timestamp is only a cold
          // seed. Never let that stale/default snapshot overwrite a live turn
          // status already learned from the event stream.
          if (ctx.state.sessionRunningFor(sessionId) === undefined || typeof updatedAt === 'number') {
            ctx.state.setSessionRunning(
              sessionId,
              (summary as { running: boolean }).running,
              typeof updatedAt === 'number' ? updatedAt : undefined,
            )
          }
        }
        for (const event of hostSessionAddedEvents(ctx, {
          sessionId: frame.sessionId,
          ...(summary === undefined ? {} : summary),
        })) hub.broadcast([event])
      }
    })
  }

  return {
    ctx,
    match,
    startSse,
    feed,
    feedHostFrame,
    setCwd(directory: string) {
      cwd = directory
      ctx.cwd = directory
    },
    prefetchSessionList() {
      void (async () => {
        try {
          const items = await cachedSessionList(ctx)
          await Promise.allSettled(
            items.slice(0, RECENT_HISTORY_PREFETCH).map((item) =>
              cachedSessionHistory(ctx, String(item.sessionId), { maxMessages: 100 }),
            ),
          )
        } catch (error) {
          log(`[bridge] session list prefetch failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    },
    prefetchSession(sessionId: string) {
      ctx.state.setCurrentSession(sessionId)
      // Match the TUI's initial v1 message fetch (default limit 100).
      void cachedSessionHistory(ctx, sessionId, { maxMessages: 100 }).catch((error) => {
        log(`[bridge] session history prefetch failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    hasNewActivity() {
      return ctx.state.newInputDuringRun
    },
    async exitNoteNeeded() {
      if (ctx.state.newInputDuringRun) return true
      const sessionId = ctx.state.currentSessionId
      if (sessionId === undefined) return false
      try {
        const history = await cachedSessionHistory(ctx, sessionId, { maxMessages: 100 })
        const title = history.projections === undefined
          ? undefined
          : (history.projections.values as Partial<Record<string, unknown>>).title
        return typeof title === 'string' && title.length > 0
      } catch {
        return false
      }
    },
  }
}

export function matchPattern(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split('/')
  const pathSegments = pathname.split('/')
  const starIndex = patternSegments.indexOf('*')
  if (starIndex !== -1) {
    if (starIndex !== patternSegments.length - 1) return false
    if (pathSegments.length <= starIndex) return false
    const prefixPattern = patternSegments.slice(0, starIndex)
    const prefixPath = pathSegments.slice(0, starIndex)
    if (prefixPattern.length !== prefixPath.length) return false
    return prefixPattern.every(
      (segment, index) => segment === prefixPath[index] || segment.startsWith(':'),
    )
  }
  if (patternSegments.length !== pathSegments.length) return false
  return patternSegments.every(
    (segment, index) => segment === pathSegments[index] || segment.startsWith(':'),
  )
}

export function extractParams(pattern: string, pathname: string): Record<string, string> {
  const patternSegments = pattern.split('/')
  const pathSegments = pathname.split('/')
  const params: Record<string, string> = {}
  const starIndex = patternSegments.indexOf('*')
  if (starIndex !== -1) {
    params['*'] = pathSegments.slice(starIndex).join('/')
    patternSegments.slice(0, starIndex).forEach((segment, index) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? '')
      }
    })
    return params
  }
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? '')
    }
  })
  return params
}
