import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type HooksConfig, mergeAgentEnvHooks } from '../extensions/hooks/config.ts'

/**
 * The seam a subagent child receives its agent's frontmatter hooks through. The parent
 * serializes them into PI_CODE_AGENT_HOOKS; the child merges them here and reports the
 * agent identity so its own end can fire SubagentStop.
 *
 * A guard has two failure modes and both matter here: payloads it must reject, and a
 * legitimate one it must not. Rejecting silently means the child runs with none of the
 * agent's hooks, which is exactly the case that looks like everything working.
 */
describe('mergeAgentEnvHooks', () => {
  const saved = { subagent: process.env.PI_CODE_SUBAGENT, hooks: process.env.PI_CODE_AGENT_HOOKS }
  const restore = (key: 'PI_CODE_SUBAGENT' | 'PI_CODE_AGENT_HOOKS', value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeEach(() => {
    process.env.PI_CODE_SUBAGENT = '1'
  })

  afterEach(() => {
    restore('PI_CODE_SUBAGENT', saved.subagent)
    restore('PI_CODE_AGENT_HOOKS', saved.hooks)
  })

  const merge = (raw: string | undefined): { config: HooksConfig; identity: ReturnType<typeof mergeAgentEnvHooks> } => {
    restore('PI_CODE_AGENT_HOOKS', raw)
    const config: HooksConfig = {}
    return { config, identity: mergeAgentEnvHooks(config) }
  }

  it('merges a well-formed payload and reports the agent identity', () => {
    const raw = JSON.stringify({ agent: 'scout', id: 'bg-1', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'agent-guard' }] }] } })

    const { config, identity } = merge(raw)

    expect(identity).toEqual({ agent: 'scout', id: 'bg-1' })
    expect(config.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('agent-guard')
  })

  it('omits the id when the parent did not send one', () => {
    const { identity } = merge(JSON.stringify({ agent: 'scout', hooks: { Stop: [] } }))
    expect(identity).toEqual({ agent: 'scout' })
  })

  it.each([
    ['unparseable json', '{not json'],
    ['a json array rather than an object', '[]'],
    ['a missing agent name', JSON.stringify({ hooks: { PreToolUse: [] } })],
    ['a non-string agent name', JSON.stringify({ agent: 7, hooks: {} })],
    ['a missing hooks map', JSON.stringify({ agent: 'scout' })],
    ['a non-object hooks map', JSON.stringify({ agent: 'scout', hooks: [] })],
  ])('rejects %s, contributing no hooks', (_label, raw) => {
    const { config, identity } = merge(raw)

    expect(identity).toBeUndefined()
    expect(config).toEqual({})
  })

  it('does nothing outside a subagent, however good the payload', () => {
    // The parent process must never merge the hooks it is handing to a child.
    process.env.PI_CODE_SUBAGENT = '0'
    const { config, identity } = merge(JSON.stringify({ agent: 'scout', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'agent-guard' }] }] } }))

    expect(identity).toBeUndefined()
    expect(config).toEqual({})
  })

  it('does nothing when the variable is absent or empty', () => {
    expect(merge(undefined).identity).toBeUndefined()
    expect(merge('').identity).toBeUndefined()
  })
})
