import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatHooksSummary,
  type HookRunner,
  hookFiles,
  httpUrlAllowed,
  interpretHookResult,
  lastAssistantText,
  loadHooks,
  matcherCompileCount,
  matchingCommands,
  readAllowedHttpHookUrls,
  readDisableAllHooks,
  resetMatcherCache,
  runAgentHook,
  runHookCommand,
  runHttpHook,
  runMcpToolHook,
  runPreToolUse,
  runPromptHook,
  stopHookBlockCap,
} from '../extensions/hooks/index.ts'
import { setAgentRunner } from '../extensions/internal/agent-run.ts'
import { setMcpToolCaller } from '../extensions/internal/mcp-call.ts'
import { setCompleteBackend } from '../extensions/internal/model-complete.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'hooks-'))

const fakeModel = {} as never

describe('runPromptHook', () => {
  afterEach(() => setCompleteBackend(null))

  it('substitutes $ARGUMENTS with the event JSON and returns the model decision as stdout', async () => {
    let sentPrompt = ''
    setCompleteBackend(async (_m, context) => {
      sentPrompt = String(context.messages[0]?.content ?? '')
      return { role: 'assistant', content: [{ type: 'text', text: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 } as never
    })
    const result = await runPromptHook({ type: 'prompt', command: '', prompt: 'Decide about $ARGUMENTS' }, { hook_event_name: 'PreToolUse', tool_name: 'bash' }, fakeModel, 30_000)
    expect(result).toMatchObject({ code: 0, timedOut: false })
    // The decision flows through the same interpreter as a command hook's stdout.
    expect(interpretHookResult(result.code, result.stdout, result.stderr)).toEqual({ block: true, reason: 'blocked by policy' })
    expect(sentPrompt).toContain('"tool_name":"bash"')
    expect(sentPrompt).toContain('Decide about')
  })

  it('is non-blocking when no model is available', async () => {
    const result = await runPromptHook({ type: 'prompt', command: '', prompt: 'x' }, {}, undefined, 30_000)
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.code).not.toBe(2)
  })

  it('is non-blocking when the completion errors (not a timeout)', async () => {
    setCompleteBackend(async () => {
      throw new Error('provider down')
    })
    const result = await runPromptHook({ type: 'prompt', command: '', prompt: 'x' }, {}, fakeModel, 30_000)
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.code).not.toBe(2)
  })

  it('substitutes $ARGUMENTS literally, not interpreting $-sequences in the payload', async () => {
    // JSON.stringify used as a string replacement would treat `$$` in the payload as
    // the `$` escape; a shell command like `echo $$` is a common trigger.
    let sentPrompt = ''
    setCompleteBackend(async (_m, context) => {
      sentPrompt = String(context.messages[0]?.content ?? '')
      return { role: 'assistant', content: [{ type: 'text', text: '{}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 } as never
    })
    await runPromptHook({ type: 'prompt', command: '', prompt: 'Check $ARGUMENTS now' }, { hook_event_name: 'PreToolUse', tool_input: { command: "a $$ b $& c $' d" } }, fakeModel, 30_000)
    expect(sentPrompt).toContain("a $$ b $& c $' d")
  })

  it('reports a timeout so PreToolUse fails closed when the model is aborted', async () => {
    setCompleteBackend(async (_m, _c, options) => {
      // Simulate the abort signal firing: reject as an aborted request would.
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    })
    const result = await runPromptHook({ type: 'prompt', command: '', prompt: 'x' }, {}, fakeModel, 30)
    expect(result.timedOut).toBe(true)
  })
})

describe('stopHookBlockCap', () => {
  it('defaults to 8 and honors a positive integer CLAUDE_CODE_STOP_HOOK_BLOCK_CAP override', () => {
    expect(stopHookBlockCap({})).toBe(8)
    expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '3' })).toBe(3)
    // Negative or malformed values fall back to the default rather than capping at 0.
    expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '-2' })).toBe(8)
    expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: 'lots' })).toBe(8)
  })

  it('disables the cap entirely for the documented 0', () => {
    // Claude: "Set to `0` to disable the cap."
    expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '0' })).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('runHookCommand exec form (real shell)', () => {
  // POSIX-only: spawns the real /bin/echo binary, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('spawns the executable directly with no shell, so metacharacters in args stay literal', async () => {
    // Through /bin/sh these would be command-substituted or split; exec-form passes
    // each arg through untouched.
    const result = await runHookCommand('/bin/echo', {}, 5000, undefined, ['$(whoami)', 'a;b', '$HOME'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('$(whoami) a;b $HOME\n')
  })

  // POSIX-only: spawns the real /bin/echo binary, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('delivers the payload on stdin and substitutes $ARGUMENTS per arg from the payload', async () => {
    const payload = { k: 'v' }
    const result = await runHookCommand('/bin/echo', payload, 5000, undefined, ['$ARGUMENTS'])
    expect(result.stdout).toBe(`${JSON.stringify(payload)}\n`)
  })
})

