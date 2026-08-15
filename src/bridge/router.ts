import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  HistoryEntry,
  PromptContentPart,
  RequestPayload,
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
import { agentErrorEvent, commandResultEvents, convertProducedFiles, toSnapshotFileDiffs } from './events.js'
import { filterGitTrackedDiffs } from './git.js'
import { dshProviderId, externalProviderId, projectIdFor } from './convert/common.js'
import { ocHelp } from '../help.js'
import { InteractionState } from './state.js'
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
}

export interface RouterOptions {
  cwd?: string
  log?: (message: string) => void
}

function json(status: number, body?: unknown): HandlerResult {
  return { status, body }
}

function sid(id: string): never {
  return id as never
}

async function rpc<K extends keyof RpcMethodMap>(
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

function bodyAsRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }
  return body as Record<string, unknown>
}

function locationInfo(ctx: BridgeRouteContext): LocationInfo {
  return {
    directory: ctx.cwd,
    project: { id: projectIdFor(ctx.cwd), directory: ctx.cwd },
  }
}

function v2LocationBody(ctx: BridgeRouteContext): { location: LocationInfo; data: unknown[] } {
  return { location: locationInfo(ctx), data: [] }
}

interface SessionView {
  summary?: SessionSummary
  events: HistoryEntry[]
  createdAt?: number
  model?: { id: string; providerID: string; variant?: string }
  cwd?: string
}

function sessionDirectoryFrom(
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
function recordSessionSummaries(
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
function filterSessionsByDirectory(
  items: readonly SessionSummary[],
  directory: string | undefined,
): SessionSummary[] {
  if (directory === undefined || directory.length === 0) return [...items]
  const normalized = resolve(directory)
  return items.filter((item) => {
    if (typeof item.cwd !== 'string') return true
    return resolve(item.cwd) === normalized
  })
}

async function sessionView(ctx: BridgeRouteContext, id: string): Promise<SessionView> {
  const list = await rpc(ctx, 'session.list', {})
  const summary = list.items.find((item) => String(item.sessionId) === id)
  recordSessionSummaries(ctx, list.items)
  const cwd = sessionDirectoryFrom(list.items, summary, ctx.cwd)
  const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
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
function encodeMessageCursor(beforeSeq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, beforeSeq }), 'utf8').toString('base64url')
}

/** Decode an opaque v2 message cursor produced by {@link encodeMessageCursor}. */
function decodeMessageCursor(raw: string): number {
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
function encodeSessionCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url')
}

/** Decode an opaque v2 session-list cursor produced by {@link encodeSessionCursor}. */
function decodeSessionCursor(raw: string): number {
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
function oldestSurfaceSeq(events: readonly HistoryEntry[]): number | undefined {
  let oldest: number | undefined
  for (const entry of events) {
    const type = entry.event.type as string
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      if (oldest === undefined || entry.event.seq < oldest) oldest = entry.event.seq
    }
  }
  return oldest
}

