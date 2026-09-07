import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { startBridgeServer, type BridgeServerHandle } from './http.js'
import { createBridgeRouter, type BridgeRouter } from './router.js'
import type { BridgeAgents, BridgeApi, BridgeCommands } from './rpc.js'
import type { BridgeControlBaseline, BridgeEvent, BridgeFrame, BridgeHostFrame } from './dsh-types.js'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import { makeEvent } from './events.js'
import { projectIdFor } from './convert/common.js'

export const name = '@chiro2001/dsh-oc/bridge'
export const inject = [
  'sessionController',
  'agentPresets',
  'goals',
  'sessionSkillCatalog',
  'agents',
  'sessions',
  'sessionProjections',
] as const

/**
 * Keep older profile plugins (notably dsh-dcp rc.6) source-compatible with
 * dsh-session 0.1.2. The Session log was intentionally moved behind
 * snapshotEvents(), but dsh-dcp rc.6 (whose peer range is still locked to
 * dsh 0.1.1-rc.2) reads `session.events` while handling the first prompt.
 * Install the compatibility getter on the actual host Session prototype seen
 * by the event callback; this also works when the host and bridge resolve
 * duplicate package copies. Remove this shim after dsh-dcp upgrades its peer
 * and switches to snapshotEvents().
 */
export function installSessionEventsCompat(session: unknown): boolean {
  if (session === null || (typeof session !== 'object' && typeof session !== 'function')) return false
  const prototype = Object.getPrototypeOf(session) as {
    snapshotEvents?: () => readonly unknown[]
  } | null
  if (prototype === null || typeof prototype.snapshotEvents !== 'function') return false
  const existing = Object.getOwnPropertyDescriptor(prototype, 'events')
  if (existing !== undefined && (existing.get !== undefined || existing.value !== undefined)) return false
  try {
    Object.defineProperty(prototype, 'events', {
      configurable: true,
      enumerable: false,
      get(this: { snapshotEvents: () => readonly unknown[] }) {
        return this.snapshotEvents()
      },
    })
    return true
  } catch {
    return false
  }
}

export function installSessionEventsOnLiveSessions(sessions: unknown): number {
  if (sessions === null || typeof sessions !== 'object') return 0
  const list = (sessions as { list?: unknown }).list
  if (typeof list !== 'function') return 0
  let live: unknown
  try {
    live = list.call(sessions)
  } catch {
    return 0
  }
  if (!Array.isArray(live)) return 0
  let installed = 0
  for (const session of live) {
    try {
      if (installSessionEventsCompat(session)) installed++
    } catch {
      // A host may freeze a Session prototype; the normal event path remains
      // usable and a later compatible dcp plugin will not need this getter.
    }
  }
  return installed
}

export interface OcBridgeValue {
  url: string
  port: number
  /** Change the bridge working directory (attach `--dir` support). */
  setCwd(directory: string): void
  /** Warm one session's tail history (attach `--session` resume support). */
  prefetchSession(sessionId: string): void
  /** Whether this run accepted new user input. */
  hasNewActivity(): boolean
  /** Whether the TUI exit banner likely printed and needs the dsh hint. */
  exitNoteNeeded(): Promise<boolean>
}

/**
 * oc-bridge cordis service: owns the loopback HTTP/SSE server and exposes
 * `{ url, port }` once the listener is ready. `Service.init` starts the
 * server before the service becomes injectable, and yields the teardown
 * disposer so dispose never hangs.
 */
export class OcBridgeService extends Service implements OcBridgeValue {
  url = ''
  port = 0
  private handle: BridgeServerHandle | undefined
  private router: BridgeRouter | undefined
  private readonly logger: (message: string) => void
  private controlAbort?: AbortController
  private controlPump?: Promise<void>
  private stopped = false
  private readonly eventDisposers: Array<() => void> = []

