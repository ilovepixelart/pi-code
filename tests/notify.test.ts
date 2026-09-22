import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import notifyExtension, { AWAY_AFTER_MS, isAway, resolveNotifChannel } from '../extensions/notify.ts'

// The channel is read from the mocked home's ~/.claude/settings.json; default '' falls
// back to the real home, which no test with an empty home relies on (they skip session_start).
const hoisted = vi.hoisted(() => ({ home: '', execCalls: [] as Array<{ file: string; args: string[] }> }))

// The Windows toast shells out; record the invocation so a test can assert what it runs
// rather than only that the promise settled.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], callback?: (error: Error | null) => void) => {
      hoisted.execCalls.push({ file, args })
      callback?.(null)
      return undefined as never
    },
  }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

type Handler = (event: unknown, ctx: unknown) => Promise<void>

function drive(): {
  sessionStart: (ctx?: unknown) => Promise<void>
  input: (source?: 'interactive' | 'extension') => Promise<void>
  agentEnd: (stopReason?: string) => Promise<void>
  agentSettled: () => Promise<void>
} {
  const handlers = new Map<string, Handler>()
  notifyExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never)
  const call =
    (name: string) =>
    (event: unknown = {}, ctx: unknown = {}) =>
      handlers.get(name)?.(event, ctx) ?? Promise.resolve()
  return {
    sessionStart: (ctx) => call('session_start')({}, ctx),
    input: (source = 'interactive') => call('input')({ source }),
    // A run has at least one assistant message; only its stopReason matters here.
    agentEnd: (stopReason = 'stop') => call('agent_end')({ messages: [{ role: 'assistant', stopReason }] }),
    agentSettled: () => call('agent_settled')(),
  }
}

