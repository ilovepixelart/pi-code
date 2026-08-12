import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { fromClaudeToolInput, type HookRunner, hookFiles, interpretHookResult, loadHooks, matchingCommands, runHookCommand, runPreToolUse, toClaudeToolInput } from '../extensions/hooks.ts'

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

  it('treats a comma-separated matcher as a list of exact names, like Claude', () => {
    const hook = { matcher: 'Edit, Write', hooks: [{ command: 'fmt' }] }
    expect(matchingCommands([hook], 'edit')).toEqual([{ command: 'fmt' }])
    expect(matchingCommands([hook], 'write')).toEqual([{ command: 'fmt' }])
    expect(matchingCommands([hook], 'read')).toEqual([])
  })

  it('applies a matcher with regex characters unanchored, like Claude', () => {
    // Claude documents `Edit.*` as matching NotebookEdit: the regex tests anywhere in the name.
    const hook = { matcher: 'Edit.*', hooks: [{ command: 'fmt' }] }
    expect(matchingCommands([hook], 'notebookedit')).toEqual([{ command: 'fmt' }])
    expect(matchingCommands([hook], 'read')).toEqual([])
  })

  it('treats dashes and underscores alike when matching exact names', () => {
    const hook = { matcher: 'mcp__brave-search__web_search', hooks: [{ command: 'x' }] }
    expect(matchingCommands([hook], 'mcp__brave_search__web-search')).toEqual([{ command: 'x' }])
    expect(matchingCommands([hook], 'mcp__brave_search__other')).toEqual([])
  })

  it('matches when any candidate name satisfies the matcher', () => {
    const hook = { matcher: 'mcp__github__create_issue', hooks: [{ command: 'x' }] }
    expect(matchingCommands([hook], ['github_create_issue', 'mcp__github__create_issue'])).toEqual([{ command: 'x' }])
    expect(matchingCommands([hook], ['github_create_issue'])).toEqual([])
  })

  it('matches a SessionStart matcher against the session source, not an empty string', () => {
    const hook = { matcher: 'startup', hooks: [{ command: 'setup.sh' }] }
    expect(matchingCommands([hook], 'startup')).toEqual([{ command: 'setup.sh' }])
    expect(matchingCommands([hook], 'resume')).toEqual([])
    expect(matchingCommands([hook], '')).toEqual([])
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

  it('blocks on a permissionDecision ask, since pi has no ask channel', () => {
    // Claude's "ask" means confirm-with-user; pi's tool_call return is allow-or-block,
    // so the safe mapping on a trust-gated path is block-with-reason, not a silent allow.
    const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm first' } })
    expect(interpretHookResult(0, out, '')).toEqual({ block: true, reason: 'confirm first' })
  })

  it('blocks on a top-level continue false', () => {
    expect(interpretHookResult(0, JSON.stringify({ continue: false, stopReason: 'halt' }), '')).toEqual({ block: true, reason: 'halt' })
  })

  it('allows on a clean exit', () => {
    expect(interpretHookResult(0, 'ok', '')).toEqual({ block: false })
  })
})

