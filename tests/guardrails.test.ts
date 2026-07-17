import { beforeAll, describe, expect, it } from 'vitest'

import guardrails from '../extensions/guardrails.ts'

type Handler = (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>

describe('guardrails (non-interactive)', () => {
  const handlers = new Map<string, Handler>()
  const ctx = { hasUI: false, ui: { notify: () => {}, select: async () => 'No' } }

  const bash = (command: string) => handlers.get('tool_call')?.({ toolName: 'bash', input: { command } }, ctx)

  beforeAll(() => {
    guardrails({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as any)
  })

  it('blocks force-push', async () => {
    expect((await bash('git push --force origin main'))?.reason).toContain('Force-push is blocked')
  })

  it('allows force-with-lease', async () => {
    expect(await bash('git push --force-with-lease origin feat')).toBeUndefined()
  })

  it('blocks Co-Authored-By Claude trailers', async () => {
    const result = await bash('git commit -m "msg" -m "Co-Authored-By: Claude <noreply@anthropic.com>"')
    expect(result?.reason).toContain('AI attribution')
  })

  it('blocks Generated-with trailers', async () => {
    expect((await bash('git commit -m "msg" -m "Generated with Claude Code"'))?.block).toBe(true)
  })

  it('allows clean commit messages', async () => {
    expect(await bash('git commit -m "Fix login bug"')).toBeUndefined()
  })

  it('blocks blanket staging without UI', async () => {
    expect((await bash('git add -A'))?.reason).toContain('Stage explicitly')
  })

  it('allows staging by explicit path', async () => {
    expect(await bash('git add src/index.ts')).toBeUndefined()
  })
})
