import { beforeEach, describe, expect, it } from 'vitest'

import planModeExtension from '../extensions/plan-mode/index.ts'
import type { TodoItem } from '../extensions/plan-mode/utils.ts'

type Handler = (event: never, ctx: never) => Promise<unknown>
type SentMessage = { customType?: string; content: string; display?: boolean }
type ToolResult = { content: Array<{ type: string; text: string }>; terminate?: boolean }

const theme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
}

const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

/** Every tool the session has configured, which is what pi's getAllTools reports. */
const ALL_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'question', 'plan_mode_complete', 'edit', 'write', 'todo', 'memory']

/**
 * pi's reload() rebuilds the runtime with `activeToolNames: getActiveToolNames()` and
 * `includeAllExtensionTools: true`, so _refreshToolRegistry force-adds every
 * extension-registered tool on top of the carried set. The restricted set therefore
 * comes back with pi-code's own tools mixed in, never as the bare plan subset.
 */
const EXTENSION_TOOLS = ['todo', 'memory', 'question', 'plan_mode_complete']
const afterReload = (active: string[]): string[] => [...new Set([...active, ...EXTENSION_TOOLS])]

/** Fresh extension instance: the extension closes over mutable plan state per registration. */
function setup(options: { flag?: boolean; activeTools?: string[] } = {}) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const tools = new Map<string, (id: string, params: Record<string, unknown>) => Promise<ToolResult>>()
  const shortcuts: Array<(ctx: unknown) => Promise<void>> = []
  const sent: SentMessage[] = []
  const sentOptions: unknown[] = []
  const userMessages: string[] = []
  const userMessageOptions: unknown[] = []
  const appended: Array<{ type: string; data: unknown }> = []
  const emitted: Array<{ channel: string; data: unknown }> = []
  let activeTools = options.activeTools ?? [...ALL_TOOLS]

  const pi = {
    registerFlag: () => {},
    getFlag: () => options.flag,
    getActiveTools: () => activeTools,
    // The real getAllTools reads the tool-definition registry, so the active-tool
    // restriction does not narrow it.
    getAllTools: () => ALL_TOOLS.map((name) => ({ name })),
    setActiveTools: (next: string[]) => {
      activeTools = next
    },
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec.handler),
    registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> }) => tools.set(tool.name, tool.execute),
    registerShortcut: (_key: unknown, spec: { handler: (ctx: unknown) => Promise<void> }) => shortcuts.push(spec.handler),
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendMessage: (message: SentMessage, options?: unknown) => {
      sent.push(message)
      sentOptions.push(options)
    },
    sendUserMessage: (text: string, options?: unknown) => {
      userMessages.push(text)
      userMessageOptions.push(options)
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
  }

  planModeExtension(pi as never)

  const status: Array<string | undefined> = []
  const widgets: Array<string[] | undefined> = []
  const notices: string[] = []
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme,
      setStatus: (_key: string, text?: string) => status.push(text),
      setWidget: (_key: string, lines?: string[]) => widgets.push(lines),
      notify: (text: string) => notices.push(text),
      select: async (_q: string, choices: string[]) => choices[0],
      editor: async () => '',
    },
    sessionManager: { getEntries: () => [] as unknown[], getBranch: () => [] as unknown[] },
  }

  const emit = (name: string, event: unknown = {}, context: unknown = ctx) => handlers.get(name)?.(event as never, context as never)

  return {
    ctx,
    emit,
    status,
    widgets,
    notices,
    sent,
    userMessages,
    userMessageOptions,
    appended,
    emitted,
    shortcuts,
    getActiveTools: () => activeTools,
    runCommand: (name: string, args = '', context: unknown = ctx) => commands.get(name)?.(args, context),
    callTool: (name: string, params: Record<string, unknown>) => tools.get(name)?.('call-1', params) as Promise<ToolResult>,
    /** The { triggerTurn } options the last sendMessage of this customType carried. */
    optionsFor: (customType: string) => {
      for (let i = sent.length - 1; i >= 0; i--) {
        if (sent[i].customType === customType) return sentOptions[i]
      }
      return undefined
    },
  }
}

