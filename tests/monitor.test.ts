import * as fs from 'node:fs'
import * as os from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import backgroundBashExtension from '../extensions/background-bash.ts'
import { allShells, registerShell, resetShells, settleShell, shellsStatusText } from '../extensions/internal/background-shells.ts'
import monitorExtension, {
  BATCH_WINDOW_MS,
  type Batch,
  batchText,
  createLineBatcher,
  DEFAULT_DEADLINE_MS,
  deadlineMs,
  FLOOD_BURST,
  FLOOD_REFILL_MS,
  MAX_BATCH_CHARS,
  MAX_BATCH_LINES,
  MAX_DEADLINE_MS,
  MAX_LINE_CHARS,
  MAX_OMITTED_LINES,
  MIN_DEADLINE_MS,
  MIN_INTERVAL_MS,
  type MonitorLimits,
  monitorAllowed,
  tokenBucket,
} from '../extensions/monitor.ts'

type ToolResult = { content: Array<{ type: string; text: string }> }
type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>
type Tool = { name: string; execute: Execute; description: string; parameters: { required?: string[]; properties: Record<string, unknown> } }
type Handler = (event: Record<string, unknown>, ctx: unknown) => void
type Sent = { message: { customType: string; content: string; display: boolean }; options: { triggerTurn?: boolean } }

/** Both extensions on one stubbed pi, as the pack loads them: task_stop is the bash
 * extension's, and the registry it stops through is shared. */
const setup = (options: { hasUI?: boolean; prompted?: boolean; cwd?: string; limits?: MonitorLimits } = {}) => {
  const tools = new Map<string, Tool>()
  const handlers = new Map<string, Handler[]>()
  const sent: Sent[] = []
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent['message'], opts: Sent['options']) => sent.push({ message, options: opts }),
  }
  // The real window and interval are a second and five; the batcher's own tests cover them.
  monitorExtension(pi as never, { windowMs: 10, minIntervalMs: 20, minDeadlineMs: 100, ...options.limits })
  backgroundBashExtension(pi as never)
  const statuses = new Map<string, string | undefined>()
  const ctx = {
    cwd: options.cwd ?? os.tmpdir(),
    ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value), theme: { fg: (_color: string, value: string) => value } },
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => 'test-session',
      getSessionFile: () => undefined,
      getBranch: () => (options.prompted === false ? [] : [{ type: 'message' }]),
    },
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
    monitor: (params: Record<string, unknown>) => get('monitor').execute('call-1', { description: 'the watch', ...params }, undefined, undefined, ctx),
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

