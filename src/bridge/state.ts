import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { HistoryEntry, SessionProjectionsBlock, SessionSummary } from './dsh-types.js'
import type { PermissionEntry } from './convert/permission.js'
import type { QuestionEntry } from './convert/question.js'
import type { V1MessageEntry } from './convert/message.js'

/** A memory-scoped "always" grant for one session + tool. */
export interface SavedPermission {
  sessionId: string
  toolName: string
  grantedAt: number
}

/** One cached history page (tail or bounded by limit/beforeSeq). */
export interface CachedHistory {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
}

/** One user-visible message sitting in a dsh pending inbox queue. */
export interface QueuedInboxMessage {
  id: string
  rpcId?: string
  /** dsh `UserMessage` content blocks (only text blocks are rendered). */
  content: readonly unknown[]
  source: { kind: string }
  /** When the message entered the queue (splice event time). */
  enqueuedAt: number
}

function sourceForQueueItem(
  placement: 'queued' | 'steering' | 'context',
  source: { kind: string; rpcId?: string } | undefined,
): { kind: string } {
  if (source !== undefined) return source
  // The 0.1.2 control ABI deliberately omits `source` from queue messages.
  // Ordinary queued/steering entries are user prompts; context entries are
  // host-injected context and must not become user cards in the TUI.
  return { kind: placement === 'context' ? 'context' : 'user' }
}

/** dsh inbox queue state mirrored by the bridge for opencode display. */
export interface InboxProjection {
  nextTurn: QueuedInboxMessage[]
  nextStep: QueuedInboxMessage[]
}

export interface InboxSpliceOutcome {
  added: QueuedInboxMessage[]
  removed: QueuedInboxMessage[]
}

/** One dsh delegation waiting for its session-backed child identity. */
export interface SubagentCallRecord {
  parentSessionId: string
  callId: string
  toolName: string
  arguments: string
  messageId: string
  description: string
  prompt: string
  subagentType: string
  background?: boolean
  turn?: number
  step?: number
  createdAt: number
  childSessionId?: string
  childMode?: 'one-shot' | 'continuable'
  /** Whether the parent Task part has already reached the SSE stream. */
  partEmitted?: boolean
  /** Terminal result retained so a late child association cannot regress it. */
  resultStatus?: 'completed' | 'error'
  resultTime?: number
  resultContent?: readonly unknown[]
  resultError?: { name?: string; code?: string }
}

/** Durable/live facts learned for one dsh subagent child. */
export interface SubagentChildRecord {
  sessionId: string
  parentSessionId: string
  label?: string
  mode?: 'one-shot' | 'continuable'
  title?: string
  agent?: string
  cwd?: string
  addedAt: number
  /** Host lifecycle arrival may use parent-local FIFO before descriptor data. */
  allowFifo?: boolean
}

/**
 * In-memory correlation maps between opencode-facing request ids and the dsh
 * rpcIds/approval ids that answer them. Populated from the mux stream; the
 * HTTP reply routes read it back.
 */
