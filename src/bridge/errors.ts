import type { RpcError } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * opencode-compatible JSON error envelope.
 *
 * The v1 SDK expects `{ name, data: { message } }` while the v2 SDK error
 * helpers accept `{ name, message, data }`. We always emit both so either
 * client can recognise the error.
 */
export interface OpenCodeErrorBody {
  name: string
  message: string
  data?: Record<string, unknown>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: OpenCodeErrorBody,
  ) {
    super(body.message)
    this.name = 'HttpError'
  }
}

function envelope(
  name: string,
  message: string,
  data: Record<string, unknown> = {},
): OpenCodeErrorBody {
  return { name, message, data: { message, ...data } }
}

export function notFound(message: string, data?: Record<string, unknown>): HttpError {
  return new HttpError(404, envelope('NotFoundError', message, data))
}

export function notImplemented(message: string): HttpError {
  return new HttpError(501, envelope('NotFoundError', message))
}

export function badRequest(message: string, data?: Record<string, unknown>): HttpError {
  return new HttpError(400, envelope('BadRequest', message, data))
}

export function conflict(message: string, data?: Record<string, unknown>): HttpError {
  return new HttpError(409, envelope('ConflictError', message, data))
}

export function internalError(message: string, data?: Record<string, unknown>): HttpError {
  return new HttpError(500, envelope('InternalServerError', message, data))
}

/** Error codes the client can correct by re-issuing the request. */
const CLIENT_FIXABLE = new Set<string>([
  'bad-request',
  'title-invalid',
  'command-error',
  'unknown-command',
  'model-unavailable',
  'agent-preset-not-found',
  'agent-preset-invalid',
  'agent-preset-read-only',
  'agent-preset-conflict',
  'settings-rejected',
  'settings-not-exposed',
  'settings-conflict',
  'credential-rejected',
  'attachment-error',
  'directory-unreadable',
  'directory-exists',
  'directory-create-failed',
  'queue-item-not-found',
  'invalid-time-zone',
  'workspace-invalid-path',
  'workspace-name-conflict',
  'model-discovery-failed',
])

/** Codes that mean the session/turn is currently owned by another actor. */
const CONFLICT_CODES = new Set<string>([
  'agent-busy',
  'fork-unavailable',
  'steer-unavailable',
  'session-conflict',
  'subagent-parent-unavailable',
  'subagent-not-found',
  'subagent-catalog-diagnostic',
  'subagent-not-resumable',
  'subagent-unauthorized',
  'subagent-delivery-unavailable',
  'agent-preset-locked',
])

/**
 * Map a dsh RPC error to an opencode-compatible HTTP error. The dsh `code`
 * and `details` are preserved inside `data` so diagnostics never disappear.
 */
export function rpcErrorToHttp(error: RpcError): HttpError {
  const data: Record<string, unknown> = {
    code: error.code,
    details: error.details,
  }
  if (error.code === 'session-not-found') {
    return notFound(error.message, data)
  }
  if (CONFLICT_CODES.has(error.code)) {
    return conflict(error.message, data)
  }
  if (CLIENT_FIXABLE.has(error.code)) {
    return badRequest(error.message, data)
  }
  return internalError(error.message, data)
}
