import * as os from 'node:os'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { type Component, type Container, Markdown } from '@earendil-works/pi-tui'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import subagentExtension, { formatTokens, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput, mapWithConcurrencyLimit } from '../extensions/subagent/index.ts'

const discoverAgentsMock = vi.hoisted(() => vi.fn())
const startBackgroundRunMock = vi.hoisted(() => vi.fn(() => 'bg-1'))

vi.mock('../extensions/subagent/agents.js', () => ({ discoverAgents: discoverAgentsMock }))
vi.mock('../extensions/subagent/background.js', () => ({
  backgroundStatusText: () => 'BACKGROUND-STATUS',
  startBackgroundRun: startBackgroundRunMock,
}))

/** Identity theme: renderers concatenate the returned strings verbatim, so output is plain text. */
const theme = { fg: (_role: string, s: string) => s, bold: (s: string) => s } as unknown as Theme

type Rendered = Component & { render: (width: number) => string[] }
/** Wide enough that Text never word-wraps; render pads each line to the width, so strip that padding. */
const str = (c: Component): string =>
  (c as Rendered)
    .render(200)
    .map((line) => line.trimEnd())
    .join('\n')
/**
 * Visible content of a container in order. Markdown stands in as a marker because
 * it cannot render without an initialized theme. Asserting content rather than the
 * child class sequence keeps these tests from breaking on spacing-only changes.
 */
const visibleLines = (c: Container): string[] => c.children.flatMap((child) => (child instanceof Markdown ? ['<output>'] : str(child).split('\n'))).filter((line) => line !== '')

type ToolShape = {
  name: string
  execute: (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<AgentToolResult<unknown>>
  renderCall: (args: Record<string, unknown>, theme: Theme, context?: unknown) => Component
  renderResult: (result: unknown, opts: { expanded: boolean }, theme: Theme, context?: unknown) => Component
}

const getTool = (): ToolShape => {
  let tool: ToolShape | undefined
  subagentExtension({
    registerTool: (t: ToolShape) => {
      if (t.name === 'subagent') tool = t
    },
  } as never)
  if (!tool) throw new Error('subagent tool was not registered')
  return tool
}

const assistant = (...content: unknown[]): Message => ({ role: 'assistant', content }) as unknown as Message
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] }) as unknown as Message
const textPart = (text: string) => ({ type: 'text', text })
const toolCallPart = (name: string, args: Record<string, unknown>) => ({ type: 'toolCall', name, arguments: args })

const noUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }

type ResultStub = {
  agent: string
  agentSource: 'user' | 'project' | 'unknown'
  task: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: typeof noUsage
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
}

const makeResult = (over: Partial<ResultStub> & { agent: string }): ResultStub => ({
  agentSource: 'user',
  task: 'task',
  exitCode: 0,
  messages: [],
  stderr: '',
  usage: { ...noUsage },
  ...over,
})

const toolResult = (mode: 'single' | 'parallel' | 'chain', results: ResultStub[], text = 'fallback text') => ({
  content: [{ type: 'text', text }],
  details: { mode, agentScope: 'user', projectAgentsDir: null, results },
})

describe('formatTokens', () => {
  // Spec: <1000 raw, <10000 one decimal k, <1000000 rounded k, else one decimal M.
  it('renders sub-thousand counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('switches to one-decimal thousands at 1000', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(9999)).toBe('10.0k')
  })

  it('switches to rounded thousands at 10000', () => {
    expect(formatTokens(10000)).toBe('10k')
    expect(formatTokens(999999)).toBe('1000k')
  })

  it('switches to one-decimal millions at 1000000', () => {
    expect(formatTokens(1000000)).toBe('1.0M')
    expect(formatTokens(2500000)).toBe('2.5M')
  })
})

