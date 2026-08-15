// permission routes for the dsh-oc bridge.
import * as R from '../router.js'
import { toPermissionRequest } from '../convert/permission.js'
import { toQuestionRequest } from '../convert/question.js'
import type { RouteRegistrar } from '../routes.js'

export function registerPermissionRoutes(register: RouteRegistrar): void {
  // ---- permission / question (legacy v1-style routes) ----
  register('GET', '/permission', 'json', async (_req, ctx) => R.json(200,
    [...ctx.state.permissions.values()].map(toPermissionRequest),
  ))

  register('POST', '/permission/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.permissionReply(ctx, requestID, req.body)
    return R.json(200, true)
  })

  register('GET', '/question', 'json', async (_req, ctx) => R.json(200,
    [...ctx.state.questions.values()].map(toQuestionRequest),
  ))

  register('POST', '/question/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReply(ctx, requestID, req.body)
    return R.json(200, true)
  })

  register('POST', '/question/:requestID/reject', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReject(ctx, requestID)
    return R.json(200, true)
  })

}
