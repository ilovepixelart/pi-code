import { describe, expect, it } from 'vitest'

import { type BackgroundRun, formatStatus, parseFinalOutputFromJsonl } from '../extensions/subagent/background.ts'

describe('background subagent helpers', () => {
  it('parses the final assistant text and turn count from jsonl', () => {
    const jsonl = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      'not json at all',
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'ignored' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }),
    ].join('\n')
    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'final answer', turns: 2 })
  })

  it('returns empty result for garbage input', () => {
    expect(parseFinalOutputFromJsonl('')).toEqual({ text: '', turns: 0 })
  })

  it('formats run status lines', () => {
    const runs: BackgroundRun[] = [
      { id: 'bg-1', agent: 'scout', task: 'find things', state: 'running', turns: 0 },
      { id: 'bg-2', agent: 'worker', task: 'do things', state: 'done', exitCode: 0, turns: 3 },
    ]
    const text = formatStatus(runs)
    expect(text).toContain('bg-1 scout: running')
    expect(text).toContain('bg-2 worker: done (exit 0, 3 turns)')
    expect(formatStatus([])).toContain('No background runs')
  })
})
