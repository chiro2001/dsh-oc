// session-v1 routes for the dsh-oc bridge.
import * as R from '../router.js'
import { randomUUID } from 'node:crypto'
import type { HistoryEntry } from '../dsh-types.js'
import { badRequest, notFound } from '../errors.js'
import { call } from '../rpc.js'
import { convertGoalTodos } from '../convert/goal.js'
import { convertMessagesV1, type V1MessageEntry } from '../convert/message.js'
import { convertSessionSummary } from '../convert/session.js'
import { filterGitTrackedDiffs } from '../git.js'
import type { RouteRegistrar } from '../routes.js'

function remapV1Messages(
  ctx: R.BridgeRouteContext,
  sessionId: string,
  entries: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
): Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
  const surfaceIdForDshId = (dshId: string): string | undefined =>
    ctx.state.promptIdForDshId(sessionId, dshId)
    ?? ctx.state.assistantIdForDshId(sessionId, dshId)
  const remapped: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  for (const entry of entries) {
    const dshId = String(entry.info.id)
    const promptId = ctx.state.promptIdForDshId(sessionId, dshId)
    const assistantId = promptId === undefined
      ? ctx.state.assistantIdForDshId(sessionId, dshId)
      : undefined
    const surfaceId = promptId ?? assistantId
    const sessionAgent = ctx.state.sessionAgentFor(sessionId)
    const synthetic = dshId.startsWith('msg_cmd:')
      || dshId.startsWith('msg_preset:')
      || dshId.startsWith('msg_shell:')
    const parentDshId = typeof entry.info.parentID === 'string' ? entry.info.parentID : undefined
    const remappedParent = parentDshId === undefined ? undefined : surfaceIdForDshId(parentDshId)
    const info: Record<string, unknown> = {
      ...entry.info,
      ...(surfaceId === undefined ? {} : { id: surfaceId }),
      ...(remappedParent === undefined ? {} : { parentID: remappedParent }),
      ...(!synthetic && sessionAgent !== undefined && entry.info.role === 'assistant'
        ? { agent: sessionAgent, mode: sessionAgent }
        : {}),
      ...(!synthetic && sessionAgent !== undefined && entry.info.role === 'user'
        ? { agent: sessionAgent }
        : {}),
    }
    if (promptId !== undefined) {
      const created = ctx.state.promptMessageCreatedAt(sessionId, promptId)
      const time = info.time as { created?: unknown; completed?: unknown } | undefined
      if (created !== undefined) info.time = { ...(time ?? {}), created }
    }
    if (assistantId !== undefined) {
      const created = ctx.state.assistantMessageCreatedAt(sessionId, assistantId)
      const time = info.time as { created?: unknown; completed?: unknown } | undefined
      if (created !== undefined) {
        const normalizedTime = {
          ...(time ?? {}),
          // Reuse the live card's immutable identity. The converter's first
          // content-block time is often later and would duplicate the card.
          created,
        }
        if (ctx.state.isAssistantPending(sessionId, assistantId)) delete normalizedTime.completed
        info.time = normalizedTime
      }
    }
    const mapped: { info: Record<string, unknown>; parts: Array<Record<string, unknown>> } = {
      info,
      parts: entry.parts.map((part) => {
        const promptCreated = promptId === undefined
          ? undefined
          : ctx.state.promptMessageCreatedAt(sessionId, promptId)
        return {
          ...part,
          ...(surfaceId === undefined ? {} : {
            id: String(part.id).replaceAll(dshId, surfaceId),
            messageID: surfaceId,
          }),
          ...(promptCreated === undefined ? {} : {
            time: {
              ...((part.time as Record<string, unknown> | undefined) ?? {}),
              start: promptCreated,
              end: promptCreated,
            },
          }),
        }
      }),
    }
    if (surfaceId !== undefined) {
      // The same bridge id may cover the tool-call step and the follow-up
      // text step of one turn; merge their parts into one history message so
      // the TUI's history/live merge sees a single canonical entry.
      const existing = remapped.find((candidate) => String(candidate.info.id) === surfaceId)
      if (existing !== undefined) {
        existing.parts.push(...mapped.parts)
        continue
      }
    }
    remapped.push(mapped)
  }
  return remapped
}

