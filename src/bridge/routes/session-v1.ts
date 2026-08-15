// session-v1 routes for the dsh-oc bridge.
import * as R from '../router.js'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionStatus } from '@opencode-ai/sdk/v2/types'
import { badRequest } from '../errors.js'
import { call } from '../rpc.js'
import { convertGoalTodos } from '../convert/goal.js'
import { convertMessagesV1 } from '../convert/message.js'
import { convertSessionSummary } from '../convert/session.js'
import { filterGitTrackedDiffs } from '../git.js'
import type { RouteRegistrar } from '../routes.js'

export function registerSessionV1Routes(register: RouteRegistrar): void {
  // ---- v1 sessions ----
  register('GET', '/session', 'json', async (_req, ctx) => {
    const list = await R.cachedSessionList(ctx)
    const items = R.filterSessionsByDirectory(list, _req.query.get('directory') ?? undefined, ctx.cwd)
    R.recordSessionSummaries(ctx, items)
    await R.warmListTitles(ctx, items)
    return R.json(200, items.map((item) => convertSessionSummary(item, {
      cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
      title: ctx.state.sessionTitleFor(String(item.sessionId)),
    })))
  })

  register('GET', '/session/status', 'json', async (_req, ctx) => {
    const list = await R.cachedSessionList(ctx)
    const status: Record<string, SessionStatus> = {}
    for (const item of R.filterSessionsByDirectory(list, _req.query.get('directory') ?? undefined, ctx.cwd)) {
      status[String(item.sessionId)] = item.running ? { type: 'busy' } : { type: 'idle' }
    }
    return R.json(200, status)
  })

  register('GET', '/session/:id/children', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const list = await R.cachedSessionList(ctx)
    const children = list.filter((item) => String(item.parentSessionId) === id)
    R.recordSessionSummaries(ctx, children)
    await R.warmListTitles(ctx, children)
    return R.json(200, children.map((item) => convertSessionSummary(item, {
      cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
      title: ctx.state.sessionTitleFor(String(item.sessionId)),
    })))
  })

  register('POST', '/session', 'json', (req, ctx) => R.createSession(req, ctx, false))

  // dsh sessions are created server-side and already initialized; the TUI's
  // init call is a no-op success.
  register('POST', '/session/:id/init', 'json', async () => R.json(200, true))

  register('POST', '/session/:id/fork', 'json', (req, ctx) => R.forkSession(req, ctx, false))

  register('POST', '/session/:id/summarize', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await R.runCompactCommand(ctx, id)
    return R.json(200, true)
  })

  // Legacy alias kept for clients that call the endpoint by its action name.
  register('POST', '/session/:id/compact', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await R.runCompactCommand(ctx, id)
    return R.json(200, true)
  })

  register('GET', '/session/:id', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const view = await R.sessionView(ctx, id)
    return R.json(200, R.toV1Session(view, id, ctx))
  })

  register('PATCH', '/session/:id', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    if (typeof body.title !== 'string') throw badRequest('session update requires a string title')
    await R.rpc(ctx, 'session.rename', { sessionId: R.sid(id), title: body.title })
    ctx.state.setSessionTitle(id, body.title)
    ctx.state.invalidateSession()
    const view = await R.sessionView(ctx, id)
    return R.json(200, R.toV1Session(view, id, ctx))
  })

  register('GET', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: limit })
    const defaultModel = await R.defaultModelRef(ctx)
    const entries = history.events
    return R.json(200, convertMessagesV1(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    ))
  })

  register('POST', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = R.parsePromptParts(R.bodyAsRecord(req.body).parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text))
    }
    await R.applyAgentFromBody(ctx, id, req.body)
    await R.applyModelSelection(ctx, id, req.body)
    await R.rpc(ctx, 'session.prompt', { sessionId: R.sid(id), mode: 'queue', content })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd))
  })

  // Alias used by the dsh-oc e2e matrix; the official SDK prompt route is
  // `POST /session/:id/message` (v1) and `POST /api/session/:id/prompt` (v2).
  register('POST', '/session/:id/prompt', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const content = R.parsePromptParts(R.bodyAsRecord(req.body).parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text))
    }
    await R.applyAgentFromBody(ctx, id, req.body)
    await R.applyModelSelection(ctx, id, req.body)
    await R.rpc(ctx, 'session.prompt', { sessionId: R.sid(id), mode: 'queue', content })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd))
  })

  // `opencode --mini` interactive attach submits through promptAsync.
  register('POST', '/session/:id/prompt_async', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    const content = R.parsePromptParts(body.parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(204)
    }
    await R.applyAgentFromBody(ctx, id, body)
    await R.applyModelSelection(ctx, id, body)
    await R.rpc(ctx, 'session.prompt', { sessionId: R.sid(id), mode: 'queue', content })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  register('POST', '/session/:id/abort', 'json', async (req, ctx) => {
    const id = req.params.id as string
    await R.rpc(ctx, 'session.cancel', { sessionId: R.sid(id) })
    return R.json(200, true)
  })

  register('POST', '/session/:id/command', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    const command = typeof body.command === 'string' ? body.command : ''
    const argumentsRaw = typeof body.arguments === 'string' ? body.arguments : ''
    const name = command.replace(/^\//, '')
    if (name === 'preset') {
      const outcome = await R.runPresetCommand(ctx, id, argumentsRaw.trim())
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text))
    }
    if (name === 'goal') {
      const outcome = await R.runGoalCommand(ctx, id, argumentsRaw)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text))
    }
    if (name === 'help') {
      const outcome = R.runHelpCommand(ctx, id, argumentsRaw)
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text))
    }
    const skills = await R.skillListForSession(ctx, id)
    if (skills.some((skill) => skill.name === name)) {
      const promptText = argumentsRaw.trim() === '' ? `/${name}` : `/${name} ${argumentsRaw.trim()}`
      await R.rpc(ctx, 'session.prompt', {
        sessionId: R.sid(id),
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
      })
      ctx.state.invalidateSession(id)
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd))
    }
    throw badRequest(`unsupported command "${command}"`)
  })

  register('GET', '/session/:id/todo', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const history = await R.cachedSessionHistory(ctx, id)
    let todos: unknown
    for (let index = history.events.length - 1; index >= 0; index--) {
      const event = (history.events[index] as HistoryEntry).event
      if (event.type === 'todo/write') {
        todos = event.data.todos
        break
      }
    }
    if (todos === undefined && history.projections) {
      const values = history.projections.values as Partial<Record<string, unknown>>
      if (values.todos !== undefined) todos = values.todos
    }
    return R.json(200, convertGoalTodos(R.goalFromHistory(history), todos ?? []))
  })

  register('GET', '/session/:id/diff', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const history = await R.cachedSessionHistory(ctx, id)
    return R.json(200, R.producedFilesV1(filterGitTrackedDiffs(ctx.cwd, R.historyFileDiffs(history))))
  })

}
