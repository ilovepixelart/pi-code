import * as fs from 'node:fs'
import * as os from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import backgroundBashExtension from '../extensions/background-bash.ts'
import { allShells, registerShell, resetShells, shellsStatusText } from '../extensions/internal/background-shells.ts'
import monitorExtension, { type Batch, batchText, createLineBatcher, DEFAULT_DEADLINE_MS, deadlineMs, MAX_DEADLINE_MS, monitorAllowed } from '../extensions/monitor.ts'

type ToolResult = { content: Array<{ type: string; text: string }> }
type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>
type Handler = (event: Record<string, unknown>, ctx: unknown) => void
type Sent = { message: { customType: string; content: string; display: boolean }; options: { triggerTurn?: boolean } }

/** Both extensions on one stubbed pi, as the pack loads them: task_stop is the bash
 * extension's, and the registry it stops through is shared. */
const setup = (options: { hasUI?: boolean; prompted?: boolean; cwd?: string } = {}) => {
  const tools = new Map<string, { name: string; execute: Execute; description: string }>()
  const handlers = new Map<string, Handler[]>()
  const sent: Sent[] = []
  const pi = {
    registerTool: (tool: { name: string; execute: Execute; description: string }) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent['message'], opts: Sent['options']) => sent.push({ message, options: opts }),
  }
  monitorExtension(pi as never)
  backgroundBashExtension(pi as never)
  const statuses = new Map<string, string | undefined>()
  const ctx = {
    cwd: options.cwd ?? os.tmpdir(),
    ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value), theme: { fg: (_color: string, value: string) => value } },
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => (options.prompted === false ? [] : [{ type: 'message' }]) },
  }
  const emit = (event: string, payload: Record<string, unknown> = {}): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx)
  }
  emit('session_start')
  const get = (name: string) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`${name} was not registered`)
    return tool
  }
  return {
    monitor: (params: Record<string, unknown>) => get('monitor').execute('call-1', params, undefined, undefined, ctx),
    stop: (task_id: string) => get('task_stop').execute('call-2', { task_id }, undefined, undefined, ctx),
    tool: get,
    sent,
    emit,
    footer: () => statuses.get('background-shells'),
  }
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.text).join('')
const idOf = (result: ToolResult): string => {
  const match = /ID: (m[0-9a-f]{8})/.exec(textOf(result))
  if (!match?.[1]) throw new Error(`no monitor id in: ${textOf(result)}`)
  return match[1]
}
const until = async (condition: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const shell = (id: string) => allShells().find((entry) => entry.id === id)

beforeEach(() => resetShells())
afterEach(() => {
  vi.useRealTimers()
  resetShells()
})

describe('createLineBatcher', () => {
  const harness = (options: Partial<Parameters<typeof createLineBatcher>[0]> = {}) => {
    const batches: Batch[] = []
    const batcher = createLineBatcher({ emit: (batch) => batches.push(batch), windowMs: 100, minIntervalMs: 1000, ...options })
    return { batches, batcher }
  }

  it('coalesces the lines that arrive within the window into one delivery', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness()
    batcher.push('one\ntw')
    batcher.push('o\nthree\n')
    expect(batches).toEqual([])
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['one', 'two', 'three'], omitted: 0 }])
  })

  it('waits out the minimum interval before the next delivery', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness()
    batcher.push('a\n')
    vi.advanceTimersByTime(100)
    batcher.push('b\n')
    // Due a full interval after the first delivery, not a window after the line.
    vi.advanceTimersByTime(999)
    expect(batches).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(batches).toEqual([
      { lines: ['a'], omitted: 0 },
      { lines: ['b'], omitted: 0 },
    ])
  })

  it('caps a delivery by lines and counts the rest', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness({ maxLines: 2 })
    batcher.push('a\nb\nc\nd\n')
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['a', 'b'], omitted: 2 }])
  })

  it('caps a delivery by characters and cuts a long line', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness({ maxChars: 12, maxLineChars: 6 })
    batcher.push('abcdefghij\nxyz\nmore\n')
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['abcde…', 'xyz'], omitted: 1 }])
  })

  it('skips blank lines and strips a carriage return', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness()
    batcher.push('\n  \r\nok\r\n')
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['ok'], omitted: 0 }])
  })

  it('schedules nothing for output that holds no line', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness()
    batcher.push('\n\n')
    vi.advanceTimersByTime(5000)
    expect(batches).toEqual([])
    expect(batcher.drain()).toBeUndefined()
  })

  it('drains what is queued, the unterminated line included, and cancels the timer', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness()
    batcher.push('done\npartial')
    expect(batcher.drain()).toEqual({ lines: ['done', 'partial'], omitted: 0 })
    vi.advanceTimersByTime(1000)
    expect(batches).toEqual([])
  })

  it('queues a line that never ends once it grows past the cap', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness({ maxLineChars: 5 })
    batcher.push('x'.repeat(30))
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['xxxx…'], omitted: 0 }])
  })

  it('uses the documented defaults when none are given', () => {
    vi.useFakeTimers()
    const batches: Batch[] = []
    const batcher = createLineBatcher({ emit: (batch) => batches.push(batch) })
    batcher.push('a\n')
    vi.advanceTimersByTime(999)
    expect(batches).toEqual([])
    vi.advanceTimersByTime(1)
    expect(batches).toHaveLength(1)
  })
})

