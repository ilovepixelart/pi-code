import { describe, expect, it } from 'vitest'

import todoExtension, { layoutOverlay, type Todo } from '../extensions/todo.ts'

type Content = Array<{ type: string; text?: string }>
type ToolResult = { content: Content; details?: { action: string; todos: Todo[]; nextId: number; error?: string } }
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

interface Component {
  render: (width: number) => string[]
  invalidate?: () => void
  handleInput?: (data: string) => void
}
type WidgetFactory = (tui: unknown, theme: unknown) => Component

/** Theme stub that returns its input unchanged, so assertions pin plain text. */
const theme = { fg: (_role: string, s: string) => s, bold: (s: string) => s } as never

/** truncateToWidth wraps the ellipsis in SGR codes; strip them to compare text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: an SGR sequence starts with a literal ESC
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
/** Text#render right-pads every line to the requested width. */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.trimEnd())

interface FakeUI {
  ui: Record<string, unknown>
  widgetCalls: Array<{ key: string; content: WidgetFactory | undefined }>
  renderRequests: () => number
  notices: Array<{ message: string; type?: string }>
  customFactories: Array<(tui: unknown, th: unknown, kb: unknown, done: (r: unknown) => void) => Component>
  /** Build the component from the most recent setWidget factory. */
  widget: () => Component
}

const fakeUI = (): FakeUI => {
  const widgetCalls: FakeUI['widgetCalls'] = []
  const notices: FakeUI['notices'] = []
  const customFactories: FakeUI['customFactories'] = []
  let renders = 0
  const tui = {
    requestRender: () => {
      renders++
    },
  }
  return {
    widgetCalls,
    notices,
    customFactories,
    renderRequests: () => renders,
    widget: () => {
      const last = widgetCalls.at(-1)?.content
      if (!last) throw new Error('no widget factory registered')
      return last(tui, theme)
    },
    ui: {
      setWidget: (key: string, content: WidgetFactory | undefined) => widgetCalls.push({ key, content }),
      notify: (message: string, type?: string) => notices.push({ message, type }),
      custom: async (factory: FakeUI['customFactories'][number]) => {
        customFactories.push(factory)
        return undefined
      },
    },
  }
}

interface Harness {
  call: (params: Record<string, unknown>) => Promise<ToolResult>
  fire: (name: string, event: unknown, ctx: unknown) => Promise<unknown>
  renderCall: (args: Record<string, unknown>) => string[]
  renderResult: (result: ToolResult, expanded: boolean) => string[]
  commandNames: string[]
  runCommand: (name: string, ctx: unknown) => Promise<void>
}

/** Fresh extension instance so module-level todo state is isolated per test. */
const setup = (): Harness => {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  let tool: Record<string, (...a: never[]) => unknown> | undefined

  todoExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: (name: string, config: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, config),
    registerTool: (t: Record<string, unknown>) => {
      if (t.name === 'todo') tool = t as Record<string, (...a: never[]) => unknown>
    },
  } as never)
  if (!tool) throw new Error('todo tool was not registered')
  const t = tool

  return {
    call: (params) => (t.execute as never as (id: string, p: unknown) => Promise<ToolResult>)('call-1', params),
    fire: async (name, event, ctx) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`no handler for ${name}`)
      return handler(event, ctx)
    },
    renderCall: (args) => trimmed((t.renderCall as never as (a: unknown, th: unknown, c: unknown) => Component)(args, theme, {}).render(200)),
    renderResult: (result, expanded) => trimmed((t.renderResult as never as (r: unknown, o: unknown, th: unknown, c: unknown) => Component)(result, { expanded }, theme, {}).render(200)),
    commandNames: [...commands.keys()],
    runCommand: async (name, ctx) => {
      const config = commands.get(name)
      if (!config) throw new Error(`no command ${name}`)
      await config.handler('', ctx)
    },
  }
}

const pending = (id: number, text: string): Todo => ({ id, text, status: 'pending' })
const completed = (id: number, text: string): Todo => ({ id, text, status: 'completed' })

