import { afterEach, describe, expect, it, vi } from 'vitest'

import notifyExtension from '../extensions/notify.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<void>

function drive(): { agentEnd: () => Promise<void> } {
  const handlers = new Map<string, Handler>()
  notifyExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never)
  return { agentEnd: () => handlers.get('agent_end')?.({}, {}) ?? Promise.resolve() }
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
})
