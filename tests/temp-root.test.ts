import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempRoot } from './temp-root.ts'

const children: ChildProcess[] = []

/** A process whose working directory is `cwd`, alive for `ms`: on Windows it holds the
 * directory, so the directory cannot be removed until the process exits. */
const holdDirectory = async (cwd: string, ms: number): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd, stdio: 'ignore' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
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

  // A stopped command's process tree is killed by a taskkill nobody waits for, so a
  // child can still hold the root when the file's teardown runs.
  it.runIf(process.platform === 'win32')('removes a root a process releases shortly after', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-'))
    await holdDirectory(dir, 1500)
    // The lock is real: a single attempt fails while the process is alive.
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EBUSY|EPERM)$/) }))

    removeTempRoot(dir)

    expect(fs.existsSync(dir)).toBe(false)
  })

  it.runIf(process.platform === 'win32')(
    'fails when a process holds the root past the retry budget',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-'))
      const child = await holdDirectory(dir, 60_000)

      expect(() => removeTempRoot(dir)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EBUSY|EPERM)$/) }))
      expect(fs.existsSync(dir)).toBe(true)

      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
    15_000,
  )
})