describe('plan mode toggle', () => {
  it('publishes the plan state on the shared bus for each toggle', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(s.emitted).toContainEqual({ channel: 'pi-code:plan-mode', data: { active: true } })
    await s.runCommand('plan')
    expect(s.emitted).toContainEqual({ channel: 'pi-code:plan-mode', data: { active: false } })
  })

  it('restricts active tools to the read-only set when enabled', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(s.getActiveTools()).toEqual(['read', 'bash', 'grep', 'find', 'ls', 'question', 'plan_mode_complete'])
    expect(s.notices[0]).toContain('Plan mode enabled')
  })

  it('only enables tools the session already had', async () => {
    const s = setup({ activeTools: ['read', 'edit'] })
    await s.runCommand('plan')
    expect(s.getActiveTools()).toEqual(['read'])
  })

  it('restores the full tool set when disabled again', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.runCommand('plan')
    expect(s.getActiveTools()).toContain('edit')
    expect(s.getActiveTools()).toContain('write')
    expect(s.notices[1]).toContain('Full access restored')
  })

  it('shows a plan badge in the status line while enabled and clears it when off', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(s.status.at(-1)).toContain('plan')
    await s.runCommand('plan')
    expect(s.status.at(-1)).toBeUndefined()
  })

  it('toggles from the keyboard shortcut too', async () => {
    const s = setup()
    await s.shortcuts[0](s.ctx)
    expect(s.getActiveTools()).not.toContain('write')
  })
})

describe('bash allowlist enforcement', () => {
  it('blocks a destructive command while in plan mode', async () => {
    const s = setup()
    await s.runCommand('plan')
    const result = (await s.emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf build' } })) as { block: boolean; reason: string }
    expect(result.block).toBe(true)
    expect(result.reason).toContain('rm -rf build')
  })

  it('allows an allowlisted read-only command', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(await s.emit('tool_call', { toolName: 'bash', input: { command: 'ls -la' } })).toBeUndefined()
  })

  it('ignores bash entirely when plan mode is off', async () => {
    const s = setup()
    expect(await s.emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf build' } })).toBeUndefined()
  })

  it('never blocks non-bash tools', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(await s.emit('tool_call', { toolName: 'read', input: { command: 'rm -rf build' } })).toBeUndefined()
  })
})

describe('plan_mode_complete tool', () => {
  it('is a no-op when plan mode is not active', async () => {
    const s = setup()
    const result = await s.callTool('plan_mode_complete', { plan: '1. Read the config loader' })
    expect(result.content[0].text).toContain('tool ignored')
    expect(result.terminate).toBeUndefined()
  })

  it('parses the submitted plan into persisted todos and terminates the turn', async () => {
    const s = setup()
    await s.runCommand('plan')
    const result = await s.callTool('plan_mode_complete', { plan: '1. Read the config loader\n2. Add the new field' })

    expect(result.terminate).toBe(true)
    const persisted = s.appended.at(-1)?.data as { todos: TodoItem[] }
    expect(persisted.todos.map((t) => t.step)).toEqual([1, 2])
  })
})

describe('/plan-todos command', () => {
  it('tells the user to create a plan first when there are no todos', async () => {
    const s = setup()
    await s.runCommand('plan-todos')
    expect(s.notices[0]).toContain('No todos')
  })

  it('lists each step with a completion mark', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. Read the config loader\n2. Add the new field' })
    await s.runCommand('plan-todos')
    expect(s.notices.at(-1)).toContain('1. ○ Config loader')
    expect(s.notices.at(-1)).toContain('2. ○ New field')
  })
})

describe('injected context', () => {
  it('injects the plan-mode brief while in plan mode', async () => {
    const s = setup()
    await s.runCommand('plan')
    const result = (await s.emit('before_agent_start')) as { message: SentMessage }
    expect(result.message.customType).toBe('plan-mode-context')
    expect(result.message.content).toContain('[PLAN MODE ACTIVE]')
    expect(result.message.display).toBe(false)
  })

  it('injects only the remaining steps while executing', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. Read the config loader\n2. Add the new field' })
    await s.emit('agent_end', { messages: [] })
    await s.emit('turn_end', { message: assistant('done with the first [DONE:1]') })

    const result = (await s.emit('before_agent_start')) as { message: SentMessage }
    expect(result.message.customType).toBe('plan-execution-context')
    expect(result.message.content).toContain('2. New field')
    expect(result.message.content).not.toContain('1. Config loader')
  })

  it('injects nothing when idle', async () => {
    const s = setup()
    expect(await s.emit('before_agent_start')).toBeUndefined()
  })
})