export class InteractionState {
  readonly permissions = new Map<string, PermissionEntry>()
  readonly questions = new Map<string, QuestionEntry>()
  readonly byApprovalId = new Map<string, string>()
  readonly byQuestionRpcId = new Map<string, string>()
  readonly sessionDirectories = new Map<string, string>()
  readonly sessionParents = new Map<string, string>()
  readonly sessionAddressModes = new Map<string, 'one-shot' | 'continuable'>()
  /** Sessions whose durable origin is the dsh subagent seam. */
  readonly sessionOrigins = new Set<string>()
  /** Pending/associated dsh delegation calls, keyed by parent + call id. */
  readonly subagentCalls = new Map<string, SubagentCallRecord>()
  /** Child records learned from api-session/added, projection, or summaries. */
  readonly subagentChildren = new Map<string, SubagentChildRecord>()
  /** Descriptor facts that can precede the host lifecycle summary. */
  readonly subagentDescriptorFacts = new Map<string, Pick<SubagentChildRecord, 'label' | 'mode'>>()
  /** Child additions that arrived before their parent tool/call was translated. */
  readonly pendingSubagentChildren = new Map<string, SubagentChildRecord[]>()
  /** Authoritative live Agent state mirrored from dsh api-session/status. */
  readonly sessionRunning = new Map<string, boolean>()
  /** Last status/activity observation used for reconnect diagnostics. */
  readonly sessionStatusUpdatedAt = new Map<string, number>()
  /** Last realtime status edge broadcast to connected SSE clients. */
  private readonly sessionStatusBroadcast = new Map<string, boolean>()
  readonly savedPermissions = new Map<string, SavedPermission>()
  /** Last explicit model selection (with variant) per session, for self-heal. */
  readonly sessionModelSelections = new Map<string, {
    providerID: string
    modelID: string
    variant?: string
  }>()
  /** Real durable titles learned from history projections / title events. */
  readonly sessionTitles = new Map<string, string>()
  /** Last known agent preset per session (survives title/projection updates). */
  private readonly sessionAgents = new Map<string, string>()
  /** One stale editor-agent value to suppress after an explicit /preset switch. */
  private readonly stalePresetPrompts = new Map<string, { from: string; to: string }>()
  /** Recent bridge-only command result cards retained for history hydration. */
  private readonly recentCommandResults = new Map<string, V1MessageEntry[]>()
  /** Mirror of each session's dsh pending inbox (next-turn / next-step). */
  readonly inboxProjections = new Map<string, InboxProjection>()
  /** Message ids already surfaced to the TUI as queued user messages. */
  readonly presentQueuedIds = new Set<string>()
  /** dsh user message ids already echoed by the prompt route (broadcast). */
  private readonly broadcastDshIds = new Set<string>()
  /** TUI-generated `messageID`s from prompt submissions, FIFO per session. */
  private readonly promptMessageIds = new Map<string, string[]>()
  /** Original optimistic-card timestamp, keyed by the TUI prompt id. */
  private readonly promptMessageTimes = new Map<string, number>()
  /** dsh user message id -> TUI prompt id (kept so history echoes match). */
  private readonly dshPromptMessageIds = new Map<string, string>()
  /** Bridge-generated assistant message ids keyed by user message id. */
  private readonly assistantIdsByUser = new Map<string, Map<string, string>>()
  /** dsh assistant message id -> bridge assistant id (history echo match). */
  private readonly dshAssistantIds = new Map<string, string>()
  /** Canonical live-card timestamp keyed by the bridge assistant id. */
  private readonly assistantMessageTimes = new Map<string, number>()
  /** Assistant cards whose turn/tool step is still live. */
  private readonly pendingAssistantIds = new Set<string>()
  sessionListCache?: { items: SessionSummary[]; at: number }
  /** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
  sessionListLoading?: Promise<SessionSummary[]>
  private sessionListGeneration = 0
  /** One bounded cold seed for the status endpoint; never retry in a poll loop. */
  sessionStatusSeedAttempted = false
  sessionStatusSeeded = false
  sessionStatusLoading?: Promise<void>
  /** Lightweight counters used to prove the status poll has no list storm. */
  sessionStatusRequests = 0
  sessionStatusSeeds = 0
  sessionListRpcCalls = 0
  /** Whether this bridge run accepted new user input (banner-bearing content). */
  newInputDuringRun = false
  /** The session the TUI most recently created/resumed/opened. */
  currentSessionId?: string
  /** Last agent preset selected during this run (inherited by new sessions). */
  lastAgentPreset?: string
  readonly historyCache = new Map<string, { value: CachedHistory; at: number }>()
  private readonly historyLoading = new Map<string, Promise<CachedHistory>>()
  private readonly historyGenerations = new Map<string, number>()

  private static subagentCallKey(parentSessionId: string, callId: string): string {
    return `${parentSessionId}\u0000${callId}`
  }

  private static subagentChildMatchesCall(
    child: SubagentChildRecord,
    call: SubagentCallRecord,
  ): boolean {
    if (child.parentSessionId !== call.parentSessionId) return false
    if (child.label === undefined || child.label.length === 0) return true
    return child.label === call.description
  }

  private attachSubagentChild(
    child: SubagentChildRecord,
    call: SubagentCallRecord,
  ): void {
    call.childSessionId = child.sessionId
    const mode = child.mode ?? call.childMode
    if (mode !== undefined) call.childMode = mode
    this.subagentCalls.set(InteractionState.subagentCallKey(call.parentSessionId, call.callId), call)
    this.subagentChildren.set(child.sessionId, child)
    this.sessionOrigins.add(child.sessionId)
    this.sessionParents.set(child.sessionId, child.parentSessionId)
    if (mode !== undefined) this.sessionAddressModes.set(child.sessionId, mode)
    if (child.cwd !== undefined) this.sessionDirectories.set(child.sessionId, child.cwd)
    if (child.title !== undefined && child.title.length > 0) this.setSessionTitle(child.sessionId, child.title)
    if (child.agent !== undefined && child.agent.length > 0) this.setSessionAgent(child.sessionId, child.agent)
  }

  private matchPendingChildForCall(call: SubagentCallRecord): SubagentChildRecord | undefined {
    const pending = this.pendingSubagentChildren.get(call.parentSessionId)
    if (pending === undefined || pending.length === 0) return undefined
    const exactIndex = pending.findIndex((child) => child.label !== undefined
      && InteractionState.subagentChildMatchesCall(child, call))
    // A host/session-added frame normally arrives in child creation order. If
    // no descriptor label is available yet, the FIFO entry is the only stable
    // fallback; descriptor/projection enrichment can still supply the exact
    // mode and label later.
    const fifoIndex = pending.findIndex((child) => child.allowFifo === true)
    if (exactIndex === -1 && fifoIndex === -1) return undefined
    const index = exactIndex === -1 ? fifoIndex : exactIndex
    const child = pending.splice(index, 1)[0]
    if (pending.length === 0) this.pendingSubagentChildren.delete(call.parentSessionId)
    return child
  }

  /** Register a parent tool call and attach any child that arrived first. */
  registerSubagentCall(call: SubagentCallRecord): SubagentCallRecord {
    const key = InteractionState.subagentCallKey(call.parentSessionId, call.callId)
    const existing = this.subagentCalls.get(key)
    if (existing !== undefined) {
      if (existing.childSessionId === undefined) {
        const child = this.matchPendingChildForCall(existing)
        if (child !== undefined) this.attachSubagentChild(child, existing)
      }
      return existing
    }
    this.subagentCalls.set(key, call)
    const child = this.matchPendingChildForCall(call)
    if (child !== undefined) this.attachSubagentChild(child, call)
    return call
  }

