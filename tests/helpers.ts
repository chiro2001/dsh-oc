import type { RpcError, RpcErrorCode } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BridgeApi } from '../src/bridge/rpc.js'

export function sessionEvent(
  type: string,
  data: unknown,
  seq = 1,
  time = 1000,
): SessionEvent {
  return {
    type,
    seq,
    time,
    data,
  } as unknown as SessionEvent
}

export function okRpc<T>(value: T) {
  return { rpcId: 'rpc-1' as never, result: { ok: true as const, value } }
}

export function errRpc(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = {
    code: code as RpcErrorCode,
    message,
    details: details as never,
  } as unknown as RpcError
  return {
    rpcId: 'rpc-1' as never,
    result: { ok: false as const, error },
  }
}

export function fakeApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  const api: BridgeApi = {
    sessions: {
      list: async () => okRpc({ items: [] }),
      create: async () => okRpc({ sessionId: 'new-session' as never }),
      fork: async () => okRpc({ sessionId: 'fork-session' as never }),
      history: async () => okRpc({ events: [], hasMore: false }),
      rename: async () => okRpc({ title: 'renamed', seq: 3 }),
      prompt: async () => okRpc({ accepted: true }),
      cancel: async () => okRpc({ accepted: true }),
    },
    host: {
      describe: async () =>
        okRpc({ version: '0.1.0-rc.6', cwd: '/work', attachedSessions: 0, canOpenPath: false }),
    },
    llm: {
      models: async () => okRpc({ groups: [], failures: [] }),
    },
    events: {
      mux: async function* () {
        return
      },
    },
    respond: async () => ({ accepted: true }),
  }
  return { ...api, ...overrides } as BridgeApi
}

export function makeUserEvent(
  text: string,
  id = 'msg-user-1',
  time = 1100,
): SessionEvent<'user/message'> {
  return sessionEvent('user/message', {
    id: id as never,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, 2, time) as SessionEvent<'user/message'>
}

export function makeAssistantEvent(
  blocks: unknown[],
  id = 'msg-assistant-1',
  time = 1200,
  usage?: { inputTokens: number; outputTokens: number },
): SessionEvent<'assistant/message'> {
  return sessionEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: id as never,
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
    },
    ...(usage === undefined ? {} : { usage }),
  }, 3, time) as SessionEvent<'assistant/message'>
}
