import { execFile, spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Message, Part } from '@opencode-ai/sdk/client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveAgent as resolveHostAgent, RpcCallError } from './rpc.js'
import type { BridgeRouteContext } from './router.js'
import {
  completedToolPart,
  errorToolPart,
  runningToolPart,
  type ToolCallInfo,
  type ToolResultInfo,
} from './convert/tool.js'
import { DEFAULT_AGENT, externalProviderId, projectIdFor } from './convert/common.js'
import { makeEvent } from './events-util.js'
import { HttpError, badRequest, conflict, internalError, notFound, rpcErrorToHttp } from './errors.js'

export interface ShellCommandBody {
  command: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  workdir?: string
}

export interface ShellCommandResult {
  info: Message
  parts: Part[]
}

interface MaintenanceAgent extends Agent {
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

const SHELL_CONTEXT_PLUGIN = 'dsh-oc'

interface ShellRunResult {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | null
  signal: string | null
  aborted: boolean
  errorMessage?: string
  /** Set when the shell card completed but model-context injection failed. */
  contextWarning?: string
}

/** Bounded per-stream retention; the child is always drained past the cap. */
export const SHELL_OUTPUT_LIMIT_BYTES = 1024 * 1024

/** Separate, smaller budgets for text sent to the configured model. */
export const SHELL_CONTEXT_COMMAND_LIMIT_BYTES = 16 * 1024
export const SHELL_CONTEXT_STREAM_LIMIT_BYTES = 64 * 1024
export const SHELL_CONTEXT_TOTAL_LIMIT_BYTES = 144 * 1024
export const SHELL_CONTEXT_WARNING_LIMIT_BYTES = 1024

interface ShellInvocation {
  file: string
  args: string[]
  detached: boolean
}

function shellInvocation(command: string): ShellInvocation {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      detached: false,
    }
  }
  const file = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  return { file, args: ['-c', command], detached: true }
}

type ShellChild = ChildProcessByStdio<null, Readable, Readable>

function signalOwnedProcess(child: ShellChild, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined && child.pid > 0) {
      execFile('taskkill', ['/PID', String(child.pid), '/T'], { windowsHide: true }, () => {})
    }
    return
  }
  try {
    if (!child.killed) child.kill(signal)
  } catch {
    // The child may have exited between the exact ownership check and signal.
  }
  if (child.pid !== undefined && child.pid > 0) {
    try {
      // POSIX detached spawn makes the exact child pid the process-group id.
      // This is never a name-based or ambient process search.
      process.kill(-child.pid, signal)
    } catch {
      // The group may already have gone away; close remains authoritative.
    }
  }
}

function forceKillOwnedProcess(child: ShellChild): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined && child.pid > 0) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }
    return
  }
  signalOwnedProcess(child, 'SIGKILL')
}

function runShellProcess(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  if (signal.aborted) {
    return Promise.resolve({ stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, aborted: true })
  }
  const invocation = shellInvocation(command)
  let child: ShellChild
  try {
    child = spawn(invocation.file, invocation.args, {
      cwd,
      detached: invocation.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: null,
      signal: null,
      aborted: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
  }

  return new Promise<ShellRunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let aborted = false
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: ShellRunResult): void => {
      if (settled) return
      settled = true
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      signal.removeEventListener('abort', onAbort)
      resolve({ ...result, stdout, stderr, stdoutTruncated, stderrTruncated })
    }
    const appendLimited = (current: string, chunk: Buffer | string, stream: 'stdout' | 'stderr'): string => {
      const bytes = Buffer.from(String(chunk))
      const used = Buffer.byteLength(current)
      if (used >= SHELL_OUTPUT_LIMIT_BYTES) {
        if (stream === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
        return current
      }
      if (used + bytes.byteLength <= SHELL_OUTPUT_LIMIT_BYTES) return current + bytes.toString()
      const keep = bytes.subarray(0, SHELL_OUTPUT_LIMIT_BYTES - used).toString()
      if (stream === 'stdout') stdoutTruncated = true
      else stderrTruncated = true
      return current + keep
    }
    const onAbort = (): void => {
      if (settled || aborted) return
      aborted = true
      signalOwnedProcess(child, 'SIGTERM')
      forceTimer = setTimeout(() => forceKillOwnedProcess(child), 3000)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer | string) => { stdout = appendLimited(stdout, chunk, 'stdout') })
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = appendLimited(stderr, chunk, 'stderr') })
    child.once('error', (error) => {
      finish({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode: null,
        signal: null,
        aborted,
        errorMessage: error.message,
      })
    })
    child.once('close', (exitCode, closeSignal) => {
      finish({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode,
        signal: closeSignal,
        aborted,
      })
    })
  })
}

