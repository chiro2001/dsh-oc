import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  SessionController,
  SessionListRequest,
  SessionListValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionAddress,
  SessionFollowRequest,
  SessionHistoryRecord,
  ModelCatalog,
} from '@deepseek-ai/dsh-api-session-controller'
import type { HistoryEntry, SessionProjectionsBlock } from './dsh-types.js'

/** Shape the bridge history readers consume (pre-0.1.2 convention). */
export interface BridgeHistory {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
}

/**
 * Expand one 0.1.2 `SessionHistoryRecord` into the bridge's `{ event, view }`
 * entries. A plain event passes through; a packed chunk run is reshaped into
 * the `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows the translator
 * already understands (the `chunkrow/` wire prefix is stripped).
 */
export function expandRecord(record: SessionHistoryRecord): HistoryEntry[] {
  if (record.type === 'event') {
    return [{ event: record.event as HistoryEntry['event'] }]
  }
  const raw = record.event as { type: string; seq: number; time: number; data: unknown }
  const kind = raw.type.startsWith('chunkrow/') ? raw.type.slice('chunkrow/'.length) : raw.type
  const base = raw.data as { turn: number; step: number; index: number; dt?: number[] }
  const elapsed = Array.isArray(base.dt)
    ? base.dt.reduce((total, gap) => total + (typeof gap === 'number' ? gap : 0), 0)
    : 0
  return [{
    event: {
      type: kind,
      seq: raw.seq,
      // The wire row's `time` is the first member (time0). Preserve the
      // final member time so reasoning/text parts close at the true end.
      time: raw.time + elapsed,
      time0: raw.time,
      data: base,
    } as HistoryEntry['event'],
  }]
}

/**
 * The dsh 0.1.2 host API surface the bridge actually consumes. Each field is
 * the host-side Cordis service that owns the @Remote business methods; the
 * bridge calls them in-process (no gateway, no browser transport).
 */
export interface BridgeApi {
  /** Router-installed durable address resolver for direct subagent history. */
  sessionAddress?: (sessionId: string) => SessionAddress
  sessionController: Pick<
    SessionController,
    | 'list'
    | 'search'
    | 'create'
    | 'selectModel'
    | 'modelCatalog'
    | 'rename'
    | 'fork'
    | 'prompt'
    | 'cancel'
    | 'page'
    | 'follow'
    | 'control'
    | 'resolveAgent'
  > & {
    /**
     * Optional bridge-level history contract used by unit fixtures. Real hosts
     * omit it; `call('session.history')` then reads through follow/page.
     */
    history?: (
      request: { sessionId?: string; maxMessages?: number; beforeSeq?: number },
      signal?: AbortSignal,
    ) => Promise<BridgeHistory>
    /**
     * Optional bridge-level session-model read used by unit fixtures. Real
     * hosts omit it; `call('session.models')` then derives from modelCatalog.
     */
    models?: (
      request: { sessionId?: string },
    ) => Promise<{ current: { provider: string; model: string; reasoningEffort?: string } }>
  }
  agentPresets: {
    list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
    select(agent: Agent, agentPreset: string): Promise<string>
    defaultId: string
  }
  goals: {
    create(agent: Agent, request: unknown): Promise<unknown>
    edit(agent: Agent, ref: unknown, request: unknown): Promise<unknown>
    pause(agent: Agent, ref: unknown): Promise<unknown>
    resume(agent: Agent, ref: unknown): Promise<unknown>
    complete(agent: Agent, ref: unknown): Promise<unknown>
    clear(agent: Agent, ref: unknown): Promise<unknown>
  }
  sessionSkillCatalog: {
    list(request: unknown, signal?: AbortSignal): Promise<unknown>
  }
  /**
   * dsh human-command registry (`ctx.commands`). Optional so unit fixtures and
   * older hosts without the registry still type-check; the oc profile always
   * mounts it through dsh-base.
   */
  commands?: BridgeCommands
  /** Live agent registry (`ctx.agents`), used to address `/compact`. */
  agents?: BridgeAgents
  /** Host object layers injected by dsh-base; kept for ABI validation. */
  sessions?: unknown
  sessionProjections?: unknown
}

/** Structural view of `@deepseek-ai/dsh-commands` CommandExecution. */
export interface BridgeCommandExecution {
  commandId: unknown
  result: { kind: 'success' | 'error'; text?: string }
}

