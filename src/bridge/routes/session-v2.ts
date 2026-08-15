// session-v2 routes for the dsh-oc bridge.
import * as R from '../router.js'
import type { SessionMessagesResponse } from '@opencode-ai/sdk/v2/types'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import { badRequest, notFound } from '../errors.js'
import { convertMessagesV2 } from '../convert/message.js'
import { convertSessionSummary, convertSessionSummaryV2 } from '../convert/session.js'
import { filterGitTrackedDiffs } from '../git.js'
import { randomUUID } from 'node:crypto'
import { toPermissionV2 } from '../convert/permission.js'
import { toQuestionV2 } from '../convert/question.js'
import type { RouteRegistrar } from '../routes.js'

export function registerSessionV2Routes(register: RouteRegistrar): void {
  // ---- v2 sessions ----
  register('GET', '/api/session', 'json', async (req, ctx) => {
    const search = req.query.get('search')
    let all: SessionSummary[]
    if (search !== null && search.length > 0) {
      const results = await R.rpc(ctx, 'session.search', { query: search })
      const ids = new Set(results.items.map((item) => String(item.sessionId)))
      const list = await R.cachedSessionList(ctx)
      all = list.filter((item) => ids.has(String(item.sessionId)))
    } else {
      all = await R.cachedSessionList(ctx)
    }
    const filtered = R.filterSessionsByDirectory(all, req.query.get('directory') ?? undefined, ctx.cwd)
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const cursorRaw = req.query.get('cursor')
    const offset = cursorRaw === null ? 0 : R.decodeSessionCursor(cursorRaw)
    const ordered = req.query.get('order') === 'asc' ? [...filtered].reverse() : filtered
    const page = ordered.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    R.recordSessionSummaries(ctx, page)
    await R.warmListTitles(ctx, page)
    return R.json(200, {
      data: page.map((item) => convertSessionSummaryV2(item, {
        cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
        title: ctx.state.sessionTitleFor(String(item.sessionId)),
      })),
      cursor: {
        ...(nextOffset < filtered.length ? { next: R.encodeSessionCursor(nextOffset) } : {}),
        ...(offset > 0 ? { previous: R.encodeSessionCursor(Math.max(0, offset - limit)) } : {}),
      },
    })
  })

  register('GET', '/experimental/session', 'json', async (req, ctx) => {
    const search = req.query.get('search')
    let all: SessionSummary[] = await R.cachedSessionList(ctx)
    if (search !== null && search.length > 0) {
      const results = await R.rpc(ctx, 'session.search', { query: search })
      const ids = new Set(results.items.map((item) => String(item.sessionId)))
      all = all.filter((item) => ids.has(String(item.sessionId)))
    }
    const filtered = R.filterSessionsByDirectory(all, req.query.get('directory') ?? undefined, ctx.cwd)
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const page = filtered.slice(0, limit)
    R.recordSessionSummaries(ctx, page)
    await R.warmListTitles(ctx, page)
    return R.json(200, page.map((item) => convertSessionSummary(item, {
      cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
      title: ctx.state.sessionTitleFor(String(item.sessionId)),
    })))
  })

  register('POST', '/api/session', 'json', (req, ctx) => R.createSession(req, ctx, true))

  register('GET', '/api/session/active', 'json', async (_req, ctx) => {
    const id = ctx.state.currentSessionId
    return R.json(200, { data: id === undefined ? {} : { [id]: { type: 'running' } } })
  })

  register('POST', '/api/session/:sessionID/wait', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const list = await R.rpc(ctx, 'session.list', {})
      const item = list.items.find((entry) => String(entry.sessionId) === id)
      if (item === undefined) throw notFound('session not found', { sessionID: id })
      if (!item.running) return R.json(204)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return R.json(503, { name: 'ServiceUnavailableError', message: 'session still busy' })
  })

  register('POST', '/api/session/:sessionID/fork', 'json', (req, ctx) => R.forkSession(req, ctx, true))

  register('POST', '/api/session/:sessionID/compact', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await R.runCompactCommand(ctx, id)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/prompt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const content = R.parsePromptParts(R.bodyAsRecord(req.body).parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, {
        data: {
          id: `msg_${randomUUID()}`,
          sessionID: id,
          prompt: { parts: content },
          delivery: 'queue',
          timeCreated: Date.now(),
          admittedSeq: 0,
        },
      })
    }
    await R.applyAgentFromBody(ctx, id, req.body)
    await R.applyModelSelection(ctx, id, req.body)
    await R.rpc(ctx, 'session.prompt', { sessionId: R.sid(id), mode: 'queue', content })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, {
      data: {
        id: `msg_${randomUUID()}`,
        sessionID: id,
        prompt: { parts: content },
        delivery: 'queue',
        timeCreated: Date.now(),
        admittedSeq: 0,
      },
    })
  })

  register('GET', '/api/session/:sessionID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const view = await R.sessionView(ctx, id)
    return R.json(200, { data: R.toV2Session(view, id, ctx) })
  })

  register('POST', '/api/session/:sessionID/model', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await R.applyModelSelection(ctx, id, req.body)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/agent', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const agent = typeof R.bodyAsRecord(req.body).agent === 'string'
      ? (R.bodyAsRecord(req.body).agent as string)
      : ''
    if (agent === '') throw badRequest('agent switch requires a string agent')
    await R.switchAgentPreset(ctx, id, agent)
    R.broadcastSessionAgent(ctx, id, agent)
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/interrupt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await R.rpc(ctx, 'session.cancel', { sessionId: R.sid(id) })
    return R.json(204)
  })

  register('GET', '/api/session/:sessionID/message', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : undefined
    const cursorRaw = req.query.get('cursor')
    const beforeSeq = cursorRaw === null ? undefined : R.decodeMessageCursor(cursorRaw)
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: limit, beforeSeq })
    const defaultModel = await R.defaultModelRef(ctx)
    const entries = history.events
    const oldest = R.oldestSurfaceSeq(entries)
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    )
    const response: SessionMessagesResponse = {
      data: req.query.get('order') === 'desc' ? data.reverse() : data,
      cursor: {
        ...(history.hasMore && oldest !== undefined ? { previous: R.encodeMessageCursor(oldest) } : {}),
      },
    }
    return R.json(200, response)
  })

  register('GET', '/api/session/:sessionID/diff', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await R.cachedSessionHistory(ctx, id)
    return R.json(200, filterGitTrackedDiffs(ctx.cwd, R.historyFileDiffs(history)))
  })

  register('GET', '/api/session/:sessionID/permission', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return R.json(200, { data: ctx.state.permissionsForSession(id).map(toPermissionV2) })
  })

  register('POST', '/api/session/:sessionID/permission/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.permissionReply(ctx, requestID, req.body)
    return R.json(204)
  })

  register('GET', '/api/session/:sessionID/question', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return R.json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) })
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReply(ctx, requestID, req.body)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reject', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReject(ctx, requestID)
    return R.json(204)
  })

}
