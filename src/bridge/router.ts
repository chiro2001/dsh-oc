import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  HistoryEntry,
  HostFrame,
  MuxFrame,
  PromptContentPart,
  RequestPayload,
  RpcRequest,
  ResponseValue,
  RpcMethodMap,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api'
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
  SessionV2Info,
} from '@opencode-ai/sdk/v2/types'
import type { Agent as V2Agent, AgentV2Info } from '@opencode-ai/sdk/v2/types'
import type { BridgeApi, BridgeCommandExecution } from './rpc.js'
import { call, RpcCallError, respondApproval, respondQuestion, cancelQuestion } from './rpc.js'
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
import { fileChangesFromToolResult, type FileChange, type ToolCallInfo } from './convert/tool.js'
import { agentErrorEvents, commandResultEvents, convertProducedFiles, makeEvent, toSnapshotFileDiffs } from './events.js'
import { filterGitTrackedDiffs } from './git.js'
import { dshProviderId, externalProviderId, projectIdFor } from './convert/common.js'
import { ocHelp } from '../help.js'
import { InteractionState, type CachedHistory } from './state.js'
import { registerRoutes } from './routes.js'
import { SseHub } from './sse.js'
import { MuxEventTranslator } from './events.js'
import { stubRoutes } from './stubs.js'

