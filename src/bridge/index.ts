import { Service, type Context } from '@deepseek-ai/cordis'
import { startBridgeServer, type BridgeServerHandle } from './http.js'
import { createBridgeRouter, type BridgeRouter } from './router.js'
import type { BridgeAgents, BridgeApi, BridgeCommands } from './rpc.js'

export const name = '@deepseek-ai/dsh-oc/bridge'
export const inject = ['apiProxy'] as const

export interface OcBridgeValue {
  url: string
  port: number
  /** Change the bridge working directory (attach `--dir` support). */
  setCwd(directory: string): void
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
    const apiProxy = (this.ctx as unknown as { apiProxy: BridgeApi }).apiProxy
    const commands = this.ctx.get('commands') as BridgeCommands | undefined
    const agents = this.ctx.get('agents') as BridgeAgents | undefined
    const api: BridgeApi = {
      ...apiProxy,
      ...(commands === undefined ? {} : { commands }),
      ...(agents === undefined ? {} : { agents }),
    }
    const router = createBridgeRouter(api, { log: this.logger })
    this.router = router
    const handle = await startBridgeServer(router)
    this.handle = handle
    this.url = handle.url
    this.port = handle.port
    this.logger(`bridge listening on ${handle.url}`)
    yield () => this.stop()
  }

  setCwd(directory: string): void {
    this.router?.setCwd(directory)
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
