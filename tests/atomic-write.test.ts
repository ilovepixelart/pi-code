import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Creating a symlink needs a privilege on Windows.
describe.skipIf(process.platform === 'win32')('atomicWriteFile through a symlink', () => {
  it('updates the file the link points to and leaves the link in place', () => {
    // A stow or dotfiles setup links ~/.claude/settings.json into a repository. The rename
    // replaced the link itself with a regular file: the setup silently stopped being
    // managed, and the real file kept the old content.
    const dir = tempDir()
    mkdirSync(join(dir, 'dotfiles'))
    const real = join(dir, 'dotfiles', 'settings.json')
    const link = join(dir, 'settings.json')
    writeFileSync(real, '{"v":1}', { mode: 0o600 })
    symlinkSync(real, link)

    atomicWriteFile(link, '{"v":2}')

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(real))
    expect(readFileSync(real, 'utf8')).toBe('{"v":2}')
    expect(statSync(real).mode & 0o777).toBe(0o600)
  })

  it('follows a chain of links, and writes beside the real file so the rename stays on its filesystem', () => {
    const dir = tempDir()
    const real = join(dir, 'real.json')
    writeFileSync(real, 'old')
    symlinkSync(real, join(dir, 'first.json'))
    symlinkSync(join(dir, 'first.json'), join(dir, 'second.json'))

    atomicWriteFile(join(dir, 'second.json'), 'new')

    expect(lstatSync(join(dir, 'second.json')).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('new')
  })

  it('writes a fresh file where a dangling link points nowhere yet', () => {
    const dir = tempDir()
    const link = join(dir, 'settings.json')
    symlinkSync(join(dir, 'not-there.json'), link)

    atomicWriteFile(link, '{}')

    expect(readFileSync(link, 'utf8')).toBe('{}')
  })
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