function toV1Session(view: SessionView, id: string, ctx: BridgeRouteContext): V2Session {
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

function toV2Session(view: SessionView, id: string, ctx: BridgeRouteContext): SessionV2Info {
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

async function modelGroups(ctx: BridgeRouteContext) {
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

const TEXT_MIME_PREFIXES = new Set([
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

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.sh', '.py', '.rs',
  '.go', '.c', '.h', '.cpp', '.hpp', '.java', '.sql', '.css', '.html',
  '.xml', '.csv', '.log',
])

function isTextMime(mime: string): boolean {
  const normalized = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  return normalized.startsWith('text/') || TEXT_MIME_PREFIXES.has(normalized)
}

function isTextFile(path: string, mime: string): boolean {
  return isTextMime(mime) || TEXT_EXTENSIONS.has(extname(path).toLowerCase())
}

function filePartToContent(part: PromptPartInput, cwd: string): PromptContentPart {
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

function parsePromptParts(raw: unknown, cwd: string): PromptContentPart[] {
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

function pendingAssistantPlaceholder(
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
const DEFAULT_AGENT_NAME = 'build'

const PRESET_COMMAND_V1: V1Command = {
  name: 'preset',
  description: 'List or switch the session dsh agent preset',
  template: 'preset',
}

const PRESET_COMMAND_V2: CommandV2Info = {
  name: 'preset',
  template: 'preset',
  description: 'List or switch the session dsh agent preset',
}

const GOAL_COMMAND_V1: V1Command = {
  name: 'goal',
  description: 'Set or view the goal for a long-running task',
  template: 'goal',
}

const GOAL_COMMAND_V2: CommandV2Info = {
  name: 'goal',
  template: 'goal',
  description: 'Set or view the goal for a long-running task',
}

const HELP_COMMAND_V1: V1Command = {
  name: 'help',
  description: 'Show the dsh-oc capability summary and documentation entry points',
  template: 'help',
}

const HELP_COMMAND_V2: CommandV2Info = {
  name: 'help',
  template: 'help',
  description: 'Show the dsh-oc capability summary and documentation entry points',
}

async function defaultAgents(ctx: BridgeRouteContext): Promise<{
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

async function defaultModelRef(ctx: BridgeRouteContext): Promise<{ providerID: string; modelID: string }> {
  return defaultAgents(ctx)
}

async function v1DefaultAgent(ctx: BridgeRouteContext): Promise<V2Agent> {
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

async function v2DefaultAgent(ctx: BridgeRouteContext): Promise<AgentV2Info> {
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

async function presetRoster(ctx: BridgeRouteContext) {
  const roster = await rpc(ctx, 'agentPreset.list', {})
  return roster.presets.filter((preset) => preset.broken === undefined)
}

async function defaultPresetId(ctx: BridgeRouteContext): Promise<string | undefined> {
  try {
    const presets = await presetRoster(ctx)
    return presets.find((preset) => preset.isDefault)?.id
  } catch (error) {
    ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function presetIdForAgent(
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

async function switchAgentPreset(
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
}

/** All text parts of a prompt body, joined the way the TUI renders them. */
function textFromPromptParts(content: readonly PromptContentPart[]): string {
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
function slashPromptCapture(content: readonly PromptContentPart[]): SlashPromptCapture | undefined {
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

async function presetCommandOutcome(
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
function broadcastCommandResult(
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

/** Run a `/preset` list/switch with visible TUI progress and result. */
async function runPresetCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  argument: string,
): Promise<PresetCommandOutcome> {
  broadcastCommandResult(ctx, sessionId, 'Running /preset…', 'busy')
  const outcome = await presetCommandOutcome(ctx, sessionId, argument)
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
async function runRegistryCommand(
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
async function runGoalCommand(
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
async function completeGoalCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
): Promise<RegistryCommandOutcome> {
  broadcastCommandResult(ctx, sessionId, 'Running /goal complete…', 'busy')
  try {
    const history = await rpc(ctx, 'session.history', { sessionId: sid(sessionId) })
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
function runHelpCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  _argument: string,
): PresetCommandOutcome {
  const text = ocHelp()
  broadcastCommandResult(ctx, sessionId, text)
  return { kind: 'success', text }
}

/** Dispatch a captured slash command to its bridge-side implementation. */
async function runSlashCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  slash: SlashPromptCapture,
): Promise<PresetCommandOutcome | RegistryCommandOutcome> {
  if (slash.name === 'preset') return runPresetCommand(ctx, sessionId, slash.argument)
  if (slash.name === 'goal') return runGoalCommand(ctx, sessionId, slash.argument)
  if (slash.name === 'help') return runHelpCommand(ctx, sessionId, slash.argument)
  throw badRequest(`unsupported command /${slash.name}`)
}

async function dshPresetAgents(ctx: BridgeRouteContext): Promise<V2Agent[]> {
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

async function dshPresetAgentsV2(ctx: BridgeRouteContext): Promise<AgentV2Info[]> {
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

function modelInputFromBody(body: unknown): ModelInput | undefined {
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

async function applyModelSelection(
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

/**
 * dsh `session.fork` anchors on a completed-turn boundary by event seq.
 * opencode's fork payload names a message id, so translate it to the seq of
 * that message's user/assistant event (dsh documents message-fork buttons as
 * passing the message seq; the boundary then closes at the following
 * turn/end, which includes the whole turn).
 */
async function atSeqForMessage(
  ctx: BridgeRouteContext,
  sessionId: string,
  messageId: string,
): Promise<number> {
  const history = await rpc(ctx, 'session.history', { sessionId: sid(sessionId) })
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

async function forkSession(
  req: BridgeRequest,
  ctx: BridgeRouteContext,
  v2: boolean,
): Promise<HandlerResult> {
  const id = req.params.id ?? req.params.sessionID ?? ''
  const body = bodyAsRecord(req.body)
  const messageId = typeof body.messageID === 'string' ? body.messageID : undefined
  const atSeq = messageId === undefined ? undefined : await atSeqForMessage(ctx, id, messageId)
  const childId = await forkFromSource(ctx, id, atSeq)
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
function forkChainBase(title: string): string {
  let base = title
  for (;;) {
    const match = /^(.*?)\s+\(fork #\d+\)$/.exec(base)
    if (!match?.[1]) return base
    base = match[1]
  }
}

function forkNumberInTitle(title: string): number {
  let max = 0
  for (const match of title.matchAll(/\(fork #(\d+)\)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max
}

async function forkTitleForSource(
  ctx: BridgeRouteContext,
  sourceId: string,
): Promise<string> {
  const list = await rpc(ctx, 'session.list', {})
  const source = list.items.find((item) => String(item.sessionId) === sourceId)
  const sourceTitle = source === undefined ? 'Session' : sessionTitleFrom(source) || 'Session'
  const base = forkChainBase(sourceTitle)
  const sourceForkNumber = forkNumberInTitle(sourceTitle)
  if (sourceForkNumber > 0) {
    return `${base} (fork #${sourceForkNumber + 1})`
  }
  const existingForks = list.items.filter(
    (item) =>
      String(item.sessionId) !== sourceId
      && String(item.parentSessionId) === sourceId
      && item.origin !== 'subagent',
  )
  return `${base} (fork #${existingForks.length + 1})`
}

async function forkFromSource(
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
async function runCompactCommand(
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
  broadcastCommandResult(ctx, sessionId, text, 'idle')
  ctx.log(`[bridge] /compact: ${text}`)
}

async function createSession(
  req: BridgeRequest,
  ctx: BridgeRouteContext,
  v2: boolean,
): Promise<HandlerResult> {
  const body = bodyAsRecord(req.body)
  const parentID = typeof body.parentID === 'string' ? body.parentID : undefined
  const sessionIdInput = typeof body.id === 'string' ? body.id : undefined
  const title = typeof body.title === 'string' ? body.title : undefined
  const agentName = typeof body.agent === 'string' ? body.agent : undefined
  const agentPreset = agentName === undefined ? undefined : await presetIdForAgent(ctx, agentName)
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
  const view = await sessionView(ctx, id)
  return json(200, v2 ? { data: toV2Session(view, id, ctx) } : toV1Session(view, id, ctx))
}

async function permissionReply(
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

async function questionReply(
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

async function questionReject(
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

function producedFilesV1(diffs: readonly { file?: string; additions: number; deletions: number }[]): V1FileDiff[] {
  return diffs.map((diff) => ({
    file: diff.file ?? '',
    before: '',
    after: '',
    additions: diff.additions,
    deletions: diff.deletions,
  }))
}

function historyChanges(history: { events: HistoryEntry[] }): FileChange[] {
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

function historyFileDiffs(history: { events: HistoryEntry[]; projections?: { values?: Partial<Record<string, unknown>> } }): Array<{ file?: string; patch?: string; additions: number; deletions: number; status?: 'added' | 'deleted' | 'modified' }> {
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
function goalFromHistory(history: {
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

  // ---- v1 boot / catalog routes ----
  register('GET', '/path', 'json', async (_req, ctx) => {
    const directory = ctx.cwd
    return json(200, {
      home: directory,
      state: 'ready',
      config: '',
      worktree: directory,
      directory,
      path: directory,
    })
  })

  register('GET', '/project/current', 'json', async (_req, ctx) => json(200, {
    id: projectIdFor(ctx.cwd),
    worktree: ctx.cwd,
    time: { created: 0 },
  }))

  register('GET', '/project/global/directories', 'json', async (_req, ctx) => json(200, [
    { directory: ctx.cwd },
  ]))

  register('GET', '/config', 'json', async () => json(200, { autoupdate: false }))

  register('GET', '/config/providers', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, { providers: convertToV1Providers(groups), default: {} })
  })

  register('GET', '/provider', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, convertToProviderCatalog(groups))
  })

  register('GET', '/provider/auth', 'json', async () => json(200, {}))

  register('GET', '/agent', 'json', async (_req, ctx) => json(200, [
    await v1DefaultAgent(ctx),
    ...(await dshPresetAgents(ctx)),
  ]))
  // `/preset` stays advertised as a server command: the 1.18.18 TUI opens a
  // slash popup for any `/` input, so the first Enter completes to `/preset `
  // and the second Enter executes through `POST /session/:id/command`. The
  // prompt routes below additionally capture `/preset` typed with a trailing
  // space (or after Esc), so every path ends with a visible SSE result.
  register('GET', '/command', 'json', async () => json(200, [PRESET_COMMAND_V1, GOAL_COMMAND_V1, HELP_COMMAND_V1]))
  for (const bare of ['/skill', '/reference', '/integration']) {
    register('GET', bare, 'json', async () => json(200, []))
  }

  // ---- v2 boot / catalog routes ----
  register('GET', '/api/location', 'json', async (_req, ctx) => json(200, locationInfo(ctx)))

  register('GET', '/api/agent', 'json', async (_req, ctx) => json(200, {
    location: locationInfo(ctx),
    data: [await v2DefaultAgent(ctx), ...(await dshPresetAgentsV2(ctx))],
  }))

  register('GET', '/api/command', 'json', async (_req, ctx) => json(200, {
    location: locationInfo(ctx),
    data: [PRESET_COMMAND_V2, GOAL_COMMAND_V2, HELP_COMMAND_V2],
  }))
  for (const bare of ['/api/skill', '/api/reference', '/api/integration']) {
    register('GET', bare, 'json', async (_req, ctx) => json(200, v2LocationBody(ctx)))
  }

  register('GET', '/api/model', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, { location: locationInfo(ctx), data: convertToV2Models(groups) })
  })

  register('GET', '/api/provider', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, { location: locationInfo(ctx), data: convertToV2Providers(groups) })
  })

  register('GET', '/api/permission/saved', 'json', async (_req, ctx) => json(200, {
    data: ctx.state.savedPermissionsList().map((saved) => ({
      id: saved.toolName,
      sessionID: saved.sessionId,
      grantedAt: saved.grantedAt,
    })),
  }))

  // ---- v1 sessions ----
  register('GET', '/session', 'json', async (_req, ctx) => {
    const list = await rpc(ctx, 'session.list', {})
    const items = filterSessionsByDirectory(list.items, _req.query.get('directory') ?? undefined)
    recordSessionSummaries(ctx, items)
    return json(200, items.map((item) => convertSessionSummary(item, {
      cwd: state.sessionDirectories.get(String(item.sessionId)) ?? cwd,
    })))
  })

  register('GET', '/session/status', 'json', async (_req, ctx) => {
    const list = await rpc(ctx, 'session.list', {})
    const status: Record<string, SessionStatus> = {}
    for (const item of filterSessionsByDirectory(list.items, _req.query.get('directory') ?? undefined)) {
      status[String(item.sessionId)] = item.running ? { type: 'busy' } : { type: 'idle' }
    }
    return json(200, status)
  })

  register('POST', '/session', 'json', (req, ctx) => createSession(req, ctx, false))

  register('POST', '/session/:id/fork', 'json', (req, ctx) => forkSession(req, ctx, false))

  register('POST', '/session/:id/summarize', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await runCompactCommand(ctx, id)
    return json(200, true)
  })

  // Legacy alias kept for clients that call the endpoint by its action name.
  register('POST', '/session/:id/compact', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await runCompactCommand(ctx, id)
    return json(200, true)
  })

  register('GET', '/session/:id', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const view = await sessionView(ctx, id)
    return json(200, toV1Session(view, id, ctx))
  })

  register('PATCH', '/session/:id', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = bodyAsRecord(req.body)
    if (typeof body.title !== 'string') throw badRequest('session update requires a string title')
    await rpc(ctx, 'session.rename', { sessionId: sid(id), title: body.title })
    const view = await sessionView(ctx, id)
    return json(200, toV1Session(view, id, ctx))
  })

  register('GET', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id), maxMessages: limit })
    const defaultModel = await defaultModelRef(ctx)
    const entries = history.events
    return json(200, convertMessagesV1(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd,
        defaultModel,
        onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    ))
  })

  register('POST', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts, cwd)
    const slash = slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return json(200, pendingAssistantPlaceholder(id, cwd, outcome.text))
    }
    await applyModelSelection(ctx, id, req.body)
    await rpc(ctx, 'session.prompt', { sessionId: sid(id), mode: 'queue', content })
    return json(200, pendingAssistantPlaceholder(id, cwd))
  })

  // Alias used by the dsh-oc e2e matrix; the official SDK prompt route is
  // `POST /session/:id/message` (v1) and `POST /api/session/:id/prompt` (v2).
  register('POST', '/session/:id/prompt', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts, cwd)
    const slash = slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return json(200, pendingAssistantPlaceholder(id, cwd, outcome.text))
    }
    await applyModelSelection(ctx, id, req.body)
    await rpc(ctx, 'session.prompt', { sessionId: sid(id), mode: 'queue', content })
    return json(200, pendingAssistantPlaceholder(id, cwd))
  })

  register('POST', '/session/:id/abort', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await rpc(ctx, 'session.cancel', { sessionId: sid(id) })
    return json(200, true)
  })

  register('POST', '/session/:id/command', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = bodyAsRecord(req.body)
    const command = typeof body.command === 'string' ? body.command : ''
    const argumentsRaw = typeof body.arguments === 'string' ? body.arguments : ''
    const name = command.replace(/^\//, '')
    if (name === 'preset') {
      const outcome = await runPresetCommand(ctx, id, argumentsRaw.trim())
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return json(200, pendingAssistantPlaceholder(id, cwd, outcome.text))
    }
    if (name === 'goal') {
      const outcome = await runGoalCommand(ctx, id, argumentsRaw)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return json(200, pendingAssistantPlaceholder(id, cwd, outcome.text))
    }
    if (name === 'help') {
      const outcome = runHelpCommand(ctx, id, argumentsRaw)
      return json(200, pendingAssistantPlaceholder(id, cwd, outcome.text))
    }
    throw badRequest(`unsupported command "${command}"`)
  })

  register('GET', '/session/:id/todo', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
    let todos: unknown
    for (let index = history.events.length - 1; index >= 0; index--) {
      const event = (history.events[index] as HistoryEntry).event
      if (event.type === 'todo/write') {
        todos = event.data.todos
        break
      }
    }
    if (todos === undefined && history.projections) {
      const values = history.projections.values as Partial<Record<string, unknown>>
      if (values.todos !== undefined) todos = values.todos
    }
    return json(200, convertGoalTodos(goalFromHistory(history), todos ?? []))
  })

  register('GET', '/session/:id/diff', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
    return json(200, producedFilesV1(filterGitTrackedDiffs(ctx.cwd, historyFileDiffs(history))))
  })

  // ---- permission / question (legacy v1-style routes) ----
  register('GET', '/permission', 'json', async (_req, ctx) => json(200,
    [...ctx.state.permissions.values()].map(toPermissionRequest),
  ))

  register('POST', '/permission/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await permissionReply(ctx, requestID, req.body)
    return json(200, true)
  })

  register('GET', '/question', 'json', async (_req, ctx) => json(200,
    [...ctx.state.questions.values()].map(toQuestionRequest),
  ))

  register('POST', '/question/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await questionReply(ctx, requestID, req.body)
    return json(200, true)
  })

  register('POST', '/question/:requestID/reject', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await questionReject(ctx, requestID)
    return json(200, true)
  })

  // ---- v2 sessions ----
  register('GET', '/api/session', 'json', async (req, ctx) => {
    const search = req.query.get('search')
    let all: SessionSummary[]
    if (search !== null && search.length > 0) {
      const results = await rpc(ctx, 'session.search', { query: search })
      const ids = new Set(results.items.map((item) => String(item.sessionId)))
      const list = await rpc(ctx, 'session.list', {})
      all = list.items.filter((item) => ids.has(String(item.sessionId)))
    } else {
      const list = await rpc(ctx, 'session.list', {})
      all = list.items
    }
    const filtered = filterSessionsByDirectory(all, req.query.get('directory') ?? undefined)
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const cursorRaw = req.query.get('cursor')
    const offset = cursorRaw === null ? 0 : decodeSessionCursor(cursorRaw)
    const ordered = req.query.get('order') === 'asc' ? [...filtered].reverse() : filtered
    const page = ordered.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    recordSessionSummaries(ctx, page)
    return json(200, {
      data: page.map((item) => convertSessionSummaryV2(item, {
        cwd: state.sessionDirectories.get(String(item.sessionId)) ?? cwd,
      })),
      cursor: {
        ...(nextOffset < filtered.length ? { next: encodeSessionCursor(nextOffset) } : {}),
        ...(offset > 0 ? { previous: encodeSessionCursor(Math.max(0, offset - limit)) } : {}),
      },
    })
  })

  register('POST', '/api/session', 'json', (req, ctx) => createSession(req, ctx, true))

  register('POST', '/api/session/:sessionID/fork', 'json', (req, ctx) => forkSession(req, ctx, true))

  register('POST', '/api/session/:sessionID/compact', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await runCompactCommand(ctx, id)
    return json(204)
  })

  register('POST', '/api/session/:sessionID/prompt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts, cwd)
    const slash = slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return json(200, {
        data: {
          id: `msg_${randomUUID()}`,
          sessionID: id,
          prompt: { parts: content },
          delivery: 'queue',
          timeCreated: Date.now(),
          admittedSeq: 0,
        },
      })
    }
    await applyModelSelection(ctx, id, req.body)
    await rpc(ctx, 'session.prompt', { sessionId: sid(id), mode: 'queue', content })
    return json(200, {
      data: {
        id: `msg_${randomUUID()}`,
        sessionID: id,
        prompt: { parts: content },
        delivery: 'queue',
        timeCreated: Date.now(),
        admittedSeq: 0,
      },
    })
  })

  register('GET', '/api/session/:sessionID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const view = await sessionView(ctx, id)
    return json(200, { data: toV2Session(view, id, ctx) })
  })

  register('POST', '/api/session/:sessionID/model', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await applyModelSelection(ctx, id, req.body)
    return json(204)
  })

  register('POST', '/api/session/:sessionID/agent', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const agent = typeof bodyAsRecord(req.body).agent === 'string'
      ? (bodyAsRecord(req.body).agent as string)
      : ''
    if (agent === '') throw badRequest('agent switch requires a string agent')
    await switchAgentPreset(ctx, id, agent)
    return json(204)
  })

  register('GET', '/api/session/:sessionID/message', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : undefined
    const cursorRaw = req.query.get('cursor')
    const beforeSeq = cursorRaw === null ? undefined : decodeMessageCursor(cursorRaw)
    const history = await rpc(ctx, 'session.history', {
      sessionId: sid(id),
      ...(limit === undefined ? {} : { maxMessages: limit }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    })
    const defaultModel = await defaultModelRef(ctx)
    const entries = history.events
    const oldest = oldestSurfaceSeq(entries)
    const response: SessionMessagesResponse = {
      data: convertMessagesV2(
        entries.map((entry) => entry.event),
        {
          sessionId: id,
          cwd,
          defaultModel,
          onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
        },
        entries.map((entry) => entry.view),
      ),
      cursor: {
        ...(history.hasMore && oldest !== undefined ? { previous: encodeMessageCursor(oldest) } : {}),
      },
    }
    return json(200, response)
  })

  register('GET', '/api/session/:sessionID/diff', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
    return json(200, filterGitTrackedDiffs(ctx.cwd, historyFileDiffs(history)))
  })

  register('GET', '/api/session/:sessionID/permission', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return json(200, { data: ctx.state.permissionsForSession(id).map(toPermissionV2) })
  })

  register('POST', '/api/session/:sessionID/permission/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await permissionReply(ctx, requestID, req.body)
    return json(204)
  })

  register('GET', '/api/session/:sessionID/question', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) })
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await questionReply(ctx, requestID, req.body)
    return json(204)
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reject', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await questionReject(ctx, requestID)
    return json(204)
  })

  // ---- SSE ----
  register('GET', '/global/event', 'sse', async () => ({ status: 200 }))

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
      try {
        const defaultModel = await defaultModelRef(ctx)
        translator = new MuxEventTranslator({
          cwd,
          state,
          defaultModel,
          log,
          onFlush: (events) => {
            for (const event of events) hub.send(client, event)
          },
        })
        const stream = api.events.mux(
          { rpcId: randomUUID() as never, payload: {} },
          controller.signal,
        )
        const hostStream = api.events.host(
          { rpcId: randomUUID() as never, payload: {} },
          controller.signal,
        )
        const hostLoop = (async () => {
          for await (const frame of hostStream) {
            const payload = frame.payload as { type?: string; sessionId?: unknown; message?: unknown }
            if (payload.type === 'host/agent-error') {
              const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
              const message = typeof payload.message === 'string' ? payload.message : 'agent error'
              if (sessionId) hub.send(client, agentErrorEvent(sessionId, message, cwd))
            }
          }
        })().catch((error) => {
          if (!controller.signal.aborted) {
            log(`[bridge/sse] host stream ended: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
        void hostLoop
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
            if (sessionEvent.type === 'session' || sessionEvent.type === 'session/created' || sessionEvent.type === 'session/title') {
              try {
                const list = await rpc(ctx, 'session.list', {})
                recordSessionSummaries(ctx, list.items)
              } catch (error) {
                log(`[bridge/sse] session list refresh failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
          for (const event of translator.translate(frame)) {
            hub.send(client, event)
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        log(`[bridge/sse] mux stream ended: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        translator?.dispose()
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
  }
}

function matchPattern(pattern: string, pathname: string): boolean {
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