function mergeCommandResults(
  entries: V1MessageEntry[],
  commandResults: readonly V1MessageEntry[],
  maxEntries?: number,
): void {
  // Durable history has already been folded in event order.  In particular,
  // dsh may write turn/start before user/message while the assistant fallback
  // time is normalized by the converter.  Never sort that list just because
  // there are no bridge-only command cards to merge.
  if (commandResults.length === 0) return
  const seen = new Set(entries.map((entry) => String(entry.info.id)))
  for (const entry of commandResults) {
    if (seen.has(String(entry.info.id))) continue
    seen.add(String(entry.info.id))
    const created = (entry.info.time as { created?: unknown } | undefined)?.created
    const createdAt = typeof created === 'number' ? created : undefined
    // Insert a synthetic card relative to the durable sequence, leaving every
    // existing user/assistant entry at its converter-provided index.  The
    // command store is oldest-first; <= keeps equal-time cards stable.
    const index = createdAt === undefined
      ? entries.length
      : entries.findIndex((candidate) => {
          const candidateCreated = (candidate.info.time as { created?: unknown } | undefined)?.created
          return typeof candidateCreated === 'number' && candidateCreated > createdAt
        })
    entries.splice(index === -1 ? entries.length : index, 0, entry)
  }
  if (maxEntries !== undefined && entries.length > maxEntries) {
    entries.splice(0, entries.length - maxEntries)
  }
}

function registerPromptIds(
  ctx: R.BridgeRouteContext,
  sessionId: string,
  body: Record<string, unknown>,
): { promptUserID: string; assistantID: string; createdAt: number } {
  const promptUserID = typeof body.messageID === 'string' && body.messageID.length > 0
    ? body.messageID
    : `msg_${randomUUID()}`
  const createdAt = Date.now()
  ctx.state.registerPromptMessageId(sessionId, promptUserID, createdAt)
  const assistantID = `msg_${randomUUID()}`
  ctx.state.registerAssistantIdForUser(sessionId, promptUserID, assistantID)
  return { promptUserID, assistantID, createdAt }
}