describe('lastAssistantText', () => {
  it('returns the text of the last assistant message, joining its text parts', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'x' },
          { type: 'text', text: 'done: ' },
          { type: 'text', text: 'ok' },
        ],
      },
      { role: 'tool_result', content: 'r' },
    ]
    expect(lastAssistantText(messages as never)).toBe('done: ok')
  })

  it('handles a plain string assistant content and returns empty when none', () => {
    expect(lastAssistantText([{ role: 'assistant', content: 'plain' }] as never)).toBe('plain')
    expect(lastAssistantText([{ role: 'user', content: 'hi' }] as never)).toBe('')
    expect(lastAssistantText([] as never)).toBe('')
  })
})

describe('runMcpToolHook', () => {
  afterEach(() => setMcpToolCaller(undefined))

  it('calls the named server tool and returns its text as stdout', async () => {
    let seen: unknown
    setMcpToolCaller(async (server, tool, input) => {
      seen = { server, tool, input }
      return { text: 'server says ok', isError: false }
    })
    const result = await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'lint', input: { strict: true } }, { hook_event_name: 'PreToolUse' }, 5000)
    expect(result).toMatchObject({ code: 0, stdout: 'server says ok', timedOut: false })
    expect(seen).toEqual({ server: 'gh', tool: 'lint', input: { strict: true } })
  })

  it('calls with no arguments when the hook declares no input, per the documented field', async () => {
    // Claude's `input` field is optional: without it the tool is called with no
    // arguments, not handed the whole event payload.
    let seenInput: unknown
    setMcpToolCaller(async (_s, _t, input) => {
      seenInput = input
      return { text: '', isError: false }
    })
    await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'lint' }, { hook_event_name: 'PreToolUse', tool_name: 'bash' }, 5000)
    expect(seenInput).toEqual({})
  })

  it('substitutes ${path} references from the hook JSON input into string values', async () => {
    // Claude: "String values support ${path} substitution from the hook's JSON
    // input, such as ${tool_input.file_path}".
    let seenInput: unknown
    setMcpToolCaller(async (_s, _t, input) => {
      seenInput = input
      return { text: '', isError: false }
    })
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/src/a.ts' } }
    const input = { file_path: '${tool_input.file_path}', label: 'checked ${tool_name}', nested: { p: '${tool_input.file_path}' } }
    await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'scan', input }, payload, 5000)
    expect(seenInput).toEqual({ file_path: '/src/a.ts', label: 'checked Edit', nested: { p: '/src/a.ts' } })
  })

  it('leaves a ${path} that resolves to nothing as literal text', async () => {
    let seenInput: unknown
    setMcpToolCaller(async (_s, _t, input) => {
      seenInput = input
      return { text: '', isError: false }
    })
    await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'scan', input: { x: '${no.such.path}' } }, { hook_event_name: 'PreToolUse' }, 5000)
    expect(seenInput).toEqual({ x: '${no.such.path}' })
  })

  it('clears its deadline timer once the call settles instead of pinning the event loop', async () => {
    // The unclosed 60s deadline timer kept a one-shot headless run alive for the
    // full timeout after the call had long resolved.
    vi.useFakeTimers()
    try {
      setMcpToolCaller(async () => ({ text: 'ok', isError: false }))
      await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'lint' }, {}, 60_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is non-blocking on a server error, a missing caller, or missing fields', async () => {
    setMcpToolCaller(async () => ({ text: 'boom', isError: true }))
    const errored = await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'lint' }, {}, 5000)
    expect(errored).toMatchObject({ code: 1, timedOut: false })
    setMcpToolCaller(undefined)
    const noCaller = await runMcpToolHook({ type: 'mcp_tool', command: '', server: 'gh', tool: 'lint' }, {}, 5000)
    expect(noCaller.timedOut).toBe(false)
    expect(noCaller.code).not.toBe(0)
    const noFields = await runMcpToolHook({ type: 'mcp_tool', command: '' }, {}, 5000)
    expect(noFields.code).not.toBe(0)
  })
})

