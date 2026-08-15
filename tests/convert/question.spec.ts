import { describe, expect, it } from 'vitest'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  answersToDsh,
  toQuestionRequest,
  toQuestionV2,
  type QuestionEntry,
} from '../../src/bridge/convert/question.js'

const items: AskUserQuestionItem[] = [
  {
    id: 'q1',
    question: 'Approve the plan?',
    header: 'Plan',
    options: [
      { label: 'Yes', description: 'go ahead' },
      { label: 'No', description: 'stop' },
    ],
  },
  {
    id: 'q2',
    question: 'Pick extras',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }],
  },
]

const entry: QuestionEntry = {
  opencodeId: 'question-1',
  rpcId: 'rpc-1',
  sessionId: 's1',
  items,
}

describe('convert/question', () => {
  it('builds the legacy QuestionRequest in order', () => {
    const request = toQuestionRequest(entry)
    expect(request.id).toBe('question-1')
    expect(request.sessionID).toBe('s1')
    expect(request.questions).toHaveLength(2)
    expect(request.questions[0]).toMatchObject({
      question: 'Approve the plan?',
      header: 'Plan',
      options: [
        { label: 'Yes', description: 'go ahead' },
        { label: 'No', description: 'stop' },
      ],
    })
    expect(request.questions[1]?.multiple).toBe(true)
  })

  it('builds the v2 QuestionV2Request', () => {
    const request = toQuestionV2(entry)
    expect(request.id).toBe('question-1')
    expect(request.questions[1]).toMatchObject({ question: 'Pick extras', multiple: true })
    expect(request.questions[0]?.options[0]?.description).toBe('go ahead')
  })

  it('maps opencode answers back to dsh answer items by index', () => {
    const answers = answersToDsh(entry, [['Yes'], ['A', 'B']])
    expect(answers).toEqual([
      { id: 'q1', selected: ['Yes'] },
      { id: 'q2', selected: ['A', 'B'] },
    ])
  })

  it('tolerates missing answers with empty selection', () => {
    expect(answersToDsh(entry, [])).toEqual([
      { id: 'q1', selected: [] },
      { id: 'q2', selected: [] },
    ])
  })

  it('fills defaults for absent optional fields', () => {
    const request = toQuestionRequest({
      ...entry,
      items: [{ id: 'q3', question: 'Q' }],
    })
    expect(request.questions[0]).toMatchObject({ header: '', options: [] })
  })
})