describe('stale plan context filtering', () => {
  const messages = [
    { role: 'user', customType: 'plan-mode-context', content: 'brief' },
    { role: 'user', content: 'x [PLAN MODE ACTIVE] y' },
    { role: 'user', content: [{ type: 'text', text: '[PLAN MODE ACTIVE]' }] },
    { role: 'user', content: 'a real question' },
    { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
  ]

  it('strips plan-mode scaffolding once plan mode is off', async () => {
    const s = setup()
    const result = (await s.emit('context', { messages })) as { messages: Array<{ content: unknown }> }
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].content).toBe('a real question')
  })

  it('leaves the context untouched while plan mode is on', async () => {
    const s = setup()
    await s.runCommand('plan')
    expect(await s.emit('context', { messages })).toBeUndefined()
  })

  it('strips stale execution scaffolding once execution is over', async () => {
    const s = setup()
    const withExecution = [
      { role: 'user', customType: 'plan-execution-context', content: '[EXECUTING PLAN]' },
      { role: 'user', content: 'a real question' },
    ]
    const result = (await s.emit('context', { messages: withExecution })) as { messages: Array<{ content: unknown }> }
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe('a real question')
  })

  it('keeps execution scaffolding while the plan is executing', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: 'Plan:\n1. Inspect the parser' })
    await s.emit('agent_end', { messages: [] })

    const withExecution = [
      { role: 'user', customType: 'plan-execution-context', content: '[EXECUTING PLAN]' },
      { role: 'user', content: 'q' },
    ]
    const result = (await s.emit('context', { messages: withExecution })) as { messages: unknown[] }
    expect(result.messages).toHaveLength(2)
  })
})

describe('execution progress tracking', () => {
  let s: ReturnType<typeof setup>

  beforeEach(async () => {
    s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. Read the config loader\n2. Add the new field' })
    await s.emit('agent_end', { messages: [] })
  })

  it('enters execution mode and asks the agent to start on step one', () => {
    const execute = s.sent.find((m) => m.customType === 'plan-mode-execute')
    expect(execute?.content).toBe('Execute the plan. Start with: Config loader')
    expect(s.getActiveTools()).toContain('write')
  })

  it('counts completed steps in the status line as [DONE:n] markers arrive', async () => {
    await s.emit('turn_end', { message: assistant('finished [DONE:1]') })
    expect(s.status.at(-1)).toContain('1/2')
  })

  it('renders the todo widget with the remaining step unticked', async () => {
    await s.emit('turn_end', { message: assistant('finished [DONE:1]') })
    expect(s.widgets.at(-1)).toEqual(['☑ Config loader', '☐ New field'])
  })

  it('ignores turn_end when the message is not from the assistant', async () => {
    await s.emit('turn_end', { message: { role: 'user', content: '[DONE:1]' } })
    expect(s.status.at(-1)).not.toContain('1/2')
  })

  it('announces completion and clears state once every step is done', async () => {
    await s.emit('turn_end', { message: assistant('[DONE:1] [DONE:2]') })
    await s.emit('agent_end', { messages: [] })

    expect(s.sent.at(-1)?.content).toContain('**Plan Complete!**')
    expect(s.widgets.at(-1)).toBeUndefined()
    expect(s.appended.at(-1)?.data as { todos: TodoItem[]; executing: boolean }).toMatchObject({ executing: false })
  })

  it('stays in execution mode while steps remain', async () => {
    await s.emit('turn_end', { message: assistant('[DONE:1]') })
    await s.emit('agent_end', { messages: [] })
    expect(s.sent.some((m) => m.content.includes('Plan Complete'))).toBe(false)
  })
})

