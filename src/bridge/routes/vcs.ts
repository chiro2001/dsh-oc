// vcs routes for the dsh-oc bridge: real git info/status/diff over the
// opencode /vcs surface (previously a schema-valid stub).
import * as R from '../router.js'
import { vcsDiff, vcsDiffRaw, vcsFileStatuses, vcsInfo } from '../git.js'
import type { RouteRegistrar } from '../routes.js'

export function registerVcsRoutes(register: RouteRegistrar): void {
  register('GET', '/vcs', 'json', async (_req, ctx) => R.json(200, vcsInfo(ctx.cwd)))

  register('GET', '/vcs/status', 'json', async (_req, ctx) => R.json(200, vcsFileStatuses(ctx.cwd)))

  register('GET', '/vcs/diff', 'json', async (req, ctx) => {
    const mode = req.query.get('mode') === 'branch' ? 'branch' : 'git'
    const contextRaw = req.query.get('context')
    const context = contextRaw === null ? undefined : Number(contextRaw)
    return R.json(200, vcsDiff(ctx.cwd, mode, context))
  })

  register('GET', '/vcs/diff/raw', 'json', async (req, ctx) => {
    const mode = req.query.get('mode') === 'branch' ? 'branch' : 'git'
    const contextRaw = req.query.get('context')
    const context = contextRaw === null ? undefined : Number(contextRaw)
    return R.json(200, vcsDiffRaw(ctx.cwd, mode, context))
  })
}
