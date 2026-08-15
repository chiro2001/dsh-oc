import { Service, type Context } from '@deepseek-ai/cordis'
import { startBridgeServer, type BridgeServerHandle } from './http.js'
import { createBridgeRouter } from './router.js'
import type { BridgeApi } from './rpc.js'

export const name = '@deepseek-ai/dsh-oc/bridge'
export const inject = ['apiProxy'] as const

export interface OcBridgeValue {
  url: string
  port: number
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
  private readonly logger: (message: string) => void

  constructor(ctx: Context) {
    super(ctx, 'ocBridge')
    this.logger = makeLogger(ctx)
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const api = (this.ctx as unknown as { apiProxy: BridgeApi }).apiProxy
    const router = createBridgeRouter(api, { log: this.logger })
    const handle = await startBridgeServer(router)
    this.handle = handle
    this.url = handle.url
    this.port = handle.port
    this.logger(`bridge listening on ${handle.url}`)
    yield () => this.stop()
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
