/**
 * dsh 0.1.2 type shim.
 *
 * dsh 0.1.2 deleted the `@deepseek-ai/dsh-host-apiproxy` package and its
 * `ApiProxy` surface; the oc-bridge now calls host services directly. The
 * types the bridge still names (session summaries, history entries, tool
 * views, projection blocks) are re-homed here as structural views over the
 * 0.1.2 packages so call sites do not chase each relocation.
 */
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  SessionSummary as HostSessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-tools/presentation'

/**
 * Structural session-event view. In dsh 0.1.2 the typed `SessionEvent` union
 * narrowed to the 12 core event types; plugin-merged events (compaction,
 * todo, title, approval, command, preset …) arrive on the live feed as
 * `ignorable` records OUTSIDE that union. The bridge reads them structurally
 * (`type` + JSON-safe `data`), which is the sanctioned path for out-of-repo
 * consumers.
 */
export interface BridgeSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: unknown
}

/**
 * The plugin-merged event names the bridge consumes beyond the core
 * `SessionEvent` union. Each is read structurally.
 */
export type PluginSessionEventType =
  | 'agent/inbox/spliced'
  | 'compaction/start'
  | 'compaction/summary'
  | 'compaction/end'
  | 'tool-call-chunks'
  | 'text-chunks'
  | 'reasoning-chunks'
  | 'todo/write'
  | 'session/title-llm-request'
  | 'permission/preset'
  | 'sandbox/mode'
  | 'approval/policy'
  | 'command/run'
  | 'command/done'
  | 'approval/asked'
  | 'approval/decided'
  | 'agent-preset/selected'
  | 'model/selection'
  | 'goal/change'

/** Core union ∪ plugin events, as the bridge's event feed actually delivers. */
export type BridgeEvent = SessionEvent | {
  readonly type: PluginSessionEventType
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: unknown
}

/** One queued inbox item as surfaced by `session/queue`. */
export interface QueuedInboxItem {
  placement: 'queued' | 'steering' | 'context'
  /** 0.1.2 queue snapshots carry the prompt rpcId beside a source-less message. */
  rpcId?: string
  message: { id: string; content: readonly unknown[]; source?: { kind: string } }
}

/** Host-wide control baseline emitted before queue/job/projection deltas. */
export interface BridgeControlBaseline {
  queues?: Record<string, readonly QueuedInboxItem[]>
  jobs?: Record<string, readonly unknown[]>
  projections?: Record<string, { asOfSeq: number; values: Record<string, unknown> }>
}

/**
 * One frame the bridge event translator consumes. This mirrors the deleted
 * `MuxFrame` wire union but carries a plain `rpcId` field (no RpcRequest
 * envelope): the answerable frames keep it so the HTTP reply routes can
 * correlate, while the pure-push frames leave it optional.
 */
export type BridgeFrame =
  | { type: 'session/event'; sessionId: string; event: BridgeEvent; view?: ToolEventView }
  | { type: 'control/baseline'; value: BridgeControlBaseline }
  | {
      type: 'approval/requested'
      rpcId: string
      sessionId: string
      approvalId: string
      toolName: string
      callId?: string
      reason?: string
    }
  | {
      type: 'approval/resolved'
      sessionId: string
      approvalId: string
      outcome: 'allowed-once' | 'rejected'
    }
  | {
      type: 'question/requested'
      rpcId: string
      sessionId: string
      questions: AskUserQuestionItem[]
    }
  | {
      type: 'question/resolved'
      sessionId: string
      questionRpcId: string
      outcome: 'answered' | 'cancelled'
      answers?: Array<Array<string>>
    }
  | { type: 'session/queue'; sessionId: string; items: QueuedInboxItem[] }
  | { type: 'session/jobs'; sessionId: string; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: { code: string; message: string; details?: unknown } }

/** One frame of the host-level lifecycle stream. */
export type BridgeHostFrame =
  | { type: 'host/agent-error'; sessionId: string; message: string }
  | { type: 'host/session-status'; sessionId: string; running: boolean; updatedAt?: number }
  | { type: 'host/session-activity'; sessionId: string; updatedAt: number }
  | {
      type: 'host/session-added'
      sessionId: string
      summary?: Partial<SessionSummary>
    }
  | { type: 'host/session-removed'; sessionId: string }

/** Per-session agent preset, learned from the creation value or live events. */
export interface SessionSummary extends HostSessionSummary {
  /** Agent preset this session's agent was composed from (may be absent). */
  agentPreset?: string
}

/** One cut of provider-validated projection values at a session event cursor. */
export interface SessionProjectionsBlock {
  asOfSeq: number
  values: Partial<Record<string, unknown>>
}

/**
 * One history record the bridge reads. In 0.1.2 durable history is paginated
 * and chunk-packaged; the bridge expands it back into `{ event, view }` so the
 * rest of the translation layer keeps the pre-0.1.2 shape.
 */
export interface HistoryEntry {
  event: BridgeEvent
  /** Host-computed presenter view for tool call/result events (may be absent). */
  view?: ToolEventView
}

/** Render intent for a `tool/call` or `tool/result` event. */
export type ToolEventView =
  | { for: 'call'; view: ToolCallView }
  | { for: 'result'; view: ToolResultView }

export type { HostSessionSummary }
