import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import goalExtension from '../extensions/goal.ts'
import { EVALUATOR_SYSTEM, NO_GOAL_TEXT } from '../extensions/internal/goal-evaluator.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import { setCompleteBackend } from '../extensions/internal/model-complete.ts'
import { SUBAGENT_CHANNEL } from '../extensions/internal/subagent-events.ts'

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown
type Sent = { message: { customType: string; content: string; display: boolean }; options: any }

const tempDir = (prefix = 'goal-'): string => mkdtempSync(join(tmpdir(), prefix))

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...extra })
const messageEntry = (message: unknown) => ({ type: 'message', id: 'e', parentId: null, timestamp: '', message })
const goalEntry = (state: string, condition: string) => ({ type: 'custom', id: 'g', parentId: null, timestamp: '', customType: 'goal', data: { state, condition } })

/** A completion backend answering with `text`; records what the evaluator was sent. */
const calls: Array<{ model: any; system: string | undefined; prompt: string; options: any }> = []
function answer(text: string, usage: Record<string, number> = {}) {
  setCompleteBackend(async (model, context, options) => {
    calls.push({ model, system: context.systemPrompt, prompt: String(context.messages[0]?.content ?? ''), options })
    return { role: 'assistant', content: [{ type: 'text', text }], api: 'x', provider: 'x', model: 'm', usage, stopReason: 'stop', timestamp: 0 } as never
  })
}
const notMet = (reason: string) => answer(JSON.stringify({ ok: false, reason }))
const met = (reason: string) => answer(JSON.stringify({ ok: true, reason }))

afterEach(() => {
  setCompleteBackend(null)
  setManagedSettingsPath(undefined)
  calls.length = 0
  vi.useRealTimers()
})

interface SetupOptions {
  model?: unknown
  idle?: boolean
  hasUI?: boolean
  trusted?: boolean
  branch?: unknown[]
  available?: Array<{ id: string; name?: string }>
}