function shellMessageInfo(
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  created: number,
  directory: string,
  agent: string,
  model: { providerID: string; modelID: string },
  parentID?: string,
): Message {
  if (role === 'user') {
    return { id, sessionID: sessionId, role, time: { created }, agent, model } as Message
  }
  return {
    id,
    sessionID: sessionId,
    role,
    agent,
    mode: agent,
    time: { created },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as Message
}

function shellUserPart(sessionId: string, messageId: string, created: number): Part {
  return {
    id: `${messageId}:0`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text: 'The following tool was executed by the user',
    synthetic: true,
    time: { start: created, end: created },
  } as Part
}

function renderShellOutput(result: ShellRunResult): string {
  let output = result.stdout
  if (result.stdoutTruncated) {
    output += `${output.length > 0 && !output.endsWith('\n') ? '\n' : ''}[stdout truncated after ${SHELL_OUTPUT_LIMIT_BYTES} bytes]`
  }
  if (result.stderr.length > 0) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += `[stderr]\n${result.stderr}`
  }
  if (result.stderrTruncated) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += `[stderr truncated after ${SHELL_OUTPUT_LIMIT_BYTES} bytes]`
  }
  if (result.errorMessage !== undefined) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += `Error: ${result.errorMessage}`
  }
  if (result.aborted) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += '<metadata>\nUser aborted the command\n</metadata>'
  } else if (result.signal !== null) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += `[killed by signal: ${result.signal}]`
  } else if (result.exitCode !== null && result.exitCode !== 0) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += `[exit code: ${result.exitCode}]`
  }
  if (result.contextWarning !== undefined) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += result.contextWarning
  }
  return output.length === 0 ? '(no output)' : output
}

/** Truncate on Unicode code-point boundaries while accounting in UTF-8 bytes. */
function truncateUtf8(value: string, limitBytes: number, marker: string): string {
  if (Buffer.byteLength(value, 'utf8') <= limitBytes) return value
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= limitBytes) {
    let clipped = ''
    let used = 0
    for (const character of marker) {
      const size = Buffer.byteLength(character, 'utf8')
      if (used + size > limitBytes) break
      clipped += character
      used += size
    }
    return clipped
  }
  let clipped = ''
  let used = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size + markerBytes > limitBytes) break
    clipped += character
    used += size
  }
  return clipped + marker
}

function compactContextWarning(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const oneLine = raw.replace(/\s+/gu, ' ').trim() || 'unknown injection error'
  return truncateUtf8(oneLine, SHELL_CONTEXT_WARNING_LIMIT_BYTES, ' [truncated]')
}

function shellContextStatus(result: ShellRunResult): string {
  const status: string[] = []
  if (result.errorMessage !== undefined) status.push(`Error: ${compactContextWarning(result.errorMessage)}`)
  if (result.aborted) {
    status.push('User aborted the command')
  } else if (result.signal !== null) {
    status.push(`killed by signal: ${result.signal}`)
  } else if (result.exitCode !== null && result.exitCode !== 0) {
    status.push(`[exit code: ${result.exitCode}]`)
  }
  return status.join('\n')
}

