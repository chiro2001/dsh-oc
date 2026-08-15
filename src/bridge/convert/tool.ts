import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Part, ToolPart } from '@opencode-ai/sdk/client'
import { safeJsonParse, textFromBlocks } from './common.js'

export interface ToolCallInfo {
  callId: string
  name: string
  arguments: string
  /** dsh presenter view carried on the mux/history frame for this call. */
  view?: ToolEventView
}

export interface ToolResultInfo {
  callId: string
  content: readonly ContentBlock[]
  error?: { name?: string; code?: string }
  time: number
  meta?: unknown
  /** dsh presenter view carried on the mux/history frame for this result. */
  view?: ToolEventView
  /** The matching call's presenter view (for call-time diff fallback). */
  callView?: ToolEventView
}

export interface ToolPartOptions {
  sessionID: string
  messageID: string
  time: number
}

/** Partial call info while tool-call delta chunks are still streaming. */
export interface StreamingToolCall {
  callId: string
  name?: string
  arguments?: string
}

/**
 * One file change translated from dsh's tool view/meta vocabulary into the
 * opencode SnapshotFileDiff shape.
 */
export interface FileChange {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

interface DshFileDiff {
  path?: string
  oldText?: string | null
  newText?: string
}

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as RecordValue
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function callView(view?: ToolEventView): { card?: string; title?: string; kind?: string; description?: string; diffs?: unknown } | undefined {
  if (view?.for !== 'call') return undefined
  return view.view as unknown as { card?: string; title?: string; kind?: string; description?: string; diffs?: unknown }
}

function resultView(view?: ToolEventView): { card?: string; title?: string; output?: string; exitCode?: number; signal?: string; diffs?: unknown } | undefined {
  if (view?.for !== 'result') return undefined
  return view.view as unknown as { card?: string; title?: string; output?: string; exitCode?: number; signal?: string; diffs?: unknown }
}

function isRecord(value: unknown): value is RecordValue {
  return record(value) !== undefined
}

function argsRecord(raw: string): RecordValue {
  return safeJsonParse(raw)
}

function pathFromArgs(args: RecordValue): string | undefined {
  return stringValue(args.file_path) ?? stringValue(args.path)
}

/**
 * Map a dsh tool name to the opencode tool semantic used by the TUI.
 * `str_replace_editor view` is a read card; every mutation command becomes
 * the native edit card.
 */
export function opencodeToolName(name: string, args: RecordValue): string {
  switch (name) {
    case 'bash':
    case 'bash-persistent':
      return 'bash'
    case 'read':
    case 'fs-read':
    case 'read_image':
      return 'read'
    case 'write':
    case 'fs-write':
      return 'edit'
    case 'edit':
    case 'fs-edit':
      return 'edit'
    case 'str_replace_editor':
      return args.command === 'view' ? 'read' : 'edit'
    default:
      return name
  }
}

function normalizedInput(name: string, args: RecordValue): RecordValue {
  const input: RecordValue = { ...args }
  if (name === 'read' || name === 'fs-read' || name === 'read_image') {
    if (typeof args.file_path === 'string') input.filePath = args.file_path
    return input
  }
  if (name === 'write' || name === 'fs-write' || name === 'edit' || name === 'fs-edit') {
    if (typeof args.file_path === 'string') input.filePath = args.file_path
    if (name === 'edit' || name === 'fs-edit') {
      if (typeof args.old_string === 'string') input.oldString = args.old_string
      if (typeof args.new_string === 'string') input.newString = args.new_string
      if (typeof args.replace_all === 'boolean') input.replaceAll = args.replace_all
    }
    return input
  }
  if (name === 'str_replace_editor') {
    if (typeof args.path === 'string') input.filePath = args.path
    if (typeof args.old_str === 'string') input.oldString = args.old_str
    if (typeof args.new_str === 'string') input.newString = args.new_str
    if (typeof args.insert_line === 'number') input.insertLine = args.insert_line
    if (typeof args.file_text === 'string') input.content = args.file_text
    return input
  }
  return input
}

function titleFromCall(name: string, args: RecordValue, view?: ToolEventView): string {
  const present = callView(view)
  if (present?.title) return present.title
  const path = pathFromArgs(args)
  switch (name) {
    case 'bash':
    case 'bash-persistent':
      return stringValue(args.command) ?? name
    case 'read':
    case 'fs-read':
    case 'read_image':
      return `Read ${path ?? ''}`.trim()
    case 'write':
    case 'fs-write':
      return `Write ${path ?? ''}`.trim()
    case 'edit':
    case 'fs-edit':
      return `Edit ${path ?? ''}`.trim()
    case 'str_replace_editor': {
      const command = stringValue(args.command) ?? name
      return `${command} ${path ?? ''}`.trim()
    }
    default:
      return `${name} ${path ?? ''}`.trim()
  }
}

function diffListFromCall(view?: ToolEventView): DshFileDiff[] {
  const present = callView(view)
  if (present?.card !== 'diff' || !Array.isArray(present.diffs)) return []
  return present.diffs.flatMap((raw) => {
    const diff = record(raw)
    if (!diff) return []
    return [{
      path: stringValue(diff.path),
      oldText: diff.oldText === null ? null : stringValue(diff.oldText),
      newText: stringValue(diff.newText),
    }]
  })
}

function diffListFromResult(view?: ToolEventView): DshFileDiff[] {
  const present = resultView(view)
  if (present?.card !== 'diff' || !Array.isArray(present.diffs)) return []
  return present.diffs.flatMap((raw) => {
    const diff = record(raw)
    if (!diff) return []
    return [{
      path: stringValue(diff.path),
      oldText: diff.oldText === null ? null : stringValue(diff.oldText),
      newText: stringValue(diff.newText),
    }]
  })
}

function diffListFromMeta(meta: unknown): DshFileDiff[] {
  const root = record(meta)
  const raw = root?.diffs
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const diff = record(entry)
    if (!diff) return []
    return [{
      path: stringValue(diff.path),
      oldText: diff.oldText === null ? null : stringValue(diff.oldText),
      newText: stringValue(diff.newText),
    }]
  })
}