export interface BridgeCommands {
  execute(
    agent: unknown,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<BridgeCommandExecution | undefined>
}

export interface BridgeAgents {
  get(sessionId: string): unknown
}

/** A dsh 0.1.2 Remote failure, rethrown so the HTTP layer can map its code. */
export class RpcCallError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'RpcCallError'
    this.code = code
    this.details = details
  }
}

/** Normalize a thrown RemoteError-like value into RpcCallError. */
function normalizeRemoteError(error: unknown): RpcCallError {
  if (error instanceof RpcCallError) return error
  if (error instanceof Error) {
    const code = (error as { code?: string }).code
    const details = (error as { details?: unknown }).details
    if (typeof code === 'string') return new RpcCallError(code, error.message, details)
    return new RpcCallError('gateway/internal', error.message, undefined)
  }
  return new RpcCallError('gateway/internal', String(error), undefined)
}

/**
 * Resolve a Session's live Agent through SessionController; a Session-domain
 * failure becomes an RpcCallError carrying its code.
 */
export async function resolveAgent(
  api: BridgeApi,
  sessionId: string,
): Promise<Agent> {
  const result = await api.sessionController.resolveAgent(sessionId as never)
  if ('error' in result) {
    const { code, message, details } = result.error as { code: string; message: string; details?: unknown }
    throw new RpcCallError(code, message, details)
  }
  return result.agent
}

/** Read one opening follow snapshot and close the iterator immediately. */
async function readHistoryThroughFollow(
  api: BridgeApi,
  sessionId: string,
  maxMessages: number | undefined,
  beforeSeq: number | undefined,
  signal: AbortSignal,
): Promise<BridgeHistory> {
  const address: SessionAddress = api.sessionAddress?.(sessionId)
    ?? { kind: 'session', sessionId: sessionId as never }
  const followRequest: SessionFollowRequest = {
    address,
    ...(maxMessages === undefined ? {} : { maxMessages }),
  }
  const it = api.sessionController.follow(followRequest, signal)[Symbol.asyncIterator]()
  try {
    const first = await it.next()
    if (first.done) return { events: [], hasMore: false }
    const snapshot = first.value as {
      type: 'snapshot'
      cursor: number
      records: readonly SessionHistoryRecord[]
      hasMore: boolean
      projections?: SessionProjectionsBlock
    }
    if (snapshot.type !== 'snapshot') return { events: [], hasMore: false }
    let records = snapshot.records
    let hasMore = snapshot.hasMore
    if (beforeSeq !== undefined && beforeSeq <= snapshot.cursor) {
      const page = await api.sessionController.page(
        {
          address,
          throughSeq: snapshot.cursor,
          beforeSeq,
          ...(maxMessages === undefined ? {} : { maxMessages }),
        },
        signal,
      )
      records = page.records
      hasMore = page.hasMore
    }
    return {
      events: records.flatMap(expandRecord),
      hasMore,
      ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
    }
  } finally {
    // `follow()` is a live stream. History consumers only need its opening
    // snapshot, so leaving the iterator open leaks a host subscription and
    // can keep the dsh process alive after the HTTP request completes.
    try {
      await it.return?.()
    } catch {
      // A transport may already have closed the live stream; history reads
      // must keep their snapshot result in that case.
    }
  }
}

function modelSelectionFromHistory(history: BridgeHistory): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const projection = history.projections?.values.modelSelection as {
    next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
    lastUsed?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  } | undefined
  const candidate = projection?.next ?? projection?.lastUsed
  if (candidate !== null && candidate !== undefined
    && typeof candidate.provider === 'string' && typeof candidate.model === 'string') {
    return {
      provider: candidate.provider,
      model: candidate.model,
      ...(typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {}),
    }
  }
  for (let index = history.events.length - 1; index >= 0; index--) {
    const event = history.events[index]?.event
    if (event?.type !== 'model/selection') continue
    const data = event.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof data.provider !== 'string' || typeof data.model !== 'string') continue
    return {
      provider: data.provider,
      model: data.model,
      ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
    }
  }
  return undefined
}

/**
 * Call a dsh host business method in-process. The method name uses the
 * opencode wire convention (`session.list`, `agentPreset.select`, ...); the
 * dispatcher maps it onto the owning host service and unwraps RemoteResult.
 */
