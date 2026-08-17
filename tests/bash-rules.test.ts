import { describe, expect, it } from 'vitest'

import { matchesBashRules } from '../extensions/internal/bash-rules.ts'

describe('matchesBashRules', () => {
  it('matches a bare specifier exactly', () => {
    expect(matchesBashRules('npm run build', ['npm run build'])).toBe(true)
    expect(matchesBashRules('npm run buildx', ['npm run build'])).toBe(false)
    expect(matchesBashRules('npm run build --watch', ['npm run build'])).toBe(false)
  })

  it('treats a :* suffix as a string prefix, as Claude documents', () => {
    expect(matchesBashRules('git add -A', ['git add:*'])).toBe(true)
    expect(matchesBashRules('git add', ['git add:*'])).toBe(true)
    // A string prefix, not a word boundary: npm run test:* covers npm run test:unit.
    expect(matchesBashRules('npm run test:unit', ['npm run test:*'])).toBe(true)
    expect(matchesBashRules('git commit -m x', ['git add:*'])).toBe(false)
  })

  it('treats * elsewhere as a wildcard', () => {
    expect(matchesBashRules('node --version', ['* --version'])).toBe(true)
    expect(matchesBashRules('node --eval 1', ['* --version'])).toBe(false)
    expect(matchesBashRules('npm run test unit', ['npm run test *'])).toBe(true)
  })

  it('requires every segment of a compound command to match some rule', () => {
    const rules = ['git add:*', 'git status']
    expect(matchesBashRules('git add -A && git status', rules)).toBe(true)
    expect(matchesBashRules('git add -A && git push', rules)).toBe(false)
    expect(matchesBashRules('git add -A; rm -rf /', rules)).toBe(false)
    expect(matchesBashRules('git status | cat', rules)).toBe(false)
  })

  it('keeps separators inside quotes out of the split', () => {
    expect(matchesBashRules("git add 'a && b'", ['git add:*'])).toBe(true)
  })

  it('fails closed on substitution, which can hide any command', () => {
    expect(matchesBashRules('git add $(rm -rf /)', ['git add:*'])).toBe(false)
    expect(matchesBashRules('git add `id`', ['git add:*'])).toBe(false)
  })

  it('fails closed on an unbalanced quote and on an empty command', () => {
    expect(matchesBashRules("git add 'oops", ['git add:*'])).toBe(false)
    expect(matchesBashRules('', ['git add:*'])).toBe(false)
  })

  it('matches nothing against an empty specifier', () => {
    // `Bash()` grants no command rather than every command.
    expect(matchesBashRules('git status', [''])).toBe(false)
  })
})
