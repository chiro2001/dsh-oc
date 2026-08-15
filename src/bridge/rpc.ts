import { randomUUID } from 'node:crypto'
import type {
  ApprovalResponsePayload,
  ApiProxy,
  ClientResponse,
  QuestionResponsePayload,
  RpcError,
  RpcId,
  RpcMethodMap,
  RpcReceipt,
  RpcRequest,
  RpcResponse,
  RequestPayload,
  ResponseValue,
} from '@deepseek-ai/dsh-host-apiproxy/api'

/** The dsh api surface the bridge actually consumes. */
export interface BridgeApi {
  sessions: Pick<
    ApiProxy['sessions'],
    | 'list'
    | 'create'
    | 'fork'
    | 'history'
    | 'models'
    | 'rename'
    | 'prompt'
    | 'cancel'
    | 'selectModel'
  >
  host: Pick<ApiProxy['host'], 'describe'>
  llm: Pick<ApiProxy['llm'], 'models'>
  agentPresets: Pick<ApiProxy['agentPresets'], 'list' | 'select'>
  events: Pick<ApiProxy['events'], 'mux'>
  respond: ApiProxy['respond']
  /**
   * dsh human-command registry (`ctx.commands`). Optional so unit fixtures and
   * older hosts without the registry still type-check; the oc profile always
   * mounts it through dsh-base.
   */
  commands?: BridgeCommands
  /** Live agent registry (`ctx.agents`), used to address `/compact`. */
  agents?: BridgeAgents
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
    signal: AbortSignal,
  ): Promise<BridgeCommandExecution | undefined>
}

export interface BridgeAgents {
  get(sessionId: string): unknown
}

export class RpcCallError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(readonly error: RpcError) {
    super(error.message)
    this.name = 'RpcCallError'
    this.code = error.code
    this.details = error.details
  }
}

const DOMAIN_ALIASES: Record<string, string> = {
  session: 'sessions',
  agentPreset: 'agentPresets',
}

function resolveMethod(
  api: BridgeApi,
  method: string,
): (...args: unknown[]) => Promise<RpcResponse<unknown>> {
  const dot = method.indexOf('.')
  const domain = dot === -1 ? method : method.slice(0, dot)
  const name = dot === -1 ? method : method.slice(dot + 1)
  const holder = (api as unknown as Record<string, Record<string, unknown>>)[
    DOMAIN_ALIASES[domain] ?? domain
  ]
  const fn = holder?.[name]
  if (typeof fn !== 'function') {
    throw new Error(`unknown dsh rpc method "${method}"`)
  }
  return fn.bind(holder) as (...args: unknown[]) => Promise<RpcResponse<unknown>>
}

function brandRpcId(value: string): RpcId {
  return value as RpcId
}

/**
 * Call a dsh unary RPC with a freshly minted rpcId, unwrapping the
 * `RpcResponse.result` envelope. A failed result becomes `RpcCallError`.
 */
export async function call<K extends keyof RpcMethodMap>(
  api: BridgeApi,
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  const rpcId = brandRpcId(randomUUID())
  const request = { rpcId, payload } as RpcRequest<RequestPayload<K>>
  const fn = resolveMethod(api, method) as (
    request: RpcRequest<RequestPayload<K>>,
    signal?: AbortSignal,
  ) => Promise<RpcResponse<ResponseValue<K>>>
  const response = await (signal === undefined ? fn(request) : fn(request, signal))
  if (!response.result.ok) {
    throw new RpcCallError(response.result.error)
  }
  return response.result.value
}

/** Send a client-response for an approval request (echoing the mux rpcId). */
export async function respondApproval(
  api: BridgeApi,
  rpcId: string,
  sessionId: string,
  approvalId: string,
  outcome: 'allowed-once' | 'rejected',
): Promise<RpcReceipt> {
  const value: ApprovalResponsePayload = {
    sessionId: sessionId as never,
    approvalId: approvalId as never,
    outcome,
  }
  return api.respond(clientResponse(rpcId, { ok: true, value }))
}

/** Send a client-response answering a question batch. */
export async function respondQuestion(
  api: BridgeApi,
  rpcId: string,
  sessionId: string,
  answers: Array<{ id: string; selected: string[]; custom?: string }>,
): Promise<RpcReceipt> {
  const value: QuestionResponsePayload = {
    sessionId: sessionId as never,
    answer: { answers },
  }
  return api.respond(clientResponse(rpcId, { ok: true, value }))
}

/** Send a cancelled client-response (used by question reject). */
export async function cancelQuestion(
  api: BridgeApi,
  rpcId: string,
): Promise<RpcReceipt> {
  const message = clientResponse(rpcId, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'cancelled by user',
      details: {},
    },
  })
  return api.respond(message)
}

function clientResponse(
  rpcId: string,
  result: RpcResponse<unknown>['result'],
): ClientResponse {
  return {
    type: 'client-response',
    rpcId: brandRpcId(rpcId),
    result,
  }
}