function promptText(content: Array<{ type: string; text?: unknown }>): string {
  return content.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

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
      ...(ctx.state.sessionAgentFor(String(item.sessionId)) === undefined
        ? {}
        : { agent: ctx.state.sessionAgentFor(String(item.sessionId)) }),
    })))
  })

  register('GET', '/session/status', 'json', async (_req, ctx) => {
    // The official TUI polls this endpoint every 250ms while a turn waits.
    // Read the host status map in memory; only the first unknown cold start
    // may seed it through one bounded session.list call.
    ctx.state.sessionStatusRequests++
    await R.ensureSessionStatusSeed(ctx)
    return R.json(200, R.sessionStatusSnapshot(ctx, _req.query.get('directory') ?? undefined))
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

  // Official OpenCode shell mode (`!` at the prompt) submits the command to
  // this v1 endpoint.  The bridge owns the exact user shell process and
  // streams a synthetic user/assistant/tool card while it runs.
  register('POST', '/session/:id/shell', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    if (typeof body.agent !== 'string' || body.agent.trim() === '') {
      throw badRequest('shell request requires a non-empty agent')
    }
    const model = body.model !== null && typeof body.model === 'object' && !Array.isArray(body.model)
      ? body.model as Record<string, unknown>
      : undefined
    const result = await R.runShellCommand(ctx, id, {
      command: typeof body.command === 'string' ? body.command : '',
      ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
      ...(req.query.get('directory') === null ? {} : { workdir: req.query.get('directory') as string }),
      ...(model === undefined ? {} : {
        model: {
          ...(typeof model.providerID === 'string' ? { providerID: model.providerID } : {}),
          ...(typeof model.modelID === 'string' ? { modelID: model.modelID } : {}),
        },
      }),
    })
    return R.json(200, result)
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
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = convertMessagesV1(
      history.events.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`),
      },
      history.events.map((entry) => entry.view),
    )
    mergeCommandResults(entries, ctx.state.commandResultsFor(id), limit)
    const remapped = remapV1Messages(ctx, id, entries)
    R.mergePendingAssistantV1(ctx, id, remapped)
    return R.json(200, remapped)
  })

  register('GET', '/session/:id/message/:messageID', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const messageID = req.params.messageID as string
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = convertMessagesV1(
      history.events.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`),
      },
      history.events.map((entry) => entry.view),
    )
    mergeCommandResults(entries, ctx.state.commandResultsFor(id))
    const remapped = remapV1Messages(ctx, id, entries)
    R.mergePendingAssistantV1(ctx, id, remapped)
    const found = remapped.find((entry) => entry.info.id === messageID)
    if (found === undefined) throw notFound('message not found', { messageID })
    return R.json(200, found)
  })

  register('POST', '/session/:id/message', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    const content = R.parsePromptParts(body.parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text, R.placeholderSessionOptions(ctx, id)))
    }
    const { promptUserID, assistantID, createdAt } = registerPromptIds(ctx, id, body)
    await R.applyAgentFromBody(ctx, id, req.body)
    if (!(await R.applyModelSelection(ctx, id, req.body))) {
      await R.reconcileModelSelection(ctx, id)
    }
    await R.broadcastPromptUserMessage(
      ctx,
      id,
      promptUserID,
      promptText(content),
      createdAt,
      R.promptModelRef(ctx, id, req.body),
    )
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      requestId: promptUserID,
      mode: 'steer',
      content,
    })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, undefined, {
      id: assistantID,
      parentID: promptUserID,
      ...await R.placeholderSessionOptionsForPrompt(ctx, id, R.promptModelRef(ctx, id, req.body)),
    }))
  })

  // Alias used by the dsh-oc e2e matrix; the official SDK prompt route is
  // `POST /session/:id/message` (v1) and `POST /api/session/:id/prompt` (v2).
  register('POST', '/session/:id/prompt', 'json', async (req, ctx) => {
    const id = req.params.id as string
    const body = R.bodyAsRecord(req.body)
    const content = R.parsePromptParts(body.parts, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, outcome.text, R.placeholderSessionOptions(ctx, id)))
    }
    const { promptUserID, assistantID, createdAt } = registerPromptIds(ctx, id, body)
    await R.applyAgentFromBody(ctx, id, req.body)
    if (!(await R.applyModelSelection(ctx, id, req.body))) {
      await R.reconcileModelSelection(ctx, id)
    }
    await R.broadcastPromptUserMessage(
      ctx,
      id,
      promptUserID,
      promptText(content),
      createdAt,
      R.promptModelRef(ctx, id, req.body),
    )
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      requestId: promptUserID,
      mode: 'steer',
      content,
    })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, undefined, {
      id: assistantID,
      parentID: promptUserID,
      ...await R.placeholderSessionOptionsForPrompt(ctx, id, R.promptModelRef(ctx, id, req.body)),
    }))
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
    const { promptUserID, createdAt } = registerPromptIds(ctx, id, body)
    await R.applyAgentFromBody(ctx, id, body)
    if (!(await R.applyModelSelection(ctx, id, body))) {
      await R.reconcileModelSelection(ctx, id)
    }
    await R.broadcastPromptUserMessage(
      ctx,
      id,
      promptUserID,
      promptText(content),
      createdAt,
      R.promptModelRef(ctx, id, body),
    )
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      requestId: promptUserID,
      mode: 'steer',
      content,
    })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  register('POST', '/session/:id/abort', 'json', async (req, ctx) => {
    const id = req.params.id as string
    R.abortShellCommand(ctx, id)
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
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, R.slashOutcomeText(ctx, id, outcome.text), R.placeholderSessionOptions(ctx, id)))
    }
    if (name === 'goal') {
      const outcome = await R.runGoalCommand(ctx, id, argumentsRaw)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, R.slashOutcomeText(ctx, id, outcome.text), R.placeholderSessionOptions(ctx, id)))
    }
    if (name === 'help') {
      const outcome = R.runHelpCommand(ctx, id, argumentsRaw)
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, R.slashOutcomeText(ctx, id, outcome.text), R.placeholderSessionOptions(ctx, id)))
    }
    const skills = await R.skillListForSession(ctx, id)
    if (skills.some((skill) => skill.name === name)) {
      const promptText = argumentsRaw.trim() === '' ? `/${name}` : `/${name} ${argumentsRaw.trim()}`
      await R.rpc(ctx, 'session.prompt', {
        sessionId: R.sid(id),
        mode: 'steer',
        content: [{ type: 'text', text: promptText }],
      })
      ctx.state.invalidateSession(id)
      return R.json(200, R.pendingAssistantPlaceholder(id, ctx.cwd, undefined, R.placeholderSessionOptions(ctx, id)))
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
        todos = (event.data as { todos: unknown }).todos
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