  /** Return a registered dsh delegation call, if any. */
  subagentCallFor(parentSessionId: string, callId: string): SubagentCallRecord | undefined {
    return this.subagentCalls.get(InteractionState.subagentCallKey(parentSessionId, callId))
  }

  /** Return the child associated with one parent tool call, if known. */
  subagentChildForCall(parentSessionId: string, callId: string): SubagentChildRecord | undefined {
    const call = this.subagentCallFor(parentSessionId, callId)
    return call?.childSessionId === undefined ? undefined : this.subagentChildren.get(call.childSessionId)
  }

  /**
   * Associate one host/session-added or projection-derived child. The child
   * may arrive before the parent's tool/call event reaches the translator.
   * Label equality wins; otherwise parent-local FIFO is deterministic.
   */
  associateSubagentChild(child: SubagentChildRecord): SubagentCallRecord | undefined {
    const previous = this.subagentChildren.get(child.sessionId)
    const descriptor = this.subagentDescriptorFacts.get(child.sessionId)
    const merged: SubagentChildRecord = previous === undefined
      ? { ...child, ...(descriptor ?? {}) }
      : {
          ...previous,
          ...child,
          ...(descriptor ?? {}),
          addedAt: previous.addedAt,
        }
    this.subagentChildren.set(child.sessionId, merged)
    this.sessionOrigins.add(child.sessionId)
    this.sessionParents.set(child.sessionId, merged.parentSessionId)
    if (merged.mode !== undefined) this.sessionAddressModes.set(child.sessionId, merged.mode)
    if (merged.cwd !== undefined) this.sessionDirectories.set(child.sessionId, merged.cwd)
    if (merged.title !== undefined && merged.title.length > 0) this.setSessionTitle(child.sessionId, merged.title)
    if (merged.agent !== undefined && merged.agent.length > 0) this.setSessionAgent(child.sessionId, merged.agent)

    const associated = [...this.subagentCalls.values()].find((call) => call.childSessionId === child.sessionId)
    if (associated !== undefined) return associated

    const calls = [...this.subagentCalls.values()]
      .filter((call) => call.parentSessionId === merged.parentSessionId && call.childSessionId === undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.callId.localeCompare(right.callId))
    const exact = calls.find((call) => merged.label !== undefined
      && InteractionState.subagentChildMatchesCall(merged, call))
    const call = exact ?? (merged.allowFifo === true ? calls[0] : undefined)
    if (call !== undefined) {
      this.attachSubagentChild(merged, call)
      return call
    }

    const pending = this.pendingSubagentChildren.get(merged.parentSessionId) ?? []
    const pendingIndex = pending.findIndex((candidate) => candidate.sessionId === merged.sessionId)
    if (pendingIndex === -1) pending.push(merged)
    else pending[pendingIndex] = merged
    this.pendingSubagentChildren.set(merged.parentSessionId, pending)
    return undefined
  }

  /** Enrich a previously associated child with descriptor/projection facts. */
  enrichSubagentChild(
    sessionId: string,
    update: Partial<Pick<SubagentChildRecord, 'label' | 'mode' | 'title' | 'agent' | 'cwd'>>,
  ): SubagentCallRecord | undefined {
    const child = this.subagentChildren.get(sessionId)
    if (child === undefined) {
      const previous = this.subagentDescriptorFacts.get(sessionId) ?? {}
      this.subagentDescriptorFacts.set(sessionId, { ...previous, ...update })
      return undefined
    }
    const next: SubagentChildRecord = { ...child, ...update }
    this.subagentChildren.set(sessionId, next)
    this.sessionOrigins.add(sessionId)
    if (next.mode !== undefined) {
      this.sessionAddressModes.set(sessionId, next.mode)
      const call = [...this.subagentCalls.values()].find((candidate) => candidate.childSessionId === sessionId)
      if (call !== undefined) call.childMode = next.mode
    }
    if (next.title !== undefined && next.title.length > 0) this.setSessionTitle(sessionId, next.title)
    if (next.agent !== undefined && next.agent.length > 0) this.setSessionAgent(sessionId, next.agent)
    if (next.cwd !== undefined) this.sessionDirectories.set(sessionId, next.cwd)
    return [...this.subagentCalls.values()].find((candidate) => candidate.childSessionId === sessionId)
  }

  /** Store descriptor/projection identity even before host/session-added. */
  recordSubagentDescriptor(
    sessionId: string,
    update: Pick<SubagentChildRecord, 'label' | 'mode'>,
  ): SubagentCallRecord | undefined {
    const previous = this.subagentDescriptorFacts.get(sessionId) ?? {}
    this.subagentDescriptorFacts.set(sessionId, { ...previous, ...update })
    return this.enrichSubagentChild(sessionId, update)
  }

  /** Whether a session is a durable subagent child. */
  isSubagentSession(sessionId: string): boolean {
    return this.sessionOrigins.has(sessionId)
  }

  recordCommandResult(sessionId: string, entry: V1MessageEntry): void {
    const results = this.recentCommandResults.get(sessionId) ?? []
    if (results.some((item) => item.info.id === entry.info.id)) return
    results.push(entry)
    if (results.length > 20) results.shift()
    this.recentCommandResults.set(sessionId, results)
  }