// A stopped monitor is killed asynchronously: wait for it, so no process outlives the file.
const stopAndWait = async (): Promise<void> => {
  const live = allShells().filter((entry) => entry.stop !== undefined)
  resetShells()
  await until(() => live.every((entry) => entry.finishedAt !== undefined))
}

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

  it('omits every line after the first one that did not fit', () => {
    vi.useFakeTimers()
    const { batches, batcher } = harness({ maxChars: 10 })
    batcher.push('aaaa\nbbbbbbbb\ncc\n')
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([{ lines: ['aaaa'], omitted: 2 }])
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

describe('tokenBucket', () => {
  it('allows the burst, then one more per refill interval, never past the burst', () => {
    let now = 0
    const bucket = tokenBucket(2, 1000, () => now)
    expect([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, true, false])
    now = 999
    expect(bucket.tryConsume()).toBe(false)
    now = 1000
    expect([bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, false])
    now = 60_000
    expect([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, true, false])
  })

  it('has the documented flood constants', () => {
    expect([FLOOD_BURST, FLOOD_REFILL_MS, MAX_OMITTED_LINES]).toEqual([10, 30_000, 1000])
  })
})

describe('deadlineMs', () => {
  it('defaults to five minutes and caps at thirty', () => {
    expect(deadlineMs(undefined)).toBe(DEFAULT_DEADLINE_MS)
    expect(DEFAULT_DEADLINE_MS).toBe(300_000)
    expect(deadlineMs(60_000)).toBe(60_000)
    expect(deadlineMs(10 * MAX_DEADLINE_MS)).toBe(1_800_000)
  })

  it('rejects a deadline that is not a number, or is under one second', () => {
    expect(MIN_DEADLINE_MS).toBe(1000)
    for (const bad of [0, -1, 999, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => deadlineMs(bad)).toThrow(/timeout_ms must be a number of milliseconds, at least 1000/)
    expect(deadlineMs(1000)).toBe(1000)
  })
})

describe('monitorAllowed', () => {
  it('allows a UI session and refuses one without a UI', () => {
    expect(monitorAllowed({ hasUI: true })).toBeUndefined()
    expect(monitorAllowed({ hasUI: false })).toMatch(/without a UI/)
  })
})

describe('batchText', () => {
  it('names the monitor and points at the output file for lines it left out', () => {
    expect(batchText('m1', 'errors in  the\napp log', { lines: ['x'], omitted: 0 }, '/o')).toBe('Monitor m1 ("errors in the app log") output:\nx')
    expect(batchText('m1', 'c', { lines: [], omitted: 1 }, '/o')).toContain('[1 more line not shown; full output: /o]')
    expect(batchText('m1', 'c', { lines: [], omitted: 3 }, '/o')).toContain('[3 more lines not shown')
  })
})

describe('docs/monitor.md', () => {
  it('states the constants in force', () => {
    const doc = fs.readFileSync(new URL('../docs/monitor.md', import.meta.url), 'utf8')
    const thousands = (value: number): string => value.toLocaleString('en-US')
    const claims = [
      `defaults to ${DEFAULT_DEADLINE_MS} `,
      `refused under ${MIN_DEADLINE_MS},`,
      `capped at ${MAX_DEADLINE_MS} `,
      `opens a ${BATCH_WINDOW_MS / 1000}-second window`,
      `at most one message every ${MIN_INTERVAL_MS / 1000} seconds`,
      `${FLOOD_BURST} messages at once, one more every ${FLOOD_REFILL_MS / 1000} seconds`,
      `leave out more than ${thousands(MAX_OMITTED_LINES)} lines`,
      `cut at ${MAX_LINE_CHARS} characters; a message carries at most ${MAX_BATCH_LINES} lines and ${thousands(MAX_BATCH_CHARS)} characters`,
    ]
    for (const claim of claims) expect(doc).toContain(claim)
  })
})

describe('/tasks listing', () => {
  it('labels a monitor as one', () => {
    const entry = registerShell({ id: 'm00000001', kind: 'monitor', description: 'app errors', command: 'tail -F x', outputFile: '/o' })
    expect(shellsStatusText([entry])).toContain('m00000001 monitor: running - app errors: tail -F x')
  })
})

describe('monitor tool', () => {
  afterEach(stopAndWait)

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

  it('still runs with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, as in Claude', async () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1')
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'echo hi' }))
    await until(() => sent.length > 0)
    expect(sent[0]?.message.content).toContain(`Monitor ${id} (`)
  })

  it('refuses an empty command, an empty description and a bad deadline', async () => {
    const { monitor } = setup()
    await expect(monitor({ command: '  ' })).rejects.toThrow(/command must not be empty/)
    await expect(monitor({ command: 'echo hi', description: ' ' })).rejects.toThrow(/description must not be empty/)
    await expect(monitor({ command: 'echo hi', description: undefined })).rejects.toThrow(/description must not be empty/)
    await expect(monitor({ command: 'echo hi', timeout_ms: -5 })).rejects.toThrow(/timeout_ms/)
    expect(allShells()).toEqual([])
  })

  it('requires a description and sets the least timeout_ms in its schema', () => {
    const { tool } = setup()
    const parameters = tool('monitor').parameters
    expect(parameters.required).toEqual(['description', 'command'])
    expect(parameters.properties.timeout_ms).toMatchObject({ minimum: 1000 })
    // A longer request is capped, not refused, so the schema names no maximum.
    expect(parameters.properties.timeout_ms).not.toHaveProperty('maximum')
  })

  it('refuses a deadline under one second', async () => {
    const { monitor } = setup({ limits: { minDeadlineMs: undefined } })
    await expect(monitor({ command: 'echo hi', timeout_ms: 300 })).rejects.toThrow(/at least 1000/)
  })

  it('lists the description in the registry entry /tasks reads', async () => {
    const { monitor } = setup()
    const id = idOf(await monitor({ command: 'sleep 30', description: 'deploy status' }))
    expect(shell(id)).toMatchObject({ description: 'deploy status', command: 'sleep 30' })
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
    expect(message.content).toContain(`Monitor ${id} ("the watch") output:\nalpha\nbeta\ngamma\n`)
    expect(message.content).toContain(`Monitor ${id} ("the watch") ended: the command exited with code 3`)
    expect(options.triggerTurn).toBe(true)
    expect(shell(id)).toMatchObject({ state: 'failed', exitCode: 3 })
    const file = shell(id)?.outputFile ?? ''
    await until(() => fs.readFileSync(file, 'utf8').includes('gamma'))
  })

  it('delivers stdout lines only, and writes stderr to the output file', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'echo visible; printf "%s%s\\n" hid den >&2' }))
    await until(() => shell(id)?.finishedAt !== undefined)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.content).toContain('output:\nvisible\n')
    expect(sent[0]?.message.content).not.toContain('hidden')
    const file = shell(id)?.outputFile ?? ''
    await until(() => ['visible', 'hidden'].every((word) => fs.readFileSync(file, 'utf8').includes(word)))
  })

  it('sends no output message for a command that writes to stderr alone', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'echo quiet >&2' }))
    await until(() => shell(id)?.finishedAt !== undefined)
    expect(sent.map((entry) => entry.message.content)).toEqual([`Monitor ${id} ("the watch") ended: the command exited with code 0. Full output: ${shell(id)?.outputFile}`])
  })

  it('runs the command with the session variables the bash tool sets', async () => {
    const { monitor, sent } = setup()
    await monitor({ command: 'echo "session=$PI_SESSION_ID"' })
    await until(() => sent.length > 0)
    expect(sent[0]?.message.content).toContain('\nsession=test-session\n')
  })

  it('delivers lines while the command is still running', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'echo early; sleep 5' }))
    await until(() => sent.length > 0)
    expect(sent[0]?.message.content).toBe(`Monitor ${id} ("the watch") output:\nearly`)
    expect(shell(id)?.state).toBe('running')
  })

  it('stops at the deadline with one notice', async () => {
    const { monitor, sent } = setup()
    const id = idOf(await monitor({ command: 'sleep 30', timeout_ms: 300 }))
    await until(() => sent.length > 0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.content).toBe(`Monitor ${id} ("the watch") reached its 0.3-second deadline and stopped. Start it again if you still need it.`)
    expect(shell(id)?.state).toBe('killed')
  })

  it('sends nothing once task_stop stops it', async () => {
    const { monitor, stop, sent } = setup()
    const id = idOf(await monitor({ command: 'echo hi; sleep 30' }))
    expect(textOf(await stop(id))).toContain('Stopped')
    // Settling drains the batcher, so nothing is left that could still send.
    await until(() => shell(id)?.finishedAt !== undefined)
    expect(sent).toEqual([])
    expect(shell(id)?.state).toBe('killed')
  })

  describe('flood protection', () => {
    const stopNotice = (id: string, why: string): string => `Monitor ${id} ("the watch") was stopped: ${why}. Full output: ${shell(id)?.outputFile}`
    const tooMany = 'it produced too many events. Start it again with a tighter filter, so it prints only the lines worth reacting to'

    it('stops a monitor that keeps sending once its message allowance is spent, with one notice', async () => {
      const { monitor, sent } = setup({ limits: { floodBurst: 2, floodRefillMs: 60_000 } })
      const id = idOf(await monitor({ command: 'while true; do echo tick; sleep 0.05; done' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent.map((entry) => entry.message.content)).toEqual([`Monitor ${id} ("the watch") output:\ntick`, expect.stringContaining('output:\ntick'), stopNotice(id, tooMany)])
      expect(sent[2]?.options.triggerTurn).toBe(true)
      expect(shell(id)).toMatchObject({ state: 'killed', stopReason: tooMany })
    })

    it('stops a monitor whose delivery leaves out too many lines, without delivering it', async () => {
      const { monitor, sent } = setup({ limits: { maxOmittedLines: 100 } })
      const id = idOf(await monitor({ command: 'yes line' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent.map((entry) => entry.message.content)).toEqual([stopNotice(id, tooMany)])
    })

    it('delivers what a finished command left queued, whatever it leaves out', async () => {
      const { monitor, sent } = setup({ limits: { floodBurst: 2, maxOmittedLines: 100 } })
      const id = idOf(await monitor({ command: 'seq 1 120' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.message.content).toContain('[70 more lines not shown')
      expect(sent[0]?.message.content).toContain('ended: the command exited with code 0')
    })

    it('stops a monitor whose output, stderr included, passes the output cap', async () => {
      const { monitor, sent } = setup({ limits: { maxOutputBytes: 1000 } })
      const id = idOf(await monitor({ command: 'printf "%2000s" x >&2; sleep 30' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent.map((entry) => entry.message.content)).toEqual([stopNotice(id, 'its output passed the 1000B limit')])
      expect(shell(id)?.state).toBe('killed')
    })
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
    expect(sent[0]?.message.content).toMatch(new RegExp(String.raw`^Monitor ${id} \("the watch"\) could not run: Working directory does not exist`))
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
    // No process stands behind this entry, so nothing else would settle it.
    settleShell(other, 0)
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
