import * as fs from 'node:fs'
import * as os from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import backgroundBashExtension from '../extensions/background-bash.ts'
import { allShells, registerShell, resetShells, settleShell, shellsStatusText } from '../extensions/internal/background-shells.ts'
import monitorExtension, {
  BATCH_WINDOW_MS,
  createLineBatcher,
  DEFAULT_DEADLINE_MS,
  deadlineMs,
  eventGate,
  eventText,
  FLOOD_BURST,
  FLOOD_REFILL_MS,
  MAX_DEADLINE_MS,
  MAX_EVENT_CHARS,
  MAX_LINE_CHARS,
  MAX_PARTIAL_CHARS,
  MIN_DEADLINE_MS,
  type MonitorLimits,
  monitorAllowed,
  SUPPRESSION_LIMIT_MS,
  suppressionNotice,
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
  // The mailbox is process state: a monitor an earlier test left on its way out reports
  // to whichever session is current, so only this session's own monitors are recorded.
  const own = new Set<string>()
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent['message'], opts: Sent['options']) => {
      if ([...own].some((id) => message.content.startsWith(`Monitor ${id} `))) sent.push({ message, options: opts })
    },
  }
  monitorExtension(pi as never, { windowMs: 10, minDeadlineMs: 100, ...options.limits })
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
    monitor: async (params: Record<string, unknown>) => {
      const result = await get('monitor').execute('call-1', { description: 'the watch', ...params }, undefined, undefined, ctx)
      own.add(idOf(result))
      return result
    },
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
/** A window no test outlasts: what the command printed goes out with its end notice,
 * in one message, however slowly the host runs it. */
const HELD: MonitorLimits = { windowMs: 60_000 }

// A stopped monitor is killed asynchronously: wait for it, so no process outlives the file.
// Every unsettled entry counts, not only the running ones: one that pi or the test has
// already stopped is still on its way out.
const stopAndWait = async (): Promise<void> => {
  const live = allShells().filter((entry) => entry.finishedAt === undefined)
  resetShells()
  await until(() => live.every((entry) => entry.finishedAt !== undefined))
}

beforeEach(() => resetShells())
afterEach(() => {
  vi.useRealTimers()
  resetShells()
})

describe('createLineBatcher', () => {
  const harness = () => {
    const events: string[] = []
    const batcher = createLineBatcher({ emit: (event) => events.push(event) })
    return { events, batcher }
  }

  it('makes one event of the lines that arrive within 200 ms of the first, and a second of a line after that', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    batcher.push('one\ntw')
    vi.advanceTimersByTime(199)
    batcher.push('o\nthree\n')
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['one\ntwo\nthree'])
    vi.advanceTimersByTime(1)
    batcher.push('four\n')
    vi.advanceTimersByTime(199)
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['one\ntwo\nthree', 'four'])
  })

  it('trims lines and skips blank ones', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    batcher.push('\n  \r\n  ok \r\n')
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toEqual(['ok'])
  })

  it('schedules nothing for output that holds no line', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    batcher.push('\n\n')
    vi.advanceTimersByTime(5000)
    expect(events).toEqual([])
    expect(batcher.drain()).toBeUndefined()
  })

  it('drains what is queued, the unterminated line included, and cancels the timer', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    batcher.push('done\npartial')
    expect(batcher.drain()).toBe('done\npartial')
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })

  it('cuts a line at 500 characters', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    batcher.push(`${'x'.repeat(500)}\n${'y'.repeat(501)}\n`)
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toEqual([`${'x'.repeat(500)}\n${'y'.repeat(500)}...(truncated)`])
  })

  it('cuts an event at 3,000 characters, however many lines follow', () => {
    vi.useFakeTimers()
    const { events, batcher } = harness()
    const line = 'z'.repeat(299)
    batcher.push(`${line}\n`.repeat(10))
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    batcher.push(`${line}\n`.repeat(10_000))
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    const whole = Array.from({ length: 10 }, () => line).join('\n')
    expect(whole).toHaveLength(2999)
    expect(events).toEqual([whole, `${whole}\n\n...(truncated)`])
  })

  it('keeps the end of a line that never ends', () => {
    const { batcher } = harness()
    batcher.push(`a${'b'.repeat(MAX_PARTIAL_CHARS)}`)
    expect(batcher.drain()).toBe(`${'b'.repeat(500)}...(truncated)`)
  })
})

describe('tokenBucket', () => {
  it('allows the burst, then one more per refill interval, never past the burst', () => {
    let now = 0
    const bucket = tokenBucket(2, 1000, () => now)
    expect(bucket.tokens()).toBe(2)
    expect([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, true, false])
    now = 999
    expect(bucket.tryConsume()).toBe(false)
    now = 1000
    expect(bucket.tokens()).toBe(1)
    expect([bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, false])
    now = 60_000
    expect(bucket.tokens()).toBe(2)
    expect([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, true, false])
  })
})