  commandResultsFor(sessionId: string): readonly V1MessageEntry[] {
    return this.recentCommandResults.get(sessionId) ?? []
  }

  getSessionListCache(ttlMs: number): SessionSummary[] | undefined {
    const cached = this.sessionListCache
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.items
    return undefined
  }

  setSessionListCache(items: SessionSummary[]): void {
    this.sessionListCache = { items, at: Date.now() }
  }

  getHistoryCache(key: string, ttlMs: number): CachedHistory | undefined {
    const entry = this.historyCache.get(key)
    if (entry !== undefined && Date.now() - entry.at < ttlMs) return entry.value
    return undefined
  }

  setHistoryCache(key: string, value: CachedHistory): void {
    this.historyCache.set(key, { value, at: Date.now() })
  }

  getHistoryLoading(key: string): Promise<CachedHistory> | undefined {
    return this.historyLoading.get(key)
  }

  setHistoryLoading(key: string, promise: Promise<CachedHistory>): void {
    this.historyLoading.set(key, promise)
  }

  clearHistoryLoading(key: string, promise: Promise<CachedHistory>): void {
    if (this.historyLoading.get(key) === promise) this.historyLoading.delete(key)
  }

  historyGeneration(key: string): number {
    return this.historyGenerations.get(key) ?? 0
  }

  listGeneration(): number {
    return this.sessionListGeneration
  }

  setSessionRunning(sessionId: string, running: boolean, updatedAt = 0): void {
    const current = this.sessionStatusUpdatedAt.get(sessionId)
    // Equal timestamps intentionally keep queue order: a later edge in the
    // serialized per-session queue is authoritative. Older host/list edges
    // must not roll a newer turn edge back to the opposite status.
    if (current !== undefined && updatedAt < current) return
    this.sessionRunning.set(sessionId, running)
    this.sessionStatusUpdatedAt.set(sessionId, updatedAt)
  }

  sessionRunningFor(sessionId: string): boolean | undefined {
    return this.sessionRunning.get(sessionId)
  }

  sessionStatusUpdatedAtFor(sessionId: string): number | undefined {
    return this.sessionStatusUpdatedAt.get(sessionId)
  }

  /**
   * Claim one live session.status edge for broadcast. dsh 0.1.2 reports the
   * same turn edge through both Session events and api-session/status; the
   * authoritative state guard also rejects an older opposite edge before it
   * can mark the session idle/busy incorrectly. SSE snapshots deliberately do
   * not use this method because every new client needs its own snapshot.
   */
  shouldBroadcastSessionStatus(sessionId: string, running: boolean): boolean {
    const authoritative = this.sessionRunning.get(sessionId)
    if (authoritative !== undefined && authoritative !== running) return false
    if (this.sessionStatusBroadcast.get(sessionId) === running) return false
    this.sessionStatusBroadcast.set(sessionId, running)
    return true
  }

  markSessionStatusSeeded(): void {
    this.sessionStatusSeeded = true
  }

  markSessionActivity(sessionId: string, updatedAt: number): void {
    const current = this.sessionStatusUpdatedAt.get(sessionId) ?? 0
    if (updatedAt >= current) this.sessionStatusUpdatedAt.set(sessionId, updatedAt)
  }

  /** Drop list and (optionally per-session) history caches after any mutation. */
  invalidateSession(sessionId?: string): void {
    this.sessionListCache = undefined
    this.sessionListLoading = undefined
    this.sessionListGeneration += 1
    this.invalidateHistory(sessionId)
  }

  /** Drop only history pages (used by the live SSE feed). */
  invalidateHistory(sessionId?: string): void {
    const bump = (key: string): void => {
      this.historyGenerations.set(key, (this.historyGenerations.get(key) ?? 0) + 1)
    }
    if (sessionId === undefined) {
      for (const key of [...this.historyCache.keys()]) bump(key)
      for (const key of [...this.historyLoading.keys()]) bump(key)
      this.historyCache.clear()
      this.historyLoading.clear()
      return
    }
    for (const key of [...this.historyCache.keys()]) {
      if (key === sessionId || key.startsWith(`${sessionId}:`)) {
        bump(key)
        this.historyCache.delete(key)
      }
    }
    for (const key of [...this.historyLoading.keys()]) {
      if (key === sessionId || key.startsWith(`${sessionId}:`)) {
        bump(key)
        this.historyLoading.delete(key)
      }
    }
  }

  private static savedKey(sessionId: string, toolName: string): string {
    return `${sessionId}\u0000${toolName}`
  }

  savePermission(sessionId: string, toolName: string): SavedPermission {
    const saved: SavedPermission = { sessionId, toolName, grantedAt: Date.now() }
    this.savedPermissions.set(InteractionState.savedKey(sessionId, toolName), saved)
    return saved
  }

  savedPermissionFor(sessionId: string, toolName: string): SavedPermission | undefined {
    return this.savedPermissions.get(InteractionState.savedKey(sessionId, toolName))
  }

  savedPermissionsList(): SavedPermission[] {
    return [...this.savedPermissions.values()]
  }

  /** Wire id for `/api/permission/saved/{id}` (unique per session + tool). */
  savedPermissionId(saved: SavedPermission): string {
    return `${saved.sessionId}:${saved.toolName}`
  }

