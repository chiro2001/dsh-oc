import { describe, expect, it } from 'vitest'
import {
  completedToolPart,
  errorToolPart,
  pendingToolPart,
  runningToolPart,
} from '../../src/bridge/convert/tool.js'

const call = { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }
const opts = { sessionID: 's1', messageID: 'm1', time: 100 }

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
})