function renderShellContextOutput(result: ShellRunResult): string {
  const stdoutMarker = `[stdout truncated for model context after ${SHELL_CONTEXT_STREAM_LIMIT_BYTES} UTF-8 bytes]`
  const stderrMarker = `[stderr truncated for model context after ${SHELL_CONTEXT_STREAM_LIMIT_BYTES} UTF-8 bytes]`
  const stdoutNeedsMarker = result.stdoutTruncated
    || Buffer.byteLength(result.stdout, 'utf8') > SHELL_CONTEXT_STREAM_LIMIT_BYTES
  const stderrNeedsMarker = result.stderrTruncated
    || Buffer.byteLength(result.stderr, 'utf8') > SHELL_CONTEXT_STREAM_LIMIT_BYTES
  const stdoutLimit = stdoutNeedsMarker
    ? Math.max(0, SHELL_CONTEXT_STREAM_LIMIT_BYTES - Buffer.byteLength(stdoutMarker, 'utf8') - 1)
    : SHELL_CONTEXT_STREAM_LIMIT_BYTES
  const stderrLimit = stderrNeedsMarker
    ? Math.max(0, SHELL_CONTEXT_STREAM_LIMIT_BYTES - Buffer.byteLength(stderrMarker, 'utf8') - 1)
    : SHELL_CONTEXT_STREAM_LIMIT_BYTES
  let output = ''
  // Put all truncation notices before the large payload so a separate total
  // budget cannot cut away the explanation for the later stream bytes.
  if (stdoutNeedsMarker) output += `${stdoutMarker}\n`
  if (stderrNeedsMarker) output += `${stderrMarker}\n`
  output += truncateUtf8(result.stdout, stdoutLimit, '')
  if (result.stderr.length > 0 || result.stderrTruncated) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += '[stderr]\n'
    output += truncateUtf8(result.stderr, stderrLimit, '')
  }
  return output.length === 0 ? '(no output)' : output
}

/**
 * Build the model-facing record for a completed `!` shell command.
 *
 * `Agent.inject()` is the dsh host seam for non-waking context.  The command
 * therefore enters the durable `agent/inbox/spliced` next-step pending queue;
 * after the agent claims it, the message is included in the next model request
 * together with the real prompt, without opening an LLM turn by itself. Keep
 * the prose explicit: the model must distinguish a command the human ran from
 * a command it requested through a tool call.
 */
function shellContextMessage(command: string, result: ShellRunResult) {
  const commandText = truncateUtf8(
    command,
    SHELL_CONTEXT_COMMAND_LIMIT_BYTES,
    `[command truncated for model context after ${SHELL_CONTEXT_COMMAND_LIMIT_BYTES} UTF-8 bytes]`,
  )
  const status = shellContextStatus(result)
  const contextText = truncateUtf8(
    [
      'The user manually executed a shell command through OpenCode ! shell mode.',
      'Source: user manually executed this command; it was not a model-requested tool call.',
      ...(status === '' ? [] : [`Status:\n${status}`]),
      `Command:\n${commandText}`,
      `Output:\n${renderShellContextOutput(result)}`,
    ].join('\n\n'),
    SHELL_CONTEXT_TOTAL_LIMIT_BYTES,
    `[dsh-oc] shell model context truncated after ${SHELL_CONTEXT_TOTAL_LIMIT_BYTES} UTF-8 bytes`,
  )
  return createUserMessage({
    content: [{
      type: 'text',
      text: contextText,
    }],
    source: {
      kind: 'plugin',
      plugin: SHELL_CONTEXT_PLUGIN,
      form: 'notice',
      summary: 'The user manually executed a shell command',
    },
  })
}

function shellError(result: ShellRunResult): ToolResultInfo['error'] | undefined {
  if (result.errorMessage !== undefined) return { name: result.errorMessage }
  return undefined
}

function agentForShell(value: unknown): MaintenanceAgent | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<MaintenanceAgent>
  return typeof candidate.runMaintenance === 'function' ? candidate as MaintenanceAgent : undefined
}

function shellDirectory(ctx: BridgeRouteContext, sessionId: string, requested?: string): string {
  // The persisted session cwd is authoritative.  The workspace-routing query
  // is only a cold-start fallback, matching OpenCode's middleware contract.
  const sessionDirectory = ctx.state.sessionDirectories.get(sessionId)
  if (sessionDirectory !== undefined) return sessionDirectory
  if (requested === undefined) return ctx.cwd
  return isAbsolute(requested) ? requested : resolve(ctx.cwd, requested)
}

