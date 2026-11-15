import { describe, expect, it } from 'vitest'

import type { HooksConfig } from '../extensions/hooks/config.ts'
import { type HookRunner, runHookCommand, runPreToolUse } from '../extensions/hooks/index.ts'

const anchors = { cwd: '/proj', projectRoot: '/proj', home: '/home/u' }

const MONITOR_INPUT = { description: 'the watch', timeout_ms: 300000, command: 'echo hi' }
const AS_BASH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi', description: 'the watch' } }
const AS_MONITOR = { hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: MONITOR_INPUT }

interface Row {
  label: string
  matcher?: string
  if?: string
  /** The payload Claude Code 2.1.325 handed this hook for one Monitor call on `echo hi`,
   * or undefined where the hook did not run. */
  payload?: typeof AS_BASH | typeof AS_MONITOR
}

// One row per hook of the live Claude Code run; the label is the hook's command.
const ROWS: Row[] = [
  { label: 'M-Bash', matcher: 'Bash', payload: AS_BASH },
  { label: 'M-regexBash', matcher: '^Bash$', payload: AS_BASH },
  { label: 'M-BashOrRead', matcher: 'Bash|Read', payload: AS_BASH },
  { label: 'MBash-IF-Bash-echo', matcher: 'Bash', if: 'Bash(echo *)', payload: AS_BASH },
  { label: 'MBash-IF-Bash-ls', matcher: 'Bash', if: 'Bash(ls *)' },
  { label: 'MBash-IF-Monitor-echo', matcher: 'Bash', if: 'Monitor(echo *)' },
  { label: 'M-Monitor', matcher: 'Monitor', payload: AS_MONITOR },
  { label: 'M-BashOrMonitor', matcher: 'Bash|Monitor', payload: AS_MONITOR },
  { label: 'M-star', matcher: '*', payload: AS_MONITOR },
  { label: 'M-none', payload: AS_MONITOR },
  { label: 'MMon-IF-Bash-echo', matcher: 'Monitor', if: 'Bash(echo *)', payload: AS_MONITOR },
  { label: 'MMon-IF-Monitor-echo', matcher: 'Monitor', if: 'Monitor(echo *)', payload: AS_MONITOR },
]

const configOf = (rows: Row[]): HooksConfig => ({
  PreToolUse: rows.map((row) => ({ ...(row.matcher === undefined ? {} : { matcher: row.matcher }), hooks: [{ command: row.label, ...(row.if === undefined ? {} : { if: row.if }) }] })),
})

/** A runner that records each hook's payload under its command and answers with `stdout`. */
const recorder = (stdout = ''): { seen: Array<{ label: string; payload: unknown }>; runner: HookRunner } => {
  const seen: Array<{ label: string; payload: unknown }> = []
  const runner: HookRunner = async (hook, payload) => {
    seen.push({ label: hook.command, payload })
    return { code: 0, stdout, stderr: '', timedOut: false }
  }
  return { seen, runner }
}

