// boot routes for the dsh-oc bridge.
import * as R from '../router.js'
import { convertToProviderCatalog, convertToV1Providers, convertToV2Models, convertToV2Providers } from '../convert/model.js'
import { projectIdFor } from '../convert/common.js'
import type { RouteRegistrar } from '../routes.js'

export function registerBootRoutes(register: RouteRegistrar): void {
  // ---- v1 boot / catalog routes ----
  register('GET', '/path', 'json', async (_req, ctx) => {
    const directory = ctx.cwd
    return R.json(200, {
      home: directory,
      state: 'ready',
      config: '',
      worktree: directory,
      directory,
      path: directory,
    })
  })

  register('GET', '/project/current', 'json', async (_req, ctx) => R.json(200, {
    id: projectIdFor(ctx.cwd),
    worktree: ctx.cwd,
    time: { created: 0 },
  }))

  register('GET', '/project/global/directories', 'json', async (_req, ctx) => R.json(200, [
    { directory: ctx.cwd },
  ]))

  register('GET', '/config', 'json', async () => R.json(200, { autoupdate: false }))

  register('GET', '/config/providers', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, { providers: convertToV1Providers(groups), default: {} })
  })

  register('GET', '/provider', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, convertToProviderCatalog(groups))
  })

  register('GET', '/provider/auth', 'json', async () => R.json(200, {}))

  register('GET', '/agent', 'json', async (_req, ctx) => R.json(200, [
    await R.v1DefaultAgent(ctx),
    ...(await R.dshPresetAgents(ctx)),
  ]))
  // `/preset` stays advertised as a server command: the 1.18.18 TUI opens a
  // slash popup for any `/` input, so the first Enter completes to `/preset `
  // and the second Enter executes through `POST /session/:id/command`. The
  // prompt routes below additionally capture `/preset` typed with a trailing
  // space (or after Esc), so every path ends with a visible SSE result.
  register('GET', '/command', 'json', async (req, ctx) => R.json(200, [
    R.PRESET_COMMAND_V1,
    R.GOAL_COMMAND_V1,
    R.HELP_COMMAND_V1,
    ...(await R.skillCommandsV1(ctx, req.query.get('directory') ?? undefined)),
  ]))
  register('GET', '/skill', 'json', async (req, ctx) => R.json(200, await R.skillList(ctx, req.query.get('directory') ?? undefined)))
  for (const bare of ['/reference', '/integration']) {
    register('GET', bare, 'json', async () => R.json(200, []))
  }

  // ---- v2 boot / catalog routes ----
  register('GET', '/api/location', 'json', async (_req, ctx) => R.json(200, R.locationInfo(ctx)))

  register('GET', '/api/agent', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [await R.v2DefaultAgent(ctx), ...(await R.dshPresetAgentsV2(ctx))],
  }))

  register('GET', '/api/command', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [
      R.PRESET_COMMAND_V2,
      R.GOAL_COMMAND_V2,
      R.HELP_COMMAND_V2,
      ...(await R.skillCommandsV2(ctx, _req.query.get('directory') ?? undefined)),
    ],
  }))
  register('GET', '/api/skill', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: await R.skillList(ctx, req.query.get('directory') ?? undefined),
  }))
  for (const bare of ['/api/reference', '/api/integration']) {
    register('GET', bare, 'json', async (_req, ctx) => R.json(200, R.v2LocationBody(ctx)))
  }

  register('GET', '/api/model', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, { location: R.locationInfo(ctx), data: convertToV2Models(groups) })
  })

  register('GET', '/api/provider', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, { location: R.locationInfo(ctx), data: convertToV2Providers(groups) })
  })

  register('GET', '/api/permission/saved', 'json', async (_req, ctx) => R.json(200, {
    data: ctx.state.savedPermissionsList().map((saved) => ({
      id: saved.toolName,
      sessionID: saved.sessionId,
      grantedAt: saved.grantedAt,
    })),
  }))

  register('GET', '/api/health', 'json', async () => R.json(200, { healthy: true }))

  // dsh sessions are always server-side and the `subagent` tool already runs
  // in the background, so "detach into background" is a no-op success.
  register('POST', '/experimental/session/:sessionID/background', 'json', async () => R.json(200, true))

}
