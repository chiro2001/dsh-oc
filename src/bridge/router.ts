import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type {
  HistoryEntry,
  PromptContentPart,
  RequestPayload,
  ResponseValue,
  RpcMethodMap,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { FileDiff as V1FileDiff } from '@opencode-ai/sdk/client'
import type {
  LocationInfo,
  Session as V2Session,
  SessionMessagesResponse,
  SessionStatus,
  SessionV2Info,
} from '@opencode-ai/sdk/v2/types'
import type { Agent as V2Agent, AgentV2Info } from '@opencode-ai/sdk/v2/types'
import type { BridgeApi } from './rpc.js'
import { call, RpcCallError, respondApproval, respondQuestion, cancelQuestion } from './rpc.js'
import {
  badRequest,
  conflict,
  internalError,
  notFound,
  rpcErrorToHttp,
} from './errors.js'
import { convertSessionSummary, convertSessionSummaryV2, minimalSession, minimalSessionV2 } from './convert/session.js'
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
import { convertTodos } from './convert/todo.js'
import { convertProducedFiles } from './events.js'
import { externalProviderId, projectIdFor } from './convert/common.js'
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
}

async function sessionView(ctx: BridgeRouteContext, id: string): Promise<SessionView> {
  const list = await rpc(ctx, 'session.list', {})
  const summary = list.items.find((item) => String(item.sessionId) === id)
  const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
  if (summary?.cwd) ctx.state.sessionDirectories.set(id, summary.cwd)
  return {
    summary,
    events: history.events,
    createdAt: history.events[0]?.event.time,
  }
}

function toV1Session(view: SessionView, id: string, ctx: BridgeRouteContext): V2Session {
  if (view.summary) {
    return convertSessionSummary(view.summary, { cwd: ctx.cwd, createdAt: view.createdAt })
  }
  return minimalSession(id, { cwd: ctx.cwd, createdAt: view.createdAt })
}

function toV2Session(view: SessionView, id: string, ctx: BridgeRouteContext): SessionV2Info {
  if (view.summary) {
    return convertSessionSummaryV2(view.summary, { cwd: ctx.cwd, createdAt: view.createdAt })
  }
  return minimalSessionV2(id, { cwd: ctx.cwd, createdAt: view.createdAt })
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
}

function parsePromptParts(raw: unknown): PromptContentPart[] {
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
      if (typeof part.url !== 'string' || typeof part.mime !== 'string') {
        throw badRequest('file part requires url and mime')
      }
      const match = /^data:([^;,]+);base64,(.+)$/.exec(part.url)
      if (!match) throw badRequest('file part url must be a data URL (images only in first version)')
      const [, mediaType, data] = match
      if (!mediaType || !data) throw badRequest('invalid file data URL')
      parts.push({ type: 'image', mediaType: mediaType as never, data })
      continue
    }
    throw badRequest(`unsupported prompt part type "${String(part.type)}"`)
  }
  return parts
}

function pendingAssistantPlaceholder(sessionID: string, cwd: string): V1MessageEntry {
  return {
    info: {
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
    },
    parts: [],
  }
}

/** The dsh-oc bridge exposes one primary agent so the TUI prompt stays usable. */
const DEFAULT_AGENT_NAME = 'build'

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

