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
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('emits an OSC 777 notification by default on agent_end', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    process.env.WT_SESSION = undefined
    process.env.KITTY_WINDOW_ID = undefined
    delete process.env.WT_SESSION
    delete process.env.KITTY_WINDOW_ID

    await drive().agentEnd()
    const out = writes.join('')
    expect(out).toContain('Ready for input')
    expect(out).toContain('\x1b]777')
  })

  it('emits an OSC 99 notification under kitty', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    delete process.env.WT_SESSION
    process.env.KITTY_WINDOW_ID = '1'

    await drive().agentEnd()
    expect(writes.join('')).toContain('\x1b]99')
  })

  it('takes the Windows path without crashing when WT_SESSION is set', async () => {
    // powershell.exe spawn fails on non-Windows, but the callback swallows the error.
    process.env.WT_SESSION = 'x'
    await expect(drive().agentEnd()).resolves.toBeUndefined()
  })
})