describe('formatUsageStats', () => {
  it('returns an empty string when every field is zero and no model is given', () => {
    expect(formatUsageStats({ ...noUsage })).toBe('')
  })

  it('omits zero-valued fields entirely', () => {
    expect(formatUsageStats({ ...noUsage, output: 5 })).toBe('↓5')
    expect(formatUsageStats({ ...noUsage, cost: 0, cacheRead: 2000 })).toBe('R2.0k')
  })

  it('appends the model even when all counters are zero', () => {
    expect(formatUsageStats({ ...noUsage }, 'sonnet')).toBe('sonnet')
  })

  it('singularizes a one-turn run and pluralizes beyond that', () => {
    expect(formatUsageStats({ ...noUsage, turns: 1 })).toBe('1 turn')
    expect(formatUsageStats({ ...noUsage, turns: 2 })).toBe('2 turns')
  })

  it('orders the parts turns, input, output, cacheRead, cacheWrite, cost, context, model', () => {
    const usage = { input: 1500, output: 200, cacheRead: 3000, cacheWrite: 4000, cost: 0.5, contextTokens: 50000, turns: 3 }
    expect(formatUsageStats(usage, 'sonnet')).toBe('3 turns ↑1.5k ↓200 R3.0k W4.0k $0.5000 ctx:50k sonnet')
  })
})

describe('getFinalOutput', () => {
  it('returns the first text part of the last assistant message', () => {
    const messages = [assistant(textPart('early')), user('ignored'), assistant(toolCallPart('bash', {}), textPart('first'), textPart('second'))]
    expect(getFinalOutput(messages)).toBe('first')
  })

  it('falls back to an earlier assistant message when the last one has no text part', () => {
    const messages = [assistant(textPart('early')), assistant(toolCallPart('bash', {}))]
    expect(getFinalOutput(messages)).toBe('early')
  })

  it('returns an empty string when there is no assistant message', () => {
    expect(getFinalOutput([user('hi')])).toBe('')
    expect(getFinalOutput([])).toBe('')
  })
})

describe('getDisplayItems', () => {
  it('collects assistant text and tool calls in forward order', () => {
    const messages = [assistant(textPart('one')), assistant(toolCallPart('read', { file_path: '/a' }), textPart('two'))]
    expect(getDisplayItems(messages)).toEqual([
      { type: 'text', text: 'one' },
      { type: 'toolCall', name: 'read', args: { file_path: '/a' } },
      { type: 'text', text: 'two' },
    ])
  })

  it('drops non-assistant messages and thinking/toolResult parts', () => {
    const messages = [user('question'), assistant({ type: 'thinking', thinking: 'hmm' }, { type: 'toolResult', output: 'x' }, textPart('kept'))]
    expect(getDisplayItems(messages)).toEqual([{ type: 'text', text: 'kept' }])
  })
})

describe('mapWithConcurrencyLimit', () => {
  /** Runs fn over items while recording peak in-flight count; each item resolves after `delays[i]` ms. */
  const instrument = (delays: number[]) => {
    let active = 0
    let peak = 0
    const fn = vi.fn(async (item: number, index: number) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delays[index]))
      active--
      return item * 10
    })
    return { fn, peak: () => peak }
  }

  it('never calls fn for an empty input', async () => {
    const fn = vi.fn(async (n: number) => n)
    expect(await mapWithConcurrencyLimit([], 4, fn)).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps result order aligned with input order when completion order is reversed', async () => {
    // Invariant: results[i] is always fn(items[i]), independent of who finishes first.
    const completions: number[] = []
    const results = await mapWithConcurrencyLimit([1, 2, 3, 4], 4, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, (4 - index) * 10))
      completions.push(item)
      return `r${item}`
    })
    expect(results).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(completions).toEqual([4, 3, 2, 1])
  })

  it('never runs more items at once than the concurrency limit', async () => {
    const { fn, peak } = instrument([30, 10, 20, 5, 15])
    const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, fn)
    expect(results).toEqual([10, 20, 30, 40, 50])
    expect(peak()).toBe(2)
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('caps the worker count at the number of items when concurrency exceeds it', async () => {
    const { fn, peak } = instrument([20, 20, 20])
    expect(await mapWithConcurrencyLimit([1, 2, 3], 10, fn)).toEqual([10, 20, 30])
    expect(peak()).toBe(3)
  })

  it('clamps a non-positive concurrency to a single worker', async () => {
    const zero = instrument([20, 10, 5])
    expect(await mapWithConcurrencyLimit([1, 2, 3], 0, zero.fn)).toEqual([10, 20, 30])
    expect(zero.peak()).toBe(1)

    const negative = instrument([20, 10, 5])
    expect(await mapWithConcurrencyLimit([1, 2, 3], -5, negative.fn)).toEqual([10, 20, 30])
    expect(negative.peak()).toBe(1)
  })

  it('propagates the rejection reason from fn', async () => {
    await expect(mapWithConcurrencyLimit([1], 1, async () => Promise.reject(new Error('worker blew up')))).rejects.toThrow('worker blew up')
  })
})

