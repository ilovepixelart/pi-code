import { describe, expect, it } from 'vitest'

import { planToTodos } from '../extensions/plan-mode/utils.ts'

describe('planToTodos', () => {
  it('parses a numbered plan without requiring a Plan: header', () => {
    const todos = planToTodos('1. Read the config loader\n2. Add the new field\n3. Update the tests')
    // cleanStepText strips leading action verbs for compact widget labels
    expect(todos.map((t) => t.text)).toEqual(['Config loader', 'New field', 'Tests'])
    expect(todos[0]).toMatchObject({ step: 1, completed: false })
  })

  it('parses a plan that already has a Plan: header', () => {
    const todos = planToTodos('Plan:\n1. First real step here\n2. Second real step here')
    expect(todos).toHaveLength(2)
  })

  it('returns empty for unstructured prose', () => {
    expect(planToTodos('Just do the thing quickly')).toEqual([])
  })
})
