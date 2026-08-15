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
  sessionListCache?: { items: SessionSummary[]; at: number }
  readonly historyCache = new Map<string, { value: CachedHistory; at: number }>()

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

  /** Drop list and (optionally per-session) history caches after any mutation. */
  invalidateSession(sessionId?: string): void {
    this.sessionListCache = undefined
    this.invalidateHistory(sessionId)
  }

  /** Drop only history pages (used by the live SSE feed). */
  invalidateHistory(sessionId?: string): void {
    if (sessionId === undefined) {
      this.historyCache.clear()
      return
    }
    for (const key of [...this.historyCache.keys()]) {
      if (key === sessionId || key.startsWith(`${sessionId}:`)) this.historyCache.delete(key)
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