describe('runAgentHook', () => {
  afterEach(() => setAgentRunner(undefined))

  it('substitutes $ARGUMENTS, passes model/systemPrompt, and returns the decision as stdout', async () => {
    let seen: unknown
    setAgentRunner(async (req) => {
      seen = req
      return '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"reads /etc"}}'
    })
    const result = await runAgentHook({ type: 'agent', command: '', prompt: 'Inspect $ARGUMENTS', model: 'fast-1', systemPrompt: 'be strict' }, { hook_event_name: 'PreToolUse', tool_name: 'bash' }, 60_000, undefined)
    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(interpretHookResult(result.code, result.stdout, result.stderr)).toEqual({ block: true, reason: 'reads /etc' })
    expect(seen).toMatchObject({ model: 'fast-1', systemPrompt: 'be strict' })
    expect((seen as { prompt: string }).prompt).toContain('"tool_name":"bash"')
    expect((seen as { prompt: string }).prompt).toContain('Inspect ')
  })

  it('falls back to the session model id when the hook names none', async () => {
    let seenModel: unknown
    setAgentRunner(async (req) => {
      seenModel = req.model
      return ''
    })
    await runAgentHook({ type: 'agent', command: '', prompt: 'x' }, {}, 60_000, 'session-model')
    expect(seenModel).toBe('session-model')
  })

  it('is non-blocking when no runner is registered or the run errors', async () => {
    const noRunner = await runAgentHook({ type: 'agent', command: '', prompt: 'x' }, {}, 60_000, undefined)
    expect(noRunner.timedOut).toBe(false)
    expect(noRunner.code).not.toBe(0)
    expect(noRunner.code).not.toBe(2)

    setAgentRunner(async () => {
      throw new Error('subagent crashed')
    })
    const errored = await runAgentHook({ type: 'agent', command: '', prompt: 'x' }, {}, 60_000, undefined)
    expect(errored.timedOut).toBe(false)
    expect(errored.code).not.toBe(0)
  })

  it('substitutes $ARGUMENTS literally, not interpreting $-sequences in the payload', async () => {
    let seenPrompt = ''
    setAgentRunner(async (req) => {
      seenPrompt = req.prompt
      return '{}'
    })
    await runAgentHook({ type: 'agent', command: '', prompt: 'Inspect $ARGUMENTS' }, { tool_input: { command: 'echo $$' } }, 60_000, undefined)
    expect(seenPrompt).toContain('echo $$')
  })

  it('reports a timeout so PreToolUse fails closed even when the runner throws a plain abort error', async () => {
    // The real subagent runner rejects with a generic Error('Subagent was aborted')
    // on abort, whose name is not AbortError, so the deadline must be detected via the
    // signal, not the error name, or a hung PreToolUse agent hook fails open.
    setAgentRunner(
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('Subagent was aborted')))
        }),
    )
    const result = await runAgentHook({ type: 'agent', command: '', prompt: 'x' }, {}, 20, undefined)
    expect(result.timedOut).toBe(true)
  })
})

describe('hookFiles', () => {
  it('always includes user settings and adds project settings only when trusted', () => {
    expect(hookFiles('/proj', '/home', false)).toEqual([join('/home', '.claude', 'settings.json')])
    expect(hookFiles('/proj', '/home', true)).toEqual([join('/home', '.claude', 'settings.json'), join('/proj', '.claude', 'settings.json'), join('/proj', '.claude', 'settings.local.json')])
  })

  it('reads settings.json from the primary working directory and settings.local.json from the repository root', () => {
    // Claude: "reads the shared .claude/settings.json from the session's primary
    // working directory" (never an ancestor), while settings.local.json lives at
    // the repository root; a legacy cwd-local file is still read, root winning.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}')
    const sub = join(repo, 'src')
    mkdirSync(sub)
    expect(hookFiles(sub, '/home', true)).toEqual([join('/home', '.claude', 'settings.json'), join(sub, '.claude', 'settings.json'), join(sub, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.local.json')])
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

  it('records the source settings file for each merged entry', () => {
    const dir = tempDir()
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeFileSync(a, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'one' }] }] } }))
    writeFileSync(b, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'two' }] }] } }))

    const sources = new Map()
    const config = loadHooks([a, b], sources)
    expect(sources.get(config.PreToolUse[0])).toBe(a)
    expect(sources.get(config.PreToolUse[1])).toBe(b)
  })
})