/** Fresh extension over a stub pi API, with an isolated config home and no managed policy. */
function setup(opts: SetupOptions = {}) {
  const home = tempDir('goal-home-')
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  setManagedSettingsPath(join(home, 'managed-settings.json'))
  const handlers = new Map<string, Handler>()
  const bus = new Map<string, (data: unknown) => void>()
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  const sent: Sent[] = []
  const appended: Array<{ type: string; data: any }> = []
  const notes: Array<{ msg: string; level?: string }> = []
  const status: Array<string | undefined> = []
  let branch: unknown[] = opts.branch ?? []
  let idle = opts.idle ?? true
  let releaseIdle: () => void = () => {}
  let idleWaits = 0

  goalExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    events: { on: (channel: string, fn: (data: unknown) => void) => bus.set(channel, fn), emit: () => {} },
    sendMessage: (message: Sent['message'], options: unknown) => sent.push({ message, options }),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
  } as never)

  const ctx = {
    cwd: tempDir('goal-proj-'),
    hasUI: opts.hasUI ?? true,
    isIdle: () => idle,
    waitForIdle: () => {
      idleWaits += 1
      return new Promise<void>((resolve) => {
        releaseIdle = resolve
      })
    },
    isProjectTrusted: () => opts.trusted ?? true,
    model: 'model' in opts ? opts.model : { id: 'session-model', contextWindow: 200_000 },
    modelRegistry: { getAvailable: () => opts.available ?? [] },
    ui: {
      notify: (msg: string, level?: string) => notes.push({ msg, level }),
      setStatus: (_key: string, text?: string) => status.push(text),
      confirm: async () => true,
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: { getBranch: () => branch },
  }
  const on = (name: string) => {
    const found = handlers.get(name)
    if (!found) throw new Error(`goal extension did not register ${name}`)
    return found
  }
  return {
    home,
    ctx,
    goal: (args = '') => {
      const spec = commands.get('goal')
      if (!spec) throw new Error('goal extension did not register /goal')
      return spec.handler(args, ctx)
    },
    description: () => commands.get('goal')?.description ?? '',
    sessionStart: (reason = 'startup') => on('session_start')({ type: 'session_start', reason }, ctx),
    shutdown: () => on('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx),
    agentStart: () => on('agent_start')({ type: 'agent_start' }, ctx),
    toolStart: () => on('tool_execution_start')({ type: 'tool_execution_start', toolName: 'bash' }, ctx),
    agentEnd: (messages: unknown[] = [assistant('working on it')]) => on('agent_end')({ type: 'agent_end', messages }, ctx),
    settled: () => on('agent_settled')({ type: 'agent_settled' }, ctx),
    input: (text: string, source = 'interactive') => on('input')({ type: 'input', text, source }, ctx),
    subagent: (phase: 'start' | 'stop', agentId: string, agentType = 'Explore') => bus.get(SUBAGENT_CHANNEL)?.({ phase, agentType, agentId }),
    setBranch: (next: unknown[]) => {
      branch = next
    },
    setIdle: (next: boolean) => {
      idle = next
    },
    idleWaits: () => idleWaits,
    releaseIdle: () => releaseIdle(),
    sent,
    appended,
    notes,
    status,
    lastNote: () => notes[notes.length - 1],
    lastStatus: () => status[status.length - 1],
    continuations: () => sent.filter((s) => s.options?.triggerTurn === true && /^Goal not yet met/.test(s.message.content)),
  }
}

describe('/goal command', () => {
  it('reports no goal, with the usage hint, when none is set', async () => {
    const t = setup()
    await t.goal()
    expect(t.lastNote()).toEqual({ msg: NO_GOAL_TEXT, level: 'info' })
    expect(t.description()).toMatch(/goal/i)
  })

  it('sets a goal: persists it, confirms it, shows the indicator, and starts a turn with the kickoff directive', async () => {
    const t = setup()
    await t.goal('all tests in test/auth pass')
    expect(t.lastNote()).toEqual({ msg: 'Goal set: all tests in test/auth pass', level: 'info' })
    expect(t.appended).toEqual([{ type: 'goal', data: { state: 'active', condition: 'all tests in test/auth pass' } }])
    expect(t.lastStatus()).toContain('◎ goal')
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0].message).toMatchObject({ customType: 'goal', display: true })
    expect(t.sent[0].message.content).toContain('"all tests in test/auth pass"')
    expect(t.sent[0].message.content).toMatch(/directive/)
    expect(t.sent[0].options).toEqual({ triggerTurn: true })
  })

  it('queues the kickoff as a follow-up turn while the agent is streaming', async () => {
    const t = setup({ idle: false })
    await t.goal('lint is clean')
    expect(t.sent[0].options).toEqual({ triggerTurn: true, deliverAs: 'followUp' })
  })

  it('holds the command open until the agent is idle when headless, so a -p run completes the loop', async () => {
    const t = setup({ hasUI: false })
    let settled = false
    const handled = t.goal('lint is clean').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(t.sent).toHaveLength(1)
    expect(t.idleWaits()).toBe(1)
    expect(settled).toBe(false)
    t.releaseIdle()
    await handled
    expect(settled).toBe(true)
  })

  it('returns at once in the TUI, where the main loop already goes back to the editor', async () => {
    const t = setup({ hasUI: true })
    await t.goal('lint is clean')
    expect(t.idleWaits()).toBe(0)
  })

  it('shows the active goal as not yet evaluated, with the clear hint, before the first verdict', async () => {
    const t = setup()
    await t.goal('lint is clean')
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: lint is clean (not yet evaluated)')
    expect(t.lastNote().msg).toContain('/goal clear to stop early')
  })

  it('replaces an active goal with a new condition and fresh counters', async () => {
    const t = setup()
    await t.goal('first')
    notMet('still going')
    await t.agentEnd()
    await t.goal('second')
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: second (not yet evaluated)')
    expect(t.appended.map((entry) => entry.data)).toEqual([
      { state: 'active', condition: 'first' },
      { state: 'active', condition: 'second' },
    ])
  })

  it('refuses a condition over 4000 characters with the count, setting nothing', async () => {
    const t = setup()
    await t.goal('x'.repeat(4001))
    expect(t.lastNote()).toEqual({ msg: 'Goal condition is limited to 4000 characters (got 4001)', level: 'error' })
    expect(t.appended).toEqual([])
    expect(t.sent).toEqual([])
    await t.goal()
    expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
  })

  it('accepts a condition of exactly 4000 characters', async () => {
    const t = setup()
    await t.goal('y'.repeat(4000))
    expect(t.lastNote().msg).toMatch(/^Goal set: y+$/)
  })

  it.each(['clear', 'stop', 'off', 'reset', 'none', 'cancel', 'CANCEL'])('clears the goal on /goal %s, recording it for the model and dropping the indicator', async (alias) => {
    const t = setup()
    await t.goal('lint is clean')
    await t.goal(alias)
    expect(t.sent[1]).toEqual({ message: { customType: 'goal', content: 'Goal cleared: lint is clean', display: true }, options: { triggerTurn: false } })
    expect(t.appended[1]).toEqual({ type: 'goal', data: { state: 'cleared', condition: 'lint is clean' } })
    expect(t.lastStatus()).toBeUndefined()
    await t.goal()
    expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
  })

  it('reports no goal on /goal clear when nothing is active', async () => {
    const t = setup()
    await t.goal('clear')
    expect(t.lastNote()).toEqual({ msg: 'No goal set', level: 'info' })
    expect(t.sent).toEqual([])
  })

  it('does not treat a condition that merely contains an alias as a clear', async () => {
    const t = setup()
    await t.goal('stop the dev server and confirm port 3000 is free')
    expect(t.lastNote().msg).toMatch(/^Goal set: stop the dev server/)
  })

  it('is unavailable when managed policy disables all hooks', async () => {
    const t = setup()
    writeFileSync(join(t.home, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true }))
    await t.goal('lint is clean')
    expect(t.lastNote()).toEqual({ msg: "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).", level: 'error' })
    expect(t.appended).toEqual([])
  })

  it('is unavailable under allowManagedHooksOnly and under a settings-file disableAllHooks', async () => {
    const managed = setup()
    writeFileSync(join(managed.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true }))
    await managed.goal('lint is clean')
    expect(managed.lastNote().msg).toMatch(/hooks are restricted/)

    const settings = setup()
    mkdirSync(join(settings.home, '.claude'), { recursive: true })
    writeFileSync(join(settings.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }))
    await settings.goal('lint is clean')
    expect(settings.lastNote().msg).toMatch(/hooks are restricted/)
  })

  it('is unavailable in an untrusted workspace, saying why', async () => {
    const t = setup({ trusted: false })
    await t.goal('lint is clean')
    expect(t.lastNote()).toEqual({ msg: '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.', level: 'error' })
    expect(t.sent).toEqual([])
  })
})

