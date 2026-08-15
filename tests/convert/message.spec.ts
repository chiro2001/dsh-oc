import { describe, expect, it } from 'vitest'
import {
  assistantMessageFromEvent,
  convertMessagesV1,
  convertMessagesV2,
  userMessageFromEvent,
} from '../../src/bridge/convert/message.js'
import { makeAssistantEvent, makeUserEvent, sessionEvent } from '../helpers.js'

const opts = { sessionId: 's1', cwd: '/work' }

describe('convert/message (v1)', () => {
  it('folds a user message into info + text part', () => {
    const [entry] = convertMessagesV1([makeUserEvent('hello')], opts)
    expect(entry?.info.role).toBe('user')
    if (entry?.info.role === 'user') {
      expect(entry.info.agent).toBe('build')
      expect(entry.info.model.providerID).toBe('deepseek')
      expect(entry.info.time.created).toBe(1100)
    }
    expect(entry?.parts).toHaveLength(1)
    expect(entry?.parts[0]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('uses the advertised default model for user message info', () => {
    const [entry] = convertMessagesV1([makeUserEvent('hello')], {
      ...opts,
      defaultModel: { providerID: 'deepseek', modelID: 'mock-model' },
    })
    expect(entry?.info.role).toBe('user')
    if (entry?.info.role === 'user') {
      expect(entry.info.model).toEqual({ providerID: 'deepseek', modelID: 'mock-model' })
    }
  })

  it('folds assistant content into text/reasoning/tool parts', () => {
    const event = makeAssistantEvent([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{"x":1}' },
    ])
    const [entry] = convertMessagesV1([event], opts)
    expect(entry?.info.role).toBe('assistant')
    if (entry?.info.role === 'assistant') {
      expect(entry.info.providerID).toBe('deepseek')
      expect(entry.info.modelID).toBe('deepseek-chat')
      expect(entry.info.path.cwd).toBe('/work')
      expect(entry.info.time.completed).toBe(1200)
    }
    expect(entry?.parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool'])
    expect(entry?.parts[0]).toMatchObject({ type: 'reasoning', time: { start: 1200, end: 1200 } })
    expect(entry?.parts[1]).toMatchObject({ type: 'text', time: { start: 1200, end: 1200 } })
    const tool = entry?.parts[2]
    expect(tool).toMatchObject({ type: 'tool', callID: 'c1', tool: 'bash' })
    if (tool?.type === 'tool') {
      expect(tool.state.status).toBe('pending')
    }
  })

  it('uses assistant chunk block-start times for reasoning duration', () => {
    const events = [
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }, 1, 1000),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
      ]),
    ]
    const [entry] = convertMessagesV1(events, opts)
    expect(entry?.parts[0]).toMatchObject({ type: 'reasoning', time: { start: 1000, end: 1200 } })
    expect(entry?.parts[1]).toMatchObject({ type: 'text', time: { start: 1200, end: 1200 } })
  })

  it('pairs tool/result with the assistant tool part', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{"cmd":"ls"}' },
      ]),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-msg-1' as never,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'file' }] }],
          source: { kind: 'tool', callId: 'c1' as never },
        },
      }, 4, 1300),
    ]
    const [entry] = convertMessagesV1(events, opts)
    const tool = entry?.parts[0]
    expect(tool?.type).toBe('tool')
    if (tool?.type === 'tool') {
      expect(tool.state.status).toBe('completed')
      if (tool.state.status === 'completed') {
        expect(tool.state.output).toBe('file')
      }
    }
  })

  it('marks a failing tool result as error', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool-call', id: 'c2' as never, name: 'read', arguments: '{}' },
      ]),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-msg-2' as never,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c2' as never, content: [] }],
          source: { kind: 'tool', callId: 'c2' as never },
        },
        error: { name: 'ReadError', code: 'EIO' },
      }, 5, 1400),
    ]
    const [entry] = convertMessagesV1(events, opts)
    const tool = entry?.parts[0]
    if (tool?.type === 'tool') {
      expect(tool.state.status).toBe('error')
    }
  })

  it('does not crash on empty or unknown-only history', () => {
    expect(convertMessagesV1([], opts)).toEqual([])
    expect(convertMessagesV1([sessionEvent('turn/start', { turn: 1 })], opts)).toEqual([])
  })

  it('skips user image blocks without crashing', () => {
    const skipped: string[] = []
    const event = sessionEvent('user/message', {
      id: 'm-img' as never,
      content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: { mediaType: 'image/png' } }],
      source: { kind: 'user' },
    }, 2, 1000)
    const [entry] = convertMessagesV1([event], {
      ...opts,
      onSkip: (type, reason) => skipped.push(`${type}: ${reason}`),
    })
    expect(entry?.parts).toHaveLength(1)
    expect(skipped.some((line) => line.includes('image'))).toBe(true)
  })

  it('exposes single-event converters for SSE', () => {
    const user = userMessageFromEvent(makeUserEvent('hi'), opts)
    expect(user.info.id).toBe('msg-user-1')
    const assistant = assistantMessageFromEvent(makeAssistantEvent([{ type: 'text', text: 'ok' }]), opts)
    expect(assistant.info.id).toBe('msg-assistant-1')
    expect(assistant.parts[0]).toMatchObject({ type: 'text', text: 'ok' })
  })
})

describe('convert/message (v2)', () => {
  it('converts user and assistant events to SessionMessage[]', () => {
    const messages = convertMessagesV2([
      makeUserEvent('hello', 'm1', 1000),
      makeAssistantEvent([
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'c9' as never, name: 'bash', arguments: '{}' },
      ], 'm2', 1100, { inputTokens: 10, outputTokens: 5 }),
    ], opts)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'user', text: 'hello' })
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      agent: 'build',
      model: { id: 'deepseek-chat', providerID: 'deepseek' },
    })
    const assistant = messages[1]
    if (assistant?.type === 'assistant') {
      expect(assistant.content.map((part) => part.type)).toEqual(['text', 'tool'])
      expect(assistant.tokens).toEqual({
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
    }
  })

  it('updates a v2 tool part when the result arrives', () => {
    const messages = convertMessagesV2([
      makeAssistantEvent([
        { type: 'tool-call', id: 'c3' as never, name: 'bash', arguments: '{}' },
      ], 'm3', 1000),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 't3' as never,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c3' as never, content: [{ type: 'text', text: 'out' }] }],
          source: { kind: 'tool', callId: 'c3' as never },
        },
      }, 4, 1200),
    ], opts)
    const assistant = messages[0]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      const tool = assistant.content.find((part) => part.type === 'tool')
      expect(tool?.type).toBe('tool')
      if (tool?.type === 'tool') {
        expect(tool.state.status).toBe('completed')
        if (tool.state.status === 'completed') {
          expect(tool.state.content[0]).toMatchObject({ type: 'text', text: 'out' })
        }
        expect(tool.time.completed).toBe(1200)
      }
    }
  })

  it('returns [] for empty history', () => {
    expect(convertMessagesV2([], opts)).toEqual([])
  })
})
