import type { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverAgents, resolveModelAlias, withPreloadedSkills } from '../extensions/subagent/agents.ts'

/**
 * Covers extensions/subagent/agents.ts and extensions/subagent/background.ts.
 *
 * No test touches the developer's real home directory: `os.homedir()` is mocked
 * to a temp dir and PI_CODING_AGENT_DIR pins `getAgentDir()` inside that same
 * temp dir. No test spawns a real process: `node:child_process` is replaced by a
 * recorder handing back EventEmitter-based fake children.
 *
 * background.ts keeps a module-level `runs` Map with no exported reset, so every
 * test that touches the registry calls `loadBackground()`, which does
 * `vi.resetModules()` + a dynamic import to get a module instance with an empty
 * Map. `formatStatus` is preferred over `backgroundStatusText` wherever the
 * registry is not the thing under test.
 */

const fakeHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome.path }
})

type FakeChild = EventEmitter & { stdout: EventEmitter; pid: number; kill: ReturnType<typeof vi.fn> }

interface SpawnCall {
  command: string
  args: string[]
  options: unknown
}

const spawned = vi.hoisted(() => ({ calls: [] as SpawnCall[], children: [] as FakeChild[] }))

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    spawn: (command: string, args: string[], options: unknown) => {
      // pid and kill mirror a real child: cancellation signals the process group.
      const child = Object.assign(new Emitter(), { stdout: new Emitter(), pid: 4242, kill: vi.fn() }) as FakeChild
      spawned.calls.push({ command, args, options })
      spawned.children.push(child)
      return child
    },
  }
})

// ---------------------------------------------------------------------------
// agents.ts
// ---------------------------------------------------------------------------

const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'