describe('runPreToolUse', () => {
  const config = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }] }

  it('blocks the tool when a matching hook returns a blocking result', async () => {
    const runner: HookRunner = async () => ({ code: 2, stdout: '', stderr: 'blocked', timedOut: false })
    expect(await runPreToolUse(config, 'bash', { command: 'x' }, runner)).toEqual({ block: true, reason: 'blocked' })
  })

  it('does not invoke the runner for a non-matching tool', async () => {
    let calls = 0
    const runner: HookRunner = async () => {
      calls++
      return { code: 2, stdout: '', stderr: 'blocked', timedOut: false }
    }
    expect(await runPreToolUse(config, 'edit', {}, runner)).toEqual({ block: false })
    expect(calls).toBe(0)
  })

  it('passes the tool name and input to the hook payload', async () => {
    let seen: unknown
    const runner: HookRunner = async (_command, payload) => {
      seen = payload
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    await runPreToolUse(config, 'bash', { command: 'git status' }, runner)
    expect(seen).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'git status' } })
  })

  it('reports a file-tool path as the Claude file_path field in the payload', async () => {
    const writeConfig = { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ command: 'guard.sh' }] }] }
    let seen: unknown
    const runner: HookRunner = async (_command, payload) => {
      seen = payload
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    await runPreToolUse(writeConfig, 'write', { path: 'src/a.ts', content: 'x' }, runner)
    expect(seen).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { file_path: 'src/a.ts', content: 'x' } })
  })

  it('translates a Claude-shaped updatedInput back to the pi path field', async () => {
    const writeConfig = { PreToolUse: [{ matcher: 'Write', hooks: [{ command: 'rewrite.sh' }] }] }
    const runner: HookRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { file_path: 'src/b.ts', content: 'y' } } }),
      stderr: '',
      timedOut: false,
    })
    const input: Record<string, unknown> = { path: 'src/a.ts', content: 'x' }
    await runPreToolUse(writeConfig, 'write', input, runner)
    expect(input).toEqual({ path: 'src/b.ts', content: 'y' })
  })
})

describe('tool input translation', () => {
  it('maps read/write/edit path to file_path and back', () => {
    expect(toClaudeToolInput('read', { path: 'a.ts', limit: 5 })).toEqual({ file_path: 'a.ts', limit: 5 })
    expect(fromClaudeToolInput('read', { file_path: 'a.ts', limit: 5 })).toEqual({ path: 'a.ts', limit: 5 })
  })

  it('leaves non-file tools and already-shaped inputs untouched', () => {
    expect(toClaudeToolInput('bash', { command: 'ls' })).toEqual({ command: 'ls' })
    expect(toClaudeToolInput('mcp__x__y', { path: 'a.ts' })).toEqual({ path: 'a.ts' })
    expect(toClaudeToolInput('write', { file_path: 'a.ts' })).toEqual({ file_path: 'a.ts' })
    expect(fromClaudeToolInput('write', { path: 'a.ts' })).toEqual({ path: 'a.ts' })
    expect(toClaudeToolInput('write', 'not-an-object')).toBe('not-an-object')
  })
})

describe('runHookCommand (real shell)', () => {
  it('decodes multi-byte output split across stream chunks', async () => {
    // 100KB of two-byte characters crosses many 64KB pipe boundaries. Concatenating raw
    // Buffers would mangle every code point that straddles one, and a mangled byte in a
    // hook's deny decision makes it unparseable, which reads as an allow.
    const result = await runHookCommand(`printf 'e\u0301%.0s' $(seq 1 50000)`, {}, 10_000)

    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.stdout.length).toBeGreaterThan(50_000)
  })

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

describe('runHookCommand timeout (real shell)', () => {
  it('resolves at the timeout when a grandchild of the shell holds the stdio pipes open', async () => {
    // The shell forks for a compound command, so killing only the direct child leaves
    // `sleep` holding stdout/stderr and `close` never fires.
    const started = Date.now()
    const result = await runHookCommand('echo denied >&2; sleep 30', {}, 300)

    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.timedOut).toBe(true)
  })

  it('kills the shell descendants rather than leaving them running past the timeout', async () => {
    const flag = join(tempDir(), 'grandchild-survived')
    await runHookCommand(`(sleep 1; touch ${flag}) & sleep 30`, {}, 200)
    await delay(2000)

    expect(existsSync(flag)).toBe(false)
  })

  it('reports a natural completion as not timed out', async () => {
    expect(await runHookCommand('exit 0', {}, 5000)).toMatchObject({ code: 0, timedOut: false })
  })
})

describe('runPreToolUse on a timed-out hook', () => {
  const config = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }, { command: 'second.sh' }] }] }

  it('blocks the tool rather than treating the killed hook as an allow', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command)
      return { code: 0, stdout: '', stderr: '', timedOut: true }
    }
    const decision = await runPreToolUse(config, 'bash', {}, runner)

    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('guard.sh')
    expect(run).toEqual(['guard.sh'])
  })
})
