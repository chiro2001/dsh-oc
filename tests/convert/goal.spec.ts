import { describe, expect, it } from 'vitest'
import { convertGoalTodos, goalChangeText, goalTodo } from '../../src/bridge/convert/goal.js'

const ACTIVE_GOAL = {
  goal: {
    id: 'goal-1',
    revision: 3,
    objective: 'ship dsh-oc goal support',
    phase: 'active',
    maxGoalRounds: 10,
  },
  roundsStarted: 2,
  createdAt: 100,
  updatedAt: 300,
}

describe('convert/goal', () => {
  it('maps an active goal projection to an in-progress high-priority todo', () => {
    expect(goalTodo(ACTIVE_GOAL)).toEqual({
      id: 'goal:goal-1',
      content: 'Goal: ship dsh-oc goal support',
      status: 'in_progress',
      priority: 'high',
    })
  })

  it('maps paused/blocked to pending and complete to completed', () => {
    expect(goalTodo({ goal: { ...ACTIVE_GOAL.goal, phase: 'paused' } })?.status).toBe('pending')
    expect(goalTodo({ goal: { ...ACTIVE_GOAL.goal, phase: 'blocked', blockedReason: { code: 'x', message: 'y' } } })?.status)
      .toBe('pending')
    expect(goalTodo({ goal: { ...ACTIVE_GOAL.goal, phase: 'complete' } })?.status).toBe('completed')
  })

  it('accepts a raw snapshot and rejects invalid values', () => {
    expect(goalTodo(ACTIVE_GOAL.goal)?.content).toContain('ship dsh-oc')
    expect(goalTodo(undefined)).toBeUndefined()
    expect(goalTodo(null)).toBeUndefined()
    expect(goalTodo({ goal: { objective: '', phase: 'active' } })).toBeUndefined()
    expect(goalTodo({ goal: { objective: 'x', phase: 'weird' } })).toBeUndefined()
  })

  it('merges the goal before dsh todos without replacing them', () => {
    const merged = convertGoalTodos(ACTIVE_GOAL, [
      { content: 'step 1', status: 'in_progress' },
      { content: 'step 2', status: 'pending' },
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0]?.content).toBe('Goal: ship dsh-oc goal support')
    expect(merged[0]?.priority).toBe('high')
    expect(merged[1]).toMatchObject({ content: 'step 1', priority: 'medium' })
    expect(merged[2]).toMatchObject({ content: 'step 2' })
  })

  it('renders one-line goal change summaries and ignores non-goal values', () => {
    expect(goalChangeText({ operation: 'create', goal: ACTIVE_GOAL.goal }))
      .toBe('Goal created: ship dsh-oc goal support')
    expect(goalChangeText({ operation: 'complete', goal: { ...ACTIVE_GOAL.goal, phase: 'complete' } }))
      .toBe('Goal completed: ship dsh-oc goal support')
    expect(goalChangeText({ operation: 'block', goal: {
      ...ACTIVE_GOAL.goal,
      phase: 'blocked',
      blockedReason: { code: 'out-of-scope', message: 'blocked by review' },
    } })).toBe('Goal blocked: ship dsh-oc goal support (out-of-scope: blocked by review)')
    expect(goalChangeText({ operation: 'clear' })).toBe('Goal cleared')
    expect(goalChangeText({ operation: 'nope' })).toBeUndefined()
    expect(goalChangeText('nope')).toBeUndefined()
  })
})
