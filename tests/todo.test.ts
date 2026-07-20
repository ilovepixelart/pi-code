import { beforeEach, describe, expect, it } from 'vitest'

import todoExtension, { type LegacyTodo, layoutOverlay, normalizeTodo, type Todo } from '../extensions/todo.ts'

type ToolResult = { content: Array<{ type: string; text: string }>; details: { action: string; todos: Todo[]; nextId: number; error?: string } }
type Execute = (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>

/** Fresh extension instance so module-level todo state is isolated per test. */
const setup = (): { call: (params: Record<string, unknown>) => Promise<ToolResult> } => {
  let execute: Execute | undefined
  todoExtension({
    on: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string; execute: Execute }) => {
      if (tool.name === 'todo') execute = tool.execute
    },
  } as never)
  if (!execute) throw new Error('todo tool was not registered')
  const run = execute
  return { call: (params) => run('call-1', params) }
}

const pending = (id: number, text: string): Todo => ({ id, text, status: 'pending' })
const completed = (id: number, text: string): Todo => ({ id, text, status: 'completed' })

describe('normalizeTodo', () => {
  it('passes through a todo that already has a status', () => {
    const todo: LegacyTodo = { id: 3, text: 'ship', status: 'in_progress', activeForm: 'Shipping' }
    expect(normalizeTodo(todo)).toEqual({ id: 3, text: 'ship', status: 'in_progress', activeForm: 'Shipping' })
  })

  it('migrates the legacy done boolean to a status', () => {
    expect(normalizeTodo({ id: 1, text: 'a', done: true })).toEqual({ id: 1, text: 'a', status: 'completed' })
    expect(normalizeTodo({ id: 2, text: 'b', done: false })).toEqual({ id: 2, text: 'b', status: 'pending' })
    expect(normalizeTodo({ id: 4, text: 'c' })).toEqual({ id: 4, text: 'c', status: 'pending' })
  })
})

describe('layoutOverlay', () => {
  it('shows every todo when the list fits the budget', () => {
    const todos = [pending(1, 'a'), pending(2, 'b')]
    expect(layoutOverlay(todos, 5)).toEqual({ visible: todos, hiddenCompleted: 0, truncatedTail: 0 })
  })

  it('drops completed todos first on overflow, reserving a row for the summary', () => {
    const todos = [pending(1, 'a'), pending(2, 'b'), completed(3, 'c'), completed(4, 'd')]
    const layout = layoutOverlay(todos, 3)
    // innerBudget = 2 rows, both pending kept, both completed hidden
    expect(layout.visible).toEqual([pending(1, 'a'), pending(2, 'b')])
    expect(layout.hiddenCompleted).toBe(2)
    expect(layout.truncatedTail).toBe(0)
  })

  it('keeps completed rows interleaved in order when they still fit', () => {
    const todos = [completed(1, 'a'), pending(2, 'b'), completed(3, 'c'), completed(4, 'd'), completed(5, 'e')]
    const layout = layoutOverlay(todos, 4)
    // innerBudget = 3: the single pending plus the first two completed, in original order
    expect(layout.visible).toEqual([completed(1, 'a'), pending(2, 'b'), completed(3, 'c')])
    expect(layout.hiddenCompleted).toBe(2)
    expect(layout.truncatedTail).toBe(0)
  })

  it('truncates the non-completed tail when the pending list alone overflows', () => {
    const todos = [pending(1, 'a'), pending(2, 'b'), pending(3, 'c'), pending(4, 'd')]
    const layout = layoutOverlay(todos, 3)
    expect(layout.visible).toEqual([pending(1, 'a'), pending(2, 'b')])
    expect(layout.hiddenCompleted).toBe(0)
    expect(layout.truncatedTail).toBe(2)
  })
})

describe('todo tool status machine', () => {
  let call: (params: Record<string, unknown>) => Promise<ToolResult>

  beforeEach(() => {
    call = setup().call
  })

  it('adds todos as pending with incrementing ids', async () => {
    const first = await call({ action: 'add', text: 'write tests' })
    const second = await call({ action: 'add', text: 'ship it' })
    expect(first.details.todos).toEqual([{ id: 1, text: 'write tests', status: 'pending', activeForm: undefined }])
    expect(second.details.todos.map((t) => t.id)).toEqual([1, 2])
    expect(second.details.nextId).toBe(3)
    expect(second.content[0].text).toContain('Added todo #2')
  })

  it('rejects add without text', async () => {
    const result = await call({ action: 'add' })
    expect(result.details.error).toBe('text required for add')
    expect(result.details.todos).toEqual([])
  })

  it('starts a todo and demotes any other in_progress todo back to pending', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    await call({ action: 'start', id: 1, activeForm: 'Doing one' })
    const result = await call({ action: 'start', id: 2 })

    const byId = new Map(result.details.todos.map((t) => [t.id, t]))
    expect(byId.get(1)?.status).toBe('pending')
    expect(byId.get(2)?.status).toBe('in_progress')
    expect(result.content[0].text).toContain('moved #1 back to pending')
  })

  it('keeps the activeForm label set on start', async () => {
    await call({ action: 'add', text: 'one' })
    const result = await call({ action: 'start', id: 1, activeForm: 'Doing one' })
    expect(result.details.todos[0].activeForm).toBe('Doing one')
  })

  it('errors when starting an unknown id', async () => {
    const result = await call({ action: 'start', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('completes a todo', async () => {
    await call({ action: 'add', text: 'one' })
    const result = await call({ action: 'complete', id: 1 })
    expect(result.details.todos[0].status).toBe('completed')
  })

  it('errors when completing an unknown id', async () => {
    const result = await call({ action: 'complete', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('deletes a todo by id', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    const result = await call({ action: 'delete', id: 1 })
    expect(result.details.todos.map((t) => t.id)).toEqual([2])
    expect(result.content[0].text).toContain('Deleted #1')
  })

  it('errors when deleting an unknown id', async () => {
    const result = await call({ action: 'delete', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('clears all todos and resets the id counter', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    const cleared = await call({ action: 'clear' })
    expect(cleared.details.todos).toEqual([])
    expect(cleared.content[0].text).toContain('Cleared 2 todos')

    const readded = await call({ action: 'add', text: 'fresh' })
    expect(readded.details.todos[0].id).toBe(1)
  })

  it('lists todos with a status mark per row', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    await call({ action: 'complete', id: 1 })
    const result = await call({ action: 'list' })
    expect(result.content[0].text).toBe('[x] #1: one\n[ ] #2: two')
  })

  it('reports an empty list', async () => {
    const result = await call({ action: 'list' })
    expect(result.content[0].text).toBe('No todos')
  })

  it('fails on an unknown action', async () => {
    const result = await call({ action: 'explode' })
    expect(result.details.error).toBe('unknown action: explode')
  })
})
