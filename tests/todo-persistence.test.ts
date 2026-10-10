import { describe, expect, it } from 'vitest'

import todoExtension, { type Todo } from '../extensions/todo.ts'

type Snapshot = { todos: Todo[]; nextId: number }
type Result = { details: Snapshot & { action: string; error?: string } }
type Entry = { type: string; customType?: string; data?: Snapshot; message?: unknown }

/** Capture provider entries independently of direct tool-result persistence. */
const setup = () => {
  const entries: Entry[] = []
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  let execute: (id: string, params: Record<string, unknown>) => Promise<Result>
  todoExtension({
    appendEntry: (customType: string, snapshot: Snapshot) => entries.push({ type: 'custom', customType, data: snapshot }),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: (tool: { execute: typeof execute }) => {
      execute = tool.execute
    },
  } as never)
  return {
    entries,
    call: (params: Record<string, unknown>) => execute('call', params),
    replay: (branch: Entry[], event = 'session_start') => handlers.get(event)?.({}, { hasUI: false, sessionManager: { getBranch: () => branch } }),
  }
}

/** Create the legacy transcript snapshot still supported on old branches. */
const toolResult = (snapshot: Snapshot): Entry => ({ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: snapshot } })

/** Read state without persisting a direct list result. */
const state = async (harness: ReturnType<typeof setup>): Promise<Snapshot> => {
  const { todos, nextId } = (await harness.call({ action: 'list' })).details
  return { todos, nextId }
}

describe('provider-owned todo persistence', () => {
  it.each(['session_start', 'session_tree', 'session_compact'])('preserves nested additions and allocation on %s', async (event) => {
    const harness = setup()
    for (let id = 1; id <= 8; id++) await harness.call({ action: 'add', text: `Task ${id}` })
    await harness.call({ action: 'complete', id: 2 })
    await harness.call({ action: 'start', id: 7, activeForm: 'Working on task seven' })
    await Promise.all([harness.call({ action: 'add', text: 'Ninth' }), harness.call({ action: 'add', text: 'Tenth' })])
    const live = await state(harness)
    expect(live.todos).toHaveLength(10)
    expect(live.nextId).toBe(11)
    const reopened = setup()
    reopened.replay(harness.entries, event)
    expect(await state(reopened)).toEqual(live)
    expect((await reopened.call({ action: 'add', text: 'Next' })).details.todos.at(-1)?.id).toBe(11)
  })

  it('does not let an older direct result overwrite a newer nested snapshot', async () => {
    const harness = setup()
    const direct = await harness.call({ action: 'add', text: 'Direct' })
    await harness.call({ action: 'add', text: 'Nested' })
    const live = await state(harness)
    const reopened = setup()
    reopened.replay([...harness.entries, toolResult(direct.details)])
    expect(await state(reopened)).toEqual(live)
  })

  it('ignores an older list result after a clear snapshot', async () => {
    const harness = setup()
    await harness.call({ action: 'add', text: 'Old' })
    const stale = await harness.call({ action: 'list' })
    await harness.call({ action: 'clear' })
    harness.replay([...harness.entries, toolResult(stale.details)])
    expect(await state(harness)).toEqual({ todos: [], nextId: 1 })
  })

  it('copies entries and result details separately from mutable live todos', async () => {
    const harness = setup()
    const added = await harness.call({ action: 'add', text: 'Task', activeForm: 'Adding' })
    const first = harness.entries[0].data
    expect(first).toEqual({ todos: added.details.todos, nextId: 2 })
    expect(first?.todos[0]).not.toBe(added.details.todos[0])
    await harness.call({ action: 'start', id: 1, activeForm: 'Working' })
    await harness.call({ action: 'complete', id: 1 })
    expect(first?.todos[0]).toEqual({ id: 1, text: 'Task', status: 'pending', activeForm: 'Adding' })
    harness.replay([harness.entries[0]], 'session_tree')
    await harness.call({ action: 'complete', id: 1 })
    expect(first?.todos[0].status).toBe('pending')
  })

  it('restores legacy history before the first provider entry and on rewind', async () => {
    const harness = setup()
    const legacy = toolResult({ todos: [{ id: 8, text: 'Legacy', done: true } as never], nextId: 9 })
    harness.replay([legacy])
    expect((await state(harness)).todos[0].status).toBe('completed')
    await harness.call({ action: 'add', text: 'Nested' })
    const snapshot = harness.entries[0]
    harness.replay([legacy, snapshot, toolResult({ todos: [], nextId: 1 })])
    expect((await state(harness)).todos).toHaveLength(2)
    harness.replay([legacy], 'session_tree')
    expect((await state(harness)).nextId).toBe(9)
    await harness.call({ action: 'add', text: 'Other branch' })
    expect((await state(harness)).todos.at(-1)?.text).toBe('Other branch')
    harness.replay([legacy, snapshot], 'session_tree')
    expect((await state(harness)).todos.at(-1)?.text).toBe('Nested')
  })

  it('persists every successful mutation but not lists or rejected operations', async () => {
    const harness = setup()
    await harness.call({ action: 'list' })
    await harness.call({ action: 'add' })
    await harness.call({ action: 'start', id: 99 })
    await harness.call({ action: 'complete', id: 99 })
    await harness.call({ action: 'delete', id: 99 })
    expect(harness.entries).toEqual([])
    await harness.call({ action: 'add', text: 'One' })
    await harness.call({ action: 'start', id: 1 })
    await harness.call({ action: 'complete', id: 1 })
    await harness.call({ action: 'delete', id: 1 })
    await harness.call({ action: 'clear' })
    expect(harness.entries).toHaveLength(5)
    expect(harness.entries.map((entry) => entry.customType)).toEqual(Array(5).fill('pi-code:todo'))
    const reopened = setup()
    reopened.replay(harness.entries)
    expect(await state(reopened)).toEqual({ todos: [], nextId: 1 })
  })

  it('ignores unrelated or incomplete custom entries without hiding legacy state', async () => {
    const harness = setup()
    const legacy = toolResult({ todos: [{ id: 1, text: 'Kept', status: 'pending' }], nextId: 2 })
    harness.replay([legacy, { type: 'custom', customType: 'another-extension', data: { todos: [], nextId: 1 } }, { type: 'custom', customType: 'pi-code:todo' }])
    expect((await state(harness)).todos[0].text).toBe('Kept')
  })
})
