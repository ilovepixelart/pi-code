import { describe, expect, it } from 'vitest'

import {
  checkinIntervalMs,
  checkinText,
  classifyUnrecoverable,
  DEFAULT_CHECKIN_MINUTES,
  EVALUATOR_SYSTEM,
  evaluatorPrompt,
  formatAchievedGoal,
  formatActiveGoal,
  formatDuration,
  formatTokens,
  GOAL_CONDITION_MAX_CHARS,
  isClearAlias,
  kickoffPrompt,
  parseVerdict,
  renderTranscript,
  summaryText,
} from '../extensions/internal/goal-evaluator.ts'

describe('isClearAlias', () => {
  it('accepts clear and each documented alias, case-insensitively', () => {
    for (const alias of ['clear', 'stop', 'off', 'reset', 'none', 'cancel', 'CLEAR', 'Stop']) expect(isClearAlias(alias)).toBe(true)
  })

  it('rejects a condition that merely starts with or contains an alias', () => {
    expect(isClearAlias('clearly the tests pass')).toBe(false)
    expect(isClearAlias('stop the server and run tests')).toBe(false)
    expect(isClearAlias('')).toBe(false)
  })
})

describe('kickoffPrompt', () => {
  it('quotes the condition as the directive and forbids the post-success /goal clear tip', () => {
    const prompt = kickoffPrompt('npm test exits 0')
    expect(prompt).toContain('"npm test exits 0"')
    expect(prompt).toMatch(/directive/)
    expect(prompt).toContain('/goal clear')
    expect(prompt).toMatch(/auto-clears/)
  })
})

describe('evaluatorPrompt and EVALUATOR_SYSTEM', () => {
  it('asks for transcript evidence only and names the condition after the transcript', () => {
    const prompt = evaluatorPrompt('User: hi\n\nAssistant: done', 'the build passes')
    expect(prompt.indexOf('User: hi')).toBeLessThan(prompt.indexOf('Condition: the build passes'))
    expect(prompt).toContain('transcript evidence only')
  })

  it('documents the three verdict shapes and reserves impossible for unachievable conditions', () => {
    expect(EVALUATOR_SYSTEM).toContain('{"ok": true')
    expect(EVALUATOR_SYSTEM).toContain('{"ok": false, "reason"')
    expect(EVALUATOR_SYSTEM).toContain('"impossible": true')
    expect(EVALUATOR_SYSTEM).toMatch(/insufficient evidence in transcript/)
    expect(EVALUATOR_SYSTEM).toMatch(/When in doubt, return \{"ok": false\} without "impossible"/)
    expect(EVALUATOR_SYSTEM).toMatch(/Output the JSON object only/)
  })
})

describe('parseVerdict', () => {
  it('reads met, not met, and impossible verdicts with their reasons', () => {
    expect(parseVerdict('{"ok": true, "reason": "tests passed"}')).toEqual({ ok: true, reason: 'tests passed', impossible: false })
    expect(parseVerdict('{"ok": false, "reason": "lint still red"}')).toEqual({ ok: false, reason: 'lint still red', impossible: false })
    expect(parseVerdict('{"ok": false, "impossible": true, "reason": "no network"}')).toEqual({ ok: false, reason: 'no network', impossible: true })
  })

  it('tolerates prose and code fences around the JSON object', () => {
    expect(parseVerdict('Sure:\n```json\n{"ok": false, "reason": "x"}\n```\n')).toEqual({ ok: false, reason: 'x', impossible: false })
  })

  it('ignores impossible on a met verdict and defaults a missing reason to empty', () => {
    expect(parseVerdict('{"ok": true, "impossible": true}')).toEqual({ ok: true, reason: '', impossible: false })
  })

  it('accepts a prose reply that opens with yes or no, as small models answer, with the reply as the reason', () => {
    expect(parseVerdict('Yes. The transcript shows DONE.md was created with the content finished.')).toEqual({ ok: true, reason: 'Yes. The transcript shows DONE.md was created with the content finished.', impossible: false })
    expect(parseVerdict('No, the tests have not been run yet.')).toEqual({ ok: false, reason: 'No, the tests have not been run yet.', impossible: false })
    expect(parseVerdict('  no')).toEqual({ ok: false, reason: 'no', impossible: false })
  })

  it('returns undefined for no JSON without a yes/no lead, malformed JSON, or a non-boolean ok', () => {
    expect(parseVerdict('all good')).toBeUndefined()
    expect(parseVerdict('Yesterday it passed')).toBeUndefined()
    expect(parseVerdict('Nothing to report')).toBeUndefined()
    expect(parseVerdict('{"ok": tru')).toBeUndefined()
    expect(parseVerdict('{"ok": "yes"}')).toBeUndefined()
    expect(parseVerdict('[1,2]')).toBeUndefined()
  })

  it('prefers the JSON object over a yes/no lead when both appear', () => {
    expect(parseVerdict('Yes, here: {"ok": false, "reason": "lint red"}')).toEqual({ ok: false, reason: 'lint red', impossible: false })
  })
})