describe('goal evaluation', () => {
  it('sends the transcript and condition to the evaluator with the stop-condition instructions', async () => {
    const t = setup({ branch: [messageEntry({ role: 'user', content: 'please make the auth tests pass' }), messageEntry(assistant('On it.'))] })
    await t.goal('all auth tests pass')
    notMet('no test run in the transcript yet')
    await t.agentEnd()
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toBe(EVALUATOR_SYSTEM)
    expect(calls[0].prompt).toContain('User: please make the auth tests pass')
    expect(calls[0].prompt).toContain('Assistant: On it.')
    expect(calls[0].prompt).toContain('Condition: all auth tests pass')
    expect(calls[0].prompt.indexOf('Assistant: On it.')).toBeLessThan(calls[0].prompt.indexOf('Condition:'))
    expect(calls[0].model.id).toBe('session-model')
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal)
    // Claude's evaluator runs with thinking disabled; no thinking level is requested here.
    expect(calls[0].options.reasoning).toBeUndefined()
  })

  it('includes the goal transcript lines the model saw, from custom message entries', async () => {
    const t = setup({ branch: [{ type: 'custom_message', id: 'c', parentId: null, timestamp: '', customType: 'goal', content: 'Goal not yet met: lint pending', display: true }] })
    await t.goal('lint passes')
    notMet('still pending')
    await t.agentEnd()
    expect(calls[0].prompt).toContain('Note (goal): Goal not yet met: lint pending')
  })

  it('trims the transcript to half the evaluator model context window, newest first', async () => {
    // 60 tokens of window at 4 chars each, halved: 120 chars of transcript. The old message
    // alone exceeds that, so only the recent one survives, with the cut marked.
    const t = setup({ model: { id: 'small', contextWindow: 60 }, branch: [messageEntry({ role: 'user', content: `ANCIENT ${'z'.repeat(300)}` }), messageEntry(assistant('RECENT reply'))] })
    await t.goal('done')
    notMet('not yet')
    await t.agentEnd()
    expect(calls[0].prompt).toContain('RECENT reply')
    expect(calls[0].prompt).not.toContain('ANCIENT')
    expect(calls[0].prompt).toContain('[earlier transcript omitted]')
  })

  it('continues the conversation on a not-met verdict, feeding the reason and the condition back', async () => {
    const t = setup()
    await t.goal('lint is clean')
    notMet('biome reports 3 errors')
    await t.agentEnd()
    const continuation = t.continuations()
    expect(continuation).toHaveLength(1)
    expect(continuation[0].message).toMatchObject({ customType: 'goal', display: true })
    expect(continuation[0].message.content).toMatch(/^Goal not yet met \(turn 1 · /)
    expect(continuation[0].message.content).toContain('biome reports 3 errors')
    expect(continuation[0].message.content).toContain('Goal: lint is clean')
    expect(continuation[0].options).toEqual({ triggerTurn: true })
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: lint is clean (1 turn)')
    expect(t.lastNote().msg).toContain('Last check: biome reports 3 errors')
  })

  it('clears an achieved goal, records the verdict for the model, and keeps it for the status view', async () => {
    const t = setup()
    await t.goal('lint is clean')
    met('biome check passed with 0 errors')
    await t.agentEnd()
    expect(t.continuations()).toEqual([])
    const record = t.sent[t.sent.length - 1]
    expect(record.message.content).toMatch(/^Goal achieved \(.* · 1 turn · .* tokens\): lint is clean\nEvaluator: biome check passed with 0 errors$/)
    expect(record.options).toEqual({ triggerTurn: false })
    expect(t.appended[1]).toEqual({ type: 'goal', data: { state: 'achieved', condition: 'lint is clean' } })
    expect(t.lastStatus()).toBeUndefined()
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal achieved: lint is clean (')
    expect(t.lastNote().msg).toContain('/goal <condition> to set another')
  })

  it('clears an impossible goal as failed and does not show it as achieved', async () => {
    const t = setup()
    await t.goal('the repo has no bugs')
    answer(JSON.stringify({ ok: false, impossible: true, reason: 'cannot be proven from output' }))
    await t.agentEnd()
    expect(t.continuations()).toEqual([])
    expect(t.sent[t.sent.length - 1].message.content).toMatch(/^Goal could not be achieved \(.*\): the repo has no bugs\nEvaluator: cannot be proven from output$/)
    expect(t.appended[1].data).toEqual({ state: 'failed', condition: 'the repo has no bugs' })
    await t.goal()
    expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
  })

  it('counts token spend from the goal start, evaluator calls included', async () => {
    const t = setup({ branch: [messageEntry(assistant('earlier', { usage: { totalTokens: 1000 } }))] })
    await t.goal('done')
    t.setBranch([messageEntry(assistant('earlier', { usage: { totalTokens: 1000 } })), messageEntry(assistant('later', { usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 } }))])
    notMet('not yet')
    answer(JSON.stringify({ ok: false, reason: 'not yet' }), { totalTokens: 200 })
    await t.agentEnd()
    await t.goal()
    // 3500 on the branch now, 1000 at set, plus the 200-token evaluator call.
    expect(t.lastNote().msg).toContain('2.7k tokens')
  })

  it('leaves the goal set and warns when the evaluator errors or answers unreadably', async () => {
    const erroring = setup()
    await erroring.goal('done')
    setCompleteBackend(async () => {
      throw new Error('provider down')
    })
    await erroring.agentEnd()
    expect(erroring.continuations()).toEqual([])
    expect(erroring.lastNote()).toEqual({ msg: 'Goal evaluator error: provider down. The goal stays set; the next turn is evaluated again.', level: 'warning' })
    await erroring.goal()
    expect(erroring.lastNote().msg).toContain('Goal active: done (not yet evaluated)')

    const garbled = setup()
    await garbled.goal('done')
    answer('I think it is probably fine')
    await garbled.agentEnd()
    expect(garbled.continuations()).toEqual([])
    expect(garbled.lastNote().msg).toMatch(/^Goal evaluator error: unreadable verdict: I think it is probably fine/)
  })

  it('also prints a warning to stderr when headless, where notify has no surface', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const headless = setup({ hasUI: false })
    const handled = headless.goal('done')
    headless.releaseIdle()
    await handled
    setCompleteBackend(async () => {
      throw new Error('provider down')
    })
    await headless.agentEnd()
    expect(written).toEqual(['Goal evaluator error: provider down. The goal stays set; the next turn is evaluated again.\n'])
    expect(headless.lastNote().level).toBe('warning')

    const tui = setup({ hasUI: true })
    await tui.goal('done')
    await tui.agentEnd()
    expect(written).toHaveLength(1)
  })

  it('warns and keeps the goal when no model is available to evaluate on', async () => {
    const t = setup({ model: undefined })
    await t.goal('done')
    notMet('x')
    await t.agentEnd()
    expect(calls).toEqual([])
    expect(t.lastNote()).toEqual({ msg: 'Goal evaluator has no model to run on; the goal stays set.', level: 'warning' })
  })

  it('evaluates on ANTHROPIC_DEFAULT_HAIKU_MODEL when it names a model this user can run', async () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku'
    const t = setup({
      available: [
        { id: 'claude-sonnet-5', name: 'Sonnet 5' },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
      ],
    })
    await t.goal('done')
    notMet('x')
    await t.agentEnd()
    expect(calls[0].model.id).toBe('claude-haiku-4-5')

    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'nonexistent'
    const fallback = setup({ available: [{ id: 'claude-sonnet-5' }] })
    await fallback.goal('done')
    await fallback.agentEnd()
    expect(calls[1].model.id).toBe('session-model')
  })

  it('does not evaluate a turn the user interrupted', async () => {
    const t = setup()
    await t.goal('done')
    notMet('x')
    await t.agentEnd([assistant('partial', { stopReason: 'aborted' })])
    expect(calls).toEqual([])
    expect(t.continuations()).toEqual([])
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: done')
  })

  it('does nothing on agent end when no goal is set', async () => {
    const t = setup()
    notMet('x')
    await t.agentEnd()
    expect(calls).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('drops a verdict that arrives after the goal was cleared during the evaluation', async () => {
    const t = setup()
    await t.goal('done')
    let resolve: (value: unknown) => void = () => {}
    setCompleteBackend(() => new Promise((r) => (resolve = r)) as never)
    const pending = t.agentEnd()
    await t.goal('clear')
    resolve({ role: 'assistant', content: [{ type: 'text', text: '{"ok": false, "reason": "late"}' }], usage: {}, stopReason: 'stop' })
    await pending
    expect(t.continuations()).toEqual([])
    expect(t.notes.some((n) => /evaluator error/.test(n.msg))).toBe(false)
  })
})