describe('formatToolCall', () => {
  const fg = ((_role: string, s: string) => s) as Theme['fg']
  const home = os.homedir()

  it('prefixes a bash command with a shell marker', () => {
    expect(formatToolCall('bash', { command: 'ls -la' }, fg)).toBe('$ ls -la')
  })

  it('truncates a bash command past 60 characters', () => {
    const command = 'x'.repeat(70)
    expect(formatToolCall('bash', { command }, fg)).toBe(`$ ${'x'.repeat(60)}...`)
    expect(formatToolCall('bash', { command: 'y'.repeat(60) }, fg)).toBe(`$ ${'y'.repeat(60)}`)
  })

  it('falls back to an ellipsis for a bash call with no command', () => {
    expect(formatToolCall('bash', {}, fg)).toBe('$ ...')
  })

  it('abbreviates the home directory prefix in paths', () => {
    expect(formatToolCall('read', { file_path: `${home}/src/a.ts` }, fg)).toBe('read ~/src/a.ts')
    expect(formatToolCall('read', { file_path: '/etc/hosts' }, fg)).toBe('read /etc/hosts')
  })

  it('appends a line range to read only when offset or limit is present', () => {
    expect(formatToolCall('read', { path: '/a.ts' }, fg)).toBe('read /a.ts')
    expect(formatToolCall('read', { path: '/a.ts', offset: 5 }, fg)).toBe('read /a.ts:5')
    expect(formatToolCall('read', { path: '/a.ts', offset: 5, limit: 10 }, fg)).toBe('read /a.ts:5-14')
    expect(formatToolCall('read', { path: '/a.ts', limit: 10 }, fg)).toBe('read /a.ts:1-10')
  })

  it('adds a line count to write only for multi-line content', () => {
    expect(formatToolCall('write', { file_path: '/a.ts', content: 'one line' }, fg)).toBe('write /a.ts')
    expect(formatToolCall('write', { file_path: '/a.ts', content: 'a\nb\nc' }, fg)).toBe('write /a.ts (3 lines)')
    expect(formatToolCall('write', {}, fg)).toBe('write ...')
  })

  it('renders edit, ls, find and grep with their path defaults', () => {
    expect(formatToolCall('edit', { file_path: `${home}/a.ts` }, fg)).toBe('edit ~/a.ts')
    expect(formatToolCall('ls', {}, fg)).toBe('ls .')
    expect(formatToolCall('find', {}, fg)).toBe('find * in .')
    expect(formatToolCall('find', { pattern: '*.ts', path: '/src' }, fg)).toBe('find *.ts in /src')
    expect(formatToolCall('grep', { pattern: 'todo', path: '/src' }, fg)).toBe('grep /todo/ in /src')
    expect(formatToolCall('grep', {}, fg)).toBe('grep // in .')
  })

  it('falls back to the tool name plus a 50-character JSON preview', () => {
    expect(formatToolCall('mystery', { a: 1 }, fg)).toBe('mystery {"a":1}')
    const long = { key: 'z'.repeat(80) }
    const json = JSON.stringify(long)
    expect(formatToolCall('mystery', long, fg)).toBe(`mystery ${json.slice(0, 50)}...`)
  })
})