  /**
   * Remove one saved grant. Prefers the composite `sessionID:toolName` id;
   * a bare tool name is accepted for compatibility and removes the first
   * matching grant.
   */
  removeSavedPermission(id: string): boolean {
    for (const [key, saved] of this.savedPermissions) {
      if (this.savedPermissionId(saved) === id || saved.toolName === id) {
        this.savedPermissions.delete(key)
        return true
      }
    }
    return false
  }

  setSessionModelSelection(
    sessionId: string,
    selection: { providerID: string; modelID: string; variant?: string },
  ): void {
    // A default-tier model is still an explicit session choice. Dropping it
    // here would make the next prompt silently fall back to catalog.default.
    this.sessionModelSelections.set(sessionId, selection)
  }

  sessionModelSelectionFor(sessionId: string): { providerID: string; modelID: string; variant?: string } | undefined {
    return this.sessionModelSelections.get(sessionId)
  }

  /** Per-session inbox projection, created on first touch. */
  inboxProjectionFor(sessionId: string): InboxProjection {
    let projection = this.inboxProjections.get(sessionId)
    if (projection === undefined) {
      projection = { nextTurn: [], nextStep: [] }
      this.inboxProjections.set(sessionId, projection)
    }
    return projection
  }

  private queuedKey(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }

  /** Whether a user message id was already surfaced as a queued card. */
  hasPresentedQueued(sessionId: string, messageId: string): boolean {
    return this.presentQueuedIds.has(this.queuedKey(sessionId, messageId))
  }

  /** Forget a presented queued id once the same message becomes durable. */
  clearPresentedQueued(sessionId: string, messageId: string): void {
    this.presentQueuedIds.delete(this.queuedKey(sessionId, messageId))
  }

  /** Remember a durable user message id already broadcast by the prompt route. */
  markBroadcastDshId(sessionId: string, dshId: string): void {
    this.broadcastDshIds.add(`${sessionId}\u0000${dshId}`)
  }

  /** Whether the durable user message was already broadcast at submission. */
  isBroadcastDshId(sessionId: string, dshId: string): boolean {
    return this.broadcastDshIds.has(`${sessionId}\u0000${dshId}`)
  }

  /** Register a TUI-generated message id for the next user echo of a session. */
  registerPromptMessageId(sessionId: string, promptId: string, createdAt = Date.now()): void {
    const queue = this.promptMessageIds.get(sessionId)
    if (queue === undefined) {
      this.promptMessageIds.set(sessionId, [promptId])
    } else {
      queue.push(promptId)
    }
    this.promptMessageTimes.set(`${sessionId}\u0000${promptId}`, createdAt)
  }

  /** Timestamp used by the optimistic user card and its queue-state update. */
  promptMessageCreatedAt(sessionId: string, promptId: string): number | undefined {
    return this.promptMessageTimes.get(`${sessionId}\u0000${promptId}`)
  }

  /** Oldest registered prompt id that has not been echoed yet, if any. */
  peekPromptMessageId(sessionId: string): string | undefined {
    return this.promptMessageIds.get(sessionId)?.[0]
  }

  /**
   * Consume the oldest prompt id for a session once its dsh user message
   * arrives; returns the surface id (prompt id when known, else the dsh id).
   */
  takePromptMessageId(sessionId: string, dshId: string): string {
    const queue = this.promptMessageIds.get(sessionId)
    const promptId = queue?.shift()
    if (queue !== undefined && queue.length === 0) this.promptMessageIds.delete(sessionId)
    if (promptId === undefined) return dshId
    this.dshPromptMessageIds.set(`${sessionId}\u0000${dshId}`, promptId)
    this.promptMessageTimes.delete(`${sessionId}\u0000${promptId}`)
    return promptId
  }

  /** Map a durable dsh message id back to its TUI prompt id, if registered. */
  promptIdForDshId(sessionId: string, dshId: string): string | undefined {
    return this.dshPromptMessageIds.get(`${sessionId}\u0000${dshId}`)
  }

  /** Reverse lookup: durable dsh id for a bridge/prompt id (user messages). */
  dshIdForPromptId(sessionId: string, promptId: string): string | undefined {
    const prefix = `${sessionId}\u0000`
    for (const [key, value] of this.dshPromptMessageIds) {
      if (key.startsWith(prefix) && value === promptId) return key.slice(prefix.length)
    }
    return undefined
  }

  /** Register the assistant id that will back a user turn's streamed reply. */
  registerAssistantIdForUser(sessionId: string, userId: string, assistantId: string): void {
    let byUser = this.assistantIdsByUser.get(sessionId)
    if (byUser === undefined) {
      byUser = new Map()
      this.assistantIdsByUser.set(sessionId, byUser)
    }
    byUser.set(userId, assistantId)
  }

  /** Assistant id registered for a user turn, if any. */
  assistantIdForUser(sessionId: string, userId: string): string | undefined {
    return this.assistantIdsByUser.get(sessionId)?.get(userId)
  }

  /** Timestamp that must be retained when history hydrates a live card. */
  assistantMessageCreatedAt(sessionId: string, assistantId: string): number | undefined {
    return this.assistantMessageTimes.get(`${sessionId}\u0000${assistantId}`)
  }