describe('goal errors', () => {
  it('skips evaluation of a failed turn and clears the goal after an unrecoverable error once the run settles', async () => {
    const t = setup()
    await t.goal('done')
    notMet('x')
    await t.agentEnd([assistant('', { stopReason: 'error', errorMessage: '401 authentication_error: invalid x-api-key' })])
    expect(calls).toEqual([])
    await t.settled()
    const text = 'Goal cleared after an unrecoverable error (authentication): "401 authentication_error: invalid x-api-key". Run /goal again to continue.'
    expect(t.lastNote()).toEqual({ msg: text, level: 'warning' })
    expect(t.sent[t.sent.length - 1]).toEqual({ message: { customType: 'goal', content: text, display: true }, options: { triggerTurn: false } })
    expect(t.appended[1].data).toEqual({ state: 'cleared', condition: 'done' })
    expect(t.lastStatus()).toBeUndefined()
  })

  it('leaves the goal set after a transient error such as a rate limit', async () => {
    const t = setup()
    await t.goal('done')
    await t.agentEnd([assistant('', { stopReason: 'error', errorMessage: '429 rate_limit_error' })])
    await t.settled()
    expect(t.appended).toHaveLength(1)
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: done')
  })

  it('forgets a failed turn once a later successful run settles', async () => {
    const t = setup()
    await t.goal('done')
    await t.agentEnd([assistant('', { stopReason: 'error', errorMessage: 'credit balance is too low' })])
    // pi retried and the run ended cleanly before settling: nothing to clear.
    notMet('x')
    await t.agentEnd()
    await t.settled()
    expect(t.appended).toHaveLength(1)
  })
})

