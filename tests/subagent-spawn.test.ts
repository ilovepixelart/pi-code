import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: (_file: string, _args: string[], options: Record<string, unknown>) => {
    spawned.options.push(options)
    return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  },
}))

const { spawnChild } = await import('../extensions/subagent/run.ts')

describe('spawnChild', () => {
  afterEach(() => {
    spawned.options.length = 0
  })

  it('keeps the Windows child on the parent console with its window hidden', () => {
    spawnChild('pi', [], { cwd: '/w', env: {} }, 'win32')
    expect(spawned.options[0]).toMatchObject({ detached: false, windowsHide: true })
  })

  it('gives the POSIX child its own process group', () => {
    spawnChild('pi', [], { cwd: '/w', env: {} }, 'linux')
    expect(spawned.options[0]).toMatchObject({ detached: true })
  })
})