describe('renderTranscript', () => {
  const messages = [
    { role: 'user', content: 'run the tests' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret plan' },
        { type: 'text', text: 'Running them.' },
        { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm test' } },
      ],
    },
    { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: '12 passed' }] },
    { role: 'custom', customType: 'goal', content: 'Goal not yet met: lint pending' },
    { role: 'assistant', content: [{ type: 'text', text: 'All green.' }], stopReason: 'stop' },
  ]

  it('renders user text, assistant text and tool calls, tool results, and custom notes in order', () => {
    const out = renderTranscript(messages, 100_000)
    expect(out).toContain('User: run the tests')
    expect(out).toContain('Assistant: Running them.')
    expect(out).toContain('[tool call bash({"command":"npm test"})]')
    expect(out).toContain('Tool result (bash): 12 passed')
    expect(out).toContain('Note (goal): Goal not yet met: lint pending')
    expect(out.indexOf('User: run the tests')).toBeLessThan(out.indexOf('All green.'))
  })

  it('drops thinking blocks so private reasoning is never evidence', () => {
    expect(renderTranscript(messages, 100_000)).not.toContain('secret plan')
  })

  it('renders a failed assistant turn as its error, and image parts as a placeholder', () => {
    const out = renderTranscript(
      [
        { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' },
        { role: 'user', content: [{ type: 'image', data: 'x' }] },
      ],
      10_000,
    )
    expect(out).toContain('Assistant: [error: boom]')
    expect(out).toContain('User: [image]')
  })

  it('keeps the newest whole messages within the budget and marks the omitted head', () => {
    const out = renderTranscript(messages, 60)
    expect(out.startsWith('[earlier transcript omitted]')).toBe(true)
    expect(out).toContain('Assistant: All green.')
    expect(out).not.toContain('run the tests')
  })

  it('keeps the whole transcript, unmarked, when it fits exactly', () => {
    const full = renderTranscript(messages, 100_000)
    expect(renderTranscript(messages, full.length)).toBe(full)
    expect(full).not.toContain('omitted')
  })

  it('never returns only the marker: an oversized last message is cut to the budget instead', () => {
    const out = renderTranscript([{ role: 'user', content: 'x'.repeat(500) }], 40)
    expect(out.startsWith('[earlier transcript omitted]')).toBe(false)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out).toContain('User: xxx')
  })

  it('caps a single huge tool result so one dump cannot consume the budget', () => {
    const out = renderTranscript(
      [
        { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(20_000) }] },
        { role: 'user', content: 'next' },
      ],
      100_000,
    )
    expect(out.length).toBeLessThan(8_000)
    expect(out).toMatch(/truncated \d+ chars/)
    expect(out).toContain('User: next')
  })

  it('skips roles it cannot render and returns empty for no messages', () => {
    expect(renderTranscript([{ role: 'branchSummary', summary: 's' }], 1000)).toBe('')
    expect(renderTranscript([], 1000)).toBe('')
  })
})

describe('classifyUnrecoverable', () => {
  it('names the four failure kinds that clear a goal', () => {
    expect(classifyUnrecoverable('401 authentication_error: invalid x-api-key')).toBe('authentication')
    expect(classifyUnrecoverable('Your credit balance is too low to access the API')).toBe('credits')
    expect(classifyUnrecoverable('prompt is too long: 210000 tokens > 200000 maximum')).toBe('context overflow')
    expect(classifyUnrecoverable('404 not_found_error: model: claude-x does not exist')).toBe('model unavailable')
  })

  it('leaves transient failures unclassified so the goal stays set', () => {
    expect(classifyUnrecoverable('429 rate_limit_error: too many requests')).toBeUndefined()
    expect(classifyUnrecoverable('529 overloaded_error: Overloaded')).toBeUndefined()
    expect(classifyUnrecoverable('fetch failed: ECONNRESET')).toBeUndefined()
    expect(classifyUnrecoverable('')).toBeUndefined()
  })
})