describe('goal no-progress cap', () => {
  const runTurns = async (t: ReturnType<typeof setup>, count: number, withTools: boolean) => {
    for (let i = 0; i < count; i += 1) {
      await t.agentStart()
      if (withTools) await t.toolStart()
      await t.agentEnd()
    }
  }

  it('pauses the loop after eight not-met turns in a row without tool use, goal still set', async () => {
    const t = setup()
    await t.goal('done')
    notMet('keep going')
    await runTurns(t, 7, false)
    expect(t.continuations()).toHaveLength(7)
    await runTurns(t, 1, false)
    expect(t.continuations()).toHaveLength(7)
    expect(t.lastNote()).toEqual({ msg: 'Goal paused after 8 turns in a row without tool use; it stays set and evaluation resumes after your next prompt.', level: 'warning' })
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: done (8 turns)')
  })

  it('keeps continuing while turns use tools, and a tool-using turn resets the streak', async () => {
    const t = setup()
    await t.goal('done')
    notMet('keep going')
    await runTurns(t, 12, true)
    expect(t.continuations()).toHaveLength(12)
    await runTurns(t, 7, false)
    expect(t.continuations()).toHaveLength(19)
    await runTurns(t, 1, true)
    expect(t.continuations()).toHaveLength(20)
    await runTurns(t, 7, false)
    expect(t.continuations()).toHaveLength(27)
  })

  it('resets the streak on genuine user input but not on extension-sourced input', async () => {
    const t = setup()
    await t.goal('done')
    notMet('keep going')
    await runTurns(t, 7, false)
    await t.input('injected continuation', 'extension')
    await runTurns(t, 1, false)
    expect(t.continuations()).toHaveLength(7)

    const fresh = setup()
    await fresh.goal('done')
    await runTurns(fresh, 7, false)
    await fresh.input('keep at it')
    await runTurns(fresh, 1, false)
    expect(fresh.continuations()).toHaveLength(8)
  })

  it('honors CLAUDE_CODE_STOP_HOOK_BLOCK_CAP as the cap', async () => {
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '2'
    const t = setup()
    await t.goal('done')
    notMet('keep going')
    await runTurns(t, 2, false)
    expect(t.continuations()).toHaveLength(1)
    expect(t.lastNote().msg).toMatch(/^Goal paused after 2 turns/)
  })
})