/** A session entry shaped like a persisted todo tool result. */
const resultEntry = (todos: unknown[], nextId: number) => ({
  type: 'message',
  message: { role: 'toolResult', toolName: 'todo', details: { action: 'add', todos, nextId } },
})

const branchCtx = (entries: unknown[], ui: FakeUI, hasUI = true) => ({
  hasUI,
  ui: ui.ui,
  sessionManager: { getBranch: () => entries },
})

describe('layoutOverlay boundaries', () => {
  it('returns an empty layout for an empty list at a zero budget', () => {
    expect(layoutOverlay([], 0)).toEqual({ visible: [], hiddenCompleted: 0, truncatedTail: 0 })
  })

  it('shows the whole list when its length exactly equals the budget', () => {
    const todos = [pending(1, 'a'), pending(2, 'b'), pending(3, 'c')]
    expect(layoutOverlay(todos, 3)).toEqual({ visible: todos, hiddenCompleted: 0, truncatedTail: 0 })
  })

  it('reserves the whole single-row budget for the summary when one todo overflows', () => {
    // budget 1 leaves innerBudget 0, so nothing is visible and both are counted.
    expect(layoutOverlay([pending(1, 'a'), pending(2, 'b')], 1)).toEqual({ visible: [], hiddenCompleted: 0, truncatedTail: 2 })
  })

  it('hides every completed todo when the budget leaves no inner rows', () => {
    expect(layoutOverlay([completed(1, 'a'), completed(2, 'b')], 1)).toEqual({ visible: [], hiddenCompleted: 2, truncatedTail: 0 })
  })

  it('counts both hidden completed and a truncated pending tail together', () => {
    // budget 6 -> innerBudget 5; 6 pending exceed it, so 5 show, 1 truncates, 2 completed hide.
    const todos = [...Array.from({ length: 6 }, (_, i) => pending(i + 1, `p${i + 1}`)), completed(7, 'x'), completed(8, 'y')]
    const layout = layoutOverlay(todos, 6)
    expect(layout.visible.map((t) => t.id)).toEqual([1, 2, 3, 4, 5])
    expect(layout.hiddenCompleted).toBe(2)
    expect(layout.truncatedTail).toBe(1)
  })
})

describe('session replay', () => {
  it('rebuilds todos and the id counter from the last todo result on the branch', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire(
      'session_start',
      {},
      branchCtx(
        [
          resultEntry([{ id: 1, text: 'a', status: 'completed' }], 2),
          resultEntry(
            [
              { id: 1, text: 'a', status: 'completed' },
              { id: 2, text: 'b', status: 'pending' },
            ],
            3,
          ),
        ],
        ui,
      ),
    )

    const listed = await h.call({ action: 'list' })
    expect(listed.content[0].text).toBe('[x] #1: a\n[ ] #2: b')
    const added = await h.call({ action: 'add', text: 'c' })
    expect(added.details?.todos.at(-1)?.id).toBe(3)
  })

  it('migrates legacy done flags found on the branch', async () => {
    const h = setup()
    await h.fire('session_start', {}, branchCtx([resultEntry([{ id: 1, text: 'old', done: true }], 2)], fakeUI()))
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[x] #1: old')
  })

  it('ignores branch entries that are not todo tool results', async () => {
    const h = setup()
    const entries = [
      { type: 'checkpoint' },
      { type: 'message', message: { role: 'assistant', content: 'hi' } },
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', details: { action: 'add', todos: [{ id: 9, text: 'nope', status: 'pending' }], nextId: 10 } } },
      resultEntry([{ id: 1, text: 'kept', status: 'pending' }], 2),
      { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: undefined } },
    ]
    await h.fire('session_start', {}, branchCtx(entries, fakeUI()))
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[ ] #1: kept')
  })

  it('replays the statuses recorded at an entry rather than later changes to the same objects', async () => {
    const h = setup()
    const first = await h.call({ action: 'add', text: 'a' })
    await h.call({ action: 'start', id: 1 })
    await h.call({ action: 'complete', id: 1 })
    // A rewind to the first call replays the details object pi kept by reference.
    await h.fire('session_tree', {}, branchCtx([{ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: first.details } }], fakeUI()))
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[ ] #1: a')
  })

  it('replaces existing todos on a session_tree replay', async () => {
    const h = setup()
    await h.call({ action: 'add', text: 'local' })
    await h.fire('session_tree', {}, branchCtx([resultEntry([{ id: 7, text: 'branch', status: 'pending' }], 8)], fakeUI()))
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[ ] #7: branch')
  })

  it('keeps the current todos when a compaction replay hits a stale context', async () => {
    const h = setup()
    await h.call({ action: 'add', text: 'survivor' })
    const staleCtx = {
      hasUI: false,
      ui: fakeUI().ui,
      sessionManager: {
        getBranch: () => {
          throw new Error('ExtensionContext is stale after session replacement')
        },
      },
    }
    await expect(h.fire('session_compact', {}, staleCtx)).resolves.toBeUndefined()
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[ ] #1: survivor')
  })

  it('propagates a replay error that is not a stale context', async () => {
    const h = setup()
    const brokenCtx = {
      hasUI: false,
      ui: fakeUI().ui,
      sessionManager: {
        getBranch: () => {
          throw new Error('disk exploded')
        },
      },
    }
    await expect(h.fire('session_tree', {}, brokenCtx)).rejects.toThrow('disk exploded')
  })
})