describe('formatting', () => {
  it('formats durations at the seconds, minutes, and hours scale', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  it('formats token counts plainly below a thousand and with k/M above', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })

  it('summarizes a goal as duration, turns, and tokens', () => {
    expect(summaryText({ condition: 'c', durationMs: 65_000, iterations: 1, tokens: 2000 })).toBe('1m 5s · 1 turn · 2.0k tokens')
    expect(summaryText({ condition: 'c', durationMs: 1000, iterations: 3, tokens: 10 })).toBe('1s · 3 turns · 10 tokens')
  })

  it('formats an active goal with the evaluation count, the last reason, and the clear hint', () => {
    const fresh = formatActiveGoal({ condition: 'tests pass', durationMs: 5000, iterations: 0, tokens: 0 })
    expect(fresh).toContain('Goal active: tests pass (not yet evaluated)')
    expect(fresh).toContain('Running for 5s · 0 tokens')
    expect(fresh).not.toContain('Last check')
    expect(fresh).toContain('/goal clear to stop early')

    const checked = formatActiveGoal({ condition: 'tests pass', durationMs: 5000, iterations: 2, tokens: 1500, lastReason: 'lint red' })
    expect(checked).toContain('Goal active: tests pass (2 turns)')
    expect(checked).toContain('Last check: lint red')
  })

  it('formats an achieved goal with its summary and the set-another hint', () => {
    const text = formatAchievedGoal({ condition: 'tests pass', durationMs: 120_000, iterations: 4, tokens: 30_000 })
    expect(text).toContain('Goal achieved: tests pass (2m 0s · 4 turns · 30.0k tokens)')
    expect(text).toContain('/goal <condition> to set another')
  })

  it('caps the condition at 4000 characters, as Claude documents', () => {
    expect(GOAL_CONDITION_MAX_CHARS).toBe(4000)
  })
})

describe('check-ins', () => {
  it('defaults to 30 minutes and doubles per delivered check-in up to four times the base', () => {
    const base = DEFAULT_CHECKIN_MINUTES * 60_000
    expect(checkinIntervalMs({}, 0)).toBe(base)
    expect(checkinIntervalMs({}, 1)).toBe(base * 2)
    expect(checkinIntervalMs({}, 2)).toBe(base * 4)
    expect(checkinIntervalMs({}, 5)).toBe(base * 4)
  })

  it('honors CLAUDE_CODE_GOAL_CHECKIN_MINUTES, with 0 turning check-ins off and junk ignored', () => {
    expect(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '5' }, 0)).toBe(5 * 60_000)
    expect(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '5' }, 1)).toBe(10 * 60_000)
    expect(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '0' }, 0)).toBe(0)
    expect(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: 'soon' }, 0)).toBe(DEFAULT_CHECKIN_MINUTES * 60_000)
    expect(checkinIntervalMs({ CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '-3' }, 0)).toBe(DEFAULT_CHECKIN_MINUTES * 60_000)
  })

  it('lists the running work and asks for a progress check while it runs', () => {
    const text = checkinText('all tests pass', 31 * 60_000, [{ id: 'run-1', agentType: 'Explore' }], false)
    expect(text).toContain('Goal check-in: «all tests pass» is still active')
    expect(text).toContain('deferred for 31 min')
    expect(text).toContain('- run-1 · subagent Explore')
    expect(text).toContain('Check on their progress')
    expect(text).not.toContain('paused')
  })

  it('asks to continue toward the goal when the work stopped without reporting, rounding under a minute up', () => {
    const text = checkinText('all tests pass', 20_000, [], false)
    expect(text).toContain('deferred for 1 min')
    expect(text).toContain('no longer running')
    expect(text).toContain('Continue toward the goal')
  })

  it('says idle check-ins are paused on the capped delivery', () => {
    expect(checkinText('c', 60_000, [], true)).toContain('Idle check-ins are paused until your next message')
  })
})
