import { describe, expect, it, vi } from 'vitest'

import contextUsageExtension, { formatContextUsage } from '../extensions/context-usage.ts'

type CommandSpec = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }

function wire() {
  const commands = new Map<string, CommandSpec>()
  contextUsageExtension({
    on: () => {},
    registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec),
  } as never)
  return commands
}

describe('formatContextUsage', () => {
  it('renders a used/window/free breakdown with a percentage for populated usage', () => {
    const text = formatContextUsage({ tokens: 45000, contextWindow: 200000, percent: 22.5 })
    expect(text).toContain('45,000')
    expect(text).toContain('200,000')
    expect(text).toContain('22.5%')
    expect(text).toContain('155,000') // window minus used
  })

  it('falls back to the model window and derives a percentage when usage omits them', () => {
    // usage.contextWindow is 0 and percent is null, so the model window and a derived
    // percentage carry the breakdown.
    const text = formatContextUsage({ tokens: 50000, contextWindow: 0, percent: null }, 200000)
    expect(text).toContain('200,000')
    expect(text).toContain('25.0%')
    expect(text).toContain('150,000')
  })

  it('reports a friendly message when usage is undefined', () => {
    expect(formatContextUsage(undefined)).toMatch(/not available yet/i)
  })

  it('reports recalculating when tokens are unknown, still naming the window', () => {
    const text = formatContextUsage({ tokens: null, contextWindow: 200000, percent: null })
    expect(text).toMatch(/recalculat/i)
    expect(text).toContain('200,000')
  })
})

describe('context command', () => {
  it('registers a single context command', () => {
    expect([...wire().keys()]).toEqual(['context'])
  })

  it('notifies the populated breakdown as info', async () => {
    const commands = wire()
    const notify = vi.fn()
    const ctx = {
      getContextUsage: () => ({ tokens: 12345, contextWindow: 200000, percent: 6.2 }),
      model: { contextWindow: 200000 },
      ui: { notify },
    }
    await commands.get('context')?.handler('', ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('12,345')
    expect(notify.mock.calls[0][0]).toContain('6.2%')
    expect(notify.mock.calls[0][1]).toBe('info')
  })

  it('notifies the friendly message when there is no usage yet', async () => {
    const commands = wire()
    const notify = vi.fn()
    const ctx = { getContextUsage: () => undefined, model: undefined, ui: { notify } }
    await commands.get('context')?.handler('', ctx)
    expect(notify.mock.calls[0][0]).toMatch(/not available yet/i)
  })
})
