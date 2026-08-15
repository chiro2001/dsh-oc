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
  /** Real durable titles learned from history projections / title events. */
  readonly sessionTitles = new Map<string, string>()
  sessionListCache?: { items: SessionSummary[]; at: number }
  /** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
  sessionListLoading?: Promise<SessionSummary[]>
  private sessionListGeneration = 0
  /** Whether this bridge run accepted new user input (banner-bearing content). */
  newInputDuringRun = false
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

  setSessionTitle(sessionId: string, title: unknown): void {
    if (typeof title === 'string' && title.length > 0) {
      this.sessionTitles.set(sessionId, title)
    }
  }

  sessionTitleFor(sessionId: string): string | undefined {
    return this.sessionTitles.get(sessionId)
  }

  /** Record that the user submitted new input during this run. */
  markInput(): void {
    this.newInputDuringRun = true
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