  constructor(ctx: Context) {
    super(ctx, 'ocBridge')
    this.logger = makeLogger(ctx)
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    this.stopped = false
    const sessionController = this.ctx.get('sessionController') as BridgeApi['sessionController'] | undefined
    const agentPresets = this.ctx.get('agentPresets') as BridgeApi['agentPresets'] | undefined
    const goals = this.ctx.get('goals') as BridgeApi['goals'] | undefined
    const sessionSkillCatalog = this.ctx.get('sessionSkillCatalog') as BridgeApi['sessionSkillCatalog'] | undefined
    const commands = this.ctx.get('commands') as BridgeCommands | undefined
    const agents = this.ctx.get('agents') as BridgeAgents | undefined
    const sessions = this.ctx.get('sessions') as BridgeApi['sessions'] | undefined
    const sessionProjections = this.ctx.get('sessionProjections') as BridgeApi['sessionProjections'] | undefined
    if (sessionController === undefined || agentPresets === undefined || goals === undefined || sessionSkillCatalog === undefined) {
      throw new Error('oc-bridge: missing dsh 0.1.2 host services (sessionController/agentPresets/goals/sessionSkillCatalog)')
    }
    const api: BridgeApi = {
      sessionController,
      agentPresets,
      goals,
      sessionSkillCatalog,
      ...(commands === undefined ? {} : { commands }),
      ...(agents === undefined ? {} : { agents }),
      ...(sessions === undefined ? {} : { sessions }),
      ...(sessionProjections === undefined ? {} : { sessionProjections }),
    }
    installSessionEventsOnLiveSessions(sessions)
    const router = createBridgeRouter(api, { log: this.logger })
    this.router = router
    router.prefetchSessionList()
    const handle = await startBridgeServer(router)
    this.handle = handle
    this.url = handle.url
    this.port = handle.port
    this.logger(`bridge listening on ${handle.url}`)
    this.subscribeHostEvents(router, api)
    yield () => this.stop()
  }