describe('plan review prompt', () => {
  it('falls back to extracting a plan from the assistant prose', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader\n2. Add the new field')] })

    const list = s.sent.find((m) => m.customType === 'plan-todo-list')
    expect(list?.content).toContain('**Plan Steps (2):**')
    expect(s.sent.find((m) => m.customType === 'plan-mode-execute')).toBeDefined()
  })

  it('stays in plan mode when the user picks "Stay in plan mode"', async () => {
    const s = setup()
    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[1]
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    expect(s.sent.find((m) => m.customType === 'plan-mode-execute')).toBeUndefined()
    expect(s.getActiveTools()).not.toContain('write')
  })

  it('sends the refinement back as a user message', async () => {
    const s = setup()
    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[2]
    s.ctx.ui.editor = async () => '  focus on the parser  '
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    expect(s.userMessages).toEqual(['focus on the parser'])
  })

  it('sends the refinement bare while idle but queues it as a followUp while streaming', async () => {
    const s = setup()
    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[2]
    s.ctx.ui.editor = async () => 'focus on the parser'
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    s.ctx.isIdle = () => false
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    expect(s.userMessageOptions).toEqual([{}, { deliverAs: 'followUp' }])
  })

  it('re-extracts the plan from prose after a tool-submitted plan is refined', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: 'Plan:\n1. Old step one\n2. Old step two' })

    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[2]
    s.ctx.ui.editor = async () => 'take a different approach'
    await s.emit('agent_end', { messages: [] })

    // The refined turn answers in prose; its plan must replace the tool-submitted todos.
    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[0]
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. New step')] })

    const last = s.sent.filter((m) => m.customType === 'plan-todo-list').at(-1)
    expect(last?.content).toContain('New step')
    expect(last?.content).not.toContain('Old step')
  })

  it('ignores an empty refinement', async () => {
    const s = setup()
    s.ctx.ui.select = async (_q: string, choices: string[]) => choices[2]
    s.ctx.ui.editor = async () => '   '
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    expect(s.userMessages).toEqual([])
  })

  it('executes without step tracking when no plan could be extracted', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('I looked around but wrote no numbered plan.')] })

    expect(s.sent.find((m) => m.customType === 'plan-todo-list')).toBeUndefined()
    expect(s.sent.find((m) => m.customType === 'plan-mode-execute')?.content).toBe('Execute the plan you just created.')
  })

  it('does not prompt when there is no UI', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] }, { ...s.ctx, hasUI: false })
    expect(s.sent).toEqual([])
  })
})