/**
 * Execute one OpenCode shell-mode request as a user-authorized maintenance
 * operation.  This deliberately does not call `ctx.tools.execute`: that API
 * is model-direct and collapses non-`run_code` calls for PTC agents; moreover
 * dsh approval audit events require an open model turn.  OpenCode's explicit
 * `!` is the authorization boundary, so this path inherits the OS user and
 * owns only its exact child process/group.
 */
export async function runShellCommand(
  ctx: BridgeRouteContext,
  sessionId: string,
  body: ShellCommandBody,
): Promise<ShellCommandResult> {
  if (typeof body.command !== 'string' || body.command.trim().length === 0) {
    throw badRequest('shell command requires a non-empty command')
  }

  let resolvedAgent: unknown
  try {
    resolvedAgent = ctx.api.agents?.get(sessionId)
    if (resolvedAgent === undefined) resolvedAgent = await resolveHostAgent(ctx.api, sessionId)
  } catch (error) {
    if (error instanceof RpcCallError) throw rpcErrorToHttp(error)
    throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
  }
  const agent = agentForShell(resolvedAgent)
  if (agent === undefined) throw internalError('shell mode unavailable: Agent.runMaintenance ABI is missing', { sessionId })
  if (typeof agent.inject !== 'function') {
    throw internalError('shell mode unavailable: Agent.inject ABI is missing', { sessionId })
  }

  const requestedAgent = body.agent?.trim()
  if (body.agent !== undefined && requestedAgent === '') throw badRequest('shell request agent must be non-empty')
  const knownAgent = ctx.state.sessionAgentFor(sessionId)
  if (requestedAgent !== undefined && knownAgent !== undefined && requestedAgent !== knownAgent) {
    throw badRequest(`shell request agent "${requestedAgent}" does not match active session agent "${knownAgent}"`)
  }
  if (requestedAgent !== undefined && requestedAgent !== DEFAULT_AGENT) {
    const presets = await ctx.api.agentPresets.list()
    if (!presets.some((preset) => preset.id === requestedAgent && preset.broken === undefined)) {
      throw badRequest(`agent "${requestedAgent}" is not available for shell mode`)
    }
  }
  const directory = shellDirectory(ctx, sessionId, body.workdir)
  if (ctx.state.isSessionCleared(sessionId)) throw notFound(`session "${sessionId}" not found`)
  const project = projectIdFor(directory)
  const agentName = requestedAgent ?? knownAgent ?? DEFAULT_AGENT
  // Prefer the session's recorded model selection over the legacy default so
  // the synthetic shell card does not show `deepseek-chat` on the first turn.
  const sessionModel = ctx.state.sessionModelSelectionFor(sessionId)
  const model = {
    providerID: externalProviderId(body.model?.providerID?.trim() || sessionModel?.providerID || 'deepseek'),
    modelID: body.model?.modelID?.trim() || sessionModel?.modelID || 'deepseek-chat',
  }
  ctx.state.markSessionPresent(sessionId)

  let maintenance: Promise<ShellCommandResult>
  try {
    maintenance = agent.runMaintenance(async (agentSignal) => {
      const userId = `msg_shell:user:${randomUUID()}`
      const assistantId = `msg_shell:${randomUUID()}`
      const callId = `call_shell:${randomUUID()}`
      const created = Date.now()
      const userInfo = shellMessageInfo(sessionId, userId, 'user', created, directory, agentName, model)
      const userPart = shellUserPart(sessionId, userId, created)
      const assistantInfo = shellMessageInfo(sessionId, assistantId, 'assistant', created, directory, agentName, model, userId)
      const call: ToolCallInfo = {
        callId,
        // OpenCode 1.18.18's ShellID.ToolID is always `bash`; the actual
        // Windows ComSpec choice is an execution detail, never a wire tool id.
        name: 'bash',
        arguments: JSON.stringify({ command: body.command, description: `Run shell command: ${body.command}` }),
      }
      const running = runningToolPart(call, { sessionID: sessionId, messageID: assistantId, time: created })
      const controller = new AbortController()
      const disposeController = ctx.state.trackShellController(sessionId, controller)
      const onAgentAbort = (): void => controller.abort(agentSignal.reason)
      let result: ShellRunResult = {
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: null,
        signal: null,
        aborted: false,
        errorMessage: 'shell execution did not settle',
      }
      let finalized = false
      let finishedInfo: Message = assistantInfo
      let finishedPart: Part | undefined
      const finalize = (): void => {
        if (finalized) return
        finalized = true
        const completed = Date.now()
        const output = renderShellOutput(result)
        const resultInfo: ToolResultInfo = {
          callId,
          content: [{ type: 'text', text: output }] as never,
          time: completed,
          ...(shellError(result) === undefined ? {} : { error: shellError(result) }),
        }
        finishedPart = shellError(result) === undefined
          ? completedToolPart(call, resultInfo, { sessionID: sessionId, messageID: assistantId, time: created })
          : errorToolPart(call, resultInfo, { sessionID: sessionId, messageID: assistantId, time: created })
        finishedInfo = { ...assistantInfo, time: { created, completed } } as Message
        // A host/session-removed edge may arrive while the owned child is
        // draining.  clearSession already aborts the child; never recreate its
        // history or status entry from this late completion.
        if (ctx.state.isSessionCleared(sessionId)) return
        try {
          ctx.state.upsertCommandResult(sessionId, { info: finishedInfo, parts: [finishedPart] })
          ctx.state.setSessionRunning(sessionId, false, completed)
          const idle = ctx.state.shouldBroadcastSessionStatus(sessionId, false)
          ctx.hub.broadcast([
            makeEvent(directory, 'message.updated', { sessionID: sessionId, info: finishedInfo }, project),
            makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part: finishedPart }, project),
            ...(idle ? [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'idle' } }, project)] : []),
            makeEvent(directory, 'session.idle', { sessionID: sessionId }, project),
          ])
        } catch (error) {
          ctx.log(`[bridge] shell finalization failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        agentSignal.addEventListener('abort', onAgentAbort, { once: true })
        if (agentSignal.aborted) onAgentAbort()
        ctx.state.setSessionRunning(sessionId, true, created)
        const busy = ctx.state.shouldBroadcastSessionStatus(sessionId, true)
        ctx.hub.broadcast([
          ...(busy ? [makeEvent(directory, 'session.status', { sessionID: sessionId, status: { type: 'busy' } }, project)] : []),
          makeEvent(directory, 'message.updated', { sessionID: sessionId, info: userInfo }, project),
          makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part: userPart }, project),
          makeEvent(directory, 'message.updated', { sessionID: sessionId, info: assistantInfo }, project),
          makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part: running }, project),
        ])
        ctx.state.recordCommandResult(sessionId, { info: userInfo, parts: [userPart] })
        ctx.state.recordCommandResult(sessionId, { info: assistantInfo, parts: [running] })
        result = await runShellProcess(body.command, directory, controller.signal)
        // A removed session must never receive a late context message. The
        // check and synchronous inject call cannot be interleaved by a host
        // event, so this also closes the remove-vs-finish race.
        if (!ctx.state.isSessionCleared(sessionId)) {
          try {
            // Injection is deliberately non-waking. The maintenance lease is
            // still held here, so a following prompt cannot race the durable
            // context insertion; it will be consumed at that prompt's next
            // step. If session.cancel cleared the inbox while aborting this
            // maintenance task, this synchronous append happens afterward and
            // deliberately re-establishes the completed-command context.
            agent.inject(shellContextMessage(body.command, result))
          } catch (error) {
            const reason = compactContextWarning(error)
            result = {
              ...result,
              contextWarning: `[dsh-oc] shell command/output was not added to model context: ${reason}`,
            }
            ctx.log(`[bridge] shell context injection failed: ${reason}`)
          }
        }
      } catch (error) {
        result = {
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: null,
          signal: null,
          aborted: controller.signal.aborted,
          errorMessage: error instanceof Error ? error.message : String(error),
        }
      } finally {
        agentSignal.removeEventListener('abort', onAgentAbort)
        disposeController()
        finalize()
      }
      return { info: finishedInfo, parts: finishedPart === undefined ? [] : [finishedPart] }
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
  }
  const disposeMaintenance = ctx.state.trackShellPromise(sessionId, maintenance)
  try {
    return await maintenance
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
  } finally {
    disposeMaintenance()
  }
}