describe('renderCall', () => {
  const renderCall = getTool().renderCall

  it('renders chain mode with a numbered step list', () => {
    const args = {
      chain: [
        { agent: 'scout', task: 'find the bug' },
        { agent: 'fixer', task: 'fix it' },
      ],
    }
    expect(str(renderCall(args, theme))).toBe(['subagent chain (2 steps) [user]', '  1. scout find the bug', '  2. fixer fix it'].join('\n'))
  })

  it('strips the {previous} placeholder from the chain preview', () => {
    const args = { chain: [{ agent: 'fixer', task: '{previous} then summarize' }] }
    expect(str(renderCall(args, theme))).toBe(['subagent chain (1 steps) [user]', '  1. fixer then summarize'].join('\n'))
  })

  it('truncates chain step previews past 40 characters', () => {
    const task = 'a'.repeat(45)
    const args = { chain: [{ agent: 'scout', task }] }
    expect(str(renderCall(args, theme))).toBe(['subagent chain (1 steps) [user]', `  1. scout ${'a'.repeat(40)}...`].join('\n'))
  })

  it('shows only the first three chain steps and counts the rest', () => {
    const chain = ['a', 'b', 'c', 'd', 'e'].map((agent) => ({ agent, task: 't' }))
    expect(str(renderCall({ chain }, theme))).toBe(['subagent chain (5 steps) [user]', '  1. a t', '  2. b t', '  3. c t', '  ... +2 more'].join('\n'))
  })

  it('renders parallel mode with an unnumbered task list and the requested scope', () => {
    const args = {
      agentScope: 'both',
      tasks: [
        { agent: 'scout', task: 'look' },
        { agent: 'fixer', task: 'patch' },
      ],
    }
    expect(str(renderCall(args, theme))).toBe(['subagent parallel (2 tasks) [both]', '  scout look', '  fixer patch'].join('\n'))
  })

  it('shows only the first three parallel tasks and counts the rest', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((agent) => ({ agent, task: 't' }))
    expect(str(renderCall({ tasks }, theme))).toBe(['subagent parallel (4 tasks) [user]', '  a t', '  b t', '  c t', '  ... +1 more'].join('\n'))
  })

  it('truncates parallel task previews past 40 characters', () => {
    const task = 'b'.repeat(41)
    expect(str(renderCall({ tasks: [{ agent: 'scout', task }] }, theme))).toBe(['subagent parallel (1 tasks) [user]', `  scout ${'b'.repeat(40)}...`].join('\n'))
  })

  it('renders single mode with the agent name and task on the second line', () => {
    expect(str(renderCall({ agent: 'scout', task: 'find it' }, theme))).toBe(['subagent scout [user]', '  find it'].join('\n'))
  })

  it('truncates a single-mode task past 60 characters', () => {
    const task = 'c'.repeat(61)
    expect(str(renderCall({ agent: 'scout', task }, theme))).toBe(['subagent scout [user]', `  ${'c'.repeat(60)}...`].join('\n'))
  })

  it('falls back to ellipses when the agent or task is missing', () => {
    expect(str(renderCall({}, theme))).toBe(['subagent ... [user]', '  ...'].join('\n'))
  })
})