async function createSession(
  req: BridgeRequest,
  ctx: BridgeRouteContext,
  v2: boolean,
): Promise<HandlerResult> {
  const body = bodyAsRecord(req.body)
  const parentID = typeof body.parentID === 'string' ? body.parentID : undefined
  const sessionIdInput = typeof body.id === 'string' ? body.id : undefined
  const title = typeof body.title === 'string' ? body.title : undefined
  let id: string
  if (parentID) {
    const result = await rpc(ctx, 'session.fork', { sessionId: sid(parentID) })
    id = String(result.sessionId)
  } else {
    const location = body.location as { directory?: unknown } | undefined
    const directory = typeof location?.directory === 'string' ? location.directory : ctx.cwd
    const result = await rpc(ctx, 'session.create', {
      cwd: directory,
      ...(sessionIdInput === undefined ? {} : { sessionId: sid(sessionIdInput) }),
    })
    id = String(result.sessionId)
  }
  if (title) {
    try {
      await rpc(ctx, 'session.rename', { sessionId: sid(id), title })
    } catch (error) {
      ctx.log(`[bridge] rename of new session ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    // dsh has no persistent grant; degrade to a one-shot allow.
    ctx.log('[bridge] permission "always" downgraded to "allowed-once" (dsh limitation)')
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

function producedFilesV1(value: unknown): V1FileDiff[] {
  return convertProducedFiles(value).map((diff) => ({
    file: diff.file ?? '',
    before: '',
    after: '',
    additions: diff.additions,
    deletions: diff.deletions,
  }))
}

export function createBridgeRouter(
  api: BridgeApi,
  options: RouterOptions = {},
): BridgeRouter {
  const cwd = options.cwd ?? process.cwd()
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
    let directory = ctx.cwd
    try {
      const describe = await rpc(ctx, 'host.describe', {})
      if (describe.cwd) directory = describe.cwd
    } catch (error) {
      ctx.log(`[bridge] host.describe unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
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

  register('GET', '/config', 'json', async () => json(200, {}))

  register('GET', '/config/providers', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, { providers: convertToV1Providers(groups), default: {} })
  })

  register('GET', '/provider', 'json', async (_req, ctx) => {
    const groups = await modelGroups(ctx)
    return json(200, convertToProviderCatalog(groups))
  })

  register('GET', '/provider/auth', 'json', async () => json(200, {}))

  register('GET', '/agent', 'json', async (_req, ctx) => json(200, [await v1DefaultAgent(ctx)]))
  for (const bare of ['/command', '/skill', '/reference', '/integration']) {
    register('GET', bare, 'json', async () => json(200, []))
  }

  // ---- v2 boot / catalog routes ----
  register('GET', '/api/location', 'json', async (_req, ctx) => json(200, locationInfo(ctx)))

  register('GET', '/api/agent', 'json', async (_req, ctx) => json(200, {
    location: locationInfo(ctx),
    data: [await v2DefaultAgent(ctx)],
  }))

  for (const bare of ['/api/command', '/api/skill', '/api/reference', '/api/integration']) {
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

  register('GET', '/api/permission/saved', 'json', async () => json(200, { data: [] }))

  // ---- v1 sessions ----
  register('GET', '/session', 'json', async (_req, ctx) => {
    const list = await rpc(ctx, 'session.list', {})
    for (const item of list.items) {
      if (item.cwd) state.sessionDirectories.set(String(item.sessionId), item.cwd)
    }
    return json(200, list.items.map((item) => convertSessionSummary(item, { cwd })))
  })

  register('GET', '/session/status', 'json', async (_req, ctx) => {
    const list = await rpc(ctx, 'session.list', {})
    const status: Record<string, SessionStatus> = {}
    for (const item of list.items) {
      status[String(item.sessionId)] = item.running ? { type: 'busy' } : { type: 'idle' }
    }
    return json(200, status)
  })

  register('POST', '/session', 'json', (req, ctx) => createSession(req, ctx, false))

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
    return json(200, convertMessagesV1(
      history.events.map((entry) => entry.event),
      {
        sessionId: id,
        cwd,
        defaultModel,
        onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`),
      },
    ))
  })

  register('POST', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts)
    await rpc(ctx, 'session.prompt', { sessionId: sid(id), mode: 'queue', content })
    return json(200, pendingAssistantPlaceholder(id, cwd))
  })

  // Alias used by the dsh-oc e2e matrix; the official SDK prompt route is
  // `POST /session/:id/message` (v1) and `POST /api/session/:id/prompt` (v2).
  register('POST', '/session/:id/prompt', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts)
    await rpc(ctx, 'session.prompt', { sessionId: sid(id), mode: 'queue', content })
    return json(200, pendingAssistantPlaceholder(id, cwd))
  })

  register('POST', '/session/:id/abort', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await rpc(ctx, 'session.cancel', { sessionId: sid(id) })
    return json(200, true)
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
    return json(200, convertTodos(todos ?? []))
  })

  register('GET', '/session/:id/diff', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
    const values = history.projections?.values as Partial<Record<string, unknown>> | undefined
    return json(200, producedFilesV1(values?.['produced-files']))
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
  register('GET', '/api/session', 'json', async (_req, ctx) => {
    const list = await rpc(ctx, 'session.list', {})
    for (const item of list.items) {
      if (item.cwd) state.sessionDirectories.set(String(item.sessionId), item.cwd)
    }
    return json(200, {
      data: list.items.map((item) => convertSessionSummaryV2(item, { cwd })),
      cursor: {},
    })
  })

  register('POST', '/api/session', 'json', (req, ctx) => createSession(req, ctx, true))

  register('POST', '/api/session/:sessionID/prompt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const content = parsePromptParts(bodyAsRecord(req.body).parts)
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

  register('GET', '/api/session/:sessionID/message', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await rpc(ctx, 'session.history', { sessionId: sid(id) })
    const defaultModel = await defaultModelRef(ctx)
    const response: SessionMessagesResponse = {
      data: convertMessagesV2(
        history.events.map((entry) => entry.event),
        {
          sessionId: id,
          cwd,
          defaultModel,
          onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
        },
      ),
      cursor: {},
    }
    return json(200, response)
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
      try {
        const defaultModel = await defaultModelRef(ctx)
        const translator = new MuxEventTranslator({ cwd, state, defaultModel, log })
        const stream = api.events.mux(
          { rpcId: randomUUID() as never, payload: {} },
          controller.signal,
        )
        for await (const frame of stream) {
          for (const event of translator.translate(frame)) {
            hub.broadcast(event)
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        log(`[bridge/sse] mux stream ended: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        hub.remove(client)
      }
    })()
  }

  return {
    ctx,
    match,
    startSse,
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
