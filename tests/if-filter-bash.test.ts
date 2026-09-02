import { describe, expect, it } from 'vitest'

import { matchesBashIfFilter } from '../extensions/internal/bash-rules.ts'

/**
 * Oracle: the "Bash if matching" table in Claude's hooks reference, plus the sentence
 * beneath it, "When Claude Code can't determine which commands the Bash input runs, it
 * runs your hook regardless of the pattern."
 *
 * This is a filter, not a grant: it decides whether a hook gets to see a call, so an
 * input it cannot resolve runs the hook, where a permission rule would deny.
 */
describe('matchesBashIfFilter', () => {
  it.each([
    ['Bash(git *)', 'FOO=bar git push', true, 'leading assignments are stripped'],
    ['Bash(git *)', 'npm test && git push', true, 'each subcommand is checked'],
    ['Bash(rm *)', 'echo $(rm -rf /)', true, 'commands inside $() are checked'],
    ['Bash(rm *)', 'echo $(date)', false, 'no subcommand matches'],
    ['Bash(cat *)', 'echo before $(date) after', false, 'neither the full command nor date matches'],
    ['Bash(git *)', '$TOOL git push', true, "the command name's expansion is unknown"],
    ['Bash(git push *)', 'echo $(date)', true, 'a pattern naming more than the command runs anyway on a substitution'],
  ])('%s against %s runs the hook: %s (%s)', (pattern, command, expected) => {
    expect(matchesBashIfFilter(command, pattern.slice('Bash('.length, -1))).toBe(expected)
  })

  it('checks commands inside backticks like those inside $()', () => {
    expect(matchesBashIfFilter('echo `rm -rf /`', 'rm *')).toBe(true)
    expect(matchesBashIfFilter('echo `date`', 'rm *')).toBe(false)
  })

  it('matches a bare command against a trailing wildcard, as permission rules do', () => {
    expect(matchesBashIfFilter('git', 'git *')).toBe(true)
    expect(matchesBashIfFilter('gitk', 'git *')).toBe(false)
  })
})