describe('readDisableAllHooks', () => {
  it('is false when no settings file sets it or files are missing', () => {
    const dir = tempDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: {} }))
    expect(readDisableAllHooks([file, join(dir, 'absent.json')], {})).toBe(false)
  })

  it('is true when any file in the chain sets it, and a later false cannot re-enable', () => {
    // The escape hatch reading: a repository file must not be able to turn back on
    // the hooks a user settings file just disabled.
    const dir = tempDir()
    const user = join(dir, 'user.json')
    const local = join(dir, 'local.json')
    writeFileSync(user, JSON.stringify({ disableAllHooks: true }))
    writeFileSync(local, JSON.stringify({ disableAllHooks: false }))
    expect(readDisableAllHooks([user, local], {})).toBe(true)
    expect(readDisableAllHooks([local], {})).toBe(false)
  })

  it('ignores non-boolean truthy values and malformed files', () => {
    const dir = tempDir()
    const junk = join(dir, 'junk.json')
    const broken = join(dir, 'broken.json')
    writeFileSync(junk, JSON.stringify({ disableAllHooks: 'yes' }))
    writeFileSync(broken, '{not json')
    expect(readDisableAllHooks([junk, broken], {})).toBe(false)
  })

  it('honors a managed-settings disableAllHooks with no chain file setting it', () => {
    expect(readDisableAllHooks([], { disableAllHooks: true })).toBe(true)
    expect(readDisableAllHooks([], { disableAllHooks: false })).toBe(false)
  })
})