describe('goal background work', () => {
  it('skips evaluation while a subagent runs and evaluates once it stops', async () => {
    const t = setup()
    await t.goal('done')
    notMet('x')
    t.subagent('start', 'run-1')
    await t.agentEnd()
    expect(calls).toEqual([])
    t.subagent('stop', 'run-1')
    await t.agentEnd()
    expect(calls).toHaveLength(1)
    expect(t.continuations()).toHaveLength(1)
  })

  it('injects a check-in turn after 30 minutes of deferral, doubling the wait up to four times', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.goal('done')
    t.subagent('start', 'run-1', 'Explore')
    await t.agentEnd()
    expect(t.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(t.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1].message.content).toContain('Goal check-in: «done» is still active')
    expect(t.sent[1].message.content).toContain('deferred for 30 min')
    expect(t.sent[1].message.content).toContain('- run-1 · subagent Explore')
    expect(t.sent[1].options).toEqual({ triggerTurn: true })
    // The check-in turn ends with the work still running: the next wait doubles.
    await t.agentEnd()
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(t.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.sent).toHaveLength(3)
    expect(t.sent[2].message.content).toContain('deferred for 90 min')
    await t.agentEnd()
    await vi.advanceTimersByTimeAsync(120 * 60_000)
    expect(t.sent).toHaveLength(4)
    expect(t.sent[3].message.content).toContain('Idle check-ins are paused until your next message')
    // Three idle check-ins between prompts is the cap; the fourth waits for a turn end.
    await t.agentEnd()
    await vi.advanceTimersByTimeAsync(120 * 60_000)
    expect(t.sent).toHaveLength(4)
    await t.agentEnd()
    expect(t.sent).toHaveLength(5)
    expect(t.sent[4].message.content).toContain('Goal check-in')
  })

  it('delivers a check-in that came due mid-turn at the next turn end', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.goal('done')
    t.subagent('start', 'run-1')
    await t.agentEnd()
    t.setIdle(false)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(t.sent).toHaveLength(1)
    await t.agentEnd()
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1].message.content).toContain('Goal check-in')
  })

  it('nudges the model to continue when the work stopped without reporting back', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.goal('done')
    t.subagent('start', 'run-1')
    await t.agentEnd()
    t.subagent('stop', 'run-1')
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(t.sent[1].message.content).toContain('no longer running')
    expect(t.sent[1].message.content).toContain('Continue toward the goal')
  })

  it('turns check-ins off with CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0 and honors a custom interval', async () => {
    vi.useFakeTimers()
    process.env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES = '0'
    const off = setup()
    await off.goal('done')
    off.subagent('start', 'run-1')
    await off.agentEnd()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(off.sent).toHaveLength(1)

    process.env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES = '2'
    const quick = setup()
    await quick.goal('done')
    quick.subagent('start', 'run-1')
    await quick.agentEnd()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(quick.sent).toHaveLength(2)
  })

  it('cancels a pending check-in when the goal clears or the session shuts down', async () => {
    vi.useFakeTimers()
    const cleared = setup()
    await cleared.goal('done')
    cleared.subagent('start', 'run-1')
    await cleared.agentEnd()
    await cleared.goal('clear')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(cleared.sent.map((s) => s.message.content)).toEqual([expect.stringContaining('Stop hook is now active'), 'Goal cleared: done'])

    const closed = setup()
    await closed.goal('done')
    closed.subagent('start', 'run-1')
    await closed.agentEnd()
    await closed.shutdown()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(closed.sent).toHaveLength(1)
  })
})