function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function relativePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Build a compact unified diff from dsh's oldText/newText presenter hunks.
 * This is intentionally small: dsh already supplies the hunk-level texts and
 * the TUI only needs a valid `---/+++` patch to render.
 */
export function unifiedDiffForFile(file: string, oldText: string, newText: string): string {
  const oldLines = (oldText ?? '').split('\n')
  const newLines = (newText ?? '').split('\n')
  if (oldLines.join('\n') === newLines.join('\n')) return ''

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1

  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }

  const removed = oldLines.slice(start, oldEnd)
  const added = newLines.slice(start, newEnd)
  const removedCount = removed.length
  const addedCount = added.length
  const oldStart = removedCount === 0 ? start : start + 1
  const newStart = addedCount === 0 ? start : start + 1
  const header = `@@ -${oldStart}${removedCount === 0 ? '' : `,${removedCount}`} +${newStart}${addedCount === 0 ? '' : `,${addedCount}`} @@`
  const body = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ]
  return [
    `--- a/${relativePath(file)}`,
    `+++ b/${relativePath(file)}`,
    header,
    ...body,
  ].join('\n') + (body.length > 0 ? '\n' : '')
}

function statusForDiffs(diffs: readonly DshFileDiff[]): 'added' | 'deleted' | 'modified' {
  const allOldNull = diffs.every((diff) => diff.oldText === null || diff.oldText === '')
  const allNewEmpty = diffs.every((diff) => diff.newText === undefined || diff.newText === '')
  if (allOldNull) return 'added'
  if (allNewEmpty) return 'deleted'
  return 'modified'
}

function insertDiffFromArgs(args: RecordValue): DshFileDiff[] {
  const path = pathFromArgs(args)
  if (!path || args.command !== 'insert') return []
  return [{ path, oldText: '', newText: stringValue(args.new_str) ?? '' }]
}

/**
 * Conservative fallback for shell commands that clearly write to a file.
 * dsh does not persist a diff for bash results, so redirection targets are
 * surfaced as best-effort file changes until a produced-files projection is
 * available.
 */
