import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  QuestionInfo,
  QuestionRequest,
  QuestionV2Info,
  QuestionV2Request,
} from '@opencode-ai/sdk/v2/types'

export interface QuestionEntry {
  opencodeId: string
  rpcId: string
  sessionId: string
  items: AskUserQuestionItem[]
}

function toQuestionInfo(item: AskUserQuestionItem): QuestionInfo {
  return {
    question: item.question,
    header: item.header ?? '',
    options: (item.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? '',
    })),
    ...(item.multiSelect === undefined ? {} : { multiple: item.multiSelect }),
  }
}

/** Legacy `/question` + `question.asked` SSE shape. */
export function toQuestionRequest(entry: QuestionEntry): QuestionRequest {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    questions: entry.items.map(toQuestionInfo),
  }
}

/** v2 `/api/session/{id}/question` shape. */
export function toQuestionV2(entry: QuestionEntry): QuestionV2Request {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    questions: entry.items.map((item): QuestionV2Info => ({
      question: item.question,
      header: item.header ?? '',
      options: (item.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? '',
      })),
      ...(item.multiSelect === undefined ? {} : { multiple: item.multiSelect }),
    })),
  }
}

/**
 * Map opencode answers (labels in question order) back to dsh answer items.
 * dsh asks one batch; opencode answers each question positionally.
 */
export function answersToDsh(
  entry: QuestionEntry,
  answers: Array<Array<string>>,
): Array<{ id: string; selected: string[]; custom?: string }> {
  return entry.items.map((item, index) => {
    const selected = answers[index] ?? []
    return {
      id: item.id,
      selected,
    }
  })
}