describe('goal persistence', () => {
  it('restores a still-active goal on resume with fresh counters and says so', async () => {
    const t = setup({ branch: [goalEntry('active', 'lint is clean'), messageEntry(assistant('later', { usage: { totalTokens: 5000 } }))] })
    await t.sessionStart('resume')
    expect(t.lastNote()).toEqual({ msg: 'Goal restored: lint is clean', level: 'info' })
    expect(t.lastStatus()).toContain('◎ goal')
    await t.goal()
    expect(t.lastNote().msg).toContain('Goal active: lint is clean (not yet evaluated)')
    expect(t.lastNote().msg).toContain('0 tokens')
    // Restoring rewrites no entry: the active entry already on the branch is the state.
    expect(t.appended).toEqual([])
  })

  it('does not restore a goal that was achieved, failed, or cleared', async () => {
    for (const state of ['achieved', 'failed', 'cleared']) {
      const t = setup({ branch: [goalEntry('active', 'c'), goalEntry(state, 'c')] })
      await t.sessionStart('resume')
      await t.goal()
      expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
    }
  })

  it('ignores a malformed goal entry', async () => {
    const t = setup({ branch: [{ type: 'custom', id: 'g', parentId: null, timestamp: '', customType: 'goal', data: { state: 'active' } }] })
    await t.sessionStart('resume')
    await t.goal()
    expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
  })

  it('drops the previous session goal on a new session', async () => {
    const t = setup()
    await t.goal('done')
    t.setBranch([])
    await t.sessionStart('new')
    expect(t.lastStatus()).toBeUndefined()
    await t.goal()
    expect(t.lastNote().msg).toBe(NO_GOAL_TEXT)
    notMet('x')
    await t.agentEnd()
    expect(calls).toEqual([])
  })

  it('refreshes the elapsed time on the indicator while the goal runs', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.goal('done')
    expect(t.lastStatus()).toBe('◎ goal 0s')
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(t.lastStatus()).toBe('◎ goal 2m 0s')
  })
})