describe('PreToolUse on a monitor call', () => {
  it.each(ROWS)('$label: matcher $matcher, if $if', async (row) => {
    const { seen, runner } = recorder()
    await runPreToolUse(configOf([row]), 'monitor', { ...MONITOR_INPUT }, runner, undefined, undefined, anchors)
    expect(seen).toEqual(row.payload === undefined ? [] : [{ label: row.label, payload: row.payload }])
  })

  it('runs every hook of the whole table at most once in one call', async () => {
    const { seen, runner } = recorder()
    await runPreToolUse(configOf(ROWS), 'monitor', { ...MONITOR_INPUT }, runner, undefined, undefined, anchors)
    const expected = ROWS.filter((row) => row.payload !== undefined).map((row) => row.label)
    expect(seen.map((run) => run.label).sort()).toEqual([...expected].sort())
  })

  it('treats a regex that meets Bash as a Bash matcher, and one that meets Monitor as a Monitor matcher', async () => {
    const { seen, runner } = recorder()
    const rows: Row[] = [
      { label: 'prefix', matcher: 'Bash.*' },
      { label: 'either', matcher: '^(Bash|Monitor)$' },
      { label: 'other', matcher: 'Read' },
    ]
    await runPreToolUse(configOf(rows), 'monitor', { ...MONITOR_INPUT }, runner, undefined, undefined, anchors)
    expect(seen).toEqual([
      { label: 'either', payload: AS_MONITOR },
      { label: 'prefix', payload: AS_BASH },
    ])
  })

  it('blocks the call when a real guard under a Bash matcher exits 2', async () => {
    const config: HooksConfig = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'cat >/dev/null; echo GUARD-BLOCK >&2; exit 2' }] }] }
    const spawned: HookRunner = (hook, payload, ms) => runHookCommand(hook.command, payload, ms)
    expect(await runPreToolUse(config, 'monitor', { description: 'probe', command: 'rm -rf build' }, spawned, undefined, undefined, anchors)).toEqual({ block: true, reason: 'GUARD-BLOCK' })
  })

  it.each([
    ['permissionDecision deny', { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no watches' } }],
    ['decision block', { decision: 'block', reason: 'no watches' }],
  ])('blocks the call on a %s from a Bash-matched hook', async (_name, output) => {
    const { runner } = recorder(JSON.stringify(output))
    expect(await runPreToolUse(configOf([{ label: 'guard', matcher: 'Bash' }]), 'monitor', { ...MONITOR_INPUT }, runner, undefined, undefined, anchors)).toEqual({ block: true, reason: 'no watches' })
  })

  it('ignores an allow and an updatedInput from a Bash-matched hook', async () => {
    const input = { ...MONITOR_INPUT }
    const { seen, runner } = recorder(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'echo rewritten', description: 'rewritten' } } }))
    const decision = await runPreToolUse(configOf([{ label: 'rewriter', matcher: 'Bash' }]), 'monitor', input, runner, undefined, undefined, anchors)
    expect(seen).toHaveLength(1)
    expect(input).toEqual(MONITOR_INPUT)
    expect(decision).toEqual({ block: false, context: undefined })
  })

  it('does not let an allow from a Bash-matched hook outvote an ask from a Monitor-matched one', async () => {
    const config = configOf([
      { label: 'asker', matcher: 'Monitor' },
      { label: 'allower', matcher: 'Bash' },
    ])
    const runner: HookRunner = async (hook) => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: hook.command === 'asker' ? 'ask' : 'allow', permissionDecisionReason: 'confirm' } }), stderr: '', timedOut: false })
    expect(await runPreToolUse(config, 'monitor', { ...MONITOR_INPUT }, runner, undefined, undefined, anchors)).toEqual({ block: true, ask: true, reason: 'confirm' })
  })

  it('still applies an updatedInput from a Monitor-matched hook', async () => {
    const input: Record<string, unknown> = { ...MONITOR_INPUT }
    const { runner } = recorder(JSON.stringify({ hookSpecificOutput: { updatedInput: { description: 'the watch', command: 'echo rewritten' } } }))
    await runPreToolUse(configOf([{ label: 'rewriter', matcher: 'Monitor' }]), 'monitor', input, runner, undefined, undefined, anchors)
    expect(input).toEqual({ description: 'the watch', command: 'echo rewritten' })
  })
})

describe('PreToolUse on a bash call beside the monitor bridge', () => {
  it('runs the same hooks with the same Bash payload, each once', async () => {
    const { seen, runner } = recorder()
    await runPreToolUse(configOf(ROWS), 'bash', { command: 'echo hi', timeout: 5 }, runner, undefined, undefined, anchors)
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi', timeout: 5000 } }
    const ran = ['M-Bash', 'M-regexBash', 'M-BashOrRead', 'MBash-IF-Bash-echo', 'M-BashOrMonitor', 'M-star', 'M-none']
    expect(seen).toEqual(ran.map((label) => ({ label, payload })))
  })

  it('still applies an updatedInput from a Bash-matched hook to a bash call', async () => {
    const input: Record<string, unknown> = { command: 'echo hi' }
    const { runner } = recorder(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'echo rewritten' } } }))
    await runPreToolUse(configOf([{ label: 'rewriter', matcher: 'Bash' }]), 'bash', input, runner, undefined, undefined, anchors)
    expect(input).toEqual({ command: 'echo rewritten' })
  })
})
