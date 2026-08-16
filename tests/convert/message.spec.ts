import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  assistantMessageFromEvent,
  convertMessagesV1,
  convertMessagesV2,
  userMessageFromEvent,
} from '../../src/bridge/convert/message.js'
import { makeAssistantEvent, makeUserEvent, sessionEvent } from '../helpers.js'

const opts = { sessionId: 's1', cwd: '/work' }

function chunkRow(
  type: 'text-chunks' | 'reasoning-chunks',
  texts: string[],
  time0: number,
  seq = 10,
  index = 0,
  turn = 1,
  step = 1,
): SessionEvent {
  return {
    type,
    seq,
    time: time0,
    time0,
    data: {
      turn,
      step,
      index,
      dt: texts.length > 1 ? texts.slice(1).map(() => 0) : [],
      texts,
    },
  } as unknown as SessionEvent
}

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

  it('marks compaction checkpoint user messages with a compaction part', () => {
    const event = sessionEvent('user/message', {
      id: 'checkpoint-1' as never,
      content: [{ type: 'text', text: '<compacted-summary>summary</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compact', sourceCommandId: 'cmd-1' },
    }, 2, 1000)
    const [entry] = convertMessagesV1([event], opts)
    expect(entry?.info.role).toBe('user')
    expect(entry?.parts).toHaveLength(1)
    expect(entry?.parts[0]).toMatchObject({
      id: 'checkpoint-1:compaction',
      sessionID: 's1',
      messageID: 'checkpoint-1',
      type: 'compaction',
      auto: false,
    })
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

  it('ends reasoning at the last reasoning chunk time, not reply completion', () => {
    const events = [
      chunkRow('reasoning-chunks', ['th'], 1000, 1, 0),
      chunkRow('reasoning-chunks', ['ink'], 1100, 2, 0),
      chunkRow('text-chunks', ['an'], 1200, 3, 1),
      chunkRow('text-chunks', ['swer'], 1300, 4, 1),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
      ]),
    ]
    const [entry] = convertMessagesV1(events, opts)
    expect(entry?.parts[0]).toMatchObject({ type: 'reasoning', time: { start: 1000, end: 1100 } })
    expect(entry?.parts[1]).toMatchObject({ type: 'text', time: { start: 1200, end: 1200 } })
  })

  it('uses turn/start and block-start times for assistant history durations', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }, 2, 1100),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 1, blockType: 'text' },
      }, 3, 1100),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
      ], 'm-duration', 2000),
    ]
    const [entry] = convertMessagesV1(events, opts)
    expect(entry?.info.role).toBe('assistant')
    if (entry?.info.role === 'assistant') {
      expect(entry.info.time).toEqual({ created: 1100, completed: 2000 })
    }
    expect(entry?.parts[0]).toMatchObject({ type: 'reasoning', time: { start: 1100, end: 2000 } })
    expect(entry?.parts[1]).toMatchObject({ type: 'text', time: { start: 1100, end: 2000 } })
  })

  it('hydrates in-flight text/reasoning chunks as a provisional assistant message', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
    ]
    const entries = convertMessagesV1(events, opts)
    expect(entries.map((entry) => entry.info.role)).toEqual(['user', 'assistant'])
    const partial = entries[1]
    expect(partial?.info.role).toBe('assistant')
    if (partial?.info.role === 'assistant') {
      expect(partial.info.id).toBe('msg_pending:s1:1:1')
      expect(partial.info.parentID).toBe('m-user')
      expect(partial.info.time).toEqual({ created: 1020 })
      expect(partial.info.time.completed).toBeUndefined()
    }
    expect(partial?.parts.map((part) => part.type)).toEqual(['text', 'reasoning'])
    const text = partial?.parts[0]
    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.id).toBe('prt_stream:s1:1:1:text:0')
      expect(text.text).toBe('hello ')
      expect(text.time).toEqual({ start: 1020 })
      expect(text.time?.end).toBeUndefined()
    }
    const reasoning = partial?.parts[1]
    expect(reasoning?.type).toBe('reasoning')
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.id).toBe('prt_stream:s1:1:1:reasoning:1')
      expect(reasoning.text).toBe('think')
      expect(reasoning.time).toEqual({ start: 1040 })
      expect(reasoning.time.end).toBeUndefined()
    }
  })

  it('replaces the provisional assistant message once the final message arrives', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'hello ' },
      ], 'm-final', 2000),
    ]
    const entries = convertMessagesV1(events, opts)
    expect(entries.map((entry) => entry.info.role)).toEqual(['user', 'assistant'])
    expect(entries[1]?.info.id).toBe('m-final')
    expect(entries.some((entry) => String(entry.info.id).startsWith('msg_pending:'))).toBe(false)
    // Final v1 parts reuse the streamed `prt_stream:` ids so history merges
    // with the live SSE without rendering duplicate text blocks.
    expect(entries[1]?.parts.every((part) => part.id.startsWith('prt_stream:'))).toBe(true)
    const final = entries[1]
    if (final?.info.role === 'assistant') {
      expect(final.info.time).toEqual({ created: 1020, completed: 2000 })
    }
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
  it('records anchor event seqs alongside v2 messages', () => {
    const anchorSeqs: number[] = []
    const messages = convertMessagesV2([
      makeUserEvent('hello', 'm1', 1000),
      makeAssistantEvent([
        { type: 'text', text: 'answer' },
      ], 'm2', 1100),
    ], opts, undefined, anchorSeqs)
    expect(messages).toHaveLength(2)
    expect(anchorSeqs).toEqual([2, 3])
  })

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

  it('fixes v2 assistant created/completed and reasoning part times', () => {
    const messages = convertMessagesV2([
      sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }, 2, 1100),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
      ], 'm-v2-duration', 2000),
    ], opts)
    const assistant = messages[0]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      expect(assistant.time).toEqual({ created: 1100, completed: 2000 })
      const reasoning = assistant.content.find((part) => part.type === 'reasoning')
      expect(reasoning?.type).toBe('reasoning')
      if (reasoning?.type === 'reasoning') {
        expect(reasoning.time).toEqual({ created: 1100, completed: 2000 })
      }
    }
  })

  it('hydrates v2 in-flight text/reasoning chunks as a provisional assistant message', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
    ]
    const messages = convertMessagesV2(events, opts)
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
    const assistant = messages[1]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      expect(assistant.id).toBe('msg_pending:s1:1:1')
      expect(assistant.time).toEqual({ created: 1020 })
      expect(assistant.time.completed).toBeUndefined()
      expect(assistant.content.map((part) => part.type)).toEqual(['text', 'reasoning'])
      const text = assistant.content[0]
      expect(text?.type).toBe('text')
      if (text?.type === 'text') {
        expect(text.id).toBe('prt_stream:s1:1:1:text:0')
        expect(text.text).toBe('hello ')
      }
      const reasoning = assistant.content[1]
      expect(reasoning?.type).toBe('reasoning')
      if (reasoning?.type === 'reasoning') {
        expect(reasoning.id).toBe('prt_stream:s1:1:1:reasoning:1')
        expect(reasoning.text).toBe('think')
        expect(reasoning.time).toEqual({ created: 1040 })
        expect(reasoning.time?.completed).toBeUndefined()
      }
    }
  })

  it('replaces the v2 provisional assistant message once the final message arrives', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'hello ' },
      ], 'm-final', 2000),
    ]
    const messages = convertMessagesV2(events, opts)
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
    expect(messages[1]?.type).toBe('assistant')
    if (messages[1]?.type === 'assistant') {
      expect(messages[1].id).toBe('m-final')
      expect(messages[1].time).toEqual({ created: 1020, completed: 2000 })
    }
    expect(messages.some((message) => message.id.startsWith('msg_pending:'))).toBe(false)
  })

  it('returns [] for empty history', () => {
    expect(convertMessagesV2([], opts)).toEqual([])
  })
})