function bashFileChangesFromArgs(args: RecordValue): FileChange[] {
  const command = stringValue(args.command)
  if (!command) return []
  const paths = new Set<string>()
  const redirection = /(?:>>|>)\s*["']?([^"'\s;&|]+)["']?/g
  for (const match of command.matchAll(redirection)) {
    const path = match[1]
    if (path) paths.add(path.replace(/^["']|["']$/g, ''))
  }
  const tee = /(?:^|[;&|]\s*)tee\s+["']?([^"'\s;&|]+)["']?/g
  for (const match of command.matchAll(tee)) {
    const path = match[1]
    if (path) paths.add(path.replace(/^["']|["']$/g, ''))
  }
  return [...paths].map((file) => ({ file, additions: 0, deletions: 0, status: 'modified' as const }))
}

/**
 * Extract opencode file changes from a completed dsh tool. The source of
 * truth is result `meta` when the tool persisted contextual diffs (write/edit
 * in dsh-tool-fs), then the live/replayed presenter result view, then the
 * call-time diff card. `str_replace_editor insert` synthesizes an
 * addition-only hunk from its arguments.
 */
export function fileChangesFromToolResult(call: ToolCallInfo, result: ToolResultInfo): FileChange[] {
  const args = argsRecord(call.arguments)
  const metaDiffs = diffListFromMeta(result.meta)
  const resultDiffs = diffListFromResult(result.view)
  const callDiffs = diffListFromCall(result.callView ?? call.view)
  const diffs = metaDiffs.length > 0
    ? metaDiffs
    : resultDiffs.length > 0
      ? resultDiffs
      : callDiffs
  if (diffs.length === 0 && call.name === 'str_replace_editor') {
    diffs.push(...insertDiffFromArgs(args))
  }
  if (diffs.length === 0 && call.name === 'bash') {
    return bashFileChangesFromArgs(args)
  }
  if (diffs.length === 0) return []

  const byPath = new Map<string, DshFileDiff[]>()
  const fallbackPath = pathFromArgs(args)
  for (const diff of diffs) {
    const path = diff.path ?? fallbackPath
    if (!path) continue
    const list = byPath.get(path) ?? []
    list.push(diff)
    byPath.set(path, list)
  }

  const changes: FileChange[] = []
  for (const [file, fileDiffs] of byPath) {
    const patch = fileDiffs
      .map((diff) => unifiedDiffForFile(file, diff.oldText ?? '', diff.newText ?? ''))
      .filter(Boolean)
      .join('\n')
    const { additions, deletions } = countPatch(patch)
    changes.push({
      file,
      ...(patch ? { patch } : {}),
      additions,
      deletions,
      status: statusForDiffs(fileDiffs),
    })
  }
  return changes
}

function descriptionForStrReplace(args: RecordValue): string | undefined {
  const command = stringValue(args.command)
  const path = pathFromArgs(args)
  if (!command) return undefined
  const labels: Record<string, string> = {
    view: 'View file',
    create: 'Create file',
    str_replace: 'Replace text in file',
    insert: 'Insert lines into file',
    undo_edit: 'Undo last edit to file',
  }
  const label = labels[command]
  return label === undefined ? undefined : `${label} ${path ?? ''}`.trim()
}

function completedMetadata(call: ToolCallInfo, result: ToolResultInfo, tool: string, input: RecordValue): RecordValue {
  const metadata: RecordValue = {}
  if (result.meta !== undefined) metadata.meta = result.meta
  if (tool === 'bash') {
    const present = resultView(result.view)
    if (present?.card === 'terminal') {
      if (present.output !== undefined) metadata.output = present.output
      if (present.exitCode !== undefined) metadata.exit = present.exitCode
      if (present.signal !== undefined) metadata.signal = present.signal
    } else {
      metadata.output = resultText(result.content)
    }
  }
  if (tool === 'read') {
    const meta = record(result.meta)
    const loaded = stringValue(meta?.path) ?? stringValue(input.filePath)
    if (loaded) metadata.loaded = [loaded]
  }
  if (tool === 'edit') {
    const changes = fileChangesFromToolResult(call, result)
    if (changes.length > 0) {
      metadata.files = changes.map((change) => change.file)
      metadata.filediff = changes[0]
      if (changes[0]?.patch) metadata.diff = changes[0].patch
    }
  }
  if (call.name === 'str_replace_editor') {
    metadata.command = stringValue(input.command) ?? ''
    metadata.mode = stringValue(input.command) ?? ''
    const description = descriptionForStrReplace(input)
    if (description) metadata.description = description
  }
  return metadata
}

function resultText(content: readonly ContentBlock[]): string {
  const blocks = content.flatMap((block) =>
    block.type === 'tool-result' ? block.content : [block],
  )
  return textFromBlocks(blocks as readonly { type: string; text?: unknown }[])
}

/** Model-facing result text for one tool/result event (used by v2 events). */
export function toolResultText(result: ToolResultInfo): string {
  return resultText(result.content)
}

/**
 * Structured v2 progress payload derived from the dsh result view: terminal
 * cards carry output/exitCode/signal; everything else is folded into a
 * generic `output` field when content exists.
 */
export function toolResultStructured(result: ToolResultInfo): Record<string, unknown> {
  const present = resultView(result.view)
  if (present?.card === 'terminal') {
    return {
      ...(present.output === undefined ? {} : { output: present.output }),
      ...(present.exitCode === undefined ? {} : { exitCode: present.exitCode }),
      ...(present.signal === undefined ? {} : { signal: present.signal }),
    }
  }
  const text = resultText(result.content)
  return text.length > 0 ? { output: text } : {}
}

/** A `tool/call` event alone becomes a pending ToolPart. */
export function pendingToolPart(call: ToolCallInfo, options: ToolPartOptions): ToolPart {
  const input = safeJsonParse(call.arguments)
  const tool = opencodeToolName(call.name, input)
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool,
    state: {
      status: 'pending',
      input: normalizedInput(call.name, input),
      raw: call.arguments,
    },
    metadata: { start: options.time },
  }
}

/**
 * A partially-streamed tool call becomes a pending ToolPart whose `raw`
 * input grows with every tool-call delta. The TUI upserts by part id, so
 * repeated updates progressively reveal the command/arguments.
 */
export function streamingToolPart(call: StreamingToolCall, options: ToolPartOptions): ToolPart {
  const input = safeJsonParse(call.arguments ?? '')
  const name = call.name ?? 'tool'
  const tool = opencodeToolName(name, input)
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool,
    state: {
      status: 'pending',
      input: normalizedInput(name, input),
      raw: call.arguments ?? '',
    },
    metadata: { start: options.time },
  }
}

/** Placeholder for an in-flight call (dsh does not emit this state today). */
export function runningToolPart(call: ToolCallInfo, options: ToolPartOptions): ToolPart {
  const input = safeJsonParse(call.arguments)
  const tool = opencodeToolName(call.name, input)
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool,
    state: {
      status: 'running',
      input: normalizedInput(call.name, input),
      title: titleFromCall(call.name, input, call.view),
      time: { start: options.time },
    },
  }
}

/** A `tool/result` success event becomes a completed ToolPart. */
export function completedToolPart(
  call: ToolCallInfo,
  result: ToolResultInfo,
  options: ToolPartOptions,
): ToolPart {
  const input = safeJsonParse(call.arguments)
  const tool = opencodeToolName(call.name, input)
  const metadata = completedMetadata(call, result, tool, input)
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool,
    state: {
      status: 'completed',
      input: normalizedInput(call.name, input),
      output: resultText(result.content),
      title: titleFromCall(call.name, input, call.view),
      metadata,
      time: {
        start: options.time,
        end: result.time,
      },
    },
  }
}

/** A `tool/result` with an error becomes an error ToolPart. */
export function errorToolPart(
  call: ToolCallInfo,
  result: ToolResultInfo,
  options: ToolPartOptions,
): ToolPart {
  const input = safeJsonParse(call.arguments)
  const tool = opencodeToolName(call.name, input)
  const message = result.error?.name ?? result.error?.code ?? 'tool failed'
  return {
    id: `tool:${call.callId}`,
    sessionID: options.sessionID,
    messageID: options.messageID,
    type: 'tool',
    callID: call.callId,
    tool,
    state: {
      status: 'error',
      input: normalizedInput(call.name, input),
      error: message,
      time: {
        start: options.time,
        end: result.time,
      },
    },
  }
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool'
}