describe('eventGate', () => {
  const stopped = (count: number, seconds: number): string => `[Monitor stopped: too much output (${count} events suppressed over ${seconds}s). Restart with a more selective source.]`
  const harness = (options: Partial<Parameters<typeof eventGate>[0]> = {}) => {
    const clock = { now: 0 }
    const sent: string[] = []
    const stops: string[] = []
    const gate = eventGate({ send: (event) => sent.push(event), stop: (notice) => stops.push(notice), now: () => clock.now, ...options })
    const offer = (count: number, prefix = 'e'): void => {
      for (let index = 0; index < count; index++) gate.offer(`${prefix}${index + 1}`)
    }
    return { clock, sent, stops, gate, offer }
  }

  it('has the constants Claude Code has', () => {
    expect([BATCH_WINDOW_MS, MAX_LINE_CHARS, MAX_EVENT_CHARS, FLOOD_BURST, FLOOD_REFILL_MS, SUPPRESSION_LIMIT_MS]).toEqual([200, 500, 3000, 10, 2000, 30_000])
  })

  it('delivers 10 events at once, suppresses the 11th, and reports it ahead of the next one delivered', () => {
    const { clock, sent, stops, gate, offer } = harness()
    offer(11)
    expect(sent).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10'])
    clock.now = 1999
    gate.offer('early')
    clock.now = 2000
    gate.offer('next')
    expect(sent.slice(10)).toEqual(['[2 events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]', 'next'])
    expect(stops).toEqual([])
  })

  it('counts one suppressed event as "1 events", as Claude does', () => {
    expect(suppressionNotice(1)).toBe('[1 events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]')
    const { clock, sent, gate, offer } = harness()
    offer(11)
    clock.now = 2000
    gate.offer('next')
    expect(sent.slice(10)).toEqual([suppressionNotice(1), 'next'])
  })

  it('stops a monitor once it has been suppressed for more than 30 seconds without a break', () => {
    const { clock, sent, stops, gate, offer } = harness()
    offer(11)
    for (clock.now = 1000; clock.now <= 30_000; clock.now += 1000) gate.offer('more')
    expect(stops).toEqual([])
    clock.now = 30_001
    gate.offer('last')
    expect(stops).toEqual([stopped(1, 30)])
    expect(sent.filter((event) => event === 'more')).toHaveLength(15)
  })

  it('starts the 30 seconds again after 6 seconds without an event', () => {
    const { clock, stops, gate, offer } = harness()
    offer(11)
    for (clock.now = 1000; clock.now <= 24_000; clock.now += 1000) gate.offer('more')
    // Exactly three refills of quiet are not a break: the suppression that began at 0 goes on.
    clock.now = 30_000
    offer(4)
    expect(stops).toEqual([])
    clock.now = 30_001
    gate.offer('late')
    expect(stops).toEqual([stopped(2, 30)])

    const second = harness()
    second.offer(11)
    for (second.clock.now = 1000; second.clock.now <= 24_000; second.clock.now += 1000) second.gate.offer('more')
    second.clock.now = 30_001
    second.offer(5)
    for (second.clock.now = 31_001; second.clock.now <= 60_001; second.clock.now += 1000) second.gate.offer('more')
    expect(second.stops).toEqual([])
    second.clock.now = 61_001
    second.gate.offer('late')
    expect(second.stops).toEqual([stopped(1, 31)])
  })

  it('starts the 30 seconds again once the allowance is whole', () => {
    const { clock, sent, stops, gate } = harness({ capacity: 1, suppressionLimitMs: 3000 })
    for (clock.now = 0; clock.now <= 20_000; clock.now += 2000) {
      gate.offer('kept')
      gate.offer('dropped')
    }
    expect(stops).toEqual([])
    expect(sent.filter((event) => event === 'kept')).toHaveLength(11)
    // One token short of whole: the suppression that began at 0 goes on.
    const short = harness({ capacity: 2, suppressionLimitMs: 3000 })
    short.offer(3)
    short.clock.now = 2000
    short.offer(2)
    short.clock.now = 4000
    short.offer(2)
    expect(short.stops).toEqual([stopped(1, 4)])
  })

  it('admits an event without stopping the monitor, for the one a command ends on', () => {
    const { clock, sent, stops, gate, offer } = harness()
    offer(12)
    clock.now = 40_000
    expect(gate.admit()).toBe(true)
    expect(sent.slice(10)).toEqual([suppressionNotice(2)])
    const spent = harness()
    spent.offer(10)
    spent.clock.now = 1000
    expect(spent.gate.admit()).toBe(false)
    expect([...stops, ...spent.stops]).toEqual([])
  })
})