export interface BridgeRequest {
  method: string
  pathname: string
  query: URLSearchParams
  params: Record<string, string>
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

export async function rpc<K extends keyof RpcMethodMap>(
  ctx: BridgeRouteContext,
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  try {
    return await call(ctx.api, method, payload, signal)
  } catch (error) {
    if (error instanceof RpcCallError) throw rpcErrorToHttp(error.error)
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

/**
 * Record child cwd and parent lineage from a session list. A subagent child
 * without its own cwd inherits the nearest parent's cwd so the TUI opens and
 * filters its events in the same project directory.
 */
export function recordSessionSummaries(
  ctx: BridgeRouteContext,
  items: readonly SessionSummary[],
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
    ctx.state.sessionDirectories.set(id, directories.get(id) ?? ctx.cwd)
    if (item.origin === 'subagent' && item.parentSessionId !== undefined) {
      ctx.state.sessionParents.set(id, String(item.parentSessionId))
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
    const selection = await rpc(ctx, 'session.models', { sessionId: sid(id) })
    model = {
      id: selection.current.model,
      providerID: externalProviderId(selection.current.provider),
      ...(selection.current.reasoningEffort === undefined
        ? {}
        : { variant: selection.current.reasoningEffort }),
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
  if (cached !== undefined) return cached
  const existing = ctx.state.sessionListLoading
  if (existing !== undefined) return existing
  const generation = ctx.state.listGeneration()
  const promise = rpc(ctx, 'session.list', {}).then((list) => list.items)
  ctx.state.sessionListLoading = promise
  try {
    const items = await promise
    // Only publish to the shared cache if no invalidation happened while the
    // scan was in flight; concurrent callers still get this same snapshot.
    if (ctx.state.listGeneration() === generation) {
      ctx.state.setSessionListCache(items)
    }
    return items
  } finally {
    if (ctx.state.sessionListLoading === promise) ctx.state.sessionListLoading = undefined
  }
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
    events: history.events,
    hasMore: history.hasMore,
    ...(history.projections === undefined ? {} : { projections: history.projections }),
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
  if (options.maxMessages === undefined) {
    const pageKey = historyCacheKey(sessionId, 100, undefined)
    if (ctx.state.getHistoryCache(pageKey, HISTORY_CACHE_MS) === undefined) {
      ctx.state.setHistoryCache(pageKey, {
        events: value.events.slice(-100),
        hasMore: value.events.length > 100 || value.hasMore,
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
      const result = await rpc(ctx, 'skill.list', { sessionId: sid(String(session.sessionId)) })
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
    const result = await rpc(ctx, 'skill.list', { sessionId: sid(sessionId) })
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
    })
  }
  return minimalSession(id, {
    cwd: view.cwd ?? ctx.cwd,
    createdAt: view.createdAt,
    ...(ctx.state.sessionParents.get(id) === undefined
      ? {}
      : { parentID: ctx.state.sessionParents.get(id) }),
  })
}

export function toV2Session(view: SessionView, id: string, ctx: BridgeRouteContext): SessionV2Info {
  if (view.summary) {
    return convertSessionSummaryV2(view.summary, {
      cwd: view.cwd ?? ctx.cwd,
      createdAt: view.createdAt,
      ...(view.model === undefined ? {} : { model: view.model }),
    })
  }
  return minimalSessionV2(id, {
    cwd: view.cwd ?? ctx.cwd,
    createdAt: view.createdAt,
    ...(ctx.state.sessionParents.get(id) === undefined
      ? {}
      : { parentID: ctx.state.sessionParents.get(id) }),
  })
}

export async function modelGroups(ctx: BridgeRouteContext) {
  const catalog = await rpc(ctx, 'llm.models', {})
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
): V1MessageEntry {
  const info: V1MessageEntry['info'] = {
    id: `pending:${randomUUID()}`,
    sessionID,
    role: 'assistant',
    time: { created: Date.now() },
    parentID: `pending:${randomUUID()}`,
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
  let providerID = 'deepseek'
  let modelID = 'deepseek-chat'
  try {
    const groups = await modelGroups(ctx)
    const first = groups[0]
    const firstModel = first?.models[0]
    if (first !== undefined) providerID = externalProviderId(first.id)
    if (firstModel !== undefined) modelID = firstModel.id
  } catch (error) {
    ctx.log(`[bridge] default agent model fallback: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { providerID, modelID }
}

export async function defaultModelRef(ctx: BridgeRouteContext): Promise<{ providerID: string; modelID: string }> {
  return defaultAgents(ctx)
}

export async function v1DefaultAgent(ctx: BridgeRouteContext): Promise<V2Agent> {
  const { providerID, modelID } = await defaultAgents(ctx)
  return {
    name: DEFAULT_AGENT_NAME,
    description: 'dsh-oc default build agent',
    mode: 'primary',
    permission: [],
    options: {},
    model: { providerID, modelID },
  }
}

export async function v2DefaultAgent(ctx: BridgeRouteContext): Promise<AgentV2Info> {
  const { providerID, modelID } = await defaultAgents(ctx)
  return {
    id: DEFAULT_AGENT_NAME,
    mode: 'primary',
    hidden: false,
    request: { headers: {}, body: {} },
    permissions: [],
    model: { id: modelID, providerID },
    description: 'dsh-oc default build agent',
  }
}

export async function presetRoster(ctx: BridgeRouteContext) {
  const roster = await rpc(ctx, 'agentPreset.list', {})
  return roster.presets.filter((preset) => preset.broken === undefined)
}

export async function defaultPresetId(ctx: BridgeRouteContext): Promise<string | undefined> {
  try {
    const presets = await presetRoster(ctx)
    return presets.find((preset) => preset.isDefault)?.id
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
): Promise<void> {
  const presetId = await presetIdForAgent(ctx, agentName)
  if (presetId === undefined) {
    if (agentName === DEFAULT_AGENT_NAME) return
    throw badRequest(`agent "${agentName}" is not a switchable dsh preset`)
  }
  await rpc(ctx, 'agentPreset.select', {
    sessionId: sid(sessionId),
    agentPreset: presetId,
  })
  ctx.state.lastAgentPreset = agentName
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
}

export async function presetCommandOutcome(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<PresetCommandOutcome> {
  try {
    if (argument === '') {
      const roster = await presetRoster(ctx)
      const text = roster.length === 0
        ? 'No switchable dsh agent presets'
        : roster.map((preset) => `${preset.id}${preset.isDefault ? ' (default)' : ''}`).join('\n')
      return { kind: 'success', text }
    }
    await switchAgentPreset(ctx, sessionId, argument)
    return { kind: 'success', text: `Switched dsh agent preset to ${argument}` }
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
): void {
  ctx.hub.broadcast(commandResultEvents(
    { cwd: ctx.cwd, state: ctx.state, log: ctx.log },
    sessionId,
    text,
    status === undefined ? {} : { status },
  ))
}

/** Push a `session.updated` carrying the new agent so the TUI label refreshes. */
export function broadcastSessionAgent(
  ctx: BridgeRouteContext,
  sessionId: string,
  agent: string,
): void {
  const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd
  const project = projectIdFor(directory)
  ctx.hub.broadcast([
    makeEvent(directory, 'session.updated', {
      sessionID: sessionId,
      info: minimalSession(sessionId, {
        cwd: directory,
        title: ctx.state.sessionTitleFor(sessionId),
        agent,
      }),
    }, project),
  ])
}

/** Run a `/preset` list/switch with visible TUI progress and result. */
export async function runPresetCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<PresetCommandOutcome> {
  broadcastCommandResult(ctx, sessionId, 'Running /preset…', 'busy')
  const outcome = await presetCommandOutcome(ctx, sessionId, argument)
  if (outcome.kind === 'success' && argument.trim() !== '') {
    broadcastSessionAgent(ctx, sessionId, argument.trim())
  }
  ctx.state.invalidateSession(sessionId)
  broadcastCommandResult(ctx, sessionId, outcome.text, 'idle')
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
    execution = await ctx.api.commands.execute(agent, commandLine, new AbortController().signal)
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
  if (slash.name === 'preset') return runPresetCommand(ctx, sessionId, slash.argument)
  if (slash.name === 'goal') return runGoalCommand(ctx, sessionId, slash.argument)
  if (slash.name === 'help') return runHelpCommand(ctx, sessionId, slash.argument)
  throw badRequest(`unsupported command /${slash.name}`)
}

export async function dshPresetAgents(ctx: BridgeRouteContext): Promise<V2Agent[]> {
  try {
    return (await presetRoster(ctx))
      .filter((preset) => preset.id !== DEFAULT_AGENT_NAME)
      .map((preset) => ({
        name: preset.id,
        description: preset.name ?? preset.description,
        mode: 'primary' as const,
        permission: [],
        options: {},
      }))
  } catch (error) {
    ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export async function dshPresetAgentsV2(ctx: BridgeRouteContext): Promise<AgentV2Info[]> {
  try {
    return (await presetRoster(ctx))
      .filter((preset) => preset.id !== DEFAULT_AGENT_NAME)
      .map((preset) => ({
        id: preset.id,
        description: preset.name ?? preset.description,
        mode: 'primary' as const,
        hidden: false,
        request: { headers: {}, body: {} },
        permissions: [],
      }))
  } catch (error) {
    ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

interface ModelInput {
  providerID: string
  modelID: string
  variant?: string
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
  const variant = typeof input.variant === 'string' ? input.variant : undefined
  return {
    providerID,
    modelID,
    ...(variant === undefined || variant === 'default' ? {} : { variant }),
  }
}

export async function applyModelSelection(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: unknown,
): Promise<void> {
  const input = modelInputFromBody(body)
  if (input === undefined) return
  await rpc(ctx, 'session.selectModel', {
    sessionId: sid(sessionId),
    provider: dshProviderId(input.providerID),
    model: input.modelID,
    ...(input.variant === undefined ? {} : { reasoningEffort: input.variant }),
  })
}

/** Apply the agent carried in a prompt body (Tab/agent picker selection). */
export async function applyAgentFromBody(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: unknown,
): Promise<void> {
  const record = bodyAsRecord(body)
  const agent = typeof record.agent === 'string' && record.agent.length > 0 ? record.agent : undefined
  if (agent === undefined || agent === DEFAULT_AGENT_NAME) return
  try {
    await switchAgentPreset(ctx, sessionId, agent)
    broadcastSessionAgent(ctx, sessionId, agent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`[bridge] prompt agent switch failed for ${sessionId}: ${message}`)
    const errorBody = (error as { body?: { data?: Record<string, unknown> } }).body
    const code = typeof errorBody?.data?.code === 'string'
      ? (errorBody.data.code as string)
      : ''
    if (code === 'agent-preset-locked' && !ctx.state.lockedAgentNoticeSeen(sessionId, agent)) {
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
  const history = await cachedSessionHistory(ctx, sessionId)
  for (const entry of history.events) {
    const event = entry.event
    const candidate = event.type === 'user/message'
      ? String(event.data.id)
      : event.type === 'assistant/message'
        ? String(event.data.message.id)
        : undefined
    if (candidate === messageId) return event.seq
  }
  throw badRequest('message not found for fork', { sessionId, messageId })
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
  const result = await rpc(ctx, 'session.fork', {
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
    execution = await ctx.api.commands.execute(agent, '/compact', new AbortController().signal)
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
    const result = await rpc(ctx, 'session.create', {
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
  ctx.state.setCurrentSession(id)
  ctx.state.invalidateSession()
  const view = await sessionView(ctx, id)
  return json(200, v2 ? { data: toV2Session(view, id, ctx) } : toV1Session(view, id, ctx))
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
  const receipt = await respondApproval(ctx.api, entry.rpcId, entry.sessionId, entry.approvalId, outcome)
  if (!receipt.accepted) {
    throw conflict('permission request is no longer pending', { reason: receipt.reason })
  }
  ctx.state.removePermission(requestID)
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
  const receipt = await respondQuestion(ctx.api, entry.rpcId, entry.sessionId, mapped)
  if (!receipt.accepted) {
    throw conflict('question request is no longer pending', { reason: receipt.reason })
  }
  ctx.state.removeQuestion(requestID)
}

export async function questionReject(
  ctx: BridgeRouteContext,
  requestID: string,
): Promise<void> {
  const entry = ctx.state.questionByOpenCodeId(requestID)
  if (!entry) throw notFound('question request not found', { requestID })
  const receipt = await cancelQuestion(ctx.api, entry.rpcId)
  if (!receipt.accepted) {
    throw conflict('question request is no longer pending', { reason: receipt.reason })
  }
  ctx.state.removeQuestion(requestID)
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

export function createBridgeRouter(
  api: BridgeApi,
  options: RouterOptions = {},
): BridgeRouter {
  let cwd = options.cwd ?? process.cwd()
  const log = options.log ?? (() => {})
  const state = new InteractionState()
  const hub = new SseHub(log)
  const ctx: BridgeRouteContext = { api, cwd, state, log, hub }
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

  function startSse(_req: BridgeRequest, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('retry: 3000\n\n')
    const client = hub.add(res)
    const controller = client.controller
    void (async () => {
      let translator: MuxEventTranslator | undefined
      let listRefreshTimer: NodeJS.Timeout | undefined
      try {
        const defaultModel = await defaultModelRef(ctx)
        const replayGuard = { approvals: new Set<string>(), questions: new Set<string>() }
        const sharedState = { todos: new Map<string, unknown>(), goals: new Map<string, unknown>() }
        const makeTranslator = (): MuxEventTranslator => new MuxEventTranslator({
          cwd,
          state,
          defaultModel,
          log,
          replayGuard,
          sharedState,
          onFlush: (events) => {
            for (const event of events) hub.send(client, event)
          },
        })
        translator = makeTranslator()
        const retryBaseMs = options.sseRetryBaseMs ?? SSE_RETRY_BASE_MS
        const retryMaxAttempts = options.sseRetryMaxAttempts ?? SSE_RETRY_MAX_ATTEMPTS
        const scheduleListRefresh = (): void => {
          if (listRefreshTimer !== undefined) return
          listRefreshTimer = setTimeout(() => {
            listRefreshTimer = undefined
            void (async () => {
              try {
                const list = await rpc(ctx, 'session.list', {})
                ctx.state.setSessionListCache(list.items)
                recordSessionSummaries(ctx, list.items)
              } catch (error) {
                log(`[bridge/sse] session list refresh failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            })()
          }, 250)
        }
        const consumeHost = async (stream: AsyncIterable<RpcRequest<HostFrame>>): Promise<void> => {
          for await (const frame of stream) {
            const payload = frame.payload as { type?: string; sessionId?: unknown; message?: unknown }
            if (payload.type === 'host/agent-error') {
              const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
              const message = typeof payload.message === 'string' ? payload.message : 'agent error'
              if (sessionId) {
                for (const event of agentErrorEvents(sessionId, message, cwd)) hub.send(client, event)
              }
            }
            if (payload.type === 'host/session-added' || payload.type === 'host/session-removed') {
              ctx.state.invalidateSession()
              scheduleListRefresh()
            }
          }
        }
        const startHostLoop = async (): Promise<void> => {
          let attempt = 0
          let delay = retryBaseMs
          while (!controller.signal.aborted) {
            attempt += 1
            const stream = api.events.host(
              { rpcId: randomUUID() as never, payload: {} },
              controller.signal,
            )
            try {
              await consumeHost(stream)
              return
            } catch (error) {
              if (controller.signal.aborted) return
              if (attempt >= retryMaxAttempts) {
                log(`[bridge/sse] host stream ended: ${error instanceof Error ? error.message : String(error)}`)
                return
              }
              log(`[bridge/sse] host stream error, retry ${attempt}/${retryMaxAttempts} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`)
              await new Promise((resolve) => setTimeout(resolve, delay))
              delay = Math.min(delay * 2, 8000)
            }
          }
        }
        void startHostLoop().catch((error) => {
          log(`[bridge/sse] host loop failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        const consumeStream = async (stream: AsyncIterable<RpcRequest<MuxFrame>>): Promise<void> => {
          for await (const frame of stream) {
            if (frame.payload.type === 'approval/requested') {
              const sessionId = String(frame.payload.sessionId)
              const toolName = frame.payload.toolName
              if (ctx.state.savedPermissionFor(sessionId, toolName) !== undefined) {
                try {
                  await respondApproval(
                    api,
                    String(frame.rpcId),
                    sessionId,
                    String(frame.payload.approvalId),
                    'allowed-once',
                  )
                } catch (error) {
                  log(`[bridge/sse] auto-approval failed: ${error instanceof Error ? error.message : String(error)}`)
                }
                continue
              }
            }
            if (frame.payload.type === 'session/event') {
              const sessionEvent = frame.payload.event as unknown as { type: string }
              ctx.state.invalidateHistory(String(frame.payload.sessionId))
              if (sessionEvent.type === 'session' || sessionEvent.type === 'session/created' || sessionEvent.type === 'session/title') {
                ctx.state.invalidateSession()
                scheduleListRefresh()
              }
            }
            for (const event of translator!.translate(frame)) {
              hub.send(client, event)
            }
          }
        }
        let attempt = 0
        let delay = retryBaseMs
        while (true) {
          attempt += 1
          const stream = api.events.mux(
            { rpcId: randomUUID() as never, payload: {} },
            controller.signal,
          )
          try {
            await consumeStream(stream)
            break
          } catch (error) {
            if (controller.signal.aborted) break
            if (attempt >= retryMaxAttempts) throw error
            log(`[bridge/sse] mux stream error, retry ${attempt}/${retryMaxAttempts} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`)
            await new Promise((resolve) => setTimeout(resolve, delay))
            delay = Math.min(delay * 2, 8000)
            translator?.dispose()
            translator = makeTranslator()
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        log(`[bridge/sse] mux stream ended: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        translator?.dispose()
        if (listRefreshTimer !== undefined) {
          clearTimeout(listRefreshTimer)
          listRefreshTimer = undefined
        }
        hub.remove(client)
      }
    })()
  }

  return {
    ctx,
    match,
    startSse,
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
  if (patternSegments.length !== pathSegments.length) return false
  return patternSegments.every(
    (segment, index) => segment === pathSegments[index] || segment.startsWith(':'),
  )
}

export function extractParams(pattern: string, pathname: string): Record<string, string> {
  const patternSegments = pattern.split('/')
  const pathSegments = pathname.split('/')
  const params: Record<string, string> = {}
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? '')
    }
  })
  return params
}
