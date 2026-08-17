import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { HistoryEntry, SessionProjectionsBlock, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { PermissionEntry } from './convert/permission.js'
import type { QuestionEntry } from './convert/question.js'

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
  /** dsh `UserMessage` content blocks (only text blocks are rendered). */
  content: readonly unknown[]
  source: { kind: string }
  /** When the message entered the queue (splice event time). */
  enqueuedAt: number
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
  /** Mirror of each session's dsh pending inbox (next-turn / next-step). */
  readonly inboxProjections = new Map<string, InboxProjection>()
  /** Message ids already surfaced to the TUI as queued user messages. */
  readonly presentQueuedIds = new Set<string>()
  /** dsh user message ids already echoed by the prompt route (broadcast). */
  private readonly broadcastDshIds = new Set<string>()
  /** TUI-generated `messageID`s from prompt submissions, FIFO per session. */
  private readonly promptMessageIds = new Map<string, string[]>()
  /** dsh user message id -> TUI prompt id (kept so history echoes match). */
  private readonly dshPromptMessageIds = new Map<string, string>()
  /** Bridge-generated assistant message ids keyed by user message id. */
  private readonly assistantIdsByUser = new Map<string, Map<string, string>>()
  /** dsh assistant message id -> bridge assistant id (history echo match). */
  private readonly dshAssistantIds = new Map<string, string>()
  sessionListCache?: { items: SessionSummary[]; at: number }
  /** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
  sessionListLoading?: Promise<SessionSummary[]>
  private sessionListGeneration = 0
  /** Whether this bridge run accepted new user input (banner-bearing content). */
  newInputDuringRun = false
  /** The session the TUI most recently created/resumed/opened. */
  currentSessionId?: string
  /** Last agent preset selected during this run (inherited by new sessions). */
  lastAgentPreset?: string
  readonly historyCache = new Map<string, { value: CachedHistory; at: number }>()
  private readonly historyLoading = new Map<string, Promise<CachedHistory>>()
  private readonly historyGenerations = new Map<string, number>()

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
    if (selection.variant === undefined) {
      this.sessionModelSelections.delete(sessionId)
    } else {
      this.sessionModelSelections.set(sessionId, selection)
    }
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
  registerPromptMessageId(sessionId: string, promptId: string): void {
    const queue = this.promptMessageIds.get(sessionId)
    if (queue === undefined) {
      this.promptMessageIds.set(sessionId, [promptId])
    } else {
      queue.push(promptId)
    }
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
    inserted: Array<{ id: string; content: readonly unknown[]; source: { kind: string } }>,
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
        content: message.content,
        source: message.source,
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
      message: { id: string; content: readonly unknown[]; source: { kind: string } }
    }>,
    enqueuedAt: number,
  ): InboxSpliceOutcome {
    if (this.inboxProjections.has(sessionId)) return { added: [], removed: [] }
    const nextTurn: QueuedInboxMessage[] = []
    const nextStep: QueuedInboxMessage[] = []
    const added: QueuedInboxMessage[] = []
    for (const item of items) {
      const id = String(item.message.id)
      const entry: QueuedInboxMessage = {
        id,
        content: item.message.content,
        source: item.message.source,
        enqueuedAt,
      }
      ;(item.placement === 'context' || item.placement === 'steering' ? nextStep : nextTurn).push(entry)
      this.presentQueuedIds.add(this.queuedKey(sessionId, id))
      added.push(entry)
    }
    this.inboxProjections.set(sessionId, { nextTurn, nextStep })
    return { added, removed: [] }
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