describe('formatHooksSummary', () => {
  it('groups hooks by event with matcher, identity and source settings file', () => {
    const preA = { matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }
    const preB = {
      hooks: [
        { type: 'http', url: 'https://ci.example/hook' },
        { type: 'mcp_tool', server: 'gh', tool: 'lint' },
      ],
    }
    const stop = { matcher: '*', hooks: [{ type: 'prompt', prompt: 'done yet?' }] }
    const config = { PreToolUse: [preA, preB], Stop: [stop] }
    const sources = new Map<object, string>([
      [preA, '/home/.claude/settings.json'],
      [preB, '/proj/.claude/settings.json'],
    ])

    expect(formatHooksSummary(config as never, sources as never)).toBe(['PreToolUse:', '  [Bash] command: guard.sh (/home/.claude/settings.json)', '  [*] http: https://ci.example/hook (/proj/.claude/settings.json)', '  [*] mcp_tool: gh:lint (/proj/.claude/settings.json)', 'Stop:', '  [*] prompt: done yet?'].join('\n'))
  })

  it('shows an agent hook by its prompt and a typeless entry as a command', () => {
    const text = formatHooksSummary({
      Stop: [{ hooks: [{ type: 'agent', prompt: 'verify the tests ran' }, { command: 'notify.sh' }] }],
    } as never)
    expect(text).toContain('  [*] agent: verify the tests ran')
    expect(text).toContain('  [*] command: notify.sh')
  })

  it('notes when no hooks are configured, including for entries with empty hook lists', () => {
    expect(formatHooksSummary({})).toContain('No hooks configured')
    expect(formatHooksSummary({ PreToolUse: [{ matcher: 'Bash', hooks: [] }] } as never)).toContain('No hooks configured')
  })

  it('names a null hook entry instead of crashing the viewer', () => {
    const text = formatHooksSummary({ PreToolUse: [{ matcher: 'Bash', hooks: [null] }] } as never)
    expect(text).toContain('  [Bash] command: (missing command)')
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

describe('matcher compilation', () => {
  it('compiles each distinct matcher once across repeated dispatches, not once per event', () => {
    resetMatcherCache()
    const matchers = [
      { matcher: 'Edit, Write', hooks: [{ command: 'fmt' }] },
      { matcher: 'Edit.*', hooks: [{ command: 'lint' }] },
    ]
    for (let i = 0; i < 5; i += 1) {
      expect(matchingCommands(matchers, 'write').map((hook) => hook.command)).toEqual(['fmt'])
      expect(matchingCommands(matchers, 'notebookedit').map((hook) => hook.command)).toEqual(['lint'])
    }
    expect(matcherCompileCount()).toBe(2)
  })

  it('memoizes the exact-list fallback of an invalid regex without changing its outcome', () => {
    resetMatcherCache()
    // `Bash(, Edit` fails the exact-matcher shape and does not compile as a regex,
    // so it falls back to exact-name matching on its comma-split tokens.
    const invalid = [{ matcher: 'Bash(, Edit', hooks: [{ command: 'guard.sh' }] }]
    for (let i = 0; i < 5; i += 1) {
      expect(matchingCommands(invalid, 'edit')).toEqual([{ command: 'guard.sh' }])
      expect(matchingCommands(invalid, 'bash')).toEqual([])
    }
    expect(matcherCompileCount()).toBe(1)
  })

  it('does not compile an absent or wildcard matcher', () => {
    resetMatcherCache()
    matchingCommands([{ hooks: [{ command: 'a' }] }, { matcher: '*', hooks: [{ command: 'b' }] }], 'anything')
    expect(matcherCompileCount()).toBe(0)
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

  it('marks a permissionDecision ask so the caller can prompt, blocking as the fallback', () => {
    // Claude's "ask" prompts the user; the tool_call handler turns ask into a
    // ctx.ui.confirm. block:true stands in for a headless run with no dialog.
    const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm first' } })
    expect(interpretHookResult(0, out, '')).toEqual({ block: true, ask: true, reason: 'confirm first' })
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

  it('surfaces an ask decision so the caller can prompt', async () => {
    const runner: HookRunner = async () => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm' } }), stderr: '', timedOut: false })
    expect(await runPreToolUse(config, 'bash', {}, runner)).toEqual({ block: true, ask: true, reason: 'confirm' })
  })

  it('prefers a hard deny over an ask, matching Claude deny > ask precedence', async () => {
    const two = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'a.sh' }, { command: 'b.sh' }] }] }
    const runner: HookRunner = async (hook) =>
      hook.command === 'a.sh'
        ? { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'maybe' } }), stderr: '', timedOut: false }
        : { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }), stderr: '', timedOut: false }
    expect(await runPreToolUse(two, 'bash', {}, runner)).toEqual({ block: true, reason: 'no' })
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
    // Built-ins report Claude's name in the payload; the matcher still sees both.
    expect(seen).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } })
  })
})

describe('runHookCommand (real shell)', () => {
  // POSIX-only: runHookCommand's shell path spawns /bin/sh, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('decodes multi-byte output split across stream chunks', async () => {
    // 100KB of two-byte characters crosses many 64KB pipe boundaries. Concatenating raw
    // Buffers would mangle every code point that straddles one, and a mangled byte in a
    // hook's deny decision makes it unparseable, which reads as an allow.
    const result = await runHookCommand(`printf 'e\u0301%.0s' $(seq 1 50000)`, {}, 10_000)

    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.stdout.length).toBeGreaterThan(50_000)
  })

  // POSIX-only: runHookCommand's shell path spawns /bin/sh, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('captures a non-zero exit code and stderr', async () => {
    const result = await runHookCommand('echo boom >&2; exit 2', {}, 5000)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('boom')
  })

  // POSIX-only: runHookCommand's shell path spawns /bin/sh, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('delivers the payload as JSON on stdin', async () => {
    const result = await runHookCommand('cat', { tool_name: 'bash' }, 5000)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('"tool_name":"bash"')
  })
})

