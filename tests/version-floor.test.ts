import { VERSION } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { floorNotice, PI_FLOOR } from '../extensions/internal/pi-floor.ts'
import { sharedSlot } from '../extensions/internal/shared-slot.ts'
import { registerFloorCheck } from '../extensions/version-floor.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void

function sessionStarts(version: string): { start: () => Promise<void>; notify: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, Handler>()
  registerFloorCheck({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never, version)
  const notify = vi.fn()
  return { start: async () => handlers.get('session_start')?.({}, { ui: { notify } }), notify }
}

describe('pi version floor', () => {
  it('is 0.80.5, the first published pi with agent_settled', () => {
    expect(PI_FLOOR).toBe('0.80.5')
  })

  it('names the floor, the running pi and what breaks on an older pi', () => {
    expect(floorNotice('0.80.4')).toBe('pi-code requires pi >= 0.80.5; this is pi 0.80.4. agent_settled never fires on it, so command tool restrictions, ultrathink escalation and the ready notification are never lifted or sent')
  })

  it.each(['0.79.9', '0.74.0', '0.9.99'])('warns on pi %s', (version) => {
    expect(floorNotice(version)).toContain(`this is pi ${version}.`)
  })

  it.each(['0.80.5', '0.80.10', '0.81.0', '1.1.0'])('stays silent on pi %s', (version) => {
    expect(floorNotice(version)).toBeUndefined()
  })

  // pi reports "0.0.0" when it cannot read its own package.json: an unknown version, not an old one.
  it.each(['0.0.0', '', 'dev'])('stays silent when pi reports no usable version (%j)', (version) => {
    expect(floorNotice(version)).toBeUndefined()
  })
})

describe('version-floor extension', () => {
  beforeEach(() => sharedSlot<boolean>('version-floor.warned').set(undefined))

  it('warns once, on the first session start, when pi is below the floor', async () => {
    const { start, notify } = sessionStarts('0.79.0')
    await start()
    await start()
    expect(notify.mock.calls).toEqual([[floorNotice('0.79.0'), 'warning']])
  })

  // pi loads a fresh extension instance for each session (/new, /resume, /fork, /reload);
  // measured on pi 0.79.10, a closure flag warned again after /new.
  it('warns once per process, not again from the next session instance', async () => {
    const first = sessionStarts('0.79.0')
    await first.start()
    const second = sessionStarts('0.79.0')
    await second.start()
    expect(first.notify).toHaveBeenCalledOnce()
    expect(second.notify).not.toHaveBeenCalled()
  })

  it('says nothing on the pi this suite runs against', async () => {
    const { start, notify } = sessionStarts(VERSION)
    await start()
    expect(notify).not.toHaveBeenCalled()
  })
})
