import { describe, expect, it } from 'vitest'

import { taskWithStartContext } from '../extensions/subagent/child.ts'

/**
 * S5: the assembled string is the whole of one argv element handed to a spawned
 * child (run.ts's `args.push(taskWithStartContext(...))`, `shell: false`). Linux
 * enforces MAX_ARG_STRLEN, a per-argument limit of 128KiB distinct from the much
 * larger total ARG_MAX; confirmed on real ubuntu CI runners (tests/argv-limit-probe
 * .test.ts) that a single argv string over it fails execve with E2BIG. Neither the
 * model's task text nor a SubagentStart hook's additionalContext is capped
 * upstream, so the assembled string must cap itself.
 */
describe('taskWithStartContext stays under the Linux argv limit', () => {
  it('caps a task far larger than the 128KiB argv limit', () => {
    const huge = 'x'.repeat(500 * 1024)
    const result = taskWithStartContext(huge, [])
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(128 * 1024)
  })

  it('caps hook context that alone would already exceed the limit', () => {
    const hugeContext = 'y'.repeat(500 * 1024)
    const result = taskWithStartContext('short task', [hugeContext])
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(128 * 1024)
  })

  it('leaves an ordinary task and context untouched', () => {
    const result = taskWithStartContext('do the thing', ['some context'])
    expect(result).toBe('some context\n\nTask: do the thing')
  })

  it('notes what was cut, so the model knows its own instructions were trimmed', () => {
    const huge = 'x'.repeat(500 * 1024)
    const result = taskWithStartContext(huge, [])
    expect(result).toContain('truncated')
  })
})
