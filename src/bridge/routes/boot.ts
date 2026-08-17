// boot routes for the dsh-oc bridge.
import * as R from '../router.js'
import { convertToProviderCatalog, convertToV1Providers, convertToV2Models, convertToV2Providers } from '../convert/model.js'
import { OPENCODE_VERSION, projectIdFor } from '../convert/common.js'
import { permissionActionFromTool } from '../convert/permission.js'
import { toPermissionV2 } from '../convert/permission.js'
import { toQuestionV2 } from '../convert/question.js'
import { notFound } from '../errors.js'
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

  register('GET', '/agent', 'json', async (_req, ctx) => R.json(200, await R.v1AgentList(ctx)))
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
    data: await R.v2AgentList(ctx),
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

  register('GET', '/api/provider/:providerID', 'json', async (req, ctx) => {
    const providerID = req.params.providerID as string
    const groups = await R.modelGroups(ctx)
    const providers = convertToV2Providers(groups)
    const found = providers.find((provider) => provider.id === providerID)
    if (found === undefined) throw notFound('provider not found', { providerID })
    return R.json(200, { location: R.locationInfo(ctx), data: found })
  })

  register('GET', '/api/permission/request', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [...ctx.state.permissions.values()].map(toPermissionV2),
  }))

  register('GET', '/api/question/request', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [...ctx.state.questions.values()].map(toQuestionV2),
  }))

  register('GET', '/api/permission/saved', 'json', async (_req, ctx) => R.json(200, {
    data: ctx.state.savedPermissionsList().map((saved) => ({
      id: ctx.state.savedPermissionId(saved),
      projectID: projectIdFor(ctx.cwd),
      action: permissionActionFromTool(saved.toolName),
      resource: saved.toolName,
      sessionID: saved.sessionId,
      grantedAt: saved.grantedAt,
    })),
  }))

  register('DELETE', '/api/permission/saved/:permissionID', 'json', async (req, ctx) => {
    const permissionID = req.params.permissionID as string
    if (!ctx.state.removeSavedPermission(permissionID)) {
      throw notFound('saved permission not found', { permissionID })
    }
    return R.json(204)
  })

  register('GET', '/api/health', 'json', async () => R.json(200, { healthy: true }))

  register('GET', '/global/health', 'json', async () => R.json(200, {
    healthy: true,
    version: OPENCODE_VERSION,
  }))

  // dsh owns the bridge/process lifecycle; client dispose requests are
  // acknowledged and ignored so the profile keeps running.
  register('POST', '/global/dispose', 'json', async () => R.json(200, true))
  register('POST', '/instance/dispose', 'json', async () => R.json(200, true))

  // dsh sessions are always server-side and the `subagent` tool already runs
  // in the background, so "detach into background" is a no-op success.
  register('POST', '/experimental/session/:sessionID/background', 'json', async () => R.json(200, true))

}