describe('runHookCommand timeout (real shell)', () => {
  // POSIX-only: runHookCommand's shell path spawns /bin/sh, which does not exist on Windows.
  it.skipIf(process.platform === 'win32')('resolves at the timeout when a grandchild of the shell holds the stdio pipes open', async () => {
    // The shell forks for a compound command, so killing only the direct child leaves
    // `sleep` holding stdout/stderr and `close` never fires.
    const started = Date.now()
    const result = await runHookCommand('echo denied >&2; sleep 30', {}, 300)

    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.timedOut).toBe(true)
  })

  // POSIX-only: /bin/sh process groups and negative-pid kill(0) probes are POSIX semantics.
  it.skipIf(process.platform === 'win32')('kills the shell descendants rather than leaving them running past the timeout', async () => {
    const dir = tempDir()
    const flag = join(dir, 'grandchild-survived')
    const pidFile = join(dir, 'group.pid')
    // The detached shell records its own pid (the process-group leader) so the test can
    // watch the whole group, then backgrounds a grandchild that would touch the flag after
    // 500ms. A 200ms timeout must SIGKILL the group before the grandchild's delay elapses.
    await runHookCommand(`echo $$ > ${pidFile}; (sleep 0.5; touch ${flag}) & sleep 30`, {}, 200)
    const pgid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pgid).toBeGreaterThan(0)

    // Bounded poll rather than a fixed sleep: watch for the group to disappear (kill -0
    // throws ESRCH once every member is gone) while asserting the grandchild's flag never
    // lands. Fast when the kill is prompt, flake-free in both directions.
    const groupGone = (): boolean => {
      try {
        process.kill(-pgid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
    const deadline = Date.now() + 2000
    while (!groupGone()) {
      expect(existsSync(flag)).toBe(false)
      if (Date.now() > deadline) throw new Error('shell process group still alive 2s past the timeout')
      await delay(50)
    }
    expect(existsSync(flag)).toBe(false)
  })

  it('reports a natural completion as not timed out', async () => {
    expect(await runHookCommand('exit 0', {}, 5000)).toMatchObject({ code: 0, timedOut: false })
  })
})

describe('http hooks', () => {
  const serve = async (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    return {
      url: `http://127.0.0.1:${address.port}/hook`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }
  }

  const httpRunner: HookRunner = (hook, payload, ms) => runHttpHook(hook, payload, ms)

  // Env stubs restore even if an assertion throws mid-test, so a failure cannot leak
  // HOOK_TOKEN/HOOK_SECRET into sibling tests.
  afterEach(() => vi.unstubAllEnvs())

  it('loads an http entry and blocks on a 2xx body carrying a deny decision', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } }))
    })
    const file = join(tempDir(), 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: srv.url }] }] } }))
    const config = loadHooks([file])

    const decision = await runPreToolUse(config, 'bash', {}, httpRunner)
    await srv.close()

    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('nope')
  })

  it('posts the payload as JSON and interpolates only allowlisted env vars into headers', async () => {
    let seenAuth = ''
    let seenOther = ''
    let seenBody = ''
    const srv = await serve((req, res) => {
      seenAuth = String(req.headers.authorization ?? '')
      seenOther = String(req.headers['x-other'] ?? '')
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        seenBody = body
        res.writeHead(200)
        res.end()
      })
    })
    vi.stubEnv('HOOK_TOKEN', 'tok123')
    vi.stubEnv('HOOK_SECRET', 'leakme')
    const hook = { type: 'http', command: srv.url, url: srv.url, headers: { Authorization: 'Bearer $HOOK_TOKEN', 'X-Other': '${HOOK_SECRET}' }, allowedEnvVars: ['HOOK_TOKEN'] }

    const result = await runHttpHook(hook, { hook_event_name: 'PreToolUse', tool_name: 'bash' }, 5000)
    await srv.close()

    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(seenAuth).toBe('Bearer tok123')
    expect(seenOther).toBe('')
    expect(JSON.parse(seenBody).tool_name).toBe('bash')
  })

  it('treats non-2xx, non-JSON bodies and unreachable endpoints as non-blocking', async () => {
    // Claude: an http hook cannot block through status codes or failures; only a
    // 2xx JSON decision blocks. A timeout renders no decision either, so none of
    // these may ever read as timedOut, which PreToolUse fails closed on.
    const srvError = await serve((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    const srvText = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not json')
    })
    const failing = await runHttpHook({ type: 'http', command: srvError.url, url: srvError.url }, {}, 5000)
    const nonJson = await runHttpHook({ type: 'http', command: srvText.url, url: srvText.url }, {}, 5000)
    const unreachable = await runHttpHook({ type: 'http', command: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9' }, {}, 2000)
    await srvError.close()
    await srvText.close()

    for (const result of [failing, nonJson, unreachable]) {
      expect(result.timedOut).toBe(false)
      expect(result.code).not.toBe(0)
      expect(result.code).not.toBe(2)
    }
    const config = { PreToolUse: [{ hooks: [{ type: 'http', command: srvError.url, url: srvError.url }] }] }
    const decision = await runPreToolUse(config, 'bash', {}, async () => failing)
    expect(decision.block).toBe(false)
  })

  it('fetches a URL matching the allowlist and never fetches one that misses it', async () => {
    let hits = 0
    const srv = await serve((_req, res) => {
      hits++
      res.writeHead(200)
      res.end()
    })
    const hook = { type: 'http', command: srv.url, url: srv.url }

    const allowed = await runHttpHook(hook, {}, 5000, ['http://127.0.0.1:*/hook'])
    const denied = await runHttpHook(hook, {}, 5000, ['https://hooks.example.com/*'])
    const blockedAll = await runHttpHook(hook, {}, 5000, [])
    await srv.close()

    expect(allowed).toMatchObject({ code: 0, timedOut: false })
    expect(hits).toBe(1)
    // A denied hook renders no decision, like every other http failure: non-blocking.
    for (const result of [denied, blockedAll]) {
      expect(result.timedOut).toBe(false)
      expect(result.code).not.toBe(0)
      expect(result.code).not.toBe(2)
      expect(result.stderr).toContain('allowedHttpHookUrls')
    }
  })
})