describe('events under the limits in force', () => {
  /** A watch as `start` wires it: the batcher's events go through the gate, and a stop
   * drops what is queued. */
  const watch = () => {
    const sent: string[] = []
    let stoppedAt: number | undefined
    const startedAt = Date.now()
    const gate = eventGate({
      send: (event) => sent.push(event),
      stop: (notice) => {
        sent.push(notice)
        stoppedAt = Date.now() - startedAt
        batcher.drain()
      },
    })
    const batcher = createLineBatcher({ emit: gate.offer })
    const push = (chunk: string): void => {
      if (stoppedAt === undefined) batcher.push(chunk)
    }
    return { sent, push, stoppedAt: () => stoppedAt }
  }
  const isNotice = (event: string): boolean => event.startsWith('[')

  const everySeconds = [5, 10, 30]
  const watches = [DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS]
  const cases = everySeconds.flatMap((seconds) => watches.map((watchMs) => ({ seconds, minutes: watchMs / 60_000, watchMs })))

  it.each(cases)('delivers every line of a command printing one every $seconds s through a $minutes-minute watch', ({ seconds, watchMs }) => {
    vi.useFakeTimers()
    const { sent, push, stoppedAt } = watch()
    const lines = Array.from({ length: watchMs / (seconds * 1000) }, (_, index) => `tick ${index + 1}`)
    for (const line of lines) {
      push(`${line}\n`)
      vi.advanceTimersByTime(seconds * 1000)
    }
    expect({ stoppedAt: stoppedAt(), sent }).toEqual({ stoppedAt: undefined, sent: lines })
  })

  it('delivers 28 of 120 lines printed two a second, reports the rest as counts, and stops after 30 seconds of suppression', () => {
    vi.useFakeTimers()
    const { sent, push, stoppedAt } = watch()
    for (let line = 1; line <= 120; line++) {
      push(`b ${line}\n`)
      vi.advanceTimersByTime(500)
    }
    const kept = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73]
    expect(sent.filter((event) => !isNotice(event))).toEqual(kept.map((line) => `b ${line}`))
    expect(sent.filter(isNotice)).toEqual([...Array.from({ length: 15 }, () => suppressionNotice(3)), '[Monitor stopped: too much output (2 events suppressed over 31s). Restart with a more selective source.]'])
    expect(sent.slice(13, 16)).toEqual([suppressionNotice(3), 'b 17', suppressionNotice(3)])
    expect(stoppedAt()).toBe(37_200)
  })

  // Nothing here lets a timer fire, as none fires while a command keeps the event loop
  // on its pipe: the events can only come from the output arriving.
  it('forms events as output arrives while no timer runs, and stops the command after 30 seconds of suppression', () => {
    const clock = { now: 0 }
    const now = (): number => clock.now
    const sent: string[] = []
    let stoppedAt: number | undefined
    const gate = eventGate({
      now,
      send: (event) => sent.push(event),
      stop: (notice) => {
        sent.push(notice)
        stoppedAt = clock.now
      },
    })
    const batcher = createLineBatcher({
      now,
      emit: (event) => {
        if (stoppedAt === undefined) gate.offer(event)
      },
    })
    for (; clock.now <= 40_000 && stoppedAt === undefined; clock.now += 50) batcher.push('line\n')
    batcher.drain()
    const events = sent.filter((event) => !isNotice(event))
    expect(new Set(events)).toEqual(new Set(['line\nline\nline\nline']))
    expect(events).toHaveLength(26)
    expect(sent.slice(10, 14)).toEqual([events[0], suppressionNotice(8), events[0], suppressionNotice(9)])
    expect(sent.at(-1)).toBe('[Monitor stopped: too much output (3 events suppressed over 30s). Restart with a more selective source.]')
    expect(stoppedAt).toBe(32_600)
  })

  it('stops a command that prints without pause after 30 seconds of suppression', () => {
    vi.useFakeTimers()
    const { sent, push, stoppedAt } = watch()
    for (let chunk = 0; chunk < 400; chunk++) {
      push('line\n'.repeat(2000))
      vi.advanceTimersByTime(100)
    }
    const events = sent.filter((event) => !isNotice(event))
    expect(new Set(events)).toEqual(new Set([`${'line\n'.repeat(600)}\n...(truncated)`]))
    expect(events).toHaveLength(26)
    expect(sent.at(-1)).toBe('[Monitor stopped: too much output (3 events suppressed over 30s). Restart with a more selective source.]')
    expect(stoppedAt()).toBe(32_600)
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

describe('eventText', () => {
  it('names the monitor ahead of the event', () => {
    expect(eventText('m1', 'errors in  the\napp log', 'x\ny')).toBe('Monitor m1 ("errors in the app log") output:\nx\ny')
  })
})

describe('docs/monitor.md', () => {
  it('states the constants and notices in force', () => {
    const doc = fs.readFileSync(new URL('../docs/monitor.md', import.meta.url), 'utf8')
    const claims = [
      `defaults to ${DEFAULT_DEADLINE_MS} `,
      `refused under ${MIN_DEADLINE_MS},`,
      `capped at ${MAX_DEADLINE_MS} `,
      `opens a ${BATCH_WINDOW_MS} ms window`,
      `cut at ${MAX_LINE_CHARS} characters and an event at ${MAX_EVENT_CHARS.toLocaleString('en-US')}`,
      `${FLOOD_BURST} events at once and one more every ${FLOOD_REFILL_MS / 1000} seconds`,
      `more than ${SUPPRESSION_LIMIT_MS / 1000} seconds without a break`,
      `${(FLOOD_REFILL_MS * 3) / 1000} seconds without an event`,
      suppressionNotice(0).replace('0', 'N'),
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
    const { monitor, sent } = setup({ limits: HELD })
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
    const { monitor, sent } = setup({ limits: HELD })
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
    expect(sent[0]?.message.content).toContain('\nsession=test-session')
  })

  it('has closed the output file by the time the monitor has settled', async () => {
    // Windows refuses to remove a directory that holds an open file, so a settled
    // monitor must have let go of it, with every byte written.
    const { monitor } = setup({ limits: HELD })
    const id = idOf(await monitor({ command: 'head -c 3000000 /dev/zero' }))
    await until(() => shell(id)?.finishedAt !== undefined)
    expect(fs.statSync(shell(id)?.outputFile ?? '').size).toBe(3_000_000)
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

    // The allowance does not come back within the test and the suppression limit is
    // short, so what is sent does not depend on how fast the host runs the command.
    it('suppresses a command that prints without pause, then stops it with one notice', async () => {
      const { monitor, sent } = setup({ limits: { floodBurst: 2, floodRefillMs: 600_000, suppressionLimitMs: 100 } })
      const id = idOf(await monitor({ command: 'yes line' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      const output = expect.stringMatching(new RegExp(String.raw`^Monitor ${id} \("the watch"\) output:\nline\nline\n`))
      const stopped = expect.stringMatching(new RegExp(String.raw`^Monitor ${id} \("the watch"\) output:\n\[Monitor stopped: too much output \(\d+ events suppressed over \d+s\)\. Restart with a more selective source\.\]$`))
      expect(sent.map((entry) => entry.message.content)).toEqual([output, output, stopped])
      expect(sent[2]?.options.triggerTurn).toBe(true)
      expect(shell(id)).toMatchObject({ state: 'killed', stopReason: 'too much output' })
    })

    it('does not send the event a command ends on once its allowance is spent', async () => {
      const { monitor, sent } = setup({ limits: { ...HELD, floodBurst: 0 } })
      const id = idOf(await monitor({ command: 'echo late' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent.map((entry) => entry.message.content)).toEqual([`Monitor ${id} ("the watch") ended: the command exited with code 0. Full output: ${shell(id)?.outputFile}`])
    })

    it('stops a monitor whose output, stderr included, passes the output cap', async () => {
      const { monitor, sent } = setup({ limits: { maxOutputBytes: 1000 } })
      const id = idOf(await monitor({ command: 'printf "%2000s" x >&2; sleep 30' }))
      await until(() => shell(id)?.finishedAt !== undefined)
      expect(sent.map((entry) => entry.message.content)).toEqual([stopNotice(id, 'its output passed the 1000B limit')])
      expect(shell(id)?.state).toBe('killed')
    })
  })

  // A process forked while the first kill lands is reached only by the second one.
  it.skipIf(process.platform === 'win32')('kills the process group again once the stopped shell has exited', async () => {
    const kills = vi.spyOn(process, 'kill')
    const { monitor, stop } = setup()
    const id = idOf(await monitor({ command: 'sleep 30' }))
    await stop(id)
    await until(() => shell(id)?.finishedAt !== undefined)
    const groups = kills.mock.calls.filter(([pid, signal]) => pid < 0 && signal === 'SIGKILL').map(([pid]) => pid)
    // Counted for this shell's own group, the first one killed after the spy was set.
    expect(groups.filter((pid) => pid === groups[0])).toHaveLength(2)
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
