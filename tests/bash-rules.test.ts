import { describe, expect, it } from 'vitest'

import { matchesBashRules } from '../extensions/internal/bash-rules.ts'

describe('matchesBashRules', () => {
  it('matches a bare specifier exactly', () => {
    expect(matchesBashRules('npm run build', ['npm run build'])).toBe(true)
    expect(matchesBashRules('npm run buildx', ['npm run build'])).toBe(false)
    expect(matchesBashRules('npm run build --watch', ['npm run build'])).toBe(false)
  })

  // Oracle: the wildcard table and the three rules stated beneath it in Claude's
  // permissions reference, plus its ":*" equivalence sentence.
  it.each([
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run test --watch', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true],
    ['git log * main', 'git log -5 main', true],
    ['git log * main', 'git log main', false],
    ['git log * main', 'git push origin main', false],
    ['git * main', 'git merge main', true],
    ['git * main', 'git push origin main', true],
    ['git * main', 'git log', false],
    ['* --version', 'node --version', true],
    ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'ls -la', true],
    ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true],
    ['* --help *', 'npm --help', false],
  ])('rule %s against %s', (rule, command, expected) => {
    expect(matchesBashRules(command, [rule])).toBe(expected)
  })

  it('reads a trailing :* as the equivalent trailing wildcard, not a string prefix', () => {
    // Claude: "The :* suffix is an equivalent way to write a trailing wildcard, so
    // Bash(ls:*) matches the same commands as Bash(ls *)", and the space in that form is
    // part of the rule.
    expect(matchesBashRules('ls -la', ['ls:*'])).toBe(true)
    expect(matchesBashRules('ls', ['ls:*'])).toBe(true)
    expect(matchesBashRules('lsof', ['ls:*'])).toBe(false)
    expect(matchesBashRules('git addx -A', ['git add:*'])).toBe(false)
    // Recognized only at the end: elsewhere the colon is a literal character.
    expect(matchesBashRules('git push', ['git:* push'])).toBe(false)
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
    // Process substitution runs the inner command too, in both directions.
    expect(matchesBashRules('git add <(id)', ['git add:*'])).toBe(false)
    expect(matchesBashRules('git add >(id)', ['git add:*'])).toBe(false)
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