describe('renderResult fallbacks', () => {
  const renderResult = getTool().renderResult

  it('shows the content text when details are missing', () => {
    const result = { content: [{ type: 'text', text: 'plain summary' }] }
    expect(str(renderResult(result, { expanded: false }, theme))).toBe('plain summary')
  })

  it('shows the content text when the results array is empty', () => {
    expect(str(renderResult(toolResult('single', [], 'nothing ran'), { expanded: true }, theme))).toBe('nothing ran')
  })

  it('reports no output when the content is not text', () => {
    const result = { content: [{ type: 'image', data: 'x' }] }
    expect(str(renderResult(result, { expanded: false }, theme))).toBe('(no output)')
  })

  it('falls through to the content text for a single mode carrying several results', () => {
    const results = [makeResult({ agent: 'a' }), makeResult({ agent: 'b' })]
    expect(str(renderResult(toolResult('single', results, 'aggregate'), { expanded: false }, theme))).toBe('aggregate')
  })
})

describe('renderResult single mode', () => {
  const renderResult = getTool().renderResult

  it('builds an expanded container with task, tool calls and a markdown final output', () => {
    const r = makeResult({
      agent: 'scout',
      task: 'do it',
      messages: [assistant(toolCallPart('bash', { command: 'ls' }), textPart('result text'))],
    })
    const container = renderResult(toolResult('single', [r]), { expanded: true }, theme) as Container

    expect(visibleLines(container)).toEqual(['✓ scout (user)', '─── Task ───', 'do it', '─── Output ───', '→ $ ls', '<output>'])
  })

  it('marks an expanded failure with the stop reason and error message', () => {
    const r = makeResult({ agent: 'scout', agentSource: 'project', task: 't', exitCode: 1, stopReason: 'error', errorMessage: 'boom' })
    const container = renderResult(toolResult('single', [r]), { expanded: true }, theme) as Container

    expect(visibleLines(container)).toEqual(['✗ scout (project) [error]', 'Error: boom', '─── Task ───', 't', '─── Output ───', '(no output)'])
  })

  it('treats an aborted stop reason as a failure even with exit code 0', () => {
    const r = makeResult({ agent: 'scout', stopReason: 'aborted' })
    expect(str(renderResult(toolResult('single', [r]), { expanded: false }, theme))).toBe('✗ scout (user) [aborted]\n(no output)')
  })

  it('appends usage stats to the expanded container when any counter is non-zero', () => {
    const r = makeResult({ agent: 'scout', usage: { ...noUsage, turns: 2, input: 1500 }, model: 'sonnet' })
    const container = renderResult(toolResult('single', [r]), { expanded: true }, theme) as Container

    expect(visibleLines(container).at(-1)).toBe('2 turns ↑1.5k sonnet')
  })

  it('clips each text item to three lines when collapsed', () => {
    const r = makeResult({ agent: 'scout', messages: [assistant(textPart('one\ntwo\nthree\nfour'))], usage: { ...noUsage, turns: 2, input: 1500 }, model: 'sonnet' })
    expect(str(renderResult(toolResult('single', [r]), { expanded: false }, theme))).toBe(['✓ scout (user)', 'one', 'two', 'three', '2 turns ↑1.5k sonnet'].join('\n'))
  })

  it('keeps the last ten items when collapsed and counts the earlier ones', () => {
    const messages = Array.from({ length: 12 }, (_, i) => assistant(textPart(`i${i}`)))
    const r = makeResult({ agent: 'scout', messages })
    const kept = Array.from({ length: 10 }, (_, i) => `i${i + 2}`)
    expect(str(renderResult(toolResult('single', [r]), { expanded: false }, theme))).toBe(['✓ scout (user)', '... 2 earlier items', ...kept, '(Ctrl+O to expand)'].join('\n'))
  })

  it('omits the expand hint when the collapsed item count is not exceeded', () => {
    const messages = Array.from({ length: 10 }, (_, i) => assistant(textPart(`i${i}`)))
    const r = makeResult({ agent: 'scout', messages })
    const kept = Array.from({ length: 10 }, (_, i) => `i${i}`)
    expect(str(renderResult(toolResult('single', [r]), { expanded: false }, theme))).toBe(['✓ scout (user)', ...kept].join('\n'))
  })

  it('prefers the error message over the item list when collapsed', () => {
    const r = makeResult({ agent: 'scout', exitCode: 2, errorMessage: 'boom', messages: [assistant(textPart('ignored'))] })
    expect(str(renderResult(toolResult('single', [r]), { expanded: false }, theme))).toBe('✗ scout (user)\nError: boom')
  })
})

