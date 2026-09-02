import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readSettingsChain } from '../extensions/internal/settings-chain.ts'

describe('readSettingsChain', () => {
  const write = (dir: string, name: string, body: string): string => {
    const file = join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('yields each readable object in chain order, so a later file wins', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const a = write(dir, 'a.json', '{"outputStyle":"first"}')
    const b = write(dir, 'b.json', '{"outputStyle":"second"}')
    expect([...readSettingsChain([a, b])]).toEqual([{ outputStyle: 'first' }, { outputStyle: 'second' }])
  })

  it('skips a missing file rather than ending the chain', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const present = write(dir, 'present.json', '{"a":1}')
    expect([...readSettingsChain([join(dir, 'absent.json'), present])]).toEqual([{ a: 1 }])
  })

  it('skips a corrupt file rather than ending the chain', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const bad = write(dir, 'bad.json', '{ not json')
    const good = write(dir, 'good.json', '{"a":1}')
    expect([...readSettingsChain([bad, good])]).toEqual([{ a: 1 }])
  })

  it('skips JSON that is not an object, including null and an array', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const nul = write(dir, 'null.json', 'null')
    const arr = write(dir, 'arr.json', '[1,2]')
    const str = write(dir, 'str.json', '"text"')
    const good = write(dir, 'good.json', '{"a":1}')
    expect([...readSettingsChain([nul, arr, str, good])]).toEqual([{ a: 1 }])
  })

  it('reads each file only when the caller pulls it, so the chain sees a late write', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const first = write(dir, 'first.json', '{"a":1}')
    // Absent when the chain starts: only a read deferred to the second pull sees it.
    const second = join(dir, 'second.json')
    const seen: Record<string, unknown>[] = []
    for (const settings of readSettingsChain([first, second])) {
      seen.push(settings)
      if (seen.length === 1) fs.writeFileSync(second, '{"a":2}')
    }
    expect(seen).toEqual([{ a: 1 }, { a: 2 }])
  })
})