describe('session restore', () => {
  /** `entries` is the current branch (pi getBranch); `all` is every entry in the file (getEntries). */
  const restoreCtx = (s: ReturnType<typeof setup>, entries: unknown[], all: unknown[] = entries) => ({ ...s.ctx, sessionManager: { getEntries: () => all, getBranch: () => entries } })

  it('enables plan mode from the --plan flag', async () => {
    const s = setup({ flag: true })
    await s.emit('session_start', {}, restoreCtx(s, []))
    expect(s.getActiveTools()).not.toContain('write')
    expect(s.status.at(-1)).toContain('plan')
  })

  it('restores persisted plan mode state', async () => {
    const s = setup()
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [], executing: false } }]
    await s.emit('session_start', {}, restoreCtx(s, entries))
    expect(s.getActiveTools()).not.toContain('write')
  })

  it('ignores a plan-mode entry that lives on an abandoned branch', async () => {
    // After a rewind past a plan the entry is still in the session file (getEntries lists
    // every branch) but not on the current path (getBranch); only the path is state.
    const s = setup()
    const stale = { type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [{ step: 1, text: 'Old', completed: false }], executing: true } }
    await s.emit('session_start', {}, restoreCtx(s, [], [stale]))
    expect(s.getActiveTools()).toContain('write')
    expect(s.widgets.at(-1)).toBeUndefined()
  })

  it('rebuilds completion state from [DONE:n] markers after the last execute marker', async () => {
    const s = setup()
    const todos: TodoItem[] = [
      { step: 1, text: 'Config loader', completed: false },
      { step: 2, text: 'New field', completed: false },
    ]
    const entries = [
      { type: 'message', customType: 'plan-mode-execute', message: assistant('start') },
      { type: 'message', message: assistant('did the first [DONE:1]') },
      { type: 'custom', customType: 'plan-mode', data: { enabled: false, todos, executing: true } },
    ]
    await s.emit('session_start', {}, restoreCtx(s, entries))
    expect(s.widgets.at(-1)).toEqual(['☑ Config loader', '☐ New field'])
  })

  it('ignores [DONE:n] markers from a previous plan run', async () => {
    const s = setup()
    const todos: TodoItem[] = [{ step: 1, text: 'Config loader', completed: false }]
    const entries = [
      { type: 'message', message: assistant('stale marker [DONE:1]') },
      { type: 'message', customType: 'plan-mode-execute', message: assistant('start') },
      { type: 'custom', customType: 'plan-mode', data: { enabled: false, todos, executing: true } },
    ]
    await s.emit('session_start', {}, restoreCtx(s, entries))
    expect(s.widgets.at(-1)).toEqual(['☐ Config loader'])
  })

  it('stays off after a plan is submitted and then plan mode is toggled off', async () => {
    // plan_mode_complete persists enabled:true; toggling off must persist the reversal
    // so a resume does not silently re-restrict tools.
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: 'Plan:\n1. Inspect the parser' })
    await s.runCommand('plan') // toggle off

    const entries = s.appended.filter((e) => e.type === 'plan-mode').map((e) => ({ type: 'custom', customType: 'plan-mode', data: e.data }))
    const s2 = setup()
    await s2.emit('session_start', {}, restoreCtx(s2, entries))
    expect(s2.getActiveTools()).toContain('write')
  })

  it('recovers edit and write when a reload restores plan mode over an already-restricted set', async () => {
    // The new extension instance has no snapshot of its own, and the set pi hands it
    // is the restriction plus every extension tool: nothing in it says edit and write
    // were ever active. Reading it as the snapshot lost them for the whole session.
    const s = setup()
    await s.runCommand('plan')
    const entries = s.appended.filter((e) => e.type === 'plan-mode').map((e) => ({ type: 'custom', customType: 'plan-mode', data: e.data }))

    const reloaded = setup({ activeTools: afterReload(s.getActiveTools()) })
    await reloaded.emit('session_start', { reason: 'reload' }, restoreCtx(reloaded, entries))
    await reloaded.runCommand('plan')

    expect(reloaded.getActiveTools()).toContain('edit')
    expect(reloaded.getActiveTools()).toContain('write')
  })

  it('restores exactly what was active before plan mode, not the whole registry', async () => {
    // A session that had narrowed itself must come back narrowed: the recovery is the
    // recorded set, not everything pi has configured.
    const s = setup({ activeTools: ['read', 'bash', 'edit', 'plan_mode_complete'] })
    await s.runCommand('plan')
    const entries = s.appended.filter((e) => e.type === 'plan-mode').map((e) => ({ type: 'custom', customType: 'plan-mode', data: e.data }))

    const reloaded = setup({ activeTools: afterReload(s.getActiveTools()) })
    await reloaded.emit('session_start', { reason: 'reload' }, restoreCtx(reloaded, entries))
    await reloaded.runCommand('plan')

    expect(reloaded.getActiveTools()).toEqual(['read', 'bash', 'edit', 'plan_mode_complete'])
  })

  it('records the snapshot for a --plan session, which never toggles', async () => {
    // The flag enters plan mode at session_start with no entry to restore from, so
    // without a write here a /reload has nothing but the restricted active set to
    // infer from, and the next persist cements that loss into the session file.
    const s = setup({ flag: true })
    await s.emit('session_start', {}, restoreCtx(s, []))
    const entries = s.appended.filter((e) => e.type === 'plan-mode').map((e) => ({ type: 'custom', customType: 'plan-mode', data: e.data }))

    const reloaded = setup({ flag: true, activeTools: afterReload(s.getActiveTools()) })
    await reloaded.emit('session_start', { reason: 'reload' }, restoreCtx(reloaded, entries))
    // A restore that already had a snapshot has nothing new to say; writing one per
    // restore would grow the session file for every reload.
    expect(reloaded.appended.filter((e) => e.type === 'plan-mode')).toEqual([])

    await reloaded.runCommand('plan')
    expect(reloaded.getActiveTools()).toContain('edit')
    expect(reloaded.getActiveTools()).toContain('write')
  })

  it('does not write a guessed snapshot over an entry that predates the field', async () => {
    // Upgrading pi-code mid-session then reloading: the entry says plan mode is on but
    // carries no snapshot, and the active set is already the restriction. Persisting
    // what it sees would cement the loss into the session file for every later resume.
    const s = setup({ activeTools: afterReload(['read', 'bash', 'plan_mode_complete']) })
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [], executing: false } }]

    await s.emit('session_start', { reason: 'reload' }, restoreCtx(s, entries))

    expect(s.appended.filter((e) => e.type === 'plan-mode')).toEqual([])
  })

  it('does not push a recorded snapshot over the live tool set when plan mode is off', async () => {
    // The snapshot is only meaningful for undoing a restriction. Applying it on a
    // restore that is not in plan mode would drop whatever pi registered since it was
    // taken, e.g. an MCP server's tools connecting into the rebuilt session.
    const s = setup()
    await s.runCommand('plan')
    await s.runCommand('plan')
    const entries = s.appended.filter((e) => e.type === 'plan-mode').map((e) => ({ type: 'custom', customType: 'plan-mode', data: e.data }))

    const reloaded = setup({ activeTools: [...ALL_TOOLS, 'mcp_sonar_search'] })
    await reloaded.emit('session_start', { reason: 'reload' }, restoreCtx(reloaded, entries))

    expect(reloaded.getActiveTools()).toContain('mcp_sonar_search')
  })

  it('falls back to the active set when the entry predates the recorded snapshot', async () => {
    // Sessions written before savedTools was persisted must still restore something.
    const s = setup()
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [], executing: false } }]
    await s.emit('session_start', {}, restoreCtx(s, entries))

    expect(s.getActiveTools()).not.toContain('write')
    await s.runCommand('plan')
    expect(s.getActiveTools()).toContain('write')
  })

  // The session file is data on disk: a hand-edit, a truncated write or an entry from a
  // different tool can put any JSON in these fields. A field that is not the shape the
  // restore expects must be ignored, never fed into the tool gating.
  it('ignores a persisted savedTools that is not an array of strings', async () => {
    const s = setup()
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: true, todos: [], executing: false, savedTools: 'read' } }]

    await s.emit('session_start', {}, restoreCtx(s, entries))

    // Falling back to the live active set, leaving plan mode after this restores it.
    await s.runCommand('plan')
    expect(s.getActiveTools()).toContain('write')
    expect(s.getActiveTools()).toContain('edit')
  })

  it('ignores a persisted enabled flag that is not a boolean', async () => {
    const s = setup()
    // "false" is a truthy string: read as-is it would silently enter plan mode.
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: 'false', todos: [], executing: false } }]

    await s.emit('session_start', {}, restoreCtx(s, entries))

    expect(s.getActiveTools()).toContain('write')
  })

  it('ignores a persisted executing flag that is not a boolean', async () => {
    const s = setup()
    // "no" is a truthy string: read as-is it would resume into execution mode.
    const todos = [{ step: 1, text: 'Inspect the parser', completed: false }]
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: false, todos, executing: 'no' } }]

    await s.emit('session_start', {}, restoreCtx(s, entries))
    const injected = (await s.emit('before_agent_start')) as { message?: { content: string } } | undefined

    expect(injected?.message?.content ?? '').not.toContain('EXECUTING PLAN')
  })

  it('ignores persisted todos that are not an array', async () => {
    const s = setup()
    const entries = [{ type: 'custom', customType: 'plan-mode', data: { enabled: false, todos: 'step one', executing: true } }]

    await s.emit('session_start', {}, restoreCtx(s, entries))
    const injected = (await s.emit('before_agent_start')) as { message?: { content: string } } | undefined

    expect(injected?.message?.content ?? '').not.toContain('EXECUTING PLAN')
  })

  it('does not carry plan state into a fresh session with no plan entry', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: 'Plan:\n1. Inspect the parser' })
    // A brand-new session (empty entries) reuses the same extension instance.
    await s.emit('session_start', {}, restoreCtx(s, []))

    expect(s.getActiveTools()).toContain('write')
    const injected = (await s.emit('before_agent_start')) as { message?: { content: string } } | undefined
    expect(injected?.message?.content ?? '').not.toContain('EXECUTING PLAN')
  })
})

