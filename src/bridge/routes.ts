// Route registrations for the dsh-oc bridge.
// Extracted from router.ts (chore-router-split); behavior is unchanged.
import * as R from './router.js'
import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionMessagesResponse, SessionStatus } from '@opencode-ai/sdk/v2/types'
import { badRequest } from './errors.js'
import { call } from './rpc.js'
import { convertGoalTodos } from './convert/goal.js'
import { convertMessagesV1, convertMessagesV2 } from './convert/message.js'
import { convertSessionSummary, convertSessionSummaryV2 } from './convert/session.js'
import { convertToProviderCatalog, convertToV1Providers, convertToV2Models, convertToV2Providers } from './convert/model.js'
import { filterGitTrackedDiffs } from './git.js'
import { projectIdFor } from './convert/common.js'
import { randomUUID } from 'node:crypto'
import { toPermissionRequest, toPermissionV2 } from './convert/permission.js'
import { toQuestionRequest, toQuestionV2 } from './convert/question.js'
import type { Route } from './router.js'

export type RouteRegistrar = (
  method: string,
  pattern: string,
  kind: Route['kind'],
  handler: Route['handler'],
) => void

export function registerRoutes(register: RouteRegistrar): void {
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

    register('POST', '/session', 'json', (req, ctx) => R.createSession(req, ctx, false))

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
      const agent = typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : undefined
      if (agent !== undefined && agent !== R.DEFAULT_AGENT_NAME) {
        try {
          await R.switchAgentPreset(ctx, id, agent)
          R.broadcastSessionAgent(ctx, id, agent)
        } catch (error) {
          ctx.log(`[bridge] prompt_async agent switch failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
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

    register('POST', '/api/session', 'json', (req, ctx) => R.createSession(req, ctx, true))

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

    // ---- SSE ----
    register('GET', '/global/event', 'sse', async () => ({ status: 200 }))
}