describe('deadlineMs', () => {
  it('defaults to five minutes and caps at thirty', () => {
    expect(deadlineMs(undefined)).toBe(DEFAULT_DEADLINE_MS)
    expect(DEFAULT_DEADLINE_MS).toBe(300_000)
    expect(deadlineMs(60_000)).toBe(60_000)
    expect(deadlineMs(10 * MAX_DEADLINE_MS)).toBe(1_800_000)
  })

  it('rejects a deadline that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => deadlineMs(bad)).toThrow(/timeout_ms/)
  })
})

describe('monitorAllowed', () => {
  it('allows a UI session', () => {
    expect(monitorAllowed({ hasUI: true }, {})).toBeUndefined()
  })

  it('refuses with background tasks disabled, or without a UI', () => {
    expect(monitorAllowed({ hasUI: true }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })).toMatch(/CLAUDE_CODE_DISABLE_BACKGROUND_TASKS/)
    expect(monitorAllowed({ hasUI: false }, {})).toMatch(/without a UI/)
  })
})

describe('batchText', () => {
  it('names the monitor and points at the output file for lines it left out', () => {
    expect(batchText('m1', 'tail -F log', { lines: ['x'], omitted: 0 }, '/o')).toBe('Monitor m1 ("tail -F log") output:\nx')
    expect(batchText('m1', 'c', { lines: [], omitted: 1 }, '/o')).toContain('[1 more line not shown; full output: /o]')
    expect(batchText('m1', 'c', { lines: [], omitted: 3 }, '/o')).toContain('[3 more lines not shown')
  })
})

describe('/tasks listing', () => {
  it('labels a monitor as one', () => {
    const entry = registerShell({ id: 'm00000001', kind: 'monitor', command: 'tail -F x', outputFile: '/o' })
    expect(shellsStatusText([entry])).toContain('m00000001 monitor: running - tail -F x')
  })
})

