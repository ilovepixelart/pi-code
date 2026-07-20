import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type HookRunner, hookFiles, interpretHookResult, loadHooks, matchingCommands, runHookCommand, runPreToolUse } from '../extensions/hooks.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'hooks-'))

describe('hookFiles', () => {
  it('always includes user settings and adds project settings only when trusted', () => {
    expect(hookFiles('/proj', '/home', false)).toEqual(['/home/.claude/settings.json'])
    expect(hookFiles('/proj', '/home', true)).toEqual(['/home/.claude/settings.json', '/proj/.claude/settings.json', '/proj/.claude/settings.local.json'])
  })
})

describe('loadHooks', () => {
  it('merges hook entries across files and skips missing or invalid ones', () => {
    const dir = tempDir()
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    const broken = join(dir, 'broken.json')
    writeFileSync(a, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'one' }] }] } }))
    writeFileSync(b, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'two' }] }] } }))
    writeFileSync(broken, '{not json')

    const config = loadHooks([a, join(dir, 'absent.json'), broken, b])
    expect(config.PreToolUse).toHaveLength(2)
    expect(config.PreToolUse.map((m) => m.matcher)).toEqual(['Bash', 'Edit'])
  })
})

describe('matchingCommands', () => {
  const bashHook = { matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }

  it('matches a Claude PascalCase matcher against a lowercase pi tool name', () => {
    expect(matchingCommands([bashHook], 'bash')).toEqual([{ command: 'guard.sh' }])
  })

  it('does not match an unrelated tool', () => {
    expect(matchingCommands([bashHook], 'edit')).toEqual([])
  })

  it('treats an absent, empty, or * matcher as match-all', () => {
    expect(matchingCommands([{ hooks: [{ command: 'x' }] }], 'anything')).toEqual([{ command: 'x' }])
    expect(matchingCommands([{ matcher: '*', hooks: [{ command: 'y' }] }], 'anything')).toEqual([{ command: 'y' }])
  })

  it('honors regex alternation in the matcher', () => {
    const hook = { matcher: 'Edit|Write', hooks: [{ command: 'fmt' }] }
    expect(matchingCommands([hook], 'write')).toEqual([{ command: 'fmt' }])
    expect(matchingCommands([hook], 'read')).toEqual([])
  })
})

describe('interpretHookResult', () => {
  it('blocks on exit code 2 with stderr as the reason', () => {
    expect(interpretHookResult(2, '', 'no force push')).toEqual({ block: true, reason: 'no force push' })
  })

  it('blocks on a permissionDecision deny JSON', () => {
    const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' } })
    expect(interpretHookResult(0, out, '')).toEqual({ block: true, reason: 'nope' })
  })

  it('blocks on the legacy decision block JSON', () => {
    expect(interpretHookResult(0, JSON.stringify({ decision: 'block', reason: 'stop' }), '')).toEqual({ block: true, reason: 'stop' })
  })

  it('allows on a clean exit', () => {
    expect(interpretHookResult(0, 'ok', '')).toEqual({ block: false })
  })
})

describe('runPreToolUse', () => {
  const config = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }] }

  it('blocks the tool when a matching hook returns a blocking result', async () => {
    const runner: HookRunner = async () => ({ code: 2, stdout: '', stderr: 'blocked' })
    expect(await runPreToolUse(config, 'bash', { command: 'x' }, runner)).toEqual({ block: true, reason: 'blocked' })
  })

  it('does not invoke the runner for a non-matching tool', async () => {
    let calls = 0
    const runner: HookRunner = async () => {
      calls++
      return { code: 2, stdout: '', stderr: 'blocked' }
    }
    expect(await runPreToolUse(config, 'edit', {}, runner)).toEqual({ block: false })
    expect(calls).toBe(0)
  })

  it('passes the tool name and input to the hook payload', async () => {
    let seen: unknown
    const runner: HookRunner = async (_command, payload) => {
      seen = payload
      return { code: 0, stdout: '', stderr: '' }
    }
    await runPreToolUse(config, 'bash', { command: 'git status' }, runner)
    expect(seen).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'git status' } })
  })
})

describe('runHookCommand (real shell)', () => {
  it('captures a non-zero exit code and stderr', async () => {
    const result = await runHookCommand('echo boom >&2; exit 2', {}, 5000)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('boom')
  })

  it('delivers the payload as JSON on stdin', async () => {
    const result = await runHookCommand('cat', { tool_name: 'bash' }, 5000)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('"tool_name":"bash"')
  })
})