export async function call(
  api: BridgeApi,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const sig = signal ?? new AbortController().signal
  try {
    const sessionId = String(payload.sessionId ?? '')
    switch (method) {
      case 'session.list':
        return await api.sessionController.list({} as SessionListRequest, sig)
      case 'session.search':
        return await api.sessionController.search(payload as unknown as SessionSearchRequest, sig)
      case 'session.create':
        return await api.sessionController.create(payload as unknown as SessionCreateRequest)
      case 'session.selectModel':
        return await api.sessionController.selectModel(payload as unknown as SessionSelectModelRequest)
      case 'session.models': {
        // Unit fixtures inject a bridge-level `models` function; the real
        // SessionController exposes no such member, so test hook detection
        // must be `typeof === 'function'` (a bare `!== undefined` check is
        // always true when a private non-function field shadows the name).
        if (typeof api.sessionController.models === 'function') {
          return await api.sessionController.models({ sessionId })
        }
        const catalog = await api.sessionController.modelCatalog()
        try {
          const history = await readHistoryThroughFollow(api, sessionId, undefined, undefined, sig)
          const selected = modelSelectionFromHistory(history)
          if (selected !== undefined) return { current: selected }
        } catch {
          // A cold or deleted session falls back to the deployment default.
        }
        return { current: catalog.default }
      }
      case 'llm.models':
        return await api.sessionController.modelCatalog()
      case 'session.rename':
        return await api.sessionController.rename(payload as unknown as SessionRenameRequest)
      case 'session.fork':
        return await api.sessionController.fork(payload as unknown as SessionForkRequest)
      case 'session.prompt': {
        // dsh 0.1.2 `SessionPromptRequest` requires a client-minted
        // `requestId`: the accepted UserMessage carries it as `source.rpcId`,
        // and an absent (undefined) rpcId makes the whole `agent/inbox/spliced`
        // journal row non-JSON-serializable, so the harness rejects the prompt
        // with `session/agent-busy`. Mint one when the caller did not.
        const request = payload as unknown as SessionPromptRequest
        const promptRequest = {
          ...request,
          ...(request.requestId === undefined
            ? { requestId: randomUUID() as never }
            : {}),
        }
        return await api.sessionController.prompt(promptRequest, sig)
      }
      case 'session.cancel':
        return await api.sessionController.cancel(payload as unknown as SessionCancelRequest)
      case 'session.history': {
        const maxMessages = typeof payload.maxMessages === 'number' ? payload.maxMessages : undefined
        const beforeSeq = typeof payload.beforeSeq === 'number' ? payload.beforeSeq : undefined
        // Unit fixtures may provide a bridge-level history hook; real hosts
        // omit it and the bridge reads through follow/page instead. Detect
        // the hook by `typeof === 'function'`: the real SessionController
        // carries a private non-function `history` field, so a bare
        // `!== undefined` check would treat that shadow as the hook and crash
        // calling it.
        if (typeof api.sessionController.history === 'function') {
          return await api.sessionController.history({ sessionId, maxMessages, beforeSeq }, sig)
        }
        return await readHistoryThroughFollow(api, sessionId, maxMessages, beforeSeq, sig)
      }
      case 'agentPreset.list':
        return await api.agentPresets.list()
      case 'agentPreset.select': {
        const agent = await resolveAgent(api, sessionId)
        return await api.agentPresets.select(agent, String(payload.agentPreset ?? ''))
      }
      case 'goal.create':
      case 'goal.edit': {
        const agent = await resolveAgent(api, sessionId)
        return method === 'goal.create'
          ? await api.goals.create(agent, payload.request ?? payload)
          : await api.goals.edit(agent, payload.ref, payload.request ?? payload)
      }
      case 'goal.pause':
      case 'goal.resume':
      case 'goal.complete':
      case 'goal.clear': {
        const agent = await resolveAgent(api, sessionId)
        const ref = payload.ref
        const op = method.slice('goal.'.length) as 'pause' | 'resume' | 'complete' | 'clear'
        return await api.goals[op](agent, ref)
      }
      case 'skill.list':
        return await api.sessionSkillCatalog.list(payload, signal)
      default:
        throw new Error(`unknown dsh rpc method "${method}"`)
    }
  } catch (error) {
    throw normalizeRemoteError(error)
  }
}