const agentMd = (fields: Record<string, string>, body = 'body text'): string => {
  const yaml = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${yaml}\n---\n${body}`
}

/** The bundled builtins are always present and asserted in their own tests; these
 * suites target user/project discovery, so the helpers filter builtins out. */
const nonBuiltin = <T extends { source: string }>(agents: T[]): T[] => agents.filter((a) => a.source !== 'builtin')
const names = (agents: Array<{ name: string; source: string }>): string[] =>
  nonBuiltin(agents)
    .map((a) => a.name)
    .sort()

describe('discoverAgents', () => {
  let root: string
  let home: string
  let cwd: string
  let piUserDir: string
  let claudeUserDir: string
  let piProjectDir: string
  let claudeProjectDir: string
  let previousEnv: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subagent-cov-'))
    home = join(root, 'home')
    const projectRoot = join(root, 'project')
    cwd = join(projectRoot, 'src', 'nested')
    piUserDir = join(home, '.pi', 'agent', 'agents')
    claudeUserDir = join(home, '.claude', 'agents')
    piProjectDir = join(projectRoot, '.pi', 'agents')
    claudeProjectDir = join(projectRoot, '.claude', 'agents')
    mkdirSync(cwd, { recursive: true })
    // Marks the project root: discovery walks up only to there, never into an ancestor.
    writeFileSync(join(projectRoot, 'package.json'), '{}')

    fakeHome.path = home
    previousEnv = process.env[AGENT_DIR_ENV]
    process.env[AGENT_DIR_ENV] = join(home, '.pi', 'agent')
  })

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[AGENT_DIR_ENV]
    else process.env[AGENT_DIR_ENV] = previousEnv
  })

  const writeAgent = (dir: string, file: string, fields: Record<string, string>, body?: string): string => {
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, file)
    writeFileSync(filePath, agentMd(fields, body))
    return filePath
  }

  it('loads a user agent from ~/.pi/agent/agents with source and file path', () => {
    const filePath = writeAgent(piUserDir, 'scout.md', { name: 'scout', description: 'finds things' }, 'Scout prompt')

    const agents = nonBuiltin(discoverAgents(cwd, 'user').agents)

    expect(agents).toEqual([
      {
        name: 'scout',
        description: 'finds things',
        tools: undefined,
        model: undefined,
        systemPrompt: 'Scout prompt',
        source: 'user',
        filePath,
      },
    ])
  })

  it('always offers the bundled builtin agents at lowest precedence', () => {
    const { agents } = discoverAgents(cwd, 'user')
    const builtins = agents.filter((a) => a.source === 'builtin').map((a) => a.name)
    expect(builtins.sort()).toEqual(['Explore', 'Plan', 'general-purpose'])
  })

  it('lets a user agent of the same name override a builtin', () => {
    writeAgent(piUserDir, 'explore.md', { name: 'Explore', description: 'mine' }, 'Custom prompt')
    const explore = discoverAgents(cwd, 'user').agents.find((a) => a.name === 'Explore')
    expect(explore?.source).toBe('user')
    expect(explore?.description).toBe('mine')
  })

  it('loads a user agent from ~/.claude/agents', () => {
    writeAgent(claudeUserDir, 'legacy.md', { name: 'legacy', description: 'from claude dir' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['legacy'])
  })

  it('excludes project agents when scope is user', () => {
    writeAgent(piUserDir, 'u.md', { name: 'u-agent', description: 'user one' })
    writeAgent(piProjectDir, 'p.md', { name: 'p-agent', description: 'project one' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['u-agent'])
  })

  it('excludes user agents when scope is project', () => {
    writeAgent(piUserDir, 'u.md', { name: 'u-agent', description: 'user one' })
    writeAgent(piProjectDir, 'p.md', { name: 'p-agent', description: 'project one' })

    expect(names(discoverAgents(cwd, 'project').agents)).toEqual(['p-agent'])
  })

  it('merges user and project agents when scope is both', () => {
    writeAgent(piUserDir, 'u.md', { name: 'u-agent', description: 'user one' })
    writeAgent(claudeProjectDir, 'p.md', { name: 'p-agent', description: 'project one' })

    expect(names(discoverAgents(cwd, 'both').agents)).toEqual(['p-agent', 'u-agent'])
  })

  it('lets a project agent win over a user agent of the same name when scope is both', () => {
    writeAgent(piUserDir, 'dup.md', { name: 'dup', description: 'user copy' }, 'USER')
    writeAgent(piProjectDir, 'dup.md', { name: 'dup', description: 'project copy' }, 'PROJECT')

    const agents = nonBuiltin(discoverAgents(cwd, 'both').agents)

    expect(agents).toHaveLength(1)
    expect(agents[0].source).toBe('project')
    expect(agents[0].systemPrompt).toBe('PROJECT')
  })

  it('lets ~/.pi/agent/agents win over ~/.claude/agents on a name conflict', () => {
    writeAgent(claudeUserDir, 'dup.md', { name: 'dup', description: 'claude copy' }, 'CLAUDE')
    writeAgent(piUserDir, 'dup.md', { name: 'dup', description: 'pi copy' }, 'PI')

    const agents = nonBuiltin(discoverAgents(cwd, 'user').agents)

    expect(agents).toHaveLength(1)
    expect(agents[0].description).toBe('pi copy')
    expect(agents[0].systemPrompt).toBe('PI')
  })

  it('returns no agents and a null projectAgentsDir when no agent directory exists', () => {
    const discovered = discoverAgents(cwd, 'both')
    expect(nonBuiltin(discovered.agents)).toEqual([])
    expect(discovered.projectAgentsDir).toBeNull()
  })

  it('reports the nearest ancestor .pi/agents as projectAgentsDir', () => {
    mkdirSync(piProjectDir, { recursive: true })

    expect(discoverAgents(cwd, 'both').projectAgentsDir).toBe(piProjectDir)
  })

  it('reports projectAgentsDir as null when only .claude/agents exists in the project', () => {
    writeAgent(claudeProjectDir, 'p.md', { name: 'p-agent', description: 'project one' })

    const { agents, projectAgentsDir } = discoverAgents(cwd, 'project')

    expect(names(agents)).toEqual(['p-agent'])
    expect(projectAgentsDir).toBeNull()
  })

  it('skips a markdown file whose frontmatter has no name', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    writeAgent(piUserDir, 'nameless.md', { description: 'no name here' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('skips a markdown file whose frontmatter has no description', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    writeAgent(piUserDir, 'undescribed.md', { name: 'undescribed' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('skips a markdown file with no frontmatter block', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    writeFileSync(join(piUserDir, 'plain.md'), 'just a heading\n\nand prose')

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('ignores files that are not markdown even when they contain valid frontmatter', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    writeFileSync(join(piUserDir, 'decoy.txt'), agentMd({ name: 'decoy', description: 'wrong extension' }))

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('ignores a directory whose name ends in .md', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    mkdirSync(join(piUserDir, 'bundle.md'))

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('skips a markdown entry whose contents cannot be read', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    symlinkSync(join(piUserDir, 'missing-target.md'), join(piUserDir, 'broken.md'))

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('skips an agent path that exists but is not a readable directory', () => {
    writeAgent(piUserDir, 'ok.md', { name: 'ok', description: 'valid' })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(claudeUserDir, 'not a directory')

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['ok'])
  })

  it('maps Claude tool names to pi tool names and lowercases unmapped ones', () => {
    writeAgent(piUserDir, 'tooled.md', { name: 'tooled', description: 'has tools', tools: 'Read, Glob, Bash, WebFetch' })

    expect(nonBuiltin(discoverAgents(cwd, 'user').agents)[0].tools).toEqual(['read', 'find', 'bash', 'webfetch'])
  })

  it('leaves tools undefined when the tools field lists nothing usable', () => {
    writeAgent(piUserDir, 'empty-tools.md', { name: 'empty-tools', description: 'no tools', tools: '",,"' })

    expect(nonBuiltin(discoverAgents(cwd, 'user').agents)[0].tools).toBeUndefined()
  })

  it('accepts a YAML block list for tools, as Claude Code agent files commonly use', () => {
    mkdirSync(piUserDir, { recursive: true })
    writeFileSync(join(piUserDir, 'listed.md'), '---\nname: listed\ndescription: block list tools\ntools:\n  - Read\n  - Glob\n---\nprompt')

    expect(nonBuiltin(discoverAgents(cwd, 'user').agents)[0].tools).toEqual(['read', 'find'])
  })

  it('skips a file with malformed YAML frontmatter instead of aborting discovery', () => {
    mkdirSync(piUserDir, { recursive: true })
    writeFileSync(join(piUserDir, 'broken-yaml.md'), '---\nname: [unclosed\ndescription: d\n---\nprompt')
    writeAgent(piUserDir, 'fine2.md', { name: 'fine2', description: 'ok' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['fine2'])
  })

  it('skips an agent whose tools field is unusable instead of aborting discovery', () => {
    // A tools value that is neither a string nor a string list must not run the agent
    // unrestricted, and must not take the rest of the directory down with it.
    mkdirSync(piUserDir, { recursive: true })
    writeFileSync(join(piUserDir, 'broken.md'), '---\nname: broken\ndescription: numeric tools\ntools: 7\n---\nprompt')
    writeAgent(piUserDir, 'fine.md', { name: 'fine', description: 'ok' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['fine'])
  })

  it('carries a concrete model id through from frontmatter', () => {
    writeAgent(piUserDir, 'modelled.md', { name: 'modelled', description: 'pinned model', model: 'gpt-oss:20b' })

    expect(nonBuiltin(discoverAgents(cwd, 'user').agents)[0].model).toBe('gpt-oss:20b')
  })

  it('normalizes disallowedTools from a comma string or YAML list', () => {
    writeAgent(piUserDir, 'denyer.md', { name: 'denyer', description: 'denies tools', disallowedTools: 'Write, Glob' })
    mkdirSync(piUserDir, { recursive: true })
    writeFileSync(join(piUserDir, 'denyer2.md'), '---\nname: denyer2\ndescription: d\ndisallowedTools:\n  - Edit\n---\nprompt')

    const byName = new Map(discoverAgents(cwd, 'user').agents.map((a) => [a.name, a]))
    expect(byName.get('denyer')?.disallowedTools).toEqual(['write', 'find'])
    expect(byName.get('denyer2')?.disallowedTools).toEqual(['edit'])
  })

  it('skips an agent whose disallowedTools field is unusable', () => {
    mkdirSync(piUserDir, { recursive: true })
    writeFileSync(join(piUserDir, 'broken-deny.md'), '---\nname: broken-deny\ndescription: d\ndisallowedTools: 7\n---\nprompt')
    writeAgent(piUserDir, 'fine3.md', { name: 'fine3', description: 'ok' })

    expect(names(discoverAgents(cwd, 'user').agents)).toEqual(['fine3'])
  })

  it('carries a valid effort level and drops an unknown one', () => {
    // Claude's effort values are a subset of pi's thinking levels, so they map 1:1.
    writeAgent(piUserDir, 'hard.md', { name: 'hard', description: 'thinks hard', effort: 'max' })
    writeAgent(piUserDir, 'soft.md', { name: 'soft', description: 'thinks little', effort: 'low' })
    writeAgent(piUserDir, 'odd.md', { name: 'odd', description: 'bad effort', effort: 'enormous' })

    const byName = new Map(discoverAgents(cwd, 'user').agents.map((a) => [a.name, a]))
    expect(byName.get('hard')?.effort).toBe('max')
    expect(byName.get('soft')?.effort).toBe('low')
    expect(byName.get('odd')?.effort).toBeUndefined()
  })

  it('maps permissionMode plan to a read-only toolset when tools are unspecified', () => {
    writeAgent(piUserDir, 'planner.md', { name: 'planner', description: 'plans', permissionMode: 'plan' })
    writeAgent(piUserDir, 'planner-tooled.md', { name: 'planner-tooled', description: 'plans with tools', permissionMode: 'plan', tools: 'Read, Bash' })

    const byName = new Map(discoverAgents(cwd, 'user').agents.map((a) => [a.name, a]))
    expect(byName.get('planner')?.tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(byName.get('planner-tooled')?.tools).toEqual(['read', 'bash'])
  })

  it.each(['inherit', 'sonnet', 'Opus', 'haiku'])('runs a Claude model alias (%s) on the session default model', (model) => {
    // pi cannot resolve Anthropic tier aliases; passing one as --model would make the
    // child fail to boot. Claude's `inherit` semantics (session model) degrade safely.
    writeAgent(piUserDir, 'aliased.md', { name: 'aliased', description: 'alias model', model })

    expect(nonBuiltin(discoverAgents(cwd, 'user').agents)[0].model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// background.ts
// ---------------------------------------------------------------------------

const messageEnd = (role: string, ...texts: string[]): string => JSON.stringify({ type: 'message_end', message: { role, content: texts.map((text) => ({ type: 'text', text })) } })

const loadBackground = async (): Promise<typeof import('../extensions/subagent/background.ts')> => {
  vi.resetModules()
  spawned.calls.length = 0
  spawned.children.length = 0
  return await import('../extensions/subagent/background.ts')
}

describe('parseFinalOutputFromJsonl', () => {
  it('joins every text part when one assistant message has several', async () => {
    const { parseFinalOutputFromJsonl } = await loadBackground()

    // The whole final message, matching getFinalOutput on the foreground path.
    expect(parseFinalOutputFromJsonl(messageEnd('assistant', 'draft', 'polished'))).toEqual({ text: 'draft\npolished', turns: 1 })
  })

  it('counts an assistant turn even when the message carries no content', async () => {
    const { parseFinalOutputFromJsonl } = await loadBackground()
    const jsonl = [JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }), messageEnd('assistant', 'answer')].join('\n')

    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'answer', turns: 2 })
  })

  it('ignores events that are not message_end', async () => {
    const { parseFinalOutputFromJsonl } = await loadBackground()
    const jsonl = [JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] } }), messageEnd('assistant', 'kept')].join('\n')

    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'kept', turns: 1 })
  })

  it('skips blank and unparseable lines instead of failing', async () => {
    const { parseFinalOutputFromJsonl } = await loadBackground()
    const jsonl = ['', '   ', '{not json', messageEnd('assistant', 'survived'), ''].join('\n')

    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'survived', turns: 1 })
  })

  it('ignores non-text content parts', async () => {
    const { parseFinalOutputFromJsonl } = await loadBackground()
    const jsonl = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'spoken' }, { type: 'tool_use' }] },
    })

    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'spoken', turns: 1 })
  })
})

describe('formatStatus', () => {
  it('renders a finished run with exit code and turn count', async () => {
    const { formatStatus } = await loadBackground()
    const run = { id: 'bg-abcd1234', agent: 'scout', task: 'survey the repo', state: 'done' as const, exitCode: 0, turns: 4 }

    expect(formatStatus([run])).toBe('bg-abcd1234 scout: done (exit 0, 4 turns) - survey the repo')
  })

  it('renders a missing exit code as a question mark', async () => {
    const { formatStatus } = await loadBackground()
    const run = { id: 'bg-abcd1234', agent: 'scout', task: 'survey', state: 'failed' as const, turns: 2 }

    expect(formatStatus([run])).toBe('bg-abcd1234 scout: failed (exit ?, 2 turns) - survey')
  })

  it('omits exit code and turns for a running run', async () => {
    const { formatStatus } = await loadBackground()
    const run = { id: 'bg-abcd1234', agent: 'scout', task: 'survey', state: 'running' as const, exitCode: 0, turns: 7 }

    expect(formatStatus([run])).toBe('bg-abcd1234 scout: running - survey')
  })

  it('truncates the task at 60 characters', async () => {
    const { formatStatus } = await loadBackground()
    const task = 'x'.repeat(65)
    const run = { id: 'bg-abcd1234', agent: 'scout', task, state: 'running' as const, turns: 0 }

    expect(formatStatus([run])).toBe(`bg-abcd1234 scout: running - ${'x'.repeat(60)}`)
  })

  it('separates multiple runs with newlines', async () => {
    const { formatStatus } = await loadBackground()
    const runs = [
      { id: 'bg-1', agent: 'a', task: 'one', state: 'running' as const, turns: 0 },
      { id: 'bg-2', agent: 'b', task: 'two', state: 'failed' as const, exitCode: 2, turns: 1 },
    ]

    expect(formatStatus(runs)).toBe('bg-1 a: running - one\nbg-2 b: failed (exit 2, 1 turns) - two')
  })

  it('reports the empty registry with a sentence', async () => {
    const { formatStatus } = await loadBackground()

    expect(formatStatus([])).toBe('No background runs in this session.')
  })
})

describe('cancelBackgroundRun', () => {
  const invocation = { command: 'pi', args: ['--mode', 'json'], cwd: '/work/dir' }

  it('signals the run, reports cancelled state, and keeps it after the child exits', async () => {
    const { startBackgroundRun, cancelBackgroundRun, backgroundStatusText } = await loadBackground()
    let completed: { state: string } | undefined
    const id = startBackgroundRun('scout', 'survey', invocation, (run) => {
      completed = run
    })

    expect(cancelBackgroundRun(id as string)).toBe('cancelled')
    expect(spawned.children[0].kill).toHaveBeenCalled()
    expect(backgroundStatusText()).toContain('cancelled')

    // The child's non-zero exit is the cancellation; it must not read as a failure.
    spawned.children[0].emit('close', 143)
    expect(completed?.state).toBe('cancelled')
  })

  it('reports an unknown id and a run that already finished', async () => {
    const { startBackgroundRun, cancelBackgroundRun } = await loadBackground()
    expect(cancelBackgroundRun('bg-deadbeef')).toBe('unknown')

    const id = startBackgroundRun('scout', 'survey', invocation, () => {})
    spawned.children[0].emit('close', 0)
    expect(cancelBackgroundRun(id as string)).toBe('not-running')
  })
})

describe('startBackgroundRun', () => {
  const invocation = { command: 'pi', args: ['--mode', 'json'], cwd: '/work/dir' }

  it('returns a bg- prefixed id built from a uuid prefix', async () => {
    const { startBackgroundRun } = await loadBackground()

    const id = startBackgroundRun('scout', 'survey', invocation, () => {})

    expect(id).toMatch(/^bg-[0-9a-f]{8}$/)
  })

  it('gives concurrent runs distinct ids', async () => {
    const { startBackgroundRun } = await loadBackground()

    const first = startBackgroundRun('scout', 'one', invocation, () => {})
    const second = startBackgroundRun('scout', 'two', invocation, () => {})

    expect(first).not.toBe(second)
  })

  it('spawns the invocation without a shell, stdout piped, marked as a subagent run', async () => {
    const { startBackgroundRun } = await loadBackground()

    startBackgroundRun('scout', 'survey', invocation, () => {})

    expect(spawned.calls).toEqual([
      {
        command: 'pi',
        args: ['--mode', 'json'],
        options: { cwd: '/work/dir', shell: false, stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: expect.objectContaining({ PI_CODE_SUBAGENT: '1' }) },
      },
    ])
  })

  it('refuses a new run at the cap, atomically with registration', async () => {
    // Callers await temp-file writes between their own check and this call, so
    // concurrent tool calls could all pass an earlier check; this one cannot be raced.
    const { startBackgroundRun, activeBackgroundRuns, MAX_BACKGROUND_RUNS } = await loadBackground()
    for (let i = 0; i < MAX_BACKGROUND_RUNS; i++) startBackgroundRun('scout', `t${i}`, invocation, () => {})
    expect(activeBackgroundRuns()).toBe(MAX_BACKGROUND_RUNS)

    expect(startBackgroundRun('scout', 'over', invocation, () => {})).toBeNull()
    expect(spawned.calls).toHaveLength(MAX_BACKGROUND_RUNS)
  })

  it('counts only running runs as active', async () => {
    const { startBackgroundRun, activeBackgroundRuns } = await loadBackground()

    startBackgroundRun('scout', 'one', invocation, () => {})
    startBackgroundRun('scout', 'two', invocation, () => {})
    expect(activeBackgroundRuns()).toBe(2)

    spawned.children[0].emit('close', 0)
    expect(activeBackgroundRuns()).toBe(1)
  })

  it('registers the run as running before the child exits', async () => {
    const { startBackgroundRun, backgroundStatusText } = await loadBackground()

    const id = startBackgroundRun('scout', 'survey the repo', invocation, () => {})

    expect(backgroundStatusText()).toBe(`${id} scout: running - survey the repo`)
  })

  it('marks the run done and reports parsed output when the child exits zero', async () => {
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []

    const id = startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.stdout.emit('data', Buffer.from(`${messageEnd('assistant', 'all done')}\n`))
    child.emit('close', 0)

    expect(completed).toMatchObject([{ id, agent: 'scout', task: 'survey', state: 'done', exitCode: 0, output: 'all done', turns: 1 }])
  })

  it('concatenates stdout chunks before parsing', async () => {
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []
    const line = messageEnd('assistant', 'split across chunks')

    startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.stdout.emit('data', Buffer.from(line.slice(0, 20)))
    child.stdout.emit('data', Buffer.from(line.slice(20)))
    child.emit('close', 0)

    expect(completed[0].output).toBe('split across chunks')
    expect(completed[0].turns).toBe(1)
  })

  it('marks the run failed and keeps the exit code when the child exits non-zero', async () => {
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []

    startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.emit('close', 3)

    expect(completed[0].state).toBe('failed')
    expect(completed[0].exitCode).toBe(3)
  })

  it('treats a null exit code as a failure recorded as exit 0', async () => {
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []

    startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.emit('close', null)

    expect(completed[0].state).toBe('failed')
    expect(completed[0].exitCode).toBe(0)
  })

  it('marks the run failed with exit 1 and no output when the child errors', async () => {
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []

    const id = startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.emit('error', new Error('ENOENT'))

    expect(completed).toMatchObject([{ id, agent: 'scout', task: 'survey', state: 'failed', exitCode: 1, turns: 0 }])
  })

  it('completes once when a spawn failure emits both error and close', async () => {
    // Node fires error then close on ENOENT; the completion callback (which triggers a
    // turn) must run a single time, not once per event.
    const { startBackgroundRun } = await loadBackground()
    const completed: Array<Record<string, unknown>> = []

    startBackgroundRun('scout', 'survey', invocation, (run) => completed.push({ ...run }))
    const child = spawned.children[0]
    child.emit('error', new Error('ENOENT'))
    child.emit('close', null)

    expect(completed).toHaveLength(1)
    expect(completed[0].state).toBe('failed')
  })

  it('reflects the finished state in the session status text', async () => {
    const { startBackgroundRun, backgroundStatusText } = await loadBackground()

    const id = startBackgroundRun('scout', 'survey', invocation, () => {})
    const child = spawned.children[0]
    child.stdout.emit('data', Buffer.from(`${messageEnd('assistant', 'ok')}\n`))
    child.emit('close', 0)

    expect(backgroundStatusText()).toBe(`${id} scout: done (exit 0, 1 turns) - survey`)
  })
})

describe('agent skills preload', () => {
  it('parses a skills list and appends the named skill bodies to the prompt', () => {
    const skillsRoot = join(fakeHome.path, '.claude', 'skills')
    mkdirSync(join(skillsRoot, 'deploy'), { recursive: true })
    writeFileSync(join(skillsRoot, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: ship it\n---\nRun the deploy checklist.')

    const prompt = withPreloadedSkills('Base prompt.', ['deploy'], [skillsRoot])
    expect(prompt).toContain('Base prompt.')
    expect(prompt).toContain('Run the deploy checklist.')
    expect(prompt).toContain('deploy')
  })

  it('notes a skill it cannot find rather than silently dropping it', () => {
    const prompt = withPreloadedSkills('Base.', ['ghost'], [join(fakeHome.path, '.claude', 'skills')])
    expect(prompt).toContain('ghost')
    expect(prompt).toContain('not found')
  })

  it('refuses a skill name that escapes the skills directory', () => {
    // The name comes from agent frontmatter, which a repository can control; a
    // traversal would read an arbitrary file into the prompt sent to the model.
    const skillsRoot = join(fakeHome.path, '.claude', 'skills')
    mkdirSync(skillsRoot, { recursive: true })
    writeFileSync(join(fakeHome.path, '.claude', 'secret.md'), 'TOP_SECRET')

    const prompt = withPreloadedSkills('Base.', ['../secret'], [skillsRoot])
    expect(prompt).not.toContain('TOP_SECRET')
    expect(prompt).toContain('not found')
  })

  it('refuses a skill name with a path separator', () => {
    const skillsRoot = join(fakeHome.path, '.claude', 'skills')
    mkdirSync(join(skillsRoot, 'nested'), { recursive: true })
    writeFileSync(join(skillsRoot, 'nested', 'SKILL.md'), 'NESTED_BODY')

    expect(withPreloadedSkills('Base.', ['nested/../nested'], [skillsRoot])).toContain('not found')
  })

  it('returns the prompt untouched when the agent preloads nothing', () => {
    expect(withPreloadedSkills('Base.', undefined, [])).toBe('Base.')
    expect(withPreloadedSkills('Base.', [], [])).toBe('Base.')
  })
})

describe('resumeBackgroundRun', () => {
  const invocation = { command: 'pi', args: ['--mode', 'json', '-p', '--no-session', 'Task: first'], cwd: '/work/dir' }

  it('spawns the follow-up under the same session id with the new task', async () => {
    const { startBackgroundRun, resumeBackgroundRun, backgroundRun } = await loadBackground()
    const id = startBackgroundRun('scout', 'first', invocation, () => {}) as string
    const sessionId = backgroundRun(id)?.sessionId
    expect(sessionId).toBeTruthy()
    // --no-session is replaced so the child persists what it saw.
    expect(spawned.calls[0].args).toContain('--session-id')
    expect(spawned.calls[0].args).not.toContain('--no-session')
    spawned.children[0].emit('close', 0)

    expect(resumeBackgroundRun(id, 'second', () => {})).toBe('resumed')
    const followUp = spawned.calls[1].args
    expect(followUp[followUp.indexOf('--session-id') + 1]).toBe(sessionId)
    expect(followUp.at(-1)).toBe('Task: second')
  })

  it('refuses to resume a run that is still going, or an unknown id', async () => {
    const { startBackgroundRun, resumeBackgroundRun } = await loadBackground()
    const id = startBackgroundRun('scout', 'first', invocation, () => {}) as string
    expect(resumeBackgroundRun(id, 'again', () => {})).toBe('still-running')
    expect(resumeBackgroundRun('bg-nope', 'again', () => {})).toBe('unknown')
  })
})

describe('resolveModelAlias', () => {
  const available = [
    { id: 'claude-sonnet-4-5', provider: 'anthropic' },
    { id: 'claude-opus-4-1', provider: 'anthropic' },
    { id: 'gpt-oss:20b', provider: 'ollama' },
  ]

  it('resolves a Claude tier alias to an authenticated model id', () => {
    expect(resolveModelAlias('sonnet', available)).toBe('claude-sonnet-4-5')
    expect(resolveModelAlias('Opus', available)).toBe('claude-opus-4-1')
  })

  it('returns undefined when the tier is not available, so the session model is used', () => {
    expect(resolveModelAlias('haiku', available)).toBeUndefined()
    expect(resolveModelAlias('sonnet', [{ id: 'gpt-oss:20b', provider: 'ollama' }])).toBeUndefined()
  })

  it('treats inherit as the session model rather than a tier to look up', () => {
    expect(resolveModelAlias('inherit', available)).toBeUndefined()
  })
})

describe('preloaded skill symlink confinement', () => {
  it('refuses a skill directory that symlinks outside the skills root', () => {
    const outside = join(fakeHome.path, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'ESCAPED_BODY')
    const skillsRoot = join(fakeHome.path, '.claude', 'skills')
    mkdirSync(skillsRoot, { recursive: true })
    symlinkSync(outside, join(skillsRoot, 'linked'))

    // The name passes the stem pattern; only resolving the link catches this.
    const prompt = withPreloadedSkills('Base.', ['linked'], [skillsRoot])
    expect(prompt).not.toContain('ESCAPED_BODY')
    expect(prompt).toContain('not found')
  })
})