describe('todo overlay widget', () => {
  it('registers no widget while the todo list is empty', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([], ui))
    expect(ui.widgetCalls).toEqual([])
  })

  it('registers the widget above the editor once the branch replays todos', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([{ id: 1, text: 'a', status: 'pending' }], 2)], ui))
    expect(ui.widgetCalls.map((c) => c.key)).toEqual(['todos'])
  })

  it('registers no widget when the session has no UI', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([{ id: 1, text: 'a', status: 'pending' }], 2)], ui, false))
    expect(ui.widgetCalls).toEqual([])
  })

  it('draws a heading, one row per todo and a trailing spacer', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'alpha'), completed(2, 'beta')], 3)], ui))
    expect(ui.widget().render(60)).toEqual(['● Todos (1/2)', '├─ ○ alpha', '└─ ✓ beta', ''])
  })

  it('marks the heading as inactive once every todo is completed', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([completed(1, 'a')], 2)], ui))
    expect(ui.widget().render(60)[0]).toBe('○ Todos (1/1)')
  })

  it('shows the activeForm label instead of the text for the in_progress todo', async () => {
    const h = setup()
    const ui = fakeUI()
    const todo = { id: 1, text: 'write tests', status: 'in_progress', activeForm: 'Writing tests' }
    await h.fire('session_start', {}, branchCtx([resultEntry([todo], 2)], ui))
    expect(ui.widget().render(60)[1]).toBe('└─ ◐ Writing tests')
  })

  it('falls back to the todo text when an in_progress todo has no activeForm', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([{ id: 1, text: 'write tests', status: 'in_progress' }], 2)], ui))
    expect(ui.widget().render(60)[1]).toBe('└─ ◐ write tests')
  })

  it('summarises the pending tail it could not fit', async () => {
    const h = setup()
    const ui = fakeUI()
    // 12 todos against the 11-row content budget: 10 rows show, 2 pending truncate.
    const todos = Array.from({ length: 12 }, (_, i) => pending(i + 1, `p${i + 1}`))
    await h.fire('session_start', {}, branchCtx([resultEntry(todos, 13)], ui))
    const lines = ui.widget().render(60)
    expect(lines[0]).toBe('● Todos (0/12)')
    expect(lines.slice(1, 11)).toEqual(todos.slice(0, 10).map((t) => `├─ ○ ${t.text}`))
    expect(lines[11]).toBe('└─ +2 more (2 pending)')
    expect(lines[12]).toBe('')
  })

  it('summarises the completed todos it dropped to make room', async () => {
    const h = setup()
    const ui = fakeUI()
    // 8 pending + 4 completed: all pending fit, 2 completed fill the budget, 2 hide.
    const todos = [...Array.from({ length: 8 }, (_, i) => pending(i + 1, `p${i + 1}`)), ...Array.from({ length: 4 }, (_, i) => completed(i + 9, `c${i + 1}`))]
    await h.fire('session_start', {}, branchCtx([resultEntry(todos, 13)], ui))
    const lines = ui.widget().render(60)
    expect(lines.at(-2)).toBe('└─ +2 more (2 completed)')
  })

  it('names both hidden groups in the summary row', async () => {
    const h = setup()
    const ui = fakeUI()
    // 11 pending + 2 completed: 10 pending show, 1 pending truncates, 2 completed hide.
    const todos = [...Array.from({ length: 11 }, (_, i) => pending(i + 1, `p${i + 1}`)), completed(12, 'x'), completed(13, 'y')]
    await h.fire('session_start', {}, branchCtx([resultEntry(todos, 14)], ui))
    expect(ui.widget().render(60).at(-2)).toBe('└─ +3 more (2 completed, 1 pending)')
  })

  it('truncates a row that is wider than the terminal', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'ABCDEFGHIJKLMNOP')], 2)], ui))
    // "└─ ○ " is 5 columns wide, leaving 2 characters plus the ellipsis at width 8.
    expect(plain(ui.widget().render(8)[1])).toBe('└─ ○ AB…')
  })

  it('renders no lines when the list emptied out from under a live component', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'a')], 2)], ui))
    const component = ui.widget()
    await h.call({ action: 'clear' })
    expect(component.render(60)).toEqual([])
  })

  it('re-renders through the TUI instead of re-registering an already-registered widget', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'a')], 2)], ui))
    ui.widget()
    await h.call({ action: 'add', text: 'b' })
    await h.fire('tool_execution_end', { toolName: 'todo', isError: false }, {})
    expect(ui.widgetCalls).toHaveLength(1)
    expect(ui.renderRequests()).toBe(1)
  })

  it('re-registers the widget after the TUI invalidates the component', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'a')], 2)], ui))
    ui.widget().invalidate?.()
    await h.fire('tool_execution_end', { toolName: 'todo', isError: false }, {})
    expect(ui.widgetCalls).toHaveLength(2)
    expect(ui.renderRequests()).toBe(0)
  })

  it('clears the widget when the last todo is deleted', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'a')], 2)], ui))
    await h.call({ action: 'delete', id: 1 })
    await h.fire('tool_execution_end', { toolName: 'todo', isError: false }, {})
    expect(ui.widgetCalls.at(-1)).toEqual({ key: 'todos', content: undefined })
  })

  it('ignores tool_execution_end for other tools', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([], ui))
    await h.call({ action: 'add', text: 'a' })
    await h.fire('tool_execution_end', { toolName: 'bash', isError: false }, {})
    expect(ui.widgetCalls).toEqual([])
  })

  it('ignores a failed todo execution', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([], ui))
    await h.call({ action: 'add', text: 'a' })
    await h.fire('tool_execution_end', { toolName: 'todo', isError: true }, {})
    expect(ui.widgetCalls).toEqual([])
  })

  it('clears the widget on shutdown and stops updating afterwards', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.fire('session_start', {}, branchCtx([resultEntry([pending(1, 'a')], 2)], ui))
    await h.fire('session_shutdown', {}, {})
    expect(ui.widgetCalls.at(-1)).toEqual({ key: 'todos', content: undefined })

    await h.call({ action: 'add', text: 'b' })
    await h.fire('tool_execution_end', { toolName: 'todo', isError: false }, {})
    expect(ui.widgetCalls).toHaveLength(2)
  })

  it('re-registers the widget when a reload swaps the UI context', async () => {
    const h = setup()
    const first = fakeUI()
    const second = fakeUI()
    const entries = [resultEntry([pending(1, 'a')], 2)]
    await h.fire('session_start', {}, branchCtx(entries, first))
    await h.fire('session_start', {}, branchCtx(entries, second))
    expect(first.widgetCalls).toHaveLength(1)
    expect(second.widgetCalls.map((c) => c.key)).toEqual(['todos'])
  })

  it('does not re-register the widget when the same UI context restarts', async () => {
    const h = setup()
    const ui = fakeUI()
    const entries = [resultEntry([pending(1, 'a')], 2)]
    const ctx = branchCtx(entries, ui)
    await h.fire('session_start', {}, ctx)
    ui.widget()
    await h.fire('session_start', {}, ctx)
    expect(ui.widgetCalls).toHaveLength(1)
    expect(ui.renderRequests()).toBe(1)
  })
})