describe('httpUrlAllowed', () => {
  it('matches allowlist entries with * as a wildcard, whole-URL otherwise', () => {
    expect(httpUrlAllowed('https://hooks.example.com/pre', ['https://hooks.example.com/*'])).toBe(true)
    expect(httpUrlAllowed('https://hooks.example.com/pre', ['*'])).toBe(true)
    expect(httpUrlAllowed('https://evil.example.com/pre', ['https://hooks.example.com/*'])).toBe(false)
    // Without a wildcard the whole URL must match; a prefix is not enough.
    expect(httpUrlAllowed('https://hooks.example.com/pre', ['https://hooks.example.com'])).toBe(false)
    expect(httpUrlAllowed('https://hooks.example.com', ['https://hooks.example.com'])).toBe(true)
  })

  it('treats regex characters in a pattern as literals', () => {
    expect(httpUrlAllowed('https://hooksXexample.com/', ['https://hooks.example.com/'])).toBe(false)
    expect(httpUrlAllowed('https://h.example.com/a+b', ['https://h.example.com/a+b'])).toBe(true)
  })

  it('is unrestricted when undefined and blocks everything on an empty list', () => {
    // Claude: undefined = no restrictions, empty array = block all http hooks.
    expect(httpUrlAllowed('https://anywhere.example/', undefined)).toBe(true)
    expect(httpUrlAllowed('https://anywhere.example/', [])).toBe(false)
  })
})

describe('readAllowedHttpHookUrls', () => {
  it('is undefined when no settings source sets the key', () => {
    const dir = tempDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: {} }))
    expect(readAllowedHttpHookUrls([file, join(dir, 'absent.json')], {})).toBeUndefined()
  })

  it('merges entries across managed settings and the chain, skipping non-strings', () => {
    // Claude documents allowedHttpHookUrls arrays as merging across settings sources.
    const dir = tempDir()
    const user = join(dir, 'user.json')
    const local = join(dir, 'local.json')
    writeFileSync(user, JSON.stringify({ allowedHttpHookUrls: ['https://a.example/*'] }))
    writeFileSync(local, JSON.stringify({ allowedHttpHookUrls: ['https://b.example/*', 42] }))
    expect(readAllowedHttpHookUrls([user, local], { allowedHttpHookUrls: ['https://m.example/*'] })).toEqual(['https://m.example/*', 'https://a.example/*', 'https://b.example/*'])
  })

  it('keeps an empty array as enforce-and-block-all rather than reading it as absent', () => {
    const dir = tempDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ allowedHttpHookUrls: [] }))
    expect(readAllowedHttpHookUrls([file], {})).toEqual([])
  })

  it('ignores a non-array value and malformed files', () => {
    const dir = tempDir()
    const junk = join(dir, 'junk.json')
    const broken = join(dir, 'broken.json')
    writeFileSync(junk, JSON.stringify({ allowedHttpHookUrls: 'https://a.example/*' }))
    writeFileSync(broken, '{not json')
    expect(readAllowedHttpHookUrls([junk, broken], {})).toBeUndefined()
  })
})