describe('plan mode call-time enforcement', () => {
  it('blocks a tool outside the plan set, since pi auto-activates late registrations', async () => {
    // An MCP server connecting during session_start registers its tools after
    // enterPlanTools ran, and pi's refreshTools adds them to the active set.
    const s = setup()
    await s.runCommand('plan')
    const result = (await s.emit('tool_call', { toolName: 'filesystem_write_file', input: {} })) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('filesystem_write_file')
  })

  it('leaves tools outside the plan set alone when plan mode is off', async () => {
    const s = setup()
    expect(await s.emit('tool_call', { toolName: 'filesystem_write_file', input: {} })).toBeUndefined()
  })
})

/** The execution-context text a before_agent_start injection carries, or undefined when
 * the handler injected nothing (execution has ended). */
const executionContext = (result: unknown): string | undefined => (result as { message?: { customType?: string; content?: string } } | undefined)?.message?.content

describe('execution mode stall exit', () => {
  it('ends execution after two runs without step progress, listing what is left', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. First step\n2. Second step' })
    await s.emit('agent_end', { messages: [] })

    await s.emit('turn_end', { message: assistant('finished [DONE:1]') })
    await s.emit('agent_end', { messages: [] })
    // The injection is what keeps execution going, so assert what it says: the step just
    // marked done is gone from it and the remaining one is named.
    expect(executionContext(await s.emit('before_agent_start'))).toContain('2. Second step')
    expect(executionContext(await s.emit('before_agent_start'))).not.toContain('1. First step')

    await s.emit('turn_end', { message: assistant('did more work, forgot the marker') })
    await s.emit('agent_end', { messages: [] })
    expect(executionContext(await s.emit('before_agent_start'))).toContain('2. Second step')

    await s.emit('turn_end', { message: assistant('answered an unrelated question') })
    await s.emit('agent_end', { messages: [] })

    expect(await s.emit('before_agent_start')).toBeUndefined()
    const notice = s.sent.at(-1)
    expect(notice?.content).toContain('2. Second step')
    // The notice, not just the injection, filters out the step already marked done.
    expect(notice?.content).not.toContain('1. First step')
  })

  it('keeps executing while every run makes progress', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. First step\n2. Second step\n3. Third step' })
    await s.emit('agent_end', { messages: [] })

    await s.emit('turn_end', { message: assistant('[DONE:1]') })
    await s.emit('agent_end', { messages: [] })
    await s.emit('turn_end', { message: assistant('[DONE:2]') })
    await s.emit('agent_end', { messages: [] })

    expect(await s.emit('before_agent_start')).toBeDefined()
  })
})

