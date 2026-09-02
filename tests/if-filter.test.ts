import { describe, expect, it } from 'vitest'

import type { HookCommand } from '../extensions/hooks/config.ts'
import { type IfFilterTarget, passesIfFilter } from '../extensions/hooks/matcher.ts'

// Fixed anchors so every expectation is hand-derivable: rules resolve against
// cwd, /-rules against the project root, ~-rules against home.
const anchors = { cwd: '/proj/sub', projectRoot: '/proj', home: '/home/u' }

const hookIf = (rule?: string): HookCommand => ({ command: 'x', ...(rule === undefined ? {} : { if: rule }) }) as HookCommand

const target = (piName: string, input: unknown, claudeName?: string): IfFilterTarget => ({ piName, input, anchors, ...(claudeName === undefined ? {} : { claudeName }) })

describe('passesIfFilter', () => {
  it('always passes a hook without an if rule', () => {
    expect(passesIfFilter(hookIf(), target('edit', {}))).toBe(true)
    expect(passesIfFilter(hookIf(), undefined)).toBe(true)
  })

  it('matches a bare tool name case- and dash-insensitively', () => {
    expect(passesIfFilter(hookIf('Edit'), target('edit', {}))).toBe(true)
    expect(passesIfFilter(hookIf('Edit'), target('read', {}))).toBe(false)
  })

  it('matches any alternative of a | rule', () => {
    expect(passesIfFilter(hookIf('Edit|Write'), target('write', {}))).toBe(true)
    expect(passesIfFilter(hookIf('Edit|Write'), target('read', {}))).toBe(false)
  })

  it('matches via the claude-side tool name too', () => {
    expect(passesIfFilter(hookIf('Glob'), target('find', {}, 'Glob'))).toBe(true)
    expect(passesIfFilter(hookIf('Grep'), target('find', {}, 'Glob'))).toBe(false)
  })

  it('evaluates a Bash pattern against the command', () => {
    expect(passesIfFilter(hookIf('Bash(git *)'), target('bash', { command: 'git status' }))).toBe(true)
    expect(passesIfFilter(hookIf('Bash(git *)'), target('bash', { command: 'npm install' }))).toBe(false)
  })

  it('refuses a Bash pattern when the input carries no command', () => {
    expect(passesIfFilter(hookIf('Bash(git *)'), target('bash', {}))).toBe(false)
  })

  it('evaluates a file-tool pattern against the path input, resolved from cwd', () => {
    expect(passesIfFilter(hookIf('Edit(docs/**)'), target('edit', { path: '/proj/sub/docs/a.md' }))).toBe(true)
    expect(passesIfFilter(hookIf('Edit(docs/**)'), target('edit', { path: 'docs/a.md' }))).toBe(true)
    expect(passesIfFilter(hookIf('Edit(docs/**)'), target('edit', { path: '/proj/sub/src/a.md' }))).toBe(false)
  })

  it('reads the claude-shaped file_path input key as well', () => {
    expect(passesIfFilter(hookIf('Write(docs/**)'), target('write', { file_path: '/proj/sub/docs/a.md' }))).toBe(true)
  })

  it('anchors a /-rule at the project root and a ~-rule at home', () => {
    expect(passesIfFilter(hookIf('Edit(/docs/**)'), target('edit', { path: '/proj/docs/a.md' }))).toBe(true)
    expect(passesIfFilter(hookIf('Edit(/docs/**)'), target('edit', { path: '/proj/sub/docs/a.md' }))).toBe(false)
    expect(passesIfFilter(hookIf('Edit(~/notes/**)'), target('edit', { path: '/home/u/notes/n.md' }))).toBe(true)
  })

  it('refuses a file-tool pattern when the input carries no path', () => {
    expect(passesIfFilter(hookIf('Edit(docs/**)'), target('edit', {}))).toBe(false)
    // The discriminating case: an empty path resolves to cwd, so a rule that
    // matches cwd itself must still refuse pathless input rather than fire.
    expect(passesIfFilter(hookIf('Edit(/sub)'), target('edit', {}))).toBe(false)
    expect(passesIfFilter(hookIf('Edit(/sub)'), target('edit', { path: '/proj/sub' }))).toBe(true)
  })

  it('matches nothing on an empty pattern, staying closed rather than open', () => {
    expect(passesIfFilter(hookIf('Edit()'), target('edit', { path: '/proj/sub/docs/a.md' }))).toBe(false)
  })

  it('matches nothing on an unparseable rule', () => {
    expect(passesIfFilter(hookIf('Edit(docs/**'), target('edit', { path: '/proj/sub/docs/a.md' }))).toBe(false)
    expect(passesIfFilter(hookIf('Edit)('), target('edit', { path: '/proj/sub/docs/a.md' }))).toBe(false)
  })
})
