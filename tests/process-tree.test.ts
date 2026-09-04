import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[] }>, child: undefined as EventEmitter | undefined }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: (file: string, args: string[]) => {
    spawned.calls.push({ file, args })
    spawned.child = new EventEmitter()
    return spawned.child
  },
}))

const { killProcessTree } = await import('../extensions/internal/process-tree.ts')

const fakeChild = (pid: number | undefined) => ({ pid, kill: vi.fn() }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }

describe('killProcessTree', () => {
  afterEach(() => {
    spawned.calls.length = 0
  })

  it('signals the whole process group on POSIX and leaves the direct kill alone', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(4242)
    killProcessTree(child, 'SIGTERM', 'linux')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to the direct kill when the group signal is refused', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const child = fakeChild(4242)
    killProcessTree(child, 'SIGKILL', 'darwin')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills a child that never got a pid directly', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(undefined)
    killProcessTree(child, 'SIGTERM', 'linux')
    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('ends the tree with taskkill by absolute path on Windows, whatever the signal', () => {
    // A subagent cancel used to signal only the direct child here; the hooks copy was
    // the only one that knew Windows has no process groups.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(777)
    killProcessTree(child, 'SIGTERM', 'win32')
    expect(kill).not.toHaveBeenCalled()
    expect(spawned.calls).toEqual([{ file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), args: ['/pid', '777', '/T', '/F'] }])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('force-kills the direct child on Windows when taskkill itself cannot start', () => {
    const child = fakeChild(777)
    killProcessTree(child, 'SIGTERM', 'win32')
    spawned.child?.emit('error', new Error('ENOENT'))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
