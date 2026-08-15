import { describe, expect, it } from 'vitest'
import { convertTodos } from '../../src/bridge/convert/todo.js'

describe('convert/todo', () => {
  it('converts dsh items with default priority and stable ids', () => {
    const todos = convertTodos([
      { content: 'fix bug', status: 'in_progress' },
      { content: 'ship it', status: 'completed' },
    ])
    expect(todos).toHaveLength(2)
    expect(todos[0]).toMatchObject({ content: 'fix bug', status: 'in_progress', priority: 'medium' })
    expect(todos[0]?.id).toMatch(/^[0-9a-f]{16}$/)
    expect(todos[1]?.status).toBe('completed')
  })

  it('keeps a valid explicit priority', () => {
    const [todo] = convertTodos([{ content: 'x', status: 'pending', priority: 'high' }])
    expect(todo?.priority).toBe('high')
  })

  it('returns [] for invalid values', () => {
    expect(convertTodos(undefined)).toEqual([])
    expect(convertTodos('nope')).toEqual([])
    expect(convertTodos([{ content: 42 }])).toEqual([])
  })
})