  /** Record the timestamp chosen for a live assistant card. */
  setAssistantMessageCreatedAt(sessionId: string, assistantId: string, createdAt: number): void {
    const key = `${sessionId}\u0000${assistantId}`
    // This value is part of the official TUI's live message identity.  It is
    // intentionally first-write-wins: once a provisional card was emitted,
    // changing its timestamp on a late durable echo makes the final update a
    // second card. Callers choose the user lower bound before the first write.
    if (!this.assistantMessageTimes.has(key)) {
      this.assistantMessageTimes.set(key, createdAt)
    }
  }

  markAssistantPending(sessionId: string, assistantId: string): void {
    this.pendingAssistantIds.add(`${sessionId}\u0000${assistantId}`)
  }

  markAssistantCompleted(sessionId: string, assistantId: string): void {
    this.pendingAssistantIds.delete(`${sessionId}\u0000${assistantId}`)
  }

  isAssistantPending(sessionId: string, assistantId: string): boolean {
    return this.pendingAssistantIds.has(`${sessionId}\u0000${assistantId}`)
  }

  clearPendingAssistants(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.pendingAssistantIds]) {
      if (key.startsWith(prefix)) this.pendingAssistantIds.delete(key)
    }
  }

  /** Record a dsh->bridge assistant id mapping after a streamed turn. */
  recordAssistantId(sessionId: string, dshId: string, bridgeId: string): void {
    this.dshAssistantIds.set(`${sessionId}\u0000${dshId}`, bridgeId)
  }

  /** Map a durable dsh assistant id back to its bridge id, if registered. */
  assistantIdForDshId(sessionId: string, dshId: string): string | undefined {
    return this.dshAssistantIds.get(`${sessionId}\u0000${dshId}`)
  }

  /** Reverse lookup: durable dsh id for a bridge assistant id. */
  dshIdForAssistantId(sessionId: string, assistantId: string): string | undefined {
    const prefix = `${sessionId}\u0000`
    for (const [key, value] of this.dshAssistantIds) {
      if (key.startsWith(prefix) && value === assistantId) return key.slice(prefix.length)
    }
    return undefined
  }

  /**
   * Apply one durable `agent/inbox/spliced` mutation to the mirrored queue.
   * `added` contains messages that were not yet surfaced to the TUI; `removed`
   * contains messages dropped from the queue (claim or cancellation).
   */
  applyInboxSplice(
    sessionId: string,
    target: 'next-turn' | 'next-step',
    start: number,
    removedCount: number,
    inserted: Array<{ id: string; rpcId?: string; content: readonly unknown[]; source?: { kind: string; rpcId?: string } }>,
    enqueuedAt: number,
    outcome?: 'canceled',
  ): InboxSpliceOutcome {
    const projection = this.inboxProjectionFor(sessionId)
    const list = target === 'next-step' ? projection.nextStep : projection.nextTurn
    const actualStart = Math.max(0, Math.min(start, list.length))
    const actualDelete = Math.max(0, Math.min(removedCount, list.length - actualStart))
    const removed = list.splice(actualStart, actualDelete)
    const added: QueuedInboxMessage[] = []
    for (const message of inserted) {
      const key = this.queuedKey(sessionId, String(message.id))
      if (this.presentQueuedIds.has(key)) continue
      this.presentQueuedIds.add(key)
      const entry: QueuedInboxMessage = {
        id: String(message.id),
        ...((message.rpcId ?? message.source?.rpcId) === undefined
          ? {}
          : { rpcId: String(message.rpcId ?? message.source?.rpcId) }),
        content: message.content,
        source: sourceForQueueItem('queued', message.source),
        enqueuedAt,
      }
      added.push(entry)
      list.splice(actualStart + added.length - 1, 0, entry)
    }
    for (const message of removed) {
      // Only a canceled message truly left the queue without being claimed
      // for execution. A claim moves the same prompt into the active turn,
      // and the queued/echoed surface marker must survive so the later
      // durable `user/message` echo cannot render a second card.
      if (outcome === 'canceled') {
        this.presentQueuedIds.delete(this.queuedKey(sessionId, message.id))
      }
    }
    return { added, removed }
  }

  /**
   * Initialize the inbox projection from the `session/queue` snapshot dsh
   * broadcasts when an SSE mux subscription starts. Later queue snapshots are
   * ignored: they cannot distinguish a claimed message from a cancelled one,
   * so incremental `agent/inbox/spliced` events own the live diff.
   * Returns only the messages that were not yet surfaced to the TUI.
   */
  initializeInboxProjection(
    sessionId: string,
    items: Array<{
      placement: 'queued' | 'steering' | 'context'
      rpcId?: string
      message: { id: string; content: readonly unknown[]; source?: { kind: string; rpcId?: string } }
    }>,
    enqueuedAt: number,
    force = false,
  ): InboxSpliceOutcome {
    const previous = this.inboxProjections.get(sessionId)
    const previousItems = previous === undefined
      ? []
      : [...previous.nextTurn, ...previous.nextStep]
    const previousById = new Map(previousItems.map((item) => [item.id, item]))
    const nextTurn: QueuedInboxMessage[] = []
    const nextStep: QueuedInboxMessage[] = []
    const added: QueuedInboxMessage[] = []
    for (const item of items) {
      const id = String(item.message.id)
      const entry: QueuedInboxMessage = {
        id,
        ...(item.rpcId === undefined ? {} : { rpcId: String(item.rpcId) }),
        content: item.message.content,
        source: sourceForQueueItem(item.placement, item.message.source),
        enqueuedAt,
      }
      ;(item.placement === 'context' || item.placement === 'steering' ? nextStep : nextTurn).push(entry)
      const key = this.queuedKey(sessionId, id)
      if (previousById.has(id) || this.presentQueuedIds.has(key)) {
        this.presentQueuedIds.add(key)
      } else {
        this.presentQueuedIds.add(key)
        added.push(entry)
      }
    }
    const nextIds = new Set([...nextTurn, ...nextStep].map((item) => item.id))
    const removed = previousItems.filter((item) => !nextIds.has(item.id))
    if (force) {
      for (const item of removed) this.presentQueuedIds.delete(this.queuedKey(sessionId, item.id))
    }
    this.inboxProjections.set(sessionId, { nextTurn, nextStep })
    return { added, removed }
  }

  setSessionTitle(sessionId: string, title: unknown): void {
    if (typeof title === 'string' && title.length > 0) {
      this.sessionTitles.set(sessionId, title)
    }
  }

  sessionTitleFor(sessionId: string): string | undefined {
    return this.sessionTitles.get(sessionId)
  }

  setSessionAgent(sessionId: string, agent: string): void {
    if (agent.length > 0) this.sessionAgents.set(sessionId, agent)
  }

  sessionAgentFor(sessionId: string): string | undefined {
    return this.sessionAgents.get(sessionId)
  }

  copyPresentationContextTo(target: InteractionState): void {
    for (const [id, value] of this.sessionDirectories) target.sessionDirectories.set(id, value)
    for (const [id, value] of this.sessionParents) target.sessionParents.set(id, value)
    for (const [id, value] of this.sessionAddressModes) target.sessionAddressModes.set(id, value)
    for (const id of this.sessionOrigins) target.sessionOrigins.add(id)
    for (const [key, value] of this.subagentCalls) target.subagentCalls.set(key, { ...value })
    for (const [id, value] of this.subagentChildren) target.subagentChildren.set(id, { ...value })
    for (const [id, value] of this.subagentDescriptorFacts) target.subagentDescriptorFacts.set(id, { ...value })
    for (const [id, value] of this.pendingSubagentChildren) {
      target.pendingSubagentChildren.set(id, value.map((child) => ({ ...child })))
    }
    for (const [id, value] of this.sessionTitles) target.sessionTitles.set(id, value)
    for (const [id, value] of this.sessionAgents) target.sessionAgents.set(id, value)
    for (const [id, value] of this.sessionModelSelections) target.sessionModelSelections.set(id, { ...value })
    for (const [id, value] of this.sessionRunning) target.sessionRunning.set(id, value)
    for (const [id, value] of this.sessionStatusUpdatedAt) target.sessionStatusUpdatedAt.set(id, value)
  }

  markStalePresetPrompt(sessionId: string, from: string, to: string): void {
    if (from === to) {
      this.stalePresetPrompts.delete(sessionId)
      return
    }
    this.stalePresetPrompts.set(sessionId, { from, to })
  }

  /** Consume only the one prompt carrying the editor value from before /preset. */
  consumeStalePresetPrompt(sessionId: string, agent: string | undefined): boolean {
    const pending = this.stalePresetPrompts.get(sessionId)
    if (pending === undefined) return false
    // Any prompt with the new/current agent means the editor has caught up;
    // any other agent is an explicit later Tab choice and must be honored.
    this.stalePresetPrompts.delete(sessionId)
    return agent !== undefined && pending.from === agent && pending.to !== agent
  }

  /** Record that the user submitted new input during this run. */
  markInput(): void {
    this.newInputDuringRun = true
  }

  setCurrentSession(sessionId: string): void {
    this.currentSessionId = sessionId
  }

  /** Agent-preset-lock notices already shown (dedupe per session + agent). */
  private readonly lockedAgentNotices = new Set<string>()

  lockedAgentNoticeSeen(sessionId: string, agent: string): boolean {
    return this.lockedAgentNotices.has(InteractionState.lockedAgentKey(sessionId, agent))
  }

  markLockedAgentNotice(sessionId: string, agent: string): void {
    this.lockedAgentNotices.add(InteractionState.lockedAgentKey(sessionId, agent))
  }

  private static lockedAgentKey(sessionId: string, agent: string): string {
    return `${sessionId}\u0000${agent}`
  }

  /** Pending approval decisions keyed by rpcId (answerer → HTTP reply). */
  readonly pendingApprovals = new Map<string, (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void>()
  /** Pending question decisions keyed by rpcId (answerer → HTTP reply). */
  readonly pendingQuestions = new Map<string, (answer: unknown | undefined) => void>()

  registerApproval(entry: PermissionEntry): PermissionEntry {
    this.permissions.set(entry.opencodeId, entry)
    this.byApprovalId.set(entry.approvalId, entry.opencodeId)
    return entry
  }

  registerQuestion(entry: QuestionEntry): QuestionEntry {
    this.questions.set(entry.opencodeId, entry)
    this.byQuestionRpcId.set(entry.rpcId, entry.opencodeId)
    return entry
  }

  permissionByOpenCodeId(id: string): PermissionEntry | undefined {
    return this.permissions.get(id)
  }

  permissionByApprovalId(approvalId: string): PermissionEntry | undefined {
    const opencodeId = this.byApprovalId.get(approvalId)
    return opencodeId === undefined ? undefined : this.permissions.get(opencodeId)
  }

  permissionByRpcId(rpcId: string): PermissionEntry | undefined {
    for (const entry of this.permissions.values()) {
      if (entry.rpcId === rpcId) return entry
    }
    return undefined
  }

  questionByOpenCodeId(id: string): QuestionEntry | undefined {
    return this.questions.get(id)
  }

  questionByRpcId(rpcId: string): QuestionEntry | undefined {
    const opencodeId = this.byQuestionRpcId.get(rpcId)
    return opencodeId === undefined ? undefined : this.questions.get(opencodeId)
  }

  removePermission(opencodeId: string): void {
    const entry = this.permissions.get(opencodeId)
    if (entry) this.byApprovalId.delete(entry.approvalId)
    this.permissions.delete(opencodeId)
  }

  removeQuestion(opencodeId: string): void {
    const entry = this.questions.get(opencodeId)
    if (entry) this.byQuestionRpcId.delete(entry.rpcId)
    this.questions.delete(opencodeId)
  }

  /** Resolve and clear every in-flight answerer when the bridge stops. */
  clearPendingInteractions(): void {
    for (const resolve of this.pendingApprovals.values()) resolve('cancelled')
    this.pendingApprovals.clear()
    for (const resolve of this.pendingQuestions.values()) resolve(undefined)
    this.pendingQuestions.clear()
    this.permissions.clear()
    this.questions.clear()
    this.byApprovalId.clear()
    this.byQuestionRpcId.clear()
  }

  clearSession(sessionId: string): void {
    this.sessionDirectories.delete(sessionId)
    this.sessionParents.delete(sessionId)
    this.sessionAddressModes.delete(sessionId)
    this.sessionOrigins.delete(sessionId)
    this.subagentChildren.delete(sessionId)
    this.subagentDescriptorFacts.delete(sessionId)
    for (const [key, call] of this.subagentCalls) {
      if (call.parentSessionId === sessionId || call.childSessionId === sessionId) this.subagentCalls.delete(key)
    }
    this.pendingSubagentChildren.delete(sessionId)
    for (const [parentId, children] of this.pendingSubagentChildren) {
      const remaining = children.filter((child) => child.sessionId !== sessionId)
      if (remaining.length === 0) this.pendingSubagentChildren.delete(parentId)
      else if (remaining.length !== children.length) this.pendingSubagentChildren.set(parentId, remaining)
    }
    this.sessionRunning.delete(sessionId)
    this.sessionStatusUpdatedAt.delete(sessionId)
    this.sessionStatusBroadcast.delete(sessionId)
    this.sessionModelSelections.delete(sessionId)
    this.sessionTitles.delete(sessionId)
    this.sessionAgents.delete(sessionId)
    this.stalePresetPrompts.delete(sessionId)
    this.recentCommandResults.delete(sessionId)
    for (const [key, saved] of this.savedPermissions) {
      if (saved.sessionId === sessionId) this.savedPermissions.delete(key)
    }
    for (const key of [...this.lockedAgentNotices]) if (key.startsWith(`${sessionId}\u0000`)) this.lockedAgentNotices.delete(key)
    this.inboxProjections.delete(sessionId)
    for (const key of [...this.presentQueuedIds]) if (key.startsWith(`${sessionId}\u0000`)) this.presentQueuedIds.delete(key)
    for (const key of [...this.broadcastDshIds]) if (key.startsWith(`${sessionId}\u0000`)) this.broadcastDshIds.delete(key)
    for (const key of [...this.dshPromptMessageIds.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.dshPromptMessageIds.delete(key)
    for (const key of [...this.dshAssistantIds.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.dshAssistantIds.delete(key)
    for (const key of [...this.assistantMessageTimes.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.assistantMessageTimes.delete(key)
    this.clearPendingAssistants(sessionId)
    this.promptMessageIds.delete(sessionId)
    for (const key of [...this.promptMessageTimes.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.promptMessageTimes.delete(key)
    this.assistantIdsByUser.delete(sessionId)
    this.historyCache.delete(sessionId)
    this.inboxProjections.delete(sessionId)
    this.invalidateHistory(sessionId)
    this.removeSessionInteractions(sessionId)
  }

  private removeSessionInteractions(sessionId: string): void {
    for (const entry of this.permissionsForSession(sessionId)) this.removePermission(entry.opencodeId)
    for (const entry of this.questionsForSession(sessionId)) this.removeQuestion(entry.opencodeId)
  }

  permissionsForSession(sessionId: string): PermissionEntry[] {
    return [...this.permissions.values()].filter((entry) => entry.sessionId === sessionId)
  }

  questionsForSession(sessionId: string): QuestionEntry[] {
    return [...this.questions.values()].filter((entry) => entry.sessionId === sessionId)
  }
}

export interface NewApprovalEntry {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface NewQuestionEntry {
  rpcId: string
  sessionId: string
  items: AskUserQuestionItem[]
}
