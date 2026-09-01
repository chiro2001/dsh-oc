import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { startBridgeServer, type BridgeServerHandle } from './http.js'
import { createBridgeRouter, type BridgeRouter } from './router.js'
import type { BridgeAgents, BridgeApi, BridgeCommands } from './rpc.js'
import type { BridgeEvent, BridgeFrame, BridgeHostFrame } from './dsh-types.js'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'

export const name = '@chiro2001/dsh-oc/bridge'
export const inject = [
  'sessionController',
  'agentPresets',
  'goals',
  'sessionSkillCatalog',
] as const

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

  constructor(ctx: Context) {
    super(ctx, 'ocBridge')
    this.logger = makeLogger(ctx)
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const sessionController = this.ctx.get('sessionController') as BridgeApi['sessionController'] | undefined
    const agentPresets = this.ctx.get('agentPresets') as BridgeApi['agentPresets'] | undefined
    const goals = this.ctx.get('goals') as BridgeApi['goals'] | undefined
    const sessionSkillCatalog = this.ctx.get('sessionSkillCatalog') as BridgeApi['sessionSkillCatalog'] | undefined
    const commands = this.ctx.get('commands') as BridgeCommands | undefined
    const agents = this.ctx.get('agents') as BridgeAgents | undefined
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
    }
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

    // Session events: one feed per append, global scope so every session's
    // events reach the bridge regardless of the agent scope that produced them.
    ctx.on('session/event', (session, event) => {
      void router.feed({
        type: 'session/event',
        sessionId: String(session.id),
        event: event as unknown as BridgeEvent,
      }).catch((error: unknown) => {
        log(`[bridge] session event feed failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, { global: true })

    ctx.on('session/created', (session) => {
      router.feedHostFrame({ type: 'host/session-added', sessionId: String(session.id) })
    }, { global: true })

    ctx.on('session/disposed', (session) => {
      router.feedHostFrame({ type: 'host/session-removed', sessionId: String(session.id) })
    }, { global: true })

    // Approval answerer: present one permission dialog to the TUI, await the
    // HTTP reply, and return the outcome to the dsh waterfall.
    ctx.on('approval/request', async (req, next) => {
      const sessionId = String(req.agent.id)
      const toolName = req.toolName
      const saved = router.ctx.state.savedPermissionFor(sessionId, toolName)
      if (saved !== undefined) return 'allowed-once'
      const rpcId = randomUUID()
      const decision = new Promise<'allowed-once' | 'rejected'>((resolve) => {
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
      await router.feed(frame)
      try {
        return await Promise.race([
          decision,
          new Promise<'cancelled'>((resolve) => {
            req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
          }),
        ])
      } finally {
        router.ctx.state.pendingApprovals.delete(rpcId)
      }
    }, { global: true })

    // Question answerer: present one question batch, await the HTTP reply.
    ctx.on('user-questions/request', async (request, next) => {
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
      await router.feed(frame)
      try {
        const answer = await Promise.race([
          decision,
          new Promise<undefined>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
          }),
        ])
        if (answer === undefined) {
          // Aborted / no answer: delegate so the dsh waterfall keeps asking.
          return await next()
        }
        return answer as never
      } finally {
        router.ctx.state.pendingQuestions.delete(rpcId)
      }
    }, { global: true })

    // Session control stream: queue/jobs/projection frames.
    void (async () => {
      for await (const frame of api.sessionController.control(new AbortController().signal)) {
        try {
          if (frame.type === 'queue') {
            void router.feed({
              type: 'session/queue',
              sessionId: String(frame.sessionId),
              items: frame.items.map((item) => ({
                placement: item.placement,
                message: item.message as never,
              })),
            })
          } else if (frame.type === 'jobs') {
            // Jobs have no TUI surface today; feed as a no-op frame type.
          } else if (frame.type === 'projection') {
            void router.feed({
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
    const handle = this.handle
    this.handle = undefined
    await handle?.close()
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
