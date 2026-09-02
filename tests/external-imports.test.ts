import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { externalImportDecision, rememberExternalImportDecision } from '../extensions/internal/external-imports.ts'

const storeIn = (): string => join(fs.mkdtempSync(join(tmpdir(), 'ei-')), 'nested', 'store.json')

describe('external import decisions', () => {
  it('reads back what was recorded, per project root', () => {
    const store = storeIn()
    rememberExternalImportDecision('/repo/a', true, store)
    rememberExternalImportDecision('/repo/b', false, store)

    expect(externalImportDecision('/repo/a', store)).toBe(true)
    expect(externalImportDecision('/repo/b', store)).toBe(false)
  })

  it('reports a project that was never asked as undecided, not as refused', () => {
    // The two must stay distinguishable: a refusal is never asked about again, so
    // reading "unasked" as "refused" would make the dialog unreachable.
    const store = storeIn()
    rememberExternalImportDecision('/repo/a', false, store)

    expect(externalImportDecision('/repo/other', store)).toBeNull()
  })

  it('reports no decision when the store does not exist', () => {
    expect(externalImportDecision('/repo/a', storeIn())).toBeNull()
  })

  it('re-asks rather than trusting a corrupt store', () => {
    const store = storeIn()
    fs.mkdirSync(join(store, '..'), { recursive: true })
    fs.writeFileSync(store, '{ not json')
    expect(externalImportDecision('/repo/a', store)).toBeNull()

    fs.writeFileSync(store, JSON.stringify({ '/repo/a': 'yes' }))
    expect(externalImportDecision('/repo/a', store)).toBeNull()

    // Valid JSON that is not an object: reading a key off it would throw, and so
    // would recording the next answer.
    for (const body of ['null', '[]', '42']) {
      fs.writeFileSync(store, body)
      expect(externalImportDecision('/repo/a', store)).toBeNull()
      expect(() => rememberExternalImportDecision('/repo/a', true, store)).not.toThrow()
      expect(externalImportDecision('/repo/a', store)).toBe(true)
    }
  })

  it('keeps the other projects when one is recorded', () => {
    const store = storeIn()
    rememberExternalImportDecision('/repo/a', true, store)
    rememberExternalImportDecision('/repo/b', true, store)
    rememberExternalImportDecision('/repo/a', false, store)

    expect(externalImportDecision('/repo/b', store)).toBe(true)
    expect(externalImportDecision('/repo/a', store)).toBe(false)
  })

  it('leaves the session usable when the store cannot be written', () => {
    // A directory in place of the store's parent fails the same way an unwritable
    // agent directory does, on every platform: the answer is forgotten, not thrown.
    const dir = fs.mkdtempSync(join(tmpdir(), 'ei-ro-'))
    const blocker = join(dir, 'blocker')
    fs.writeFileSync(blocker, 'not a directory')
    const store = join(blocker, 'store.json')

    expect(() => rememberExternalImportDecision('/repo/a', true, store)).not.toThrow()
    expect(externalImportDecision('/repo/a', store)).toBeNull()
  })
})