  /**
   * Host-side event pump (dsh 0.1.2 has no mux/host stream): subscribe to
   * session events, lifecycle, approval/question answerer waterfalls, and the
   * session control stream, translating each into bridge frames for the SSE
   * hub. Registered once for the service's lifetime.
   */
  private subscribeHostEvents(router: BridgeRouter, api: BridgeApi): void {
    const ctx = this.ctx
    const log = this.logger

    this.eventDisposers.push(ctx.on('session/created', (session) => {
      installSessionEventsCompat(session)
    }, { global: true, prepend: true }) as () => void)

    // Session events: one feed per append, global scope so every session's
    // events reach the bridge regardless of the agent scope that produced them.
    this.eventDisposers.push(ctx.on('session/event', (session, event) => {
      if (this.stopped) return
      installSessionEventsCompat(session)
      void router.feed({
        type: 'session/event',
        sessionId: String(session.id),
        event: event as unknown as BridgeEvent,
      }).catch((error: unknown) => {
        log(`[bridge] session event feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, { global: true }) as () => void)

    // The 0.1.2 SessionController publishes authoritative cold-session
    // lifecycle and agent-error events on the host event bus. Use those
    // records exclusively so a live `session/created` fallback cannot briefly
    // overwrite a child's real cwd/lineage summary.
    this.eventDisposers.push(ctx.on('api-session/added', (summary) => {
      if (this.stopped) return
      router.feedHostFrame({
        type: 'host/session-added',
        sessionId: String(summary.sessionId),
        summary: summary as never,
      })
    }, { global: true }) as () => void)
    this.eventDisposers.push(ctx.on('api-session/removed', (sessionId) => {
      if (this.stopped) return
      router.feedHostFrame({ type: 'host/session-removed', sessionId: String(sessionId) })
    }, { global: true }) as () => void)
    this.eventDisposers.push(ctx.on('api-session/error', (sessionId, message) => {
      if (this.stopped) return
      router.feedHostFrame({ type: 'host/agent-error', sessionId: String(sessionId), message: String(message) })
    }, { global: true }) as () => void)
    // dsh 0.1.2 exposes the live Agent edge separately from durable
    // session/event records. Feed it through the same per-session serializer
    // so `/session/status` and reconnect status snapshots never need to scan
    // the full persisted session corpus.
    this.eventDisposers.push(ctx.on('api-session/status', (sessionId, running) => {
      if (this.stopped) return
      router.feedHostFrame({
        type: 'host/session-status',
        sessionId: String(sessionId),
        running: Boolean(running),
        updatedAt: Date.now(),
      })
    }, { global: true }) as () => void)
    this.eventDisposers.push(ctx.on('api-session/activity', (sessionId, updatedAt) => {
      if (this.stopped) return
      router.feedHostFrame({
        type: 'host/session-activity',
        sessionId: String(sessionId),
        updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
      })
    }, { global: true }) as () => void)

    // Approval answerer: present one permission dialog to the TUI, await the
    // HTTP reply, and return the outcome to the dsh waterfall.
    this.eventDisposers.push(ctx.on('approval/request', async (req, next) => {
      if (this.stopped) return await next()
      const sessionId = String(req.agent.id)
      const toolName = req.toolName
      const saved = router.ctx.state.savedPermissionFor(sessionId, toolName)
      if (saved !== undefined) return 'allowed-once'
      const rpcId = randomUUID()
      const decision = new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
        router.ctx.state.pendingApprovals.set(rpcId, resolve)
      })
      const frame: BridgeFrame = {
        type: 'approval/requested',
        rpcId,
        sessionId,
        approvalId: rpcId,
        toolName,
        ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
        ...(req.reason === undefined ? {} : { reason: req.reason }),
      }
      try {
        await router.feed(frame)
      } catch (error) {
        log(`[bridge] approval frame feed failed: ${error instanceof Error ? error.message : String(error)}`)
        router.ctx.state.pendingApprovals.delete(rpcId)
        return await next()
      }
      try {
        return await Promise.race([
          decision,
          new Promise<'cancelled'>((resolve) => {
            if (req.signal?.aborted) resolve('cancelled')
            else req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
          }),
        ])
      } finally {
        const entry = router.ctx.state.permissionByRpcId(rpcId)
        router.ctx.state.pendingApprovals.delete(rpcId)
        if (entry !== undefined && req.signal?.aborted) {
          router.ctx.state.removePermission(entry.opencodeId)
          const directory = router.ctx.state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd
          router.ctx.hub.broadcast([makeEvent(directory, 'permission.replied', {
            sessionID: entry.sessionId,
            requestID: entry.opencodeId,
            reply: 'reject',
          }, projectIdFor(directory))])
        }
      }
    }, { global: true }) as () => void)

    // Question answerer: present one question batch, await the HTTP reply.
    this.eventDisposers.push(ctx.on('user-questions/request', async (request, next) => {
      if (this.stopped) return await next()
      const sessionId = request.agent === undefined ? undefined : String(request.agent.id)
      const rpcId = randomUUID()
      const decision = new Promise<unknown>((resolve) => {
        router.ctx.state.pendingQuestions.set(rpcId, resolve)
      })
      const frame: BridgeFrame = {
        type: 'question/requested',
        rpcId,
        sessionId: sessionId ?? '',
        questions: request.questions,
      }
      try {
        await router.feed(frame)
      } catch (error) {
        log(`[bridge] question frame feed failed: ${error instanceof Error ? error.message : String(error)}`)
        router.ctx.state.pendingQuestions.delete(rpcId)
        return await next()
      }
      try {
        const answer = await Promise.race([
          decision,
          new Promise<undefined>((resolve) => {
            if (request.signal?.aborted) resolve(undefined)
            else request.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
          }),
        ])
        if (answer === undefined) {
          // Aborted / no answer: delegate so the dsh waterfall keeps asking.
          return await next()
        }
        return (answer !== undefined && !Array.isArray(answer)
          ? answer
          : { answers: answer }) as never
      } finally {
        const entry = router.ctx.state.questionByRpcId(rpcId)
        router.ctx.state.pendingQuestions.delete(rpcId)
        if (entry !== undefined && request.signal?.aborted) {
          router.ctx.state.removeQuestion(entry.opencodeId)
          const directory = router.ctx.state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd
          router.ctx.hub.broadcast([makeEvent(directory, 'question.rejected', {
            sessionID: entry.sessionId,
            requestID: entry.opencodeId,
          }, projectIdFor(directory))])
        }
      }
    }, { global: true }) as () => void)

    // Session control stream: queue/jobs/projection frames.
    const controlAbort = new AbortController()
    this.controlAbort = controlAbort
    this.controlPump = (async () => {
      for await (const frame of api.sessionController.control(controlAbort.signal)) {
        try {
          if (frame.type === 'baseline') {
            await router.feed({
              type: 'control/baseline',
              value: frame.value as unknown as BridgeControlBaseline,
            })
          } else if (frame.type === 'queue') {
            await router.feed({
              type: 'session/queue',
              sessionId: String(frame.sessionId),
              items: frame.items.map((item) => ({
                placement: item.placement,
                rpcId: item.rpcId === undefined ? undefined : String(item.rpcId),
                message: item.message,
              })),
            })
          } else if (frame.type === 'jobs') {
            // Jobs have no TUI surface today; feed as a no-op frame type.
          } else if (frame.type === 'projection') {
            await router.feed({
              type: 'session/projection',
              sessionId: String(frame.sessionId),
              key: frame.key,
              value: frame.value,
              seq: frame.seq,
            })
          }
        } catch (error) {
          log(`[bridge] control frame feed failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().catch((error: unknown) => {
      log(`[bridge] control stream ended: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  setCwd(directory: string): void {
    this.router?.setCwd(directory)
  }

  prefetchSession(sessionId: string): void {
    this.router?.prefetchSession(sessionId)
  }

  hasNewActivity(): boolean {
    return this.router?.hasNewActivity() ?? false
  }

  exitNoteNeeded(): Promise<boolean> {
    return this.router?.exitNoteNeeded() ?? Promise.resolve(false)
  }

  private async stop(): Promise<void> {
    this.stopped = true
    this.controlAbort?.abort()
    this.controlAbort = undefined
    this.broadcastPendingUiCleanup()
    this.ctxStateClearPending()
    for (const dispose of this.eventDisposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.logger(`[bridge] event listener cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const controlPump = this.controlPump
    this.controlPump = undefined
    if (controlPump !== undefined) {
      // A host transport should honor AbortSignal, but teardown must remain
      // bounded even when a custom stream implementation is stuck in a read.
      await Promise.race([
        controlPump,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ])
    }
    const handle = this.handle
    this.handle = undefined
    await handle?.close()
  }

  private ctxStateClearPending(): void {
    this.router?.ctx.state.clearPendingInteractions()
  }

  private broadcastPendingUiCleanup(): void {
    const router = this.router
    if (router === undefined) return
    const state = router.ctx.state
    for (const entry of state.permissions.values()) {
      const directory = state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd
      router.ctx.hub.broadcast([makeEvent(directory, 'permission.replied', {
        sessionID: entry.sessionId,
        requestID: entry.opencodeId,
        reply: 'reject',
      }, projectIdFor(directory))])
    }
    for (const entry of state.questions.values()) {
      const directory = state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd
      router.ctx.hub.broadcast([makeEvent(directory, 'question.rejected', {
        sessionID: entry.sessionId,
        requestID: entry.opencodeId,
      }, projectIdFor(directory))])
    }
  }
}

function makeLogger(ctx: Context): (message: string) => void {
  const logger = ctx.logger?.('oc-bridge')
  return (message) => {
    if (logger) {
      logger.warn(message)
    } else {
      console.warn(`[dsh-oc/bridge] ${message}`)
    }
  }
}

export default OcBridgeService
