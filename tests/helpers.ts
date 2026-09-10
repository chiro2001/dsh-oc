import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { BridgeApi } from '../src/bridge/rpc.js'
import { RpcCallError } from '../src/bridge/rpc.js'

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

/** Host services return plain values; `okRpc` is now an identity helper. */
export function okRpc<T>(value: T): T {
  return value
}

/** Host services throw on failure; `errRpc` throws a RemoteError-like error. */
export function errRpc(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new RpcCallError(code, message, details)
}

/** Wrap an old-style history result into a follow override (test fixture). */
export function followWith(
  events: Array<{ event: unknown; view?: unknown }>,
  hasMore = false,
  projections?: { asOfSeq: number; values: Record<string, unknown> },
): (request: unknown, signal?: AbortSignal) => AsyncIterable<SessionFollowFrame> {
  return async function* () {
    yield {
      type: 'snapshot',
      header: {} as never,
      cursor: events.length > 0 ? events.length : -1,
      records: events.map((e) => ({ type: 'event', event: e.event } as never)),
      hasMore,
      projections: projections ?? { asOfSeq: -1, values: {} },
    } as SessionFollowFrame
  }
}

export function fakeApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  const api: BridgeApi = {
    sessionController: {
      list: async () => ({ items: [] }),
      search: async () => ({ items: [], hasMore: false }),
      create: async () => ({ sessionId: 'new-session' as never }),
      fork: async () => ({ sessionId: 'fork-session' as never }),
      prompt: async () => ({ accepted: true }),
      cancel: () => ({ accepted: true as const }),
      selectModel: async () => ({
        selected: { provider: 'deepseek-official', model: 'mock-model', reasoningEffort: 'off' },
      }),
      modelCatalog: async () => ({
        default: { provider: 'deepseek-official', model: 'mock-model' },
        routableProviders: ['deepseek-official'],
        groups: [],
        failures: [],
      }),
      rename: async () => ({ title: 'renamed', seq: 3 }),
      page: async () => ({ records: [], hasMore: false }),
      follow: followWith([]),
      control: async function* () {},
      resolveAgent: async () => ({ agent: { id: 'agent-1' } as never }),
      history: async () => ({ events: [], hasMore: false }),
      models: async () => ({ current: { provider: 'deepseek-official', model: 'mock-model' } }),
    },
    agentPresets: {
      list: async () => [],
      select: async () => 'minimal',
      defaultId: 'minimal',
    },
    goals: {
      create: async () => ({ id: 'goal-1' as never, revision: 1 }),
      edit: async () => ({ id: 'goal-1' as never, revision: 2 }),
      pause: async () => ({ id: 'goal-1' as never, revision: 2 }),
      resume: async () => ({ id: 'goal-1' as never, revision: 3 }),
      complete: async () => ({ id: 'goal-1' as never, revision: 4 }),
      clear: async () => ({ cleared: true }),
    },
    sessionSkillCatalog: {
      list: async () => ({ skills: [] }),
    },
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
  stream?: AssistantStreamRecord[],
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
    ...(stream === undefined ? {} : { stream }),
  }, 3, time) as SessionEvent<'assistant/message'>
}
