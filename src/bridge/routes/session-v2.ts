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

function remapV2Messages(
  ctx: R.BridgeRouteContext,
  sessionId: string,
  messages: SessionMessagesResponse['data'],
): SessionMessagesResponse['data'] {
  return messages.map((message) => {
    const promptId = ctx.state.promptIdForDshId(sessionId, message.id)
    const assistantId = promptId === undefined
      ? ctx.state.assistantIdForDshId(sessionId, message.id)
      : undefined
    const surfaceId = promptId ?? assistantId
    const sessionAgent = ctx.state.sessionAgentFor(sessionId)
    if (surfaceId === undefined && sessionAgent === undefined) return message
    if (!('content' in message) || !Array.isArray(message.content)) {
      return {
        ...message,
        ...(surfaceId === undefined ? {} : { id: surfaceId }),
        ...(sessionAgent !== undefined && message.type === 'assistant'
          ? { agent: sessionAgent }
          : {}),
      }
    }
    const content = message.content.map((part) => ({
      ...part,
      ...(surfaceId === undefined ? {} : {
        id: String(part.id).replaceAll(message.id, surfaceId),
        messageID: surfaceId,
      }),
    }))
    return {
      ...message,
      ...(surfaceId === undefined ? {} : { id: surfaceId }),
      ...(sessionAgent !== undefined && message.type === 'assistant'
        ? { agent: sessionAgent }
        : {}),
      content,
    } as SessionMessagesResponse['data'][number]
  })
}

function promptText(content: Array<{ type: string; text?: unknown }>): string {
  return content.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

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
    if (id === undefined) return R.json(200, { data: {} })
    const list = await R.cachedSessionList(ctx)
    const item = list.find((entry) => String(entry.sessionId) === id)
    if (item === undefined || !item.running) return R.json(200, { data: {} })
    return R.json(200, { data: { [id]: { type: 'running' } } })
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
    const body = R.bodyAsRecord(req.body)
    const content = R.parsePromptParts(body.parts, ctx.cwd)
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
    const promptUserID = typeof body.messageID === 'string' && body.messageID.length > 0
      ? body.messageID
      : `msg_${randomUUID()}`
    ctx.state.registerPromptMessageId(id, promptUserID)
    const assistantID = `msg_${randomUUID()}`
    ctx.state.registerAssistantIdForUser(id, promptUserID, assistantID)
    await R.applyAgentFromBody(ctx, id, req.body)
    await R.broadcastPromptUserMessage(ctx, id, promptUserID, promptText(content), Date.now())
    if (!(await R.applyModelSelection(ctx, id, req.body))) {
      await R.reconcileModelSelection(ctx, id)
    }
    await R.rpc(ctx, 'session.prompt', { sessionId: R.sid(id), mode: 'queue', content })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, {
      data: {
        id: promptUserID,
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

  register('GET', '/api/session/:sessionID/event', 'sse', async () => ({ status: 200 }))

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
    const remapped = remapV2Messages(ctx, id, data)
    const response: SessionMessagesResponse = {
      data: req.query.get('order') === 'desc' ? remapped.reverse() : remapped,
      cursor: {
        ...(history.hasMore && oldest !== undefined ? { previous: R.encodeMessageCursor(oldest) } : {}),
      },
    }
    return R.json(200, response)
  })

  register('GET', '/api/session/:sessionID/history', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : undefined
    const afterRaw = req.query.get('after')
    const after = afterRaw === null ? undefined : Number(afterRaw)
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      throw badRequest('after must be a non-negative integer')
    }
    const history = await R.cachedSessionHistory(ctx, id)
    const defaultModel = await R.defaultModelRef(ctx)
    const entries = history.events
    const anchorSeqs: number[] = []
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        onSkip: (type, reason) => ctx.log(`[bridge/history-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
      anchorSeqs,
    )
    const withSeq = data.map((message, index) => ({ message, seq: anchorSeqs[index] ?? 0 }))
    const filtered = after === undefined ? withSeq : withSeq.filter((entry) => entry.seq > after)
    const page = filtered.slice(0, limit ?? filtered.length)
    const next = page.length === 0
      ? null
      : page.reduce((max, entry) => Math.max(max, entry.seq), -1)
    return R.json(200, {
      data: remapV2Messages(ctx, id, page.map((entry) => entry.message)),
      hasMore: filtered.length > page.length,
      next,
    })
  })

  register('GET', '/api/session/:sessionID/context', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    const defaultModel = await R.defaultModelRef(ctx)
    const entries = history.events
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
    return R.json(200, { data })
  })

  register('GET', '/api/session/:sessionID/message/:messageID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const messageID = req.params.messageID as string
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    const defaultModel = await R.defaultModelRef(ctx)
    const entries = history.events
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
    const remapped = remapV2Messages(ctx, id, data)
    const found = remapped.find((message) => message.id === messageID)
    if (found === undefined) throw notFound('message not found', { messageID })
    return R.json(200, { data: found })
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

  register('GET', '/api/session/:sessionID/permission/:requestID', 'json', async (req, ctx) => {
    const sessionID = req.params.sessionID as string
    const requestID = req.params.requestID as string
    const entry = ctx.state.permissionByOpenCodeId(requestID)
    if (entry === undefined || entry.sessionId !== sessionID) {
      throw notFound('permission request not found', { requestID })
    }
    return R.json(200, { data: toPermissionV2(entry) })
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
