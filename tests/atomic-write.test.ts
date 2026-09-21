import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { atomicWriteFile } from '../extensions/internal/atomic-write.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// POSIX permission bits do not exist on Windows.
describe.skipIf(process.platform === 'win32')('atomicWriteFile permissions', () => {
  it.each([
    ['600', 0o600],
    ['640', 0o640],
    ['644', 0o644],
    ['400', 0o400],
  ])('keeps the mode %s of the file it replaces', (_label, mode) => {
    // settings.local.json can hold env secrets. The rewrite went through a new temp file,
    // created 0644 under the default umask and renamed over the target: a 0600 file came
    // back readable by everyone on the machine.
    const file = join(tempDir(), 'settings.local.json')
    writeFileSync(file, '{"env":{"TOKEN":"secret"}}', { mode })

    atomicWriteFile(file, '{"env":{"TOKEN":"rotated"}}')

    expect(statSync(file).mode & 0o777).toBe(mode)
    expect(readFileSync(file, 'utf8')).toBe('{"env":{"TOKEN":"rotated"}}')
  })

  it('leaves a new file at the default mode', () => {
    const file = join(tempDir(), 'fresh.json')
    atomicWriteFile(file, '{}')
    expect(statSync(file).mode & 0o777).toBe(0o644 & ~process.umask())
  })
})
