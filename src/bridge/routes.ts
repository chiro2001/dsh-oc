// Route registrations for the dsh-oc bridge.
// Aggregates domain route modules; see src/bridge/routes/*.ts.
import type { Route } from './router.js'
import { registerBootRoutes } from './routes/boot.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerPermissionRoutes } from './routes/permission.js'
import { registerSessionV1Routes } from './routes/session-v1.js'
import { registerSessionV2Routes } from './routes/session-v2.js'
import { registerVcsRoutes } from './routes/vcs.js'

export type RouteRegistrar = (
  method: string,
  pattern: string,
  kind: Route['kind'],
  handler: Route['handler'],
) => void

export function registerRoutes(register: RouteRegistrar): void {
  registerBootRoutes(register)
  registerSessionV1Routes(register)
  registerPermissionRoutes(register)
  registerSessionV2Routes(register)
  registerVcsRoutes(register)
  registerFsRoutes(register)
  register('GET', '/global/event', 'sse', async () => ({ status: 200 }))
}
