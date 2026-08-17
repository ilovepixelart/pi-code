import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import notifyExtension, { AWAY_AFTER_MS, isAway, resolveNotifChannel } from '../extensions/notify.ts'

// The channel is read from the mocked home's ~/.claude/settings.json; default '' falls
// back to the real home, which no test with an empty home relies on (they skip session_start).
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

type Handler = (event: unknown, ctx: unknown) => Promise<void>

function drive(): { sessionStart: (ctx?: unknown) => Promise<void>; input: () => Promise<void>; agentEnd: () => Promise<void>; agentSettled: () => Promise<void> } {
  const handlers = new Map<string, Handler>()
  notifyExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never)
  const call =
    (name: string) =>
    (ctx: unknown = {}) =>
      handlers.get(name)?.({}, ctx) ?? Promise.resolve()
  return { sessionStart: call('session_start'), input: () => call('input')(), agentEnd: () => call('agent_end')(), agentSettled: () => call('agent_settled')() }
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

  it('emits an OSC 777 notification by default on agent_end', async () => {
    process.stdout.isTTY = true
    const writes = captureWrites()
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID

    await drive().agentEnd()
    const out = writes.join('')
    expect(out).toContain('Ready for input')
    expect(out).toContain('\x1b]777')
  })

  it('emits an OSC 99 notification under kitty', async () => {
    process.stdout.isTTY = true
    const writes = captureWrites()
    delete process.env.WT_SESSION
    process.env.KITTY_WINDOW_ID = '1'

    await drive().agentEnd()
    expect(writes.join('')).toContain('\x1b]99')
  })

  it('stays silent when stdout is not a terminal', async () => {
    // Piped or headless output (pi -p, CI) must not receive raw escape bytes.
    process.stdout.isTTY = false
    const writes = captureWrites()
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID

    await drive().agentEnd()
    expect(writes).toEqual([])
  })

  it('takes the Windows path without crashing when WT_SESSION is set', async () => {
    // powershell.exe spawn fails on non-Windows, but the callback swallows the error.
    process.stdout.isTTY = true
    process.env.WT_SESSION = 'x'
    await expect(drive().agentEnd()).resolves.toBeUndefined()
  })

  it('stays silent for a quick turn right after the user submitted (they are present)', async () => {
    process.stdout.isTTY = true
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID
    const writes = captureWrites()

    const d = drive()
    await d.input() // records "now"; the turn that follows is far under the away threshold
    await d.agentEnd()
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
    const out = writes.join('')
    expect(out).toContain('\x07')
    expect(out).not.toContain('\x1b]777')
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
    expect(writes).toEqual([])
    hoisted.home = ''
  })
})

describe('resolveNotifChannel', () => {
  it('maps preferredNotifChannel values, defaulting to desktop', () => {
    expect(resolveNotifChannel(undefined)).toBe('desktop')
    expect(resolveNotifChannel('iterm2')).toBe('desktop')
    expect(resolveNotifChannel('terminal_bell')).toBe('bell')
    expect(resolveNotifChannel('iterm2_with_bell')).toBe('both')
    expect(resolveNotifChannel('notifications_disabled')).toBe('off')
  })
})

describe('isAway', () => {
  it('treats an unrecorded or long-running turn as away, a quick one as present', () => {
    expect(isAway(undefined, 1_000_000, AWAY_AFTER_MS)).toBe(true)
    expect(isAway(1_000_000, 1_000_000 + AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(true)
    expect(isAway(1_000_000, 1_000_000 + AWAY_AFTER_MS - 1, AWAY_AFTER_MS)).toBe(false)
  })
})