describe('record-only sends (0.84.2 triggerTurn:false semantics)', () => {
  // pi 0.84.2 (#8022) made sendMessage(..., { triggerTurn: false }) purely record-only:
  // it no longer steers an active run, only appends a display message. plan mode has two
  // such sites (the plan-todo-list review message and the plan-complete/stall summary);
  // both intend record-only, and no surrounding logic depends on the old steer side effect.
  it('records the plan-todo-list review message without triggering a turn', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader\n2. Add the new field')] })

    expect(s.sent.find((m) => m.customType === 'plan-todo-list')).toBeDefined()
    expect(s.optionsFor('plan-todo-list')).toEqual({ triggerTurn: false })
  })

  it('records the plan-complete summary without triggering a turn', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.callTool('plan_mode_complete', { plan: '1. First step\n2. Second step' })
    await s.emit('agent_end', { messages: [] }) // default choice executes the plan
    await s.emit('turn_end', { message: assistant('[DONE:1] [DONE:2]') })
    await s.emit('agent_end', { messages: [] }) // every step done -> endExecution sends plan-complete

    expect(s.sent.find((m) => m.customType === 'plan-complete')).toBeDefined()
    expect(s.optionsFor('plan-complete')).toEqual({ triggerTurn: false })
  })

  it('still drives a turn for the execute message (triggerTurn:true), unlike the record-only sends', async () => {
    const s = setup()
    await s.runCommand('plan')
    await s.emit('agent_end', { messages: [assistant('Plan:\n1. Read the config loader')] })

    // The one send that must still steer a run is plan-mode-execute; the record-only sites
    // are deliberately triggerTurn:false alongside it.
    expect(s.optionsFor('plan-mode-execute')).toEqual({ triggerTurn: true })
  })
})
