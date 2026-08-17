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
    sessionManager: { getBranch: vi.fn(() => branch), getSessionId: () => 's', getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 0, contextWindow: 0, percent: 0 }),
  })
  return { handlers, status, makeCtx }
}

const usageEntry = (total: number) => ({ type: 'message', message: { usage: { cost: { total } } } })

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
    // The branch is walked once at session start (a resumed or forked session
    // carries history); renders reuse the running total.
    const { handlers, status, makeCtx } = setup()
    const ctx = makeCtx([usageEntry(0.5), usageEntry(0.25)])
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.75')
  })

  it('uses four decimals for sub-cent costs', async () => {
    const { handlers, status, makeCtx } = setup()
    const ctx = makeCtx([usageEntry(0.0012)])
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.0012')
  })

  it('accumulates cost from message_end usage without re-walking the branch per render', async () => {
    const { handlers, status, makeCtx } = setup()
    const ctx = makeCtx([])
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('message_end')?.({ type: 'message_end', message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.5 } } } }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.50')
    await handlers.get('message_end')?.({ type: 'message_end', message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.25 } } } }, ctx)
    await handlers.get('agent_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.75')
    // Only the session_start seed touched the branch; renders must not walk it.
    expect(ctx.sessionManager.getBranch.mock.calls.length).toBe(1)
  })

  it('reseeds the cost from the branch when compaction or tree navigation reshapes it', async () => {
    const { handlers, status, makeCtx } = setup()
    const branch = [usageEntry(0.75)]
    const ctx = makeCtx(branch)
    await handlers.get('session_start')?.({}, ctx)
    // Compaction replaces the branch; the running total must follow it, not double.
    branch.splice(0, branch.length, usageEntry(0.1))
    await handlers.get('session_compact')?.({ reason: 'manual' }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.10')
    // Tree navigation swaps the branch wholesale with no message_end events.
    branch.push(usageEntry(0.05))
    await handlers.get('session_tree')?.({ newLeafId: null, oldLeafId: null }, ctx)
    await handlers.get('agent_end')?.({}, ctx)
    expect(status.at(-1)).toContain('$0.15')
    // One walk per reshaping event (start, compact, tree), none per render.
    expect(ctx.sessionManager.getBranch.mock.calls.length).toBe(3)
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