describe('renderCall', () => {
  it('renders the action alone when no other argument is set', () => {
    expect(setup().renderCall({ action: 'list' })).toEqual(['todo list'])
  })

  it('appends the id, text and activeForm in that order', () => {
    expect(setup().renderCall({ action: 'add', id: 3, text: 'write tests', activeForm: 'Writing tests' })).toEqual(['todo add #3 "write tests" (Writing tests)'])
  })

  it('renders id zero rather than treating it as absent', () => {
    expect(setup().renderCall({ action: 'complete', id: 0 })).toEqual(['todo complete #0'])
  })
})

describe('renderResult', () => {
  const result = (text: string, details?: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], details: details as never })

  it('falls back to the message text when the result has no details', () => {
    expect(setup().renderResult({ content: [{ type: 'text', text: 'raw output' }] }, false)).toEqual(['raw output'])
  })

  it('renders nothing when a detail-less result carries no text content', () => {
    expect(setup().renderResult({ content: [{ type: 'image' }] }, false)).toEqual([])
  })

  it('renders the error message for a failed call', () => {
    expect(setup().renderResult(result('Error: #9 not found', { action: 'start', todos: [], nextId: 1, error: '#9 not found' }), false)).toEqual(['Error: #9 not found'])
  })

  it('renders an empty-list placeholder for a list action with no todos', () => {
    expect(setup().renderResult(result('No todos', { action: 'list', todos: [], nextId: 1 }), false)).toEqual(['No todos'])
  })

  it('renders a count header and one glyph row per todo', () => {
    const todos = [pending(1, 'a'), completed(2, 'b'), { id: 3, text: 'c', status: 'in_progress' }]
    expect(setup().renderResult(result('...', { action: 'list', todos, nextId: 4 }), false)).toEqual(['3 todo(s):', '○ #1 a', '✓ #2 b', '◐ #3 c'])
  })

  it('caps a collapsed list at five rows and counts the remainder', () => {
    const todos = Array.from({ length: 7 }, (_, i) => pending(i + 1, `t${i + 1}`))
    const lines = setup().renderResult(result('...', { action: 'list', todos, nextId: 8 }), false)
    expect(lines).toEqual(['7 todo(s):', '○ #1 t1', '○ #2 t2', '○ #3 t3', '○ #4 t4', '○ #5 t5', '... 2 more'])
  })

  it('shows every row and no remainder line when expanded', () => {
    const todos = Array.from({ length: 7 }, (_, i) => pending(i + 1, `t${i + 1}`))
    const lines = setup().renderResult(result('...', { action: 'list', todos, nextId: 8 }), true)
    expect(lines).toHaveLength(8)
    expect(lines.at(-1)).toBe('○ #7 t7')
  })

  it('shows exactly five rows without a remainder line at the collapse boundary', () => {
    const todos = Array.from({ length: 5 }, (_, i) => pending(i + 1, `t${i + 1}`))
    const lines = setup().renderResult(result('...', { action: 'list', todos, nextId: 6 }), false)
    expect(lines).toEqual(['5 todo(s):', '○ #1 t1', '○ #2 t2', '○ #3 t3', '○ #4 t4', '○ #5 t5'])
  })

  it('prefixes a start result with the in_progress glyph', () => {
    expect(setup().renderResult(result('Started #1: a', { action: 'start', todos: [], nextId: 2 }), false)).toEqual(['◐ Started #1: a'])
  })

  it('prefixes any other successful result with the success glyph', () => {
    expect(setup().renderResult(result('Added todo #1: a', { action: 'add', todos: [], nextId: 2 }), false)).toEqual(['✓ Added todo #1: a'])
  })

  it('renders only the glyph when a non-list result has no text content', () => {
    expect(setup().renderResult({ content: [], details: { action: 'clear', todos: [], nextId: 1 } as never }, false)).toEqual(['✓'])
  })
})

