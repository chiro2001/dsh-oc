// Workspace filesystem routes: /api/fs/read/*, /api/fs/list, /api/fs/find.
import * as R from '../router.js'
import { findWithin, listDirWithin, readFileWithin } from '../fs.js'
import type { RouteRegistrar } from '../routes.js'

export function registerFsRoutes(register: RouteRegistrar): void {
  register('GET', '/api/fs/read/*', 'json', async (req, ctx) => {
    const raw = decodeURIComponent(req.params['*'] ?? '')
    const data = readFileWithin(ctx.cwd, raw)
    return {
      status: 200,
      raw: data,
      headers: { 'Content-Type': 'application/octet-stream' },
    }
  })

  register('GET', '/api/fs/list', 'json', async (req, ctx) => {
    const raw = req.query.get('path') ?? ''
    return R.json(200, {
      location: R.locationInfo(ctx),
      data: listDirWithin(ctx.cwd, raw),
    })
  })

  register('GET', '/api/fs/find', 'json', async (req, ctx) => {
    const query = req.query.get('query') ?? ''
    const typeRaw = req.query.get('type')
    const type = typeRaw === 'file' || typeRaw === 'directory' ? typeRaw : undefined
    const limitRaw = req.query.get('limit')
    const limit = limitRaw === null ? undefined : Number(limitRaw)
    return R.json(200, {
      location: R.locationInfo(ctx),
      data: findWithin(ctx.cwd, query, type, limit),
    })
  })
}
