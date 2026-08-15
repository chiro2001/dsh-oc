import type { Todo } from '@opencode-ai/sdk/client'
import { stableId } from './common.js'
import { convertTodos } from './todo.js'

interface GoalSnapshotLike {
  id?: unknown
  objective?: unknown
  phase?: unknown
  maxGoalRounds?: unknown
  blockedReason?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow the dsh goal vocabulary to the fields the bridge renders. Both the
 * `goal` projection (`{ goal: GoalSnapshot, ... }`) and the raw snapshot on
 * `goal/change` events are accepted so history folds and live mux frames
 * share one converter.
 */
function goalSnapshotFrom(value: unknown): GoalSnapshotLike | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.goal)) return value.goal as GoalSnapshotLike
  if (typeof value.objective === 'string' || typeof value.phase === 'string') {
    return value as GoalSnapshotLike
  }
  return undefined
}

/** Map a durable goal phase onto the opencode todo status vocabulary. */
function goalPhaseStatus(phase: unknown): Todo['status'] | undefined {
  if (phase === 'active') return 'in_progress'
  if (phase === 'paused' || phase === 'blocked') return 'pending'
  if (phase === 'complete') return 'completed'
  return undefined
}

/**
 * Convert one goal snapshot/projection into the opencode todo shown first in
 * the sidebar. Returns `undefined` when the value carries no renderable goal.
 */
export function goalTodo(value: unknown): Todo | undefined {
  const snapshot = goalSnapshotFrom(value)
  if (snapshot === undefined) return undefined
  const objective = typeof snapshot.objective === 'string' ? snapshot.objective.trim() : ''
  if (objective.length === 0) return undefined
  const status = goalPhaseStatus(snapshot.phase)
  if (status === undefined) return undefined
  const id = typeof snapshot.id === 'string' && snapshot.id.length > 0
    ? snapshot.id
    : stableId(`${objective}\0${String(snapshot.phase)}`)
  return {
    id: `goal:${id}`,
    content: `Goal: ${objective}`,
    status,
    priority: 'high',
  }
}

/**
 * Merge the current goal (first) with dsh todo items. The goal is additive:
 * it never replaces or hides the todo projection.
 */
export function convertGoalTodos(goalValue: unknown, todosValue: unknown): Todo[] {
  const goal = goalTodo(goalValue)
  return [...(goal === undefined ? [] : [goal]), ...convertTodos(todosValue)]
}

/**
 * One-line human summary of a `goal/change` event for the history/message
 * surface. Returns `undefined` for values that are not goal changes.
 */
export function goalChangeText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.operation === 'clear') return 'Goal cleared'
  const snapshot = goalSnapshotFrom(value)
  if (snapshot === undefined) return undefined
  const objective = typeof snapshot.objective === 'string' ? snapshot.objective.trim() : ''
  if (objective.length === 0) return undefined
  switch (value.operation) {
    case 'create':
      return `Goal created: ${objective}`
    case 'edit':
      return `Goal updated: ${objective}`
    case 'pause':
      return `Goal paused: ${objective}`
    case 'resume':
      return `Goal resumed: ${objective}`
    case 'complete':
      return `Goal completed: ${objective}`
    case 'block': {
      const reason = snapshot.blockedReason
      const reasonRecord = isRecord(reason) ? reason : undefined
      const code = typeof reasonRecord?.code === 'string' ? reasonRecord.code : 'unknown'
      const message = typeof reasonRecord?.message === 'string' ? reasonRecord.message : ''
      return `Goal blocked: ${objective} (${code}${message.length === 0 ? '' : `: ${message}`})`
    }
    default:
      return undefined
  }
}