describe('/todos command', () => {
  it('is registered under the name todos', () => {
    expect(setup().commandNames).toEqual(['todos'])
  })

  it('notifies instead of opening the list outside interactive mode', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: false, ui: ui.ui })
    expect(ui.notices).toEqual([{ message: '/todos requires interactive mode', type: 'error' }])
    expect(ui.customFactories).toHaveLength(0)
  })

  it('notifies the plain list instead of a custom component in RPC mode', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.call({ action: 'add', text: 'first' })
    await h.call({ action: 'add', text: 'second' })
    await h.call({ action: 'complete', id: 1 })
    await h.runCommand('todos', { hasUI: true, mode: 'rpc', ui: ui.ui })
    expect(ui.customFactories).toHaveLength(0)
    expect(ui.notices).toEqual([{ message: '[x] #1: first\n[ ] #2: second', type: 'info' }])
  })

  it('notifies the empty-list placeholder in RPC mode', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: true, mode: 'rpc', ui: ui.ui })
    expect(ui.customFactories).toHaveLength(0)
    expect(ui.notices).toEqual([{ message: 'No todos', type: 'info' }])
  })

  it('renders an invitation when the list is empty', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    const lines = ui.customFactories[0](null, theme, null, () => {}).render(60)
    expect(lines[3]).toBe('  No todos yet. Ask the agent to add some!')
    expect(lines.at(-2)).toBe('  Press Escape to close')
  })

  it('renders a completion count, a row per todo and the activeForm suffix', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.call({ action: 'add', text: 'first' })
    await h.call({ action: 'add', text: 'second' })
    await h.call({ action: 'complete', id: 1 })
    await h.call({ action: 'start', id: 2, activeForm: 'Doing second' })
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })

    const lines = ui.customFactories[0](null, theme, null, () => {}).render(60)
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe(`${'─'.repeat(3)} Todos ${'─'.repeat(50)}`)
    expect(lines[3]).toBe('  1/2 completed')
    expect(lines[5]).toBe('  ✓ #1 first')
    expect(lines[6]).toBe('  ◐ #2 second (Doing second)')
  })

  it('closes the list on escape', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    let closed = 0
    const component = ui.customFactories[0](null, theme, null, () => {
      closed++
    })
    component.handleInput?.('\x1b')
    expect(closed).toBe(1)
  })

  it('closes the list on ctrl+c', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    let closed = 0
    const component = ui.customFactories[0](null, theme, null, () => {
      closed++
    })
    component.handleInput?.('\x03')
    expect(closed).toBe(1)
  })

  it('ignores unrelated keystrokes', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    let closed = 0
    const component = ui.customFactories[0](null, theme, null, () => {
      closed++
    })
    component.handleInput?.('x')
    expect(closed).toBe(0)
  })

  it('reuses the cached lines for a repeated width and drops them on invalidate', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.call({ action: 'add', text: 'first' })
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    const component = ui.customFactories[0](null, theme, null, () => {})

    const before = component.render(60)
    await h.call({ action: 'add', text: 'second' })
    expect(component.render(60)).toEqual(before)

    component.invalidate?.()
    expect(component.render(60).join('\n')).toContain('second')
  })

  it('re-lays out when the width changes', async () => {
    const h = setup()
    const ui = fakeUI()
    await h.call({ action: 'add', text: 'first' })
    await h.runCommand('todos', { hasUI: true, mode: 'tui', ui: ui.ui })
    const component = ui.customFactories[0](null, theme, null, () => {})

    component.render(60)
    expect(component.render(20)[1]).toBe(`${'─'.repeat(3)} Todos ${'─'.repeat(10)}`)
  })
})

