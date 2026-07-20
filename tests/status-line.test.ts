import { describe, expect, it } from 'vitest'

import statusLine from '../extensions/status-line.ts'

const theme = { fg: (_color: string, text: string) => text }

function setup() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  statusLine({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn) } as never)
  const status: string[] = []
  const makeCtx = (branch: unknown[] = []) => ({
    ui: { theme, setStatus: (_key: string, text: string) => status.push(text) },
    sessionManager: { getBranch: () => branch },
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
})
