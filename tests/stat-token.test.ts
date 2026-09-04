import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { statToken } from '../extensions/internal/stat-token.ts'

/** The token is the change detector behind import expansion and memory-index reuse:
 * a same-length edit changes mtime and nothing else, so mtime must be part of it.
 * Every other rewrite fixture in the suite changes the size too, which a size-only
 * token would also catch. */
describe('statToken', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('changes when only the mtime moves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stat-token-'))
    dirs.push(dir)
    const file = join(dir, 'a.md')
    writeFileSync(file, 'same length')
    const before = statToken(file)
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    expect(statToken(file)).not.toBe(before)
  })

  it('is stable while nothing changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stat-token-'))
    dirs.push(dir)
    const file = join(dir, 'a.md')
    writeFileSync(file, 'same length')
    expect(statToken(file)).toBe(statToken(file))
  })
})