describe('renderResult chain mode', () => {
  const renderResult = getTool().renderResult

  const steps = [makeResult({ agent: 'alpha', task: 'first task', step: 1, messages: [assistant(toolCallPart('bash', { command: 'ls' }), textPart('out1'))], usage: { ...noUsage, turns: 1, input: 500 } }), makeResult({ agent: 'beta', task: 'second task', step: 2 })]

  it('summarizes the successful step count when collapsed', () => {
    expect(str(renderResult(toolResult('chain', steps), { expanded: false }, theme))).toBe(['✓ chain 2/2 steps', '', '─── Step 1: alpha ✓', '→ $ ls', 'out1', '', '─── Step 2: beta ✓', '(no output)', '', 'Total: 1 turn ↑500', '(Ctrl+O to expand)'].join('\n'))
  })

  it('marks the chain as failed when any step has a non-zero exit code', () => {
    const failed = [steps[0], makeResult({ agent: 'beta', step: 2, exitCode: 1 })]
    expect(str(renderResult(toolResult('chain', failed), { expanded: false }, theme)).split('\n')[0]).toBe('✗ chain 1/2 steps')
  })

  it('keeps only the last five items per step when collapsed', () => {
    const messages = Array.from({ length: 7 }, (_, i) => assistant(textPart(`i${i}`)))
    const long = [makeResult({ agent: 'alpha', step: 1, messages })]
    expect(str(renderResult(toolResult('chain', long), { expanded: false }, theme))).toBe(['✓ chain 1/1 steps', '', '─── Step 1: alpha ✓', '... 2 earlier items', 'i2', 'i3', 'i4', 'i5', 'i6', '(Ctrl+O to expand)'].join('\n'))
  })

  it('builds an expanded container with a per-step block and an aggregate total', () => {
    const container = renderResult(toolResult('chain', steps), { expanded: true }, theme) as Container

    expect(visibleLines(container)).toEqual(['✓ chain 2/2 steps', '─── Step 1: alpha ✓', 'Task: first task', '→ $ ls', '<output>', '1 turn ↑500', '─── Step 2: beta ✓', 'Task: second task', 'Total: 1 turn ↑500'])
  })
})

describe('renderResult parallel mode', () => {
  const renderResult = getTool().renderResult

  it('renders a running indicator for tasks whose exit code is -1', () => {
    const results = [makeResult({ agent: 'a', exitCode: -1 }), makeResult({ agent: 'b', messages: [assistant(textPart('done'))] }), makeResult({ agent: 'c', exitCode: 1 })]
    // Still running, so the expanded flag is ignored and the compact view is used.
    expect(str(renderResult(toolResult('parallel', results), { expanded: true }, theme))).toBe(['⏳ parallel 2/3 done, 1 running', '', '─── a ⏳', '(running...)', '', '─── b ✓', 'done', '', '─── c ✗', '(no output)'].join('\n'))
  })

  it('appends the expand hint and a total once nothing is running', () => {
    const results = [makeResult({ agent: 'a', usage: { ...noUsage, turns: 1, input: 500 } }), makeResult({ agent: 'b', exitCode: 2 })]
    expect(str(renderResult(toolResult('parallel', results), { expanded: false }, theme))).toBe(['◐ parallel 1/2 tasks', '', '─── a ✓', '(no output)', '', '─── b ✗', '(no output)', '', 'Total: 1 turn ↑500', '(Ctrl+O to expand)'].join('\n'))
  })

  it('uses the success icon when every task exited cleanly', () => {
    const results = [makeResult({ agent: 'a' }), makeResult({ agent: 'b' })]
    expect(str(renderResult(toolResult('parallel', results), { expanded: false }, theme)).split('\n')[0]).toBe('✓ parallel 2/2 tasks')
  })

  it('builds an expanded container per task with an aggregate total', () => {
    const results = [makeResult({ agent: 'a', task: 'T', messages: [assistant(toolCallPart('bash', { command: 'ls' }), textPart('hello'))], usage: { ...noUsage, turns: 1, input: 100 } })]
    const container = renderResult(toolResult('parallel', results), { expanded: true }, theme) as Container

    expect(visibleLines(container)).toEqual(['✓ parallel 1/1 tasks', '─── a ✓', 'Task: T', '→ $ ls', '<output>', '1 turn ↑100', 'Total: 1 turn ↑100'])
  })
})