describe('monitor tool', () => {
  it('is named Monitor in Claude vocabulary and mentions task_stop', () => {
    const { tool } = setup()
    expect(tool('monitor').description).toContain('task_stop')
    expect(tool('task_stop').description).toContain('monitor')
  })

  it('refuses in a session without a UI', async () => {
    const { monitor } = setup({ hasUI: false })
    await expect(monitor({ command: 'echo hi' })).rejects.toThrow(/without a UI/)
    expect(allShells()).toEqual([])
  })

  it('refuses with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', async () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1')
    const { monitor } = setup()
    await expect(monitor({ command: 'echo hi' })).rejects.toThrow(/disabled/)
  })

  it('refuses an empty command and a bad deadline', async () => {
    const { monitor } = setup()
    await expect(monitor({ command: '  ' })).rejects.toThrow(/empty/)
    await expect(monitor({ command: 'echo hi', timeout_ms: -5 })).rejects.toThrow(/timeout_ms/)
  })

  it('delivers the lines and one end notice when the command exits, and writes the output file', async () => {
    const { monitor, sent } = setup()
    const result = await monitor({ command: 'printf "alpha\\nbeta\\n"; printf gamma; exit 3' })
    const id = idOf(result)
    expect(textOf(result)).toContain('5-minute deadline')
    expect(shell(id)).toMatchObject({ kind: 'monitor', state: 'running' })
    await until(() => sent.length > 0 && shell(id)?.state !== 'running')
    expect(sent).toHaveLength(1)
    const [{ message, options }] = sent
    expect(message.customType).toBe('monitor')
    expect(message.content).toContain(`Monitor ${id} ("printf`)
    expect(message.content).toContain('alpha\nbeta\ngamma')
    expect(message.content).toContain(`Monitor ${id} ended: the command exited with code 3`)
    expect(options.triggerTurn).toBe(true)
    expect(shell(id)).toMatchObject({ state: 'failed', exitCode: 3 })
    const file = shell(id)?.outputFile ?? ''
    await until(() => fs.readFileSync(file, 'utf8').includes('gamma'))
  })

  it('delivers lines while the command is still running', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'echo early; sleep 5' }))
    await until(() => sent.length > 0)
    expect(sent[0]?.message.content).toBe(`Monitor ${id} ("echo early; sleep 5") output:\nearly`)
    expect(shell(id)?.state).toBe('running')
  })

  it('stops at the deadline with one notice', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'sleep 30', timeout_ms: 300 }))
    await until(() => sent.length > 0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.content).toBe(`Monitor ${id} reached its 0.3-second deadline and stopped. Start it again if you still need it.`)
    expect(shell(id)?.state).toBe('killed')
  })

  it('sends nothing once task_stop stops it', async () => {
    const { monitor, stop, sent } = setup()
    const id = idOf(await monitor({ command: 'echo hi; sleep 30' }))
    expect(textOf(await stop(id))).toContain('Stopped')
    await until(() => shell(id)?.stop === undefined && shell(id)?.finishedAt !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(sent).toEqual([])
    expect(shell(id)?.state).toBe('killed')
  })

  it('counts a running monitor in the footer until it is stopped', async () => {
    const { monitor, stop, footer } = setup()
    const id = idOf(await monitor({ command: 'sleep 30' }))
    expect(footer()).toBe('⏵ 1 background shell')
    await stop(id)
    expect(footer()).toBeUndefined()
  })

  it('reports a command that could not start', async () => {
    // pi's exec rejects before spawning when the working directory is gone.
    const { monitor, sent } = setup({ cwd: `${os.tmpdir()}/no-such-dir-${Date.now()}` })
    const id = idOf(await monitor({ command: 'echo never' }))
    await until(() => sent.length > 0)
    expect(sent[0]?.message.content).toMatch(new RegExp(`^Monitor ${id} could not run: Working directory does not exist`))
    expect(shell(id)?.state).toBe('failed')
  })

  it('holds a notice for the next prompt in a session that has had no turn', async () => {
    const { monitor, sent } = setup({ prompted: false })
    await monitor({ command: 'echo hi' })
    await until(() => sent.length > 0)
    expect(sent[0]?.options.triggerTurn).toBe(false)
  })

  it('stops monitors, and only monitors, when the session switches', async () => {
    const { monitor, emit, sent } = setup()
    const id = idOf(await monitor({ command: 'sleep 30' }))
    const other = registerShell({ id: 'b00000001', command: 'sleep 30', outputFile: '/o', stop: () => {} })
    emit('session_shutdown', { reason: 'new' })
    expect(shell(id)?.state).toBe('killed')
    expect(other.state).toBe('running')
    await until(() => shell(id)?.finishedAt !== undefined)
    expect(sent).toEqual([])
  })

  it('keeps monitors across /reload and stops everything on quit', async () => {
    const { monitor, emit } = setup()
    const id = idOf(await monitor({ command: 'sleep 30' }))
    emit('session_shutdown', { reason: 'reload' })
    expect(shell(id)?.state).toBe('running')
    emit('session_shutdown', { reason: 'quit' })
    expect(shell(id)?.state).toBe('killed')
  })
})
