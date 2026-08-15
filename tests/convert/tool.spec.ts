import { describe, expect, it } from 'vitest'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  completedToolPart,
  errorToolPart,
  fileChangesFromToolResult,
  opencodeToolName,
  pendingToolPart,
  runningToolPart,
} from '../../src/bridge/convert/tool.js'

const call = { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }
const opts = { sessionID: 's1', messageID: 'm1', time: 100 }

function callFor(name: string, args: Record<string, unknown>, view?: ToolEventView) {
  return {
    callId: 'call-1',
    name,
    arguments: JSON.stringify(args),
    ...(view === undefined ? {} : { view }),
  }
}

function resultFor(
  content: string,
  meta?: unknown,
  view?: ToolEventView,
  callView?: ToolEventView,
) {
  return {
    callId: 'call-1',
    content: [{ type: 'text' as const, text: content }],
    time: 200,
    ...(meta === undefined ? {} : { meta }),
    ...(view === undefined ? {} : { view }),
    ...(callView === undefined ? {} : { callView }),
  }
}

describe('convert/tool', () => {
  it('maps tool/call to a pending part with parsed input and raw', () => {
    const part = pendingToolPart(call, opts)
    expect(part.type).toBe('tool')
    expect(part.callID).toBe('call-1')
    expect(part.tool).toBe('bash')
    expect(part.state.status).toBe('pending')
    if (part.state.status === 'pending') {
      expect(part.state.input).toEqual({ command: 'ls' })
      expect(part.state.raw).toBe('{"command":"ls"}')
    }
  })

  it('supports a running state', () => {
    const part = runningToolPart(call, opts)
    expect(part.state.status).toBe('running')
  })

  it('maps a successful result to completed', () => {
    const part = completedToolPart(call, {
      callId: 'call-1',
      content: [{ type: 'text', text: 'ok' }],
      time: 200,
    }, opts)
    expect(part.state.status).toBe('completed')
    if (part.state.status === 'completed') {
      expect(part.state.output).toBe('ok')
      expect(part.state.time).toEqual({ start: 100, end: 200 })
    }
  })

  it('maps a failing result to error', () => {
    const part = errorToolPart(call, {
      callId: 'call-1',
      content: [],
      error: { name: 'Boom', code: 'E_X' },
      time: 200,
    }, opts)
    expect(part.state.status).toBe('error')
    if (part.state.status === 'error') {
      expect(part.state.error).toBe('Boom')
    }
  })

  it('tolerates unparseable tool input', () => {
    const part = pendingToolPart({ ...call, arguments: 'not json' }, opts)
    if (part.state.status === 'pending') {
      expect(part.state.input).toEqual({})
      expect(part.state.raw).toBe('not json')
    }
  })

  it('maps bash to the native shell card with output metadata', () => {
    const part = completedToolPart(callFor('bash', {
      command: 'echo hi',
      description: 'say hi',
    }), resultFor('hi', undefined, {
      for: 'result',
      view: { card: 'terminal', output: 'hi\n', exitCode: 0 },
    }), opts)
    expect(part.tool).toBe('bash')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({ command: 'echo hi' })
      expect(part.state.title).toBe('echo hi')
      expect(part.state.metadata).toMatchObject({ output: 'hi\n', exit: 0 })
    }
    expect(fileChangesFromToolResult(callFor('bash', {
      command: 'echo hi',
    }), resultFor('hi'))).toEqual([])
  })

  it('surfaces bash redirection targets as best-effort file changes', () => {
    const changes = fileChangesFromToolResult(callFor('bash', {
      command: 'mkdir -p src && printf "hello\\n" > src/generated.txt',
    }), resultFor('(no output)'))
    expect(changes).toEqual([{
      file: 'src/generated.txt',
      additions: 0,
      deletions: 0,
      status: 'modified',
    }])
  })

  it('maps read/fs-read to the read card and exposes loaded paths', () => {
    const part = completedToolPart(callFor('read', {
      file_path: '/repo/a.ts',
      offset: 2,
      limit: 3,
    }, {
      for: 'call',
      view: { card: 'generic', title: 'Read /repo/a.ts (2 - 4)', kind: 'read' },
    }), resultFor('2: x\n3: y\n4: z\n', {
      path: '/repo/a.ts',
      offset: 2,
      lines: [{ number: 2, text: 'x' }, { number: 3, text: 'y' }, { number: 4, text: 'z' }],
      totalLines: 4,
    }), opts)
    expect(part.tool).toBe('read')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({ filePath: '/repo/a.ts', offset: 2, limit: 3 })
      expect(part.state.title).toBe('Read /repo/a.ts (2 - 4)')
      expect(part.state.metadata.loaded).toEqual(['/repo/a.ts'])
    }
  })

  it('maps write/fs-write to edit with files/diff metadata', () => {
    const callInfo = callFor('write', {
      file_path: '/repo/new.ts',
      content: 'export const x = 1\n',
    }, {
      for: 'call',
      view: {
        card: 'diff',
        title: 'Write /repo/new.ts',
        diffs: [{ path: '/repo/new.ts', oldText: null, newText: 'export const x = 1\n' }],
      },
    })
    const part = completedToolPart(callInfo, resultFor('Created file', {
      diffs: [{ path: '/repo/new.ts', oldText: null, newText: 'export const x = 1\n' }],
    }), opts)
    expect(part.tool).toBe('edit')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({ filePath: '/repo/new.ts', content: 'export const x = 1\n' })
      expect(part.state.metadata.files).toEqual(['/repo/new.ts'])
      expect(part.state.metadata.diff).toContain('+++ b/repo/new.ts')
      expect(part.state.metadata.diff).toContain('+export const x = 1')
      expect(part.state.metadata.filediff).toMatchObject({ file: '/repo/new.ts', additions: 1, deletions: 0 })
    }
    const changes = fileChangesFromToolResult(callInfo, resultFor('Created file', {
      diffs: [{ path: '/repo/new.ts', oldText: null, newText: 'export const x = 1\n' }],
    }))
    expect(changes[0]).toMatchObject({ file: '/repo/new.ts', status: 'added', additions: 1, deletions: 0 })
  })

  it('maps edit to edit with old/new strings and a real diff', () => {
    const callInfo = callFor('edit', {
      file_path: '/repo/a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    }, {
      for: 'call',
      view: {
        card: 'diff',
        title: 'Edit /repo/a.ts',
        diffs: [{
          path: '/repo/a.ts',
          oldText: 'const a = 1',
          newText: 'const a = 2',
        }],
      },
    })
    const part = completedToolPart(callInfo, resultFor('Edited', {
      diffs: [{
        path: '/repo/a.ts',
        oldText: 'const a = 1',
        newText: 'const a = 2',
      }],
    }), opts)
    expect(part.tool).toBe('edit')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({
        filePath: '/repo/a.ts',
        oldString: 'const a = 1',
        newString: 'const a = 2',
      })
      expect(part.state.metadata.diff).toContain('-const a = 1')
      expect(part.state.metadata.diff).toContain('+const a = 2')
    }
  })

  it('maps str_replace_editor view to a read card', () => {
    const callInfo = callFor('str_replace_editor', {
      command: 'view',
      path: '/repo/a.ts',
      view_range: [1, 5],
    }, {
      for: 'call',
      view: { card: 'generic', title: 'view /repo/a.ts', kind: 'read' },
    })
    const pending = pendingToolPart(callInfo, opts)
    expect(pending.tool).toBe('read')
    if (pending.state.status === 'pending') {
      expect(pending.state.input).toMatchObject({ filePath: '/repo/a.ts', command: 'view' })
    }
    const part = completedToolPart(callInfo, resultFor('1: x\n'), opts)
    expect(part.tool).toBe('read')
    if (part.state.status === 'completed') {
      expect(part.state.title).toBe('view /repo/a.ts')
      expect(part.state.metadata).toMatchObject({ command: 'view', description: 'View file /repo/a.ts' })
    }
  })

  it('maps str_replace_editor insert to an edit card with a synthesized diff', () => {
    const callInfo = callFor('str_replace_editor', {
      command: 'insert',
      path: '/repo/a.ts',
      insert_line: 2,
      new_str: 'const added = 1\n',
    }, {
      for: 'call',
      view: {
        card: 'generic',
        title: 'insert /repo/a.ts',
        kind: 'edit',
        locations: [{ path: '/repo/a.ts', line: 3 }],
      },
    })
    const part = completedToolPart(callInfo, resultFor('Inserted'), opts)
    expect(part.tool).toBe('edit')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({
        filePath: '/repo/a.ts',
        command: 'insert',
        newString: 'const added = 1\n',
        insertLine: 2,
      })
      expect(part.state.metadata).toMatchObject({
        command: 'insert',
        description: 'Insert lines into file /repo/a.ts',
      })
      expect(part.state.metadata.diff).toContain('+const added = 1')
    }
    const changes = fileChangesFromToolResult(callInfo, resultFor('Inserted'))
    expect(changes[0]).toMatchObject({ file: '/repo/a.ts', status: 'added', additions: 1 })
  })

  it('maps str_replace_editor undo_edit to an edit card with a descriptive title', () => {
    const callInfo = callFor('str_replace_editor', {
      command: 'undo_edit',
      path: '/repo/a.ts',
    })
    const part = completedToolPart(callInfo, resultFor('Undone'), opts)
    expect(part.tool).toBe('edit')
    if (part.state.status === 'completed') {
      expect(part.state.input).toMatchObject({ filePath: '/repo/a.ts', command: 'undo_edit' })
      expect(part.state.title).toBe('undo_edit /repo/a.ts')
      expect(part.state.metadata).toMatchObject({
        command: 'undo_edit',
        description: 'Undo last edit to file /repo/a.ts',
      })
    }
  })

  it('keeps unknown tools under their dsh name', () => {
    expect(opencodeToolName('weird_tool', {})).toBe('weird_tool')
  })
})