describe('subagent execute guards', () => {
  const ctx = { cwd: '/repo', hasUI: false, isProjectTrusted: () => true, ui: { confirm: async () => true } }
  let execute: ToolShape['execute']

  beforeEach(() => {
    discoverAgentsMock.mockReturnValue({
      agents: [{ name: 'scout', description: 'd', systemPrompt: '', source: 'user', filePath: '/a.md' }],
      projectAgentsDir: null,
    })
    startBackgroundRunMock.mockClear()
    execute = getTool().execute
  })

  it('short-circuits to the background status listing when status is set', async () => {
    const result = await execute('c1', { status: true }, undefined, undefined, ctx)
    expect(result.content).toEqual([{ type: 'text', text: 'BACKGROUND-STATUS' }])
    expect(result.details).toMatchObject({ mode: 'single', results: [] })
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('rejects a call with no mode and lists the available agents', async () => {
    const result = await execute('c1', {}, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Invalid parameters. Provide exactly one mode.\nAvailable agents: scout (user)' })
  })

  it('rejects a call combining two modes', async () => {
    const params = { agent: 'scout', task: 't', tasks: [{ agent: 'scout', task: 'u' }] }
    const result = await execute('c1', params, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Invalid parameters. Provide exactly one mode.\nAvailable agents: scout (user)' })
  })

  it('reports none when no agents were discovered', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [], projectAgentsDir: null })
    const result = await execute('c1', {}, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Invalid parameters. Provide exactly one mode.\nAvailable agents: none' })
  })

  it('refuses more than eight parallel tasks before spawning anything', async () => {
    const tasks = Array.from({ length: 9 }, () => ({ agent: 'scout', task: 't' }))
    const result = await execute('c1', { tasks }, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Too many parallel tasks (9). Max is 8.' })
    expect(result.details).toMatchObject({ mode: 'parallel', results: [] })
  })

  it('rejects background mode without a single-mode agent and task', async () => {
    const result = await execute('c1', { background: true, tasks: [{ agent: 'scout', task: 't' }] }, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'background: true requires single mode (agent + task).' })
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('rejects a background run for an unknown agent', async () => {
    const result = await execute('c1', { background: true, agent: 'ghost', task: 't' }, undefined, undefined, ctx)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Unknown agent: "ghost". Available agents: "scout".' })
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('refuses untrusted project agents in headless mode', async () => {
    discoverAgentsMock.mockReturnValue({
      agents: [{ name: 'repo', description: 'd', systemPrompt: '', source: 'project', filePath: '/p.md' }],
      projectAgentsDir: '/repo/.pi/agents',
    })
    const headless = { ...ctx, isProjectTrusted: () => false }
    const result = await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, headless)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Project-local agents (repo) require a trusted project; refusing in non-interactive mode.' })
  })

  it('cancels when the user declines the project agent confirmation', async () => {
    discoverAgentsMock.mockReturnValue({
      agents: [{ name: 'repo', description: 'd', systemPrompt: '', source: 'project', filePath: '/p.md' }],
      projectAgentsDir: '/repo/.pi/agents',
    })
    const interactive = { ...ctx, hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => false } }
    const result = await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, interactive)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Canceled: project-local agents not approved.' })
  })
})