describe('notify', () => {
  const env = { WT_SESSION: process.env.WT_SESSION, KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID }
  const savedIsTTY = process.stdout.isTTY
  afterEach(() => {
    vi.restoreAllMocks()
    process.stdout.isTTY = savedIsTTY
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  const captureWrites = (): string[] => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    return writes
  }

  it('emits an OSC 777 notification by default once the run settles', async () => {
    process.stdout.isTTY = true
    const writes = captureWrites()
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID

    const d = drive()
    await d.agentEnd()
    expect(writes).toEqual([]) // agent_end alone never fires it; see below
    await d.agentSettled()
    const out = writes.join('')
    expect(out).toContain('Ready for input')
    expect(out).toContain('\x1b]777')
  })

  it('emits an OSC 99 notification under kitty', async () => {
    process.stdout.isTTY = true
    const writes = captureWrites()
    delete process.env.WT_SESSION
    process.env.KITTY_WINDOW_ID = '1'

    const d = drive()
    await d.agentEnd()
    await d.agentSettled()
    expect(writes.join('')).toContain('\x1b]99')
  })

  it('stays silent when stdout is not a terminal', async () => {
    // Piped or headless output (pi -p, CI) must not receive raw escape bytes.
    process.stdout.isTTY = false
    const writes = captureWrites()
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID

    const d = drive()
    await d.agentEnd()
    await d.agentSettled()
    expect(writes).toEqual([])
  })

  it('sends the toast through PowerShell by absolute path when WT_SESSION is set on native Windows', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.stdout.isTTY = true
    delete process.env.KITTY_WINDOW_ID
    process.env.WT_SESSION = '1'
    hoisted.execCalls.length = 0

    try {
      const d = drive()
      await d.agentEnd()
      await d.agentSettled()
      const call = hoisted.execCalls.at(-1)
      expect(call?.file).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
      expect(call?.args.join(' ')).toContain('Windows.UI.Notifications')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  // Windows Terminal sets WT_SESSION for a WSL session it hosts too, but a WSL process
  // is Linux (process.platform !== 'win32'), where the fixed C:\\Windows\\... path can
  // never resolve: PowerShell was never actually launched, so no toast ever fired.
  it('falls back to the OSC 777 escape sequence rather than a Windows-only path under WSL', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.stdout.isTTY = true
    delete process.env.KITTY_WINDOW_ID
    process.env.WT_SESSION = '1'
    hoisted.execCalls.length = 0
    const writes = captureWrites()

    try {
      const d = drive()
      await d.agentEnd()
      await d.agentSettled()
      expect(hoisted.execCalls).toEqual([])
      expect(writes.join('')).toContain('\x1b]777')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('stays silent for a quick turn right after the user submitted (they are present)', async () => {
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.input() // records "now"; the turn that follows is far under the away threshold
    await d.agentEnd()
    await d.agentSettled()
    expect(writes).toEqual([])
  })

  it('rings the terminal bell instead of a desktop notification for terminal_bell', async () => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'notify-home-'))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ preferredNotifChannel: 'terminal_bell' }))
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.sessionStart({ cwd: hoisted.home })
    await d.agentEnd() // no input this session, so the turn counts as away
    await d.agentSettled()
    const out = writes.join('')
    expect(out).toContain('\x07')
    expect(out).not.toContain('\x1b]777')
    hoisted.home = ''
  })

  it('sends both the bell and the desktop notification for iterm2_with_bell', async () => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'notify-home-'))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ preferredNotifChannel: 'iterm2_with_bell' }))
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.sessionStart({ cwd: hoisted.home })
    await d.agentEnd()
    await d.agentSettled()
    const out = writes.join('')
    expect(out).toContain('\x1b]777')
    // The OSC 777 sequence is terminated by a BEL byte of its own, so a plain
    // toContain cannot see the bell; two BELs means the sequence's terminator plus the
    // explicit bell the 'both' channel adds.
    expect(out.split('\x07').length - 1).toBe(2)
    hoisted.home = ''
  })

  it('emits nothing when notifications are disabled', async () => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'notify-home-'))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ preferredNotifChannel: 'notifications_disabled' }))
    process.stdout.isTTY = true
    const writes = captureWrites()

    const d = drive()
    await d.sessionStart({ cwd: hoisted.home })
    await d.agentEnd()
    await d.agentSettled()
    expect(writes).toEqual([])
  })

  // agent_end fires once per internal step (an automatic retry, each turn of a /goal
  // loop); agent_settled is pi's own "no automatic retry, compaction, or queued
  // continuation will run" signal and fires exactly once for the whole chain. Firing
  // straight off agent_end notified on every one of those steps, though nothing was
  // ever actually waiting on the user until the last one.
  describe('a run that continues itself one or more times before it is truly done', () => {
    it('does not notify for an automatic retry, only once the run finally settles', async () => {
      process.stdout.isTTY = true
      delete process.env.WT_SESSION
      delete process.env.KITTY_WINDOW_ID
      const writes = captureWrites()

      const d = drive()
      await d.agentEnd() // the failed attempt
      await d.agentEnd() // the retry's own end
      expect(writes).toEqual([])
      await d.agentSettled()
      expect(writes.join('')).toContain('Ready for input')
    })

    it('fires only once for a /goal loop of several turns, not once per turn', async () => {
      process.stdout.isTTY = true
      delete process.env.WT_SESSION
      delete process.env.KITTY_WINDOW_ID
      const writes = captureWrites()

      const d = drive()
      for (let i = 0; i < 4; i++) await d.agentEnd() // four /goal-driven turns, none of them the last
      expect(writes).toEqual([])
      await d.agentSettled() // the goal condition is finally met
      const notifyCount = writes.filter((w) => w.includes('Ready for input')).length
      expect(notifyCount).toBe(1)
    })

    it('does not carry a settled notification over to the next run with nothing pending', async () => {
      process.stdout.isTTY = true
      delete process.env.WT_SESSION
      delete process.env.KITTY_WINDOW_ID
      const writes = captureWrites()

      const d = drive()
      await d.agentEnd()
      await d.agentSettled()
      writes.length = 0
      await d.agentSettled() // e.g. a stray or duplicate event; nothing new to report
      expect(writes).toEqual([])
    })
  })

  // Esc produces stopReason: 'aborted' on the last assistant message (as goal.ts's own
  // check for it does). The user just interrupted the run themselves, so they are at the
  // keyboard by definition, whatever isAway's timer-based guess would otherwise say.
  it('does not notify when the user interrupted the run themselves (Esc)', async () => {
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.agentEnd('aborted')
    await d.agentSettled()
    expect(writes).toEqual([])
  })

  it('does not leave a stale pending notification armed after an aborted settle', async () => {
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.agentEnd('aborted')
    await d.agentSettled() // consumed and cleared, not just skipped
    writes.length = 0
    await d.agentSettled() // nothing re-armed it; a stray repeat must stay silent
    expect(writes).toEqual([])
  })

  it('does not let an earlier aborted step in the same chain suppress the real notification', async () => {
    // Only the last step before settling reflects why the run actually ended.
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.agentEnd('aborted')
    await d.agentEnd('stop')
    await d.agentSettled()
    expect(writes.join('')).toContain('Ready for input')
  })

  // goal.ts's own continuation prompt carries source: 'extension'; only the user's own
  // input is evidence they are at the keyboard.
  it('does not count an extension-originated continuation as the user being present', async () => {
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.input('extension')
    await d.agentEnd()
    await d.agentSettled()
    expect(writes.join('')).toContain('Ready for input')
  })
})

describe('resolveNotifChannel', () => {
  it('maps preferredNotifChannel values, defaulting to desktop', () => {
    expect(resolveNotifChannel('notifications_disabled')).toBe('off')
    expect(resolveNotifChannel('terminal_bell')).toBe('bell')
    expect(resolveNotifChannel('iterm2_with_bell')).toBe('both')
    expect(resolveNotifChannel('anything_else')).toBe('desktop')
    expect(resolveNotifChannel(undefined)).toBe('desktop')
  })
})

describe('isAway', () => {
  it('treats an unrecorded or long-running turn as away, a quick one as present', () => {
    expect(isAway(undefined, 1_000_000, AWAY_AFTER_MS)).toBe(true)
    expect(isAway(0, AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(true)
    expect(isAway(1_000_000, 1_000_000 + AWAY_AFTER_MS - 1, AWAY_AFTER_MS)).toBe(false)
  })
})
