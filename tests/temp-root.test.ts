import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempRoot } from './temp-root.ts'

const children: ChildProcess[] = []
const HELD = expect.objectContaining({ code: expect.stringMatching(/^(EBUSY|EPERM)$/) })

/** A native process with its working directory in `cwd`, which exits on its own after `ms`.
 * Resolves once it is running, when Windows refuses to remove `cwd`. */
const holdDirectory = async (cwd: string, ms: number): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', `console.log('up'); setTimeout(() => {}, ${ms})`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
  })
  return child
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

describe('removeTempRoot', () => {
  it('removes a populated tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-'))
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a', 'b', 'file.txt'), 'x')

    removeTempRoot(dir)

    expect(fs.existsSync(dir)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('removes a root that a process releases shortly after', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-'))
    await holdDirectory(dir, 1000)
    // The precondition: one attempt fails while the process is alive.
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).toThrow(HELD)

    removeTempRoot(dir)

    expect(fs.existsSync(dir)).toBe(false)
  })

  it.runIf(process.platform === 'win32')(
    'fails when a process holds the root past the retry budget',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-'))
      const child = await holdDirectory(dir, 60_000)

      expect(() => removeTempRoot(dir)).toThrow(HELD)
      expect(fs.existsSync(dir)).toBe(true)

      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
      removeTempRoot(dir)
    },
    15_000,
  )
})
