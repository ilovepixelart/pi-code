import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import statusLine from '../extensions/status-line.ts'

// The extension reads statusLine settings from the home dir at session start; point
// it at an empty temp home so the developer's real config never reaches the tests.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})
hoisted.home = mkdtempSync(join(tmpdir(), 'sl-home-'))

const theme = { fg: (_color: string, text: string) => text }

function setup() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  statusLine({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
    events: { on: () => () => {}, emit: () => {} },
  } as never)
  const status: string[] = []
  const makeCtx = (branch: unknown[] = []) => ({
    cwd: mkdtempSync(join(tmpdir(), 'sl-cwd-')),
    isProjectTrusted: () => true,
    ui: { theme, setStatus: (_key: string, text: string) => status.push(text), confirm: async () => true, notify: () => {} },
    sessionManager: { getBranch: () => branch, getSessionId: () => 's', getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 0, contextWindow: 0, percent: 0 }),
  })
  return { handlers, status, makeCtx }
}

describe('status-line', () => {
  it('shows "ready" with no turns or cost at session start', async () => {
    const { handlers, status, makeCtx } = setup()
    await handlers.get('session_start')?.({}, makeCtx())
    expect(status.at(-1)).toContain('ready')
  })

  it('shows the turn counter during a turn and on turn end', async () => {
    const { handlers, status, makeCtx } = setup()
    await handlers.get('turn_start')?.({}, makeCtx())
    expect(status.at(-1)).toContain('turn 1...')
    await handlers.get('turn_end')?.({}, makeCtx())
    expect(status.at(-1)).toContain('turn 1')
  })

  it('sums session cost from branch usage and formats it to cents', async () => {
    const { handlers, status, makeCtx } = setup()
    const branch = [
      { type: 'message', message: { usage: { cost: { total: 0.5 } } } },
      { type: 'message', message: { usage: { cost: { total: 0.25 } } } },
    ]
    await handlers.get('turn_end')?.({}, makeCtx(branch))
    expect(status.at(-1)).toContain('$0.75')
  })

  it('uses four decimals for sub-cent costs', async () => {
    const { handlers, status, makeCtx } = setup()
    await handlers.get('turn_end')?.({}, makeCtx([{ type: 'message', message: { usage: { cost: { total: 0.0012 } } } }]))
    expect(status.at(-1)).toContain('$0.0012')
  })

  it('keeps the running turn count after agent_end', async () => {
    const { handlers, status, makeCtx } = setup()
    await handlers.get('turn_start')?.({}, makeCtx())
    await handlers.get('agent_end')?.({}, makeCtx())
    expect(status.at(-1)).toContain('turn 1')
  })

  it('resets the turn count on a new session', async () => {
    // One extension instance serves every session; a fresh session (/new) must start
    // from ready, not continue the prior session's counter.
    const { handlers, status, makeCtx } = setup()
    await handlers.get('turn_start')?.({}, makeCtx())
    await handlers.get('session_start')?.({}, makeCtx())
    expect(status.at(-1)).toContain('ready')
    expect(status.at(-1)).not.toContain('turn 1')
  })
})