describe('todo tool argument validation', () => {
  it('rejects start without an id', async () => {
    const result = await setup().call({ action: 'start' })
    expect(result.details?.error).toBe('id required for start')
  })

  it('rejects complete without an id', async () => {
    const result = await setup().call({ action: 'complete' })
    expect(result.details?.error).toBe('id required for complete')
  })

  it('rejects delete without an id', async () => {
    const result = await setup().call({ action: 'delete' })
    expect(result.details?.error).toBe('id required for delete')
  })

  it('rejects add with empty text', async () => {
    const result = await setup().call({ action: 'add', text: '' })
    expect(result.details?.error).toBe('text required for add')
    expect(result.details?.todos).toEqual([])
  })

  it('stores whitespace-only text verbatim', async () => {
    const result = await setup().call({ action: 'add', text: '   ' })
    expect(result.details?.todos).toEqual([{ id: 1, text: '   ', status: 'pending', activeForm: undefined }])
  })

  it('keeps an existing activeForm when start is called again without one', async () => {
    const h = setup()
    await h.call({ action: 'add', text: 'a' })
    await h.call({ action: 'start', id: 1, activeForm: 'Doing a' })
    await h.call({ action: 'complete', id: 1 })
    const result = await h.call({ action: 'start', id: 1 })
    expect(result.details?.todos[0]).toEqual({ id: 1, text: 'a', status: 'in_progress', activeForm: 'Doing a' })
  })

  it('demotes every other in_progress todo, naming each in the message', async () => {
    const h = setup()
    // Replay seeds two simultaneous in_progress todos, which start must collapse.
    await h.fire(
      'session_start',
      {},
      branchCtx(
        [
          resultEntry(
            [
              { id: 1, text: 'a', status: 'in_progress' },
              { id: 2, text: 'b', status: 'in_progress' },
              { id: 3, text: 'c', status: 'pending' },
            ],
            4,
          ),
        ],
        fakeUI(),
      ),
    )
    const result = await h.call({ action: 'start', id: 3 })
    expect(result.content[0].text).toBe('Started #3: c (moved #1, #2 back to pending)')
    expect(result.details?.todos.map((t) => t.status)).toEqual(['pending', 'pending', 'in_progress'])
  })

  it('marks an in_progress todo with [>] in the list output', async () => {
    const h = setup()
    await h.call({ action: 'add', text: 'a' })
    await h.call({ action: 'start', id: 1 })
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[>] #1: a')
  })

  it('reports zero cleared todos for an empty list', async () => {
    const result = await setup().call({ action: 'clear' })
    expect(result.content[0].text).toBe('Cleared 0 todos')
  })

  it('deletes the first match when the branch replayed duplicate ids', async () => {
    const h = setup()
    await h.fire(
      'session_start',
      {},
      branchCtx(
        [
          resultEntry(
            [
              { id: 1, text: 'first', status: 'pending' },
              { id: 1, text: 'second', status: 'pending' },
            ],
            2,
          ),
        ],
        fakeUI(),
      ),
    )
    const result = await h.call({ action: 'delete', id: 1 })
    expect(result.content[0].text).toBe('Deleted #1: first')
    expect(result.details?.todos).toEqual([{ id: 1, text: 'second', status: 'pending' }])
  })
})

describe('replay with a failed todo call', () => {
  it('keeps replaying the list when an errored result is on the branch', async () => {
    const h = setup()
    // pi persists a rejected or blocked call as details: {}, which is truthy; the
    // list must survive it rather than the replay throwing for the rest of the session.
    const entries = [resultEntry([{ id: 1, text: 'kept', done: false }], 2), { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: {} } }]
    await h.fire('session_start', {}, branchCtx(entries as never, fakeUI()))

    // The errored result must neither throw nor wipe the list it followed.
    expect((await h.call({ action: 'list' })).content[0].text).toBe('[ ] #1: kept')
  })
})