describe('runPreToolUse on a timed-out hook', () => {
  const config = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }, { command: 'second.sh' }] }] }

  it('blocks the tool rather than treating the killed hook as an allow', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command.command)
      return { code: 0, stdout: '', stderr: '', timedOut: true }
    }
    const decision = await runPreToolUse(config, 'bash', {}, runner)

    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('guard.sh')
    // Parallel launch, as Claude runs hooks: the sibling was already in flight.
    expect(run).toEqual(['guard.sh', 'second.sh'])
  })
})

describe('hook stdout parsing rule', () => {
  it('reads only {..}-shaped stdout as JSON output, per the documented rule', async () => {
    // Claude: stdout starting with { and ending with } parses as JSON; a JSON
    // array, a quoted string, or a bare number is plain text.
    const { tryParseJson } = await import('../extensions/hooks/decisions.ts')
    expect(tryParseJson('{"decision":"block","reason":"no"}')).toMatchObject({ decision: 'block' })
    expect(tryParseJson('[1,2]')).toBeUndefined()
    expect(tryParseJson('"just quoted text"')).toBeUndefined()
    expect(tryParseJson('42')).toBeUndefined()
    expect(tryParseJson('{"a":1} trailing')).toBeUndefined()
  })

  it('treats multi-line JSON objects with no output fields as plain text', async () => {
    // Claude: two or more lines that each parse as JSON on their own, none setting
    // an output field, are plain text.
    const { tryParseJson } = await import('../extensions/hooks/decisions.ts')
    expect(tryParseJson('{"note":1}\n{"note":2}')).toBeUndefined()
  })

  it('keeps a quoted-string stdout as plain-text context instead of silently dropping it', async () => {
    const { promptContext } = await import('../extensions/hooks/decisions.ts')
    expect(promptContext('"quoted context"')).toBe('"quoted context"')
  })

  it('reports a hook error for {..}-shaped stdout that is not valid JSON output', async () => {
    // Claude: when stdout looks like JSON but cannot be parsed, the transcript
    // shows a hook error notice and the output is not treated as plain text.
    const { hookJsonError } = await import('../extensions/hooks/decisions.ts')
    expect(hookJsonError('{"decision": broken}')).toContain('JSON')
    expect(hookJsonError('plain text')).toBeUndefined()
    expect(hookJsonError('{"decision":"block"}')).toBeUndefined()
    // A multi-line output where one line sets an output field is a parse failure;
    // with no output field set it is plain text, not an error.
    expect(hookJsonError('{"decision":"block"}\n{"note":2}')).toContain('JSON')
    expect(hookJsonError('{"note":1}\n{"note":2}')).toBeUndefined()
  })
})

describe('hook command child environment', () => {
  // POSIX-only: the probe runs sh variable expansion through runHookCommand's /bin/sh path.
  it.skipIf(process.platform === 'win32')('marks hook commands with CLAUDE_CODE_CHILD_SESSION and passes terminal dimensions', async () => {
    // Claude sets CLAUDE_CODE_CHILD_SESSION=1 in hook and status line commands
    // (not stdio MCP servers), and COLUMNS/LINES to the terminal dimensions.
    const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
    const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows')
    Object.defineProperty(process.stdout, 'columns', { value: 121, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: 43, configurable: true })
    // Hermetic: pi-code itself may run under Claude Code, whose parent env already
    // carries the marker; clear it to prove runHookCommand sets it.
    const savedChild = process.env.CLAUDE_CODE_CHILD_SESSION
    delete process.env.CLAUDE_CODE_CHILD_SESSION
    try {
      const result = await runHookCommand('echo "$CLAUDE_CODE_CHILD_SESSION:$COLUMNS:$LINES"', {}, 5000)
      expect(result.stdout.trim()).toBe('1:121:43')
    } finally {
      if (savedColumns) Object.defineProperty(process.stdout, 'columns', savedColumns)
      else delete (process.stdout as unknown as Record<string, unknown>).columns
      if (savedRows) Object.defineProperty(process.stdout, 'rows', savedRows)
      else delete (process.stdout as unknown as Record<string, unknown>).rows
      if (savedChild === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION
      else process.env.CLAUDE_CODE_CHILD_SESSION = savedChild
    }
  })
})
