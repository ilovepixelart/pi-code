import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import commandsExtension, { collectCommands, commandDirs, expandCommand, SHELL_DISABLED_PLACEHOLDER, shellExecutionDisabled, slashCommandBudget, slashCommandToolDescription } from '../extensions/commands.ts'
import { parseCommandFile } from '../extensions/internal/command-file.js'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'

const hoisted = vi.hoisted(() => ({ home: '', pwshBinary: undefined as string | undefined }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})
// The resolver seam: these tests must not depend on pwsh being installed, so the
// binary lookup is stubbed while everything else in the module stays real.
vi.mock('../extensions/internal/command-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extensions/internal/command-file.js')>()
  return { ...actual, resolvePowershellBinary: () => hoisted.pwshBinary }
})

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cmds-'))
  dirs.push(dir)
  return dir
}
const writeCommand = (root: string, rel: string, content: string): void => {
  const full = join(root, '.claude', 'commands', rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

let savedAgentDir: string | undefined
beforeEach(() => {
  hoisted.home = tempDir()
  hoisted.pwshBinary = undefined
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = tempDir()
})
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  setManagedSettingsPath()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('commandDirs', () => {
  it('includes the project directory only when the project is approved', () => {
    const cwd = tempDir()
    writeCommand(cwd, 'a.md', 'x')
    writeCommand(hoisted.home, 'b.md', 'y')
    expect(commandDirs(cwd, hoisted.home, false)).toHaveLength(1)
    expect(commandDirs(cwd, hoisted.home, true)).toHaveLength(2)
  })

  it('finds project commands at the repository root from a subdirectory session', () => {
    // The approval walk gates on config up to the repo root; discovery has to reach
    // the same files, or a subdirectory session is prompted for commands it never gets.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    writeCommand(repo, 'ship.md', 'x')
    const sub = join(repo, 'src')
    mkdirSync(sub)
    expect(commandDirs(sub, hoisted.home, true)).toEqual([join(repo, '.claude', 'commands')])
  })

  it('resolves the user commands directory under CLAUDE_CONFIG_DIR', () => {
    // Claude keeps commands inside CLAUDE_CONFIG_DIR when set, not ~/.claude/commands.
    const cfg = tempDir()
    mkdirSync(join(cfg, 'commands'), { recursive: true })
    writeFileSync(join(cfg, 'commands', 'x.md'), 'body')
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      expect(commandDirs(tempDir(), hoisted.home, false)).toEqual([join(cfg, 'commands')])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
})

describe('collectCommands', () => {
  it('lets a personal command win a name clash with a project command', () => {
    // Claude: "personal overrides project".
    const cwd = tempDir()
    writeCommand(hoisted.home, 'ship.md', 'user version')
    writeCommand(cwd, 'ship.md', 'project version')
    const found = collectCommands(commandDirs(cwd, hoisted.home, true))
    expect(found).toHaveLength(1)
    expect(found[0].filePath).toContain(hoisted.home)
  })
})

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (id: string, params: { command: string }, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>
}

const setup = (cwd: string, trusted = true) => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  const tools = new Map<string, RegisteredTool>()
  const sent: string[] = []
  const sentOptions: unknown[] = []
  const toolSets: string[][] = []
  const notices: string[] = []
  const execCalls: Array<{ file: string; args: string[]; shell: string; timeout?: number; env?: Record<string, string> }> = []
  const execResult = { stderr: '', code: 0, killed: false }
  let active = ['bash', 'read', 'edit', 'write']
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    exec: async (file: string, args: string[], opts?: { timeout?: number; env?: Record<string, string> }) => {
      execCalls.push({ file, args, shell: args[1], timeout: opts?.timeout, env: opts?.env })
      return { stdout: `ran:${args[1]}`, ...execResult }
    },
    sendUserMessage: (text: string, options?: unknown) => {
      sent.push(text)
      sentOptions.push(options)
    },
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => {
      active = next
      toolSets.push(next)
    },
    setModel: async (model: { id: string }) => {
      modelSets.push(model.id)
      return true
    },
    setThinkingLevel: (level: string) => {
      thinkingSets.push(level)
    },
  }
  const modelSets: string[] = []
  const thinkingSets: string[] = []
  const available = [
    { id: 'gemma4', name: 'Gemma 4' },
    { id: 'claude-opus-5', name: 'Opus' },
    { id: 'claude-fable-5', name: 'Fable' },
  ]
  commandsExtension(pi as never)
  let idle = true
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => 'sess-1' },
    thinkingLevel: 'high',
    model: available[0],
    modelRegistry: { getAvailable: () => available },
    ui: {
      confirm: async () => trusted,
      notify: (message: string) => {
        notices.push(message)
      },
    },
  }
  return {
    handlers,
    commands,
    tools,
    sent,
    sentOptions,
    toolSets,
    notices,
    execCalls,
    ctx,
    modelSets,
    thinkingSets,
    activeTools: () => active,
    setIdle: (value: boolean) => {
      idle = value
    },
    failExec: (result: { stderr: string; code: number; killed?: boolean }) => Object.assign(execResult, result),
  }
}

describe('commands extension', () => {
  it('registers a nested command under its file name and drives a turn with substituted args', async () => {
    const cwd = tempDir()
    writeCommand(cwd, join('frontend', 'build.md'), '---\ndescription: Build it\nargument-hint: [target]\n---\nBuild $0 now.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    expect([...s.commands.keys()]).toEqual(['build'])
    expect(s.commands.get('build')?.description).toBe('Build it [target]')

    await s.commands.get('build')?.handler('web', s.ctx)
    expect(s.sent).toEqual(['Build web now.'])
  })

  it('leaves ${user_config.*} literal in an ordinary (non-plugin) command', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', 'token is ${user_config.token}')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('deploy')?.handler('', s.ctx)
    // Only plugin commands carry user config; a plain command keeps the text verbatim.
    expect(s.sent[0]).toBe('token is ${user_config.token}')
  })

  it('expands bash spans and file references in the body', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'notes.md'), 'NOTE_BODY')
    writeCommand(cwd, 'ctx.md', 'status: !`git status`\nnotes: @notes.md')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ctx')?.handler('', s.ctx)

    expect(s.sent[0]).toContain('git status')
    expect(s.sent[0]).toContain('NOTE_BODY')
  })

  it('exposes CLAUDE_PROJECT_DIR to a bash span, as hooks do', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ctx.md', 'here: !`pwd`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ctx')?.handler('', s.ctx)

    // pi.exec takes no env, so the variable is exported in the shell string itself.
    expect(s.execCalls[0].shell).toContain(`export CLAUDE_PROJECT_DIR='${cwd}'`)
    expect(s.execCalls[0].shell).toContain('pwd')
  })

  it('keeps the restriction in place for the run, restoring only when it ends', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('safe')?.handler('', s.ctx)

    // sendUserMessage is fire-and-forget, so restoring inside the handler would put
    // the full set back before the agent ever read it: the restriction must outlive
    // the handler and end with the agent run.
    expect(s.toolSets[0]).toEqual(['read'])
    expect(s.activeTools()).toEqual(['read'])

    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('queues a command invoked mid-stream as a follow-up without touching the in-flight run', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    // The agent is streaming: the command must not narrow the in-flight run's tools or
    // switch its model, and a bare sendUserMessage would throw. It is queued as a
    // follow-up through pi's own queue instead, with no scoping applied.
    s.setIdle(false)
    await s.commands.get('safe')?.handler('', s.ctx)
    expect(s.sent).toEqual(['Look only.'])
    expect(s.sentOptions).toEqual([{ deliverAs: 'followUp' }])
    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('applies scoping and sends bare when the command is invoked while idle', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    await s.commands.get('safe')?.handler('', s.ctx)
    expect(s.sent).toEqual(['Look only.'])
    expect(s.sentOptions).toEqual([undefined])
    expect(s.activeTools()).toEqual(['read'])
  })

  it('keeps the restriction through a mid-run turn_end, since pi fires one per assistant step', async () => {
    // Claude's contract is "the grant clears when you send your next message". pi's
    // turn_end fires after every assistant step, so restoring there stripped a
    // multi-step command's scoping right after step one.
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('safe')?.handler('', s.ctx)

    await s.handlers.get('turn_end')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['read'])

    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('keeps the scoping across an agent_end loop boundary and lifts it only once the run has settled', async () => {
    // agent_end fires once per agent loop, ahead of an automatic retry, an auto-
    // compaction-and-retry, or a Stop-hook continuation. Restoring there would lift
    // the command's scoping while that continued run is still to come, so the restore
    // is bound to agent_settled, which fires only after the run has fully settled.
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('safe')?.handler('', s.ctx)
    expect(s.activeTools()).toEqual(['read'])

    await s.handlers.get('agent_end')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['read'])

    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('honors an explicitly empty grant, which asks for no tools', async () => {
    // Distinct from the case below: `[]` is a restriction the author wrote, not a
    // restriction that failed to map.
    const cwd = tempDir()
    writeCommand(cwd, 'none.md', '---\nallowed-tools: []\n---\nThink only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('none')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual([])
  })

  it('applies a flow-sequence grant, which YAML allows and a hand-rolled parse missed', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ro.md', '---\nallowed-tools: [Read]\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ro')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['read'])
  })

  it('runs unrestricted rather than with no tools when no name maps to a pi tool', async () => {
    // Every unmapped Claude name intersects the active set to nothing. A turn with no
    // tools is never what the command asked for.
    const cwd = tempDir()
    writeCommand(cwd, 'nb.md', '---\nallowed-tools: NotebookEdit\n---\nEdit the notebook.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('nb')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('restores the set from before the first command when two run in one turn', async () => {
    // The second command recorded the first one's narrowed set as the thing to put
    // back, so the tools the first command dropped never returned.
    const cwd = tempDir()
    writeCommand(cwd, 'a.md', '---\nallowed-tools: Read\n---\nLook.')
    writeCommand(cwd, 'b.md', '---\nallowed-tools: Bash\n---\nRun.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('a')?.handler('', s.ctx)
    await s.commands.get('b')?.handler('', s.ctx)
    await s.handlers.get('agent_settled')?.({}, s.ctx)

    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('drops pending command scoping on session_start so it never restores across a session switch', async () => {
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while a command's tool, model, and effort scoping is still pending;
    // restoring that stale state into the next session would corrupt it, so session_start
    // drops the pending state (without itself restoring anything).
    const cwd = tempDir()
    writeCommand(cwd, 'deep.md', '---\nallowed-tools: Read\nmodel: opus\neffort: max\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('deep')?.handler('', s.ctx)
    expect(s.activeTools()).toEqual(['read'])
    expect(s.modelSets).toEqual(['claude-opus-5'])
    expect(s.thinkingSets).toEqual(['max'])

    // A mid-turn /new reuses the instance: the pending restores must be dropped.
    await s.handlers.get('session_start')?.({}, s.ctx)
    const toolSetsBefore = s.toolSets.length
    await s.handlers.get('agent_settled')?.({}, s.ctx)

    // agent_settled fired no stale restore: tools, model, and effort are left where the
    // command left them rather than reverted into the next session.
    expect(s.toolSets.length).toBe(toolSetsBefore)
    expect(s.activeTools()).toEqual(['read'])
    expect(s.modelSets).toEqual(['claude-opus-5'])
    expect(s.thinkingSets).toEqual(['max'])
  })

  it('does not register project commands for an unapproved project', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'evil.md', 'do bad things')
    const s = setup(cwd, false)
    await s.handlers.get('session_start')?.({}, s.ctx)
    expect(s.commands.size).toBe(0)
  })
})

describe('command model frontmatter', () => {
  it('switches to the command model for the run and restores it on agent_settled', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deep.md', '---\nmodel: opus\n---\nThink hard.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('deep')?.handler('', s.ctx)
    // opus fuzzy-matches claude-opus-5 among the available models.
    expect(s.modelSets).toEqual(['claude-opus-5'])
    // A mid-run turn_end must not restore: a multi-step command keeps its model.
    await s.handlers.get('turn_end')?.({}, s.ctx)
    expect(s.modelSets).toEqual(['claude-opus-5'])
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    // Restored to the session model.
    expect(s.modelSets).toEqual(['claude-opus-5', 'gemma4'])
  })

  it('resolves a fable tier alias and a concrete id, and no-ops on inherit or absent', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'f.md', '---\nmodel: fable\n---\nx')
    writeCommand(cwd, 'exact.md', '---\nmodel: claude-opus-5\n---\nx')
    writeCommand(cwd, 'inh.md', '---\nmodel: inherit\n---\nx')
    writeCommand(cwd, 'none.md', 'x')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('f')?.handler('', s.ctx)
    expect(s.modelSets.at(-1)).toBe('claude-fable-5')
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    const before = s.modelSets.length
    await s.commands.get('exact')?.handler('', s.ctx)
    expect(s.modelSets.at(-1)).toBe('claude-opus-5')
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    const afterExact = s.modelSets.length
    await s.commands.get('inh')?.handler('', s.ctx)
    await s.commands.get('none')?.handler('', s.ctx)
    // inherit and no model do not touch setModel.
    expect(s.modelSets.length).toBe(afterExact)
    expect(before).toBeGreaterThan(0)
  })

  it('leaves the model unchanged when the command names an unavailable model', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'x.md', '---\nmodel: nonesuch-9\n---\nx')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('x')?.handler('', s.ctx)
    expect(s.modelSets).toEqual([])
  })
})

describe('command effort frontmatter', () => {
  it('escalates the thinking level for the run and restores it on agent_settled', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deep.md', '---\neffort: max\n---\nThink hard.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('deep')?.handler('', s.ctx)
    // The session level is 'high'; the command raises it for its run.
    expect(s.thinkingSets).toEqual(['max'])
    // A mid-run turn_end must not restore: a multi-step command keeps its level.
    await s.handlers.get('turn_end')?.({}, s.ctx)
    expect(s.thinkingSets).toEqual(['max'])
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    // Restored to the session level once the run settles.
    expect(s.thinkingSets).toEqual(['max', 'high'])
  })

  it('does not touch the thinking level when effort matches the session or is absent, and restores nothing', async () => {
    const cwd = tempDir()
    // The session level is 'high'.
    writeCommand(cwd, 'same.md', '---\neffort: high\n---\nx')
    writeCommand(cwd, 'none.md', 'x')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('same')?.handler('', s.ctx)
    await s.commands.get('none')?.handler('', s.ctx)
    expect(s.thinkingSets).toEqual([])
    // Nothing was changed, so agent_settled restores nothing either.
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(s.thinkingSets).toEqual([])
  })

  it('ignores an effort value outside the thinking-level union', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'bad.md', '---\neffort: turbo\n---\nx')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('bad')?.handler('', s.ctx)
    expect(s.thinkingSets).toEqual([])
  })

  it('restores the level from before the first command when two escalate in one turn', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'a.md', '---\neffort: max\n---\nA.')
    writeCommand(cwd, 'b.md', '---\neffort: low\n---\nB.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('a')?.handler('', s.ctx)
    await s.commands.get('b')?.handler('', s.ctx)
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    // First-restriction-wins: the restore target is the original session level.
    expect(s.thinkingSets).toEqual(['max', 'low', 'high'])
  })
})

describe('user-invocable frontmatter', () => {
  it('hides a user-invocable:false command from the slash-command map but lists and runs it via the tool', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'gen.md', '---\ndescription: Generate code\nuser-invocable: false\n---\nGenerate $0.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    // Not registered as a user slash command...
    expect(s.commands.has('gen')).toBe(false)
    // ...but present in the slash_command tool description and callable by the model.
    const tool = s.tools.get('slash_command')
    expect(tool?.description).toContain('/gen - Generate code')
    const result = await tool?.execute('t1', { command: '/gen staging' }, undefined, undefined, s.ctx)
    expect(result?.content[0].text).toContain('Generate staging.')
  })

  it('registers only the user-invocable commands while keeping the hidden one model-callable', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'hidden.md', '---\nuser-invocable: false\n---\nHidden.')
    writeCommand(cwd, 'shown.md', '---\ndescription: Visible\n---\nShown.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    expect([...s.commands.keys()]).toEqual(['shown'])
    // The hidden command still resolves for the model.
    const result = await s.tools.get('slash_command')?.execute('t1', { command: '/hidden' }, undefined, undefined, s.ctx)
    expect(result?.content[0].text).toContain('Hidden.')
  })
})

describe('when_to_use frontmatter', () => {
  it('appends when_to_use to the tool listing but not the user-facing command description', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', '---\ndescription: Deploy it\nargument-hint: [env]\nwhen_to_use: use when shipping to prod\n---\nDeploy $0.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    // The user-facing command description omits when_to_use.
    expect(s.commands.get('deploy')?.description).toBe('Deploy it [env]')
    // The tool listing carries the trigger text.
    expect(s.tools.get('slash_command')?.description).toContain('use when shipping to prod')
  })
})

describe('plugin commands', () => {
  const installPluginCommand = (home: string, plugin: string, file: string, body: string): string => {
    const root = join(home, '.claude', 'plugins', 'cache', 'market', plugin, '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin }))
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, 'commands', file), body)
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [plugin]: true } }))
    return root
  }

  it('registers an enabled plugin command under its plugin namespace with plugin vars', async () => {
    const cwd = tempDir()
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const root = installPluginCommand(hoisted.home, 'deployer', 'ship.md', 'Run ${CLAUDE_PLUGIN_ROOT}/bin/ship.sh with data in ${CLAUDE_PLUGIN_DATA}.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    expect([...s.commands.keys()]).toContain('deployer:ship')
    await s.commands.get('deployer:ship')?.handler('', s.ctx)
    expect(s.sent[0]).toBe(`Run ${root}/bin/ship.sh with data in ${join(hoisted.home, '.claude', 'plugins', 'data', 'deployer-market')}.`)
  })

  it('substitutes ${user_config.*} in a plugin command body from pluginConfigs', async () => {
    const cwd = tempDir()
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    installPluginCommand(hoisted.home, 'deployer', 'ship.md', 'Deploy to ${user_config.region} as ${user_config.actor}.')
    // Overwrite settings so the enabled plugin also carries its user config.
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { deployer: true }, pluginConfigs: { deployer: { options: { region: 'eu-west-1' } } } }))
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    await s.commands.get('deployer:ship')?.handler('', s.ctx)
    // A configured key substitutes; an unset one collapses to empty, like Claude.
    expect(s.sent[0]).toBe('Deploy to eu-west-1 as .')
  })

  it('does not register commands from an explicitly disabled plugin', async () => {
    const cwd = tempDir()
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'dormant', '1.0.0')
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, 'commands', 'x.md'), 'body')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { dormant: false } }))
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    expect([...s.commands.keys()]).not.toContain('dormant:x')
  })
})

describe('claude variables and skill frontmatter wiring', () => {
  it('substitutes ${CLAUDE_*} variables in the body and in allowed-tools rules', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'v.md', '---\nallowed-tools: Bash(${CLAUDE_SKILL_DIR}/run.sh *)\n---\nRun ${CLAUDE_SKILL_DIR}/run.sh in ${CLAUDE_PROJECT_DIR} as ${CLAUDE_SESSION_ID} (${CLAUDE_EFFORT}).')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('v')?.handler('', s.ctx)

    const skillDir = join(cwd, '.claude', 'commands')
    expect(s.sent[0]).toContain(`Run ${skillDir}/run.sh in ${cwd} as sess-1 (high).`)
    // The rule matches the exact command the body names, as Claude documents.
    expect(await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: `${skillDir}/run.sh data.csv` } }, s.ctx)).toBeUndefined()
    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm -rf /' } }, s.ctx)) as { block?: boolean }
    expect(blocked?.block).toBe(true)
  })

  it('appends ARGUMENTS when args are passed and the body never reads them', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'd.md', 'Deploy now.')
    writeCommand(cwd, 'e.md', 'Deploy $ARGUMENTS now.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('d')?.handler('prod', s.ctx)
    await s.commands.get('e')?.handler('prod', s.ctx)

    expect(s.sent[0]).toBe('Deploy now.\n\nARGUMENTS: prod')
    expect(s.sent[1]).toBe('Deploy prod now.')
  })

  it('removes disallowed-tools for the run and restores them after', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ro.md', '---\ndisallowed-tools: Edit, Write\n---\nLook, do not touch.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ro')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['bash', 'read'])
    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
  })

  it('aborts the invocation when a bash span fails, sending nothing', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'f.md', 'status: !`broken-cmd`')
    const s = setup(cwd)
    s.failExec({ stderr: 'not found', code: 127 })
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('f')?.handler('', s.ctx)

    expect(s.sent).toEqual([])
    expect(s.notices.some((n) => n.includes('broken-cmd'))).toBe(true)
  })

  it('aborts the invocation when a bash span is killed at its timeout, even with exit code 0', async () => {
    // pi reports a timeout kill as killed:true with code 0 (a signal death has no exit
    // code); Claude kills the command at the Bash timeout and that failure aborts the skill.
    const cwd = tempDir()
    writeCommand(cwd, 'f.md', 'status: !`sleep 999`')
    const s = setup(cwd)
    s.failExec({ stderr: '', code: 0, killed: true })
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('f')?.handler('', s.ctx)

    expect(s.sent).toEqual([])
    expect(s.notices.some((n) => n.includes('sleep 999') && n.includes('timed out'))).toBe(true)
  })

  it('runs bash spans with merged stderr under the Bash tool budget', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ctx2.md', 'here: !`pwd`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ctx2')?.handler('', s.ctx)

    expect(s.execCalls[0].shell).toContain('2>&1')
    expect(s.execCalls[0].timeout).toBe(120_000)
  })

  it('keeps a comment-only ```! fence a harmless no-op on the sh path', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'noop.md', 'Steps:\n```!\n# nothing yet\n```\ndone')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('noop')?.handler('', s.ctx)

    // Wrapping the span as `{ ... } 2>&1` alone was an sh syntax error for an
    // empty or comment-only fence, aborting the whole command; the `:` null
    // command keeps the group valid so these run as no-ops, as they did on HEAD.
    expect(s.execCalls[0].args[1]).toContain('{ :\n')
    expect(s.sent).toHaveLength(1)
  })
})

it('substitutes CLAUDE_EFFORT in Claude vocabulary, and leaves it unset when thinking is off', async () => {
  // env-vars: CLAUDE_EFFORT is "low, medium, high, xhigh, or max" and is "only set when
  // the current model supports the effort parameter", so pi's minimal and off must not
  // reach a command body as themselves.
  const cwd = tempDir()
  writeCommand(cwd, 'e.md', 'effort: ${CLAUDE_EFFORT}')
  const s = setup(cwd)
  await s.handlers.get('session_start')?.({}, s.ctx)

  await s.commands.get('e')?.handler('', { ...s.ctx, thinkingLevel: 'minimal' })
  expect(s.sent.at(-1)).toBe('effort: low')

  await s.commands.get('e')?.handler('', { ...s.ctx, thinkingLevel: 'off' })
  expect(s.sent.at(-1)).toBe('effort: ${CLAUDE_EFFORT}')
})

describe('shell frontmatter', () => {
  // The bash path is /bin/sh off Windows; the Windows runners have Git for Windows, so Git Bash.
  const expectBashPath = (file: string): void => {
    if (process.platform === 'win32') expect(file).toMatch(/\\Git\\bin\\bash\.exe$/)
    else expect(file).toBe('/bin/sh')
  }

  it('runs a powershell command span through the resolved pwsh binary with -Command', async () => {
    const cwd = tempDir()
    hoisted.pwshBinary = '/opt/homebrew/bin/pwsh'
    writeCommand(cwd, 'ps.md', '---\nshell: powershell\n---\nfiles: !`Get-ChildItem`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ps')?.handler('', s.ctx)

    expect(s.execCalls[0].file).toBe('/opt/homebrew/bin/pwsh')
    expect(s.execCalls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    // The PowerShell script carries the same contract as the sh one: project dir
    // set (PowerShell quoting, not sh's), failure propagation, Bash tool budget.
    expect(s.execCalls[0].args[3]).toContain(`$env:CLAUDE_PROJECT_DIR='${cwd}'`)
    expect(s.execCalls[0].args[3]).toContain('Get-ChildItem')
    // pwsh -Command exits 0 even when a native command in the block failed, so
    // the script must forward $LASTEXITCODE for failures to abort the command.
    expect(s.execCalls[0].args[3]).toContain('exit $LASTEXITCODE')
    expect(s.execCalls[0].timeout).toBe(120_000)
    expect(s.sent).toHaveLength(1)
  })

  it('pastes a powershell span stderr into the output via the caller-side merge', async () => {
    const cwd = tempDir()
    hoisted.pwshBinary = '/opt/homebrew/bin/pwsh'
    writeCommand(cwd, 'ps.md', '---\nshell: powershell\n---\nhits: !`grep x .`')
    const s = setup(cwd)
    // Exit 0 with stderr text: pwsh cannot merge in-script (`2>&1` on a script
    // block drops a native command's stderr), so the runner must append it.
    s.failExec({ stderr: 'grep: warning text\n', code: 0 })
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ps')?.handler('', s.ctx)

    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('grep: warning text')
  })

  it('leaves the sh path merge to the script itself, never appending stderr twice', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'sh2.md', 'x: !`pwd`')
    const s = setup(cwd)
    s.failExec({ stderr: 'stray noise', code: 0 })
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('sh2')?.handler('', s.ctx)

    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).not.toContain('stray noise')
  })

  it('falls back to the bash path when no PowerShell binary is installed', async () => {
    const cwd = tempDir()
    // hoisted.pwshBinary stays undefined: the resolver finds nothing, as on this mac.
    writeCommand(cwd, 'ps.md', '---\nshell: powershell\n---\nfiles: !`Get-ChildItem`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ps')?.handler('', s.ctx)

    expectBashPath(s.execCalls[0].file)
    expect(s.execCalls[0].args[0]).toBe('-c')
    expect(s.execCalls[0].args[1]).toContain('Get-ChildItem')
    expect(s.execCalls[0].args[1]).toContain(`export CLAUDE_PROJECT_DIR='${cwd}'`)
    expect(s.sent).toHaveLength(1)
  })

  it('never routes a bash-shell command through pwsh, even when it is installed', async () => {
    const cwd = tempDir()
    hoisted.pwshBinary = '/opt/homebrew/bin/pwsh'
    writeCommand(cwd, 'sh.md', 'status: !`git status`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('sh')?.handler('', s.ctx)

    expectBashPath(s.execCalls[0].file)
    expect(s.execCalls[0].args[0]).toBe('-c')
  })
})

describe('allowed-tools argument scopes', () => {
  it('grants bash but enforces the scope at call time for the restricted turn', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'stage.md', '---\nallowed-tools: Bash(git add:*), Read\n---\nStage it.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('stage')?.handler('', s.ctx)

    // pi's active-tool set has no argument dimension, so the base tool is granted...
    expect(s.activeTools()).toEqual(['bash', 'read'])
    // ...and the scope is enforced when the call arrives.
    expect(await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'git add -A' } }, s.ctx)).toBeUndefined()
    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm -rf /' } }, s.ctx)) as { block?: boolean; reason?: string }
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('git add:*')
  })

  it('leaves other granted tools alone while a bash scope is enforced', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'stage.md', '---\nallowed-tools: Bash(git add:*), Read\n---\nStage it.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('stage')?.handler('', s.ctx)

    expect(await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'x' } }, s.ctx)).toBeUndefined()
  })

  it('stops enforcing when the run ends, not on a mid-run turn_end', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'stage.md', '---\nallowed-tools: Bash(git add:*)\n---\nStage it.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('stage')?.handler('', s.ctx)

    // A second assistant step is still inside the command's run: the scope holds.
    await s.handlers.get('turn_end')?.({}, s.ctx)
    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm -rf /' } }, s.ctx)) as { block?: boolean }
    expect(blocked?.block).toBe(true)

    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm -rf /' } }, s.ctx)).toBeUndefined()
  })

  it('blocks every path when a Read scope is empty (fail closed like Bash)', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'nada.md', '---\nallowed-tools: Read()\n---\nLook at nothing.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('nada')?.handler('', s.ctx)

    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'anything.ts' } }, s.ctx)) as { block?: boolean }
    expect(blocked?.block).toBe(true)
  })

  it('anchors a ${CLAUDE_*}-substituted absolute path rule as absolute, so it matches', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'plug.md', '---\nallowed-tools: Read(${CLAUDE_PROJECT_DIR}/docs/**)\n---\nRead docs.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('plug')?.handler('', s.ctx)

    // The rule expands to an absolute path under cwd (the project root here); a read
    // inside docs is allowed rather than blocked by re-anchoring under the root twice.
    expect(await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'docs/guide.md' } }, s.ctx)).toBeUndefined()
    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'src/secret.ts' } }, s.ctx)) as { block?: boolean }
    expect(blocked?.block).toBe(true)
  })

  it('does not enforce when the same command also grants bash unscoped', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'run.md', '---\nallowed-tools: Bash, Bash(git add:*)\n---\nRun.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('run')?.handler('', s.ctx)

    expect(await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'make deploy' } }, s.ctx)).toBeUndefined()
  })

  it('enforces Read and Edit path scopes at call time, writes included', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'docs.md', '---\nallowed-tools: Read(docs/**), Edit(docs/**), Write(docs/**)\n---\nDocs only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('docs')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['read', 'edit', 'write'])
    expect(await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'docs/a.md' } }, s.ctx)).toBeUndefined()
    expect(await s.handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'docs/a.md' } }, s.ctx)).toBeUndefined()
    expect(await s.handlers.get('tool_call')?.({ toolName: 'write', input: { path: 'docs/new.md' } }, s.ctx)).toBeUndefined()
    const read = (await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'src/secret.ts' } }, s.ctx)) as { block?: boolean; reason?: string }
    expect(read?.block).toBe(true)
    expect(read?.reason).toContain('docs/**')
    const write = (await s.handlers.get('tool_call')?.({ toolName: 'write', input: { path: 'src/evil.ts' } }, s.ctx)) as { block?: boolean }
    expect(write?.block).toBe(true)

    await s.handlers.get('agent_settled')?.({}, s.ctx)
    expect(await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'src/secret.ts' } }, s.ctx)).toBeUndefined()
  })

  it('expands a brace glob in an Edit path scope at the tool_call guard', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'edit.md', '---\nallowed-tools: Edit(src/{x,y}/**)\n---\nEdit x or y.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('edit')?.handler('', s.ctx)

    // `{x,y}` must expand: edits under src/x and src/y (both alternatives) pass, src/z blocks.
    expect(await s.handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'src/x/app.ts' } }, s.ctx)).toBeUndefined()
    expect(await s.handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'src/y/util.ts' } }, s.ctx)).toBeUndefined()
    const blocked = (await s.handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'src/z/other.ts' } }, s.ctx)) as { block?: boolean; reason?: string }
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('src/{x,y}/**')
  })

  it('lifts the scope when a later command in the turn grants bash unscoped', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'a.md', '---\nallowed-tools: Bash(git add:*)\n---\nStage.')
    writeCommand(cwd, 'b.md', '---\nallowed-tools: Bash\n---\nRun.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('a')?.handler('', s.ctx)
    await s.commands.get('b')?.handler('', s.ctx)

    expect(await s.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'make deploy' } }, s.ctx)).toBeUndefined()
  })
})

describe('allowed-tools with queued commands', () => {
  it('grants the second command its tools from the pre-restriction set', async () => {
    // Intersecting against the first command's narrowed set granted nothing, so the
    // second command ran under the first one's restriction.
    const cwd = tempDir()
    writeCommand(cwd, 'a.md', '---\nallowed-tools: Read\n---\nLook.')
    writeCommand(cwd, 'b.md', '---\nallowed-tools: Bash\n---\nRun.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('a')?.handler('', s.ctx)
    await s.commands.get('b')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['bash'])
  })
})

const stubRunner = () => {
  const calls: string[] = []
  return {
    calls,
    exec: async (_file: string, args: string[]) => {
      calls.push(args[1])
      return { stdout: `ran:${args[1]}`, stderr: '', code: 0, killed: false }
    },
  }
}

describe('expandCommand', () => {
  it('produces exactly what the user path sends for the same invocation', async () => {
    const cwd = tempDir()
    const file = join(cwd, '.claude', 'commands', 'par.md')
    writeCommand(cwd, 'par.md', '---\nargument-hint: [target]\n---\nBuild $0 in ${CLAUDE_PROJECT_DIR}: !`git status`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('par')?.handler('web', s.ctx)

    const parsed = parseCommandFile(readFileSync(file, 'utf-8'))
    const out = await expandCommand(stubRunner(), parsed, 'web', s.ctx as { cwd: string }, file)
    expect(s.sent).toHaveLength(1)
    expect(out).toBe(s.sent[0])
  })

  it('appends ARGUMENTS when the body never reads the passed args', async () => {
    const cwd = tempDir()
    const out = await expandCommand(stubRunner(), parseCommandFile('Deploy now.'), 'prod', { cwd }, join(cwd, 'd.md'))
    expect(out).toBe('Deploy now.\n\nARGUMENTS: prod')
  })

  it('throws on a span failure instead of returning a half-expanded body', async () => {
    const cwd = tempDir()
    const failing = { exec: async () => ({ stdout: '', stderr: 'boom', code: 2, killed: false }) }
    await expect(expandCommand(failing, parseCommandFile('x: !`bad`'), '', { cwd }, join(cwd, 'f.md'))).rejects.toThrow(/bad[\s\S]*boom/)
  })

  it('replaces every shell span with the policy placeholder when shell is disallowed', async () => {
    const cwd = tempDir()
    const runner = stubRunner()
    const parsed = parseCommandFile('status: !`git status`\n```!\nrm -rf /\n```\ndone')
    const out = await expandCommand(runner, parsed, '', { cwd }, join(cwd, 's.md'), undefined, { allowShell: false })
    expect(runner.calls).toEqual([])
    expect(out).toBe(`status: ${SHELL_DISABLED_PLACEHOLDER}\n${SHELL_DISABLED_PLACEHOLDER}\ndone`)
  })
})

describe('slashCommandBudget', () => {
  it('prefers the env override, then ~1% of the context window, then the default', () => {
    expect(slashCommandBudget(200_000, { SLASH_COMMAND_TOOL_CHAR_BUDGET: '4000' })).toBe(4000)
    // 1% of the window's tokens at ~4 chars per token is window / 25.
    expect(slashCommandBudget(200_000, {})).toBe(8000)
    expect(slashCommandBudget(undefined, {})).toBe(15_000)
  })

  it('ignores a malformed or non-positive env value', () => {
    expect(slashCommandBudget(undefined, { SLASH_COMMAND_TOOL_CHAR_BUDGET: 'lots' })).toBe(15_000)
    expect(slashCommandBudget(undefined, { SLASH_COMMAND_TOOL_CHAR_BUDGET: '0' })).toBe(15_000)
  })
})

describe('slashCommandToolDescription', () => {
  it('lists each command as /name - description (argument-hint)', () => {
    const text = slashCommandToolDescription(
      [
        { name: 'deploy', description: 'Deploy it', argumentHint: '[env]' },
        { name: 'lint', description: 'Lint the tree' },
      ],
      15_000,
    )
    expect(text).toContain('/deploy - Deploy it ([env])')
    expect(text).toContain('/lint - Lint the tree')
  })

  it('appends when_to_use trigger text after the description, before the argument hint', () => {
    const text = slashCommandToolDescription([{ name: 'deploy', description: 'Deploy it', whenToUse: 'use when shipping', argumentHint: '[env]' }], 15_000)
    expect(text).toContain('/deploy - Deploy it use when shipping ([env])')
  })

  it('caps one entry at 1536 characters', () => {
    const text = slashCommandToolDescription([{ name: 'big', description: 'x'.repeat(4000) }], 15_000)
    const entry = text.split('\n').find((line) => line.startsWith('/big')) ?? ''
    expect(entry).toHaveLength(1536)
  })

  it('keeps the name of an over-budget entry, shedding only its description', () => {
    const commands = [
      { name: 'a', description: 'first command' },
      { name: 'b', description: 'x'.repeat(300) },
    ]
    const text = slashCommandToolDescription(commands, 60)
    expect(text).toContain('/a - first command')
    expect(text.split('\n')).toContain('/b')
    expect(text).not.toContain('omitted')
  })
})

describe('slash_command tool', () => {
  it('registers the tool listing only model-invocable commands', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', '---\ndescription: Deploy it\nargument-hint: [env]\n---\nDeploy $0.')
    writeCommand(cwd, 'secret.md', '---\ndescription: User only\ndisable-model-invocation: true\n---\nSecret steps.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    const tool = s.tools.get('slash_command')
    expect(tool).toBeDefined()
    expect(tool?.label).toBe('SlashCommand')
    expect(tool?.description).toContain('/deploy - Deploy it ([env])')
    expect(tool?.description).not.toContain('/secret')
  })

  it('does not register the tool when every command is user-only, or none exist', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'secret.md', '---\ndisable-model-invocation: true\n---\nSecret steps.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    expect(s.tools.has('slash_command')).toBe(false)

    const empty = setup(tempDir())
    await empty.handlers.get('session_start')?.({}, empty.ctx)
    expect(empty.tools.has('slash_command')).toBe(false)
  })

  it('expands a command into the tool result without spawning a user turn', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', '---\ndescription: Deploy it\n---\nDeploy $0 from ${CLAUDE_PROJECT_DIR}.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    const result = await s.tools.get('slash_command')?.execute('t1', { command: '/deploy staging' }, undefined, undefined, s.ctx)
    expect(result?.content[0].text).toBe(`Contents of /deploy (expanded):\n\nDeploy staging from ${cwd}.`)
    // The tool result is the channel; sendUserMessage would spawn a second turn.
    expect(s.sent).toEqual([])
  })

  it('re-reads the file on invocation so a live edit takes effect', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', 'Old body.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    writeCommand(cwd, 'deploy.md', 'New body.')

    const result = await s.tools.get('slash_command')?.execute('t1', { command: '/deploy' }, undefined, undefined, s.ctx)
    expect(result?.content[0].text).toContain('New body.')
  })

  it('refuses a disable-model-invocation command and says not to reproduce it', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ok.md', 'Fine.')
    writeCommand(cwd, 'secret.md', '---\ndisable-model-invocation: true\n---\nSecret steps.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    await expect(s.tools.get('slash_command')?.execute('t1', { command: '/secret' }, undefined, undefined, s.ctx)).rejects.toThrow(/user-only[\s\S]*reproduce/)
    expect(s.sent).toEqual([])
  })

  it('honors disable-model-invocation added by a live edit after registration', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deploy.md', 'Deploy.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    writeCommand(cwd, 'deploy.md', '---\ndisable-model-invocation: true\n---\nDeploy.')

    await expect(s.tools.get('slash_command')?.execute('t1', { command: '/deploy' }, undefined, undefined, s.ctx)).rejects.toThrow(/user-only/)
  })

  it('never runs a shell span for a model invocation, substituting the placeholder', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ctx.md', 'Fine.')
    writeCommand(cwd, 'st.md', 'status: !`git status`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    const result = await s.tools.get('slash_command')?.execute('t1', { command: '/st' }, undefined, undefined, s.ctx)
    expect(s.execCalls).toEqual([])
    expect(result?.content[0].text).toContain(SHELL_DISABLED_PLACEHOLDER)
    expect(result?.content[0].text).not.toContain('ran:')
  })

  it('rejects an unknown command name', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ok.md', 'Fine.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    await expect(s.tools.get('slash_command')?.execute('t1', { command: '/nope now' }, undefined, undefined, s.ctx)).rejects.toThrow(/nope/)
  })

  it('caps the tool result so a huge command expansion cannot overflow the context', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'big.md', 'x'.repeat(60_000))
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    const result = await s.tools.get('slash_command')?.execute('t1', { command: '/big' }, undefined, undefined, s.ctx)
    expect(result?.content[0].text).toContain('[truncated')
  })

  it("drops a previous project's commands from the model path on a session switch", async () => {
    // A resume or fork can land on a different project in-process, firing session_start
    // again with a new cwd. The model must not be able to run a command that belonged
    // to the project it just left, so the resolution set is rebuilt each session_start.
    const cwdA = tempDir()
    writeCommand(cwdA, 'deploy-a.md', 'Deploy project A.')
    const s = setup(cwdA)
    await s.handlers.get('session_start')?.({}, s.ctx)
    const runA = await s.tools.get('slash_command')?.execute('t1', { command: '/deploy-a' }, undefined, undefined, s.ctx)
    expect(runA?.content[0].text).toContain('Deploy project A.')

    const cwdB = tempDir()
    writeCommand(cwdB, 'deploy-b.md', 'Deploy project B.')
    const ctxB = { ...s.ctx, cwd: cwdB }
    await s.handlers.get('session_start')?.({}, ctxB)

    // The project A command no longer resolves for the model after the switch.
    await expect(s.tools.get('slash_command')?.execute('t1', { command: '/deploy-a' }, undefined, undefined, ctxB)).rejects.toThrow(/Unknown command/)
    const runB = await s.tools.get('slash_command')?.execute('t1', { command: '/deploy-b' }, undefined, undefined, ctxB)
    expect(runB?.content[0].text).toContain('Deploy project B.')
  })

  it('leaves the user path running spans as before', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'st.md', 'status: !`git status`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('st')?.handler('', s.ctx)

    expect(s.execCalls).toHaveLength(1)
    expect(s.sent[0]).toContain('git status')
  })
})

describe('disableSkillShellExecution', () => {
  const writeSettings = (dir: string, settings: Record<string, unknown>): void => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings))
  }

  it('reads user settings always and project settings only when trusted', () => {
    const cwd = tempDir()
    expect(shellExecutionDisabled(cwd, hoisted.home, true)).toBe(false)
    writeSettings(cwd, { disableSkillShellExecution: true })
    expect(shellExecutionDisabled(cwd, hoisted.home, true)).toBe(true)
    expect(shellExecutionDisabled(cwd, hoisted.home, false)).toBe(false)
    writeSettings(hoisted.home, { disableSkillShellExecution: true })
    expect(shellExecutionDisabled(tempDir(), hoisted.home, false)).toBe(true)
  })

  it('cannot be re-enabled by a lower layer once the user disabled it', () => {
    // Fail closed: a trusted repository's `false` must not lift the user's policy.
    const cwd = tempDir()
    writeSettings(hoisted.home, { disableSkillShellExecution: true })
    writeSettings(cwd, { disableSkillShellExecution: false })
    expect(shellExecutionDisabled(cwd, hoisted.home, true)).toBe(true)
  })

  it('honors the managed policy file', () => {
    const managed = join(tempDir(), 'managed-settings.json')
    writeFileSync(managed, JSON.stringify({ disableSkillShellExecution: true }))
    setManagedSettingsPath(managed)
    expect(shellExecutionDisabled(tempDir(), hoisted.home, false)).toBe(true)
  })

  it('reads the user settings.json from CLAUDE_CONFIG_DIR', () => {
    // The user policy relocates with CLAUDE_CONFIG_DIR; ~/.claude/settings.json is no
    // longer where Claude stores it.
    const cfg = tempDir()
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ disableSkillShellExecution: true }))
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      expect(shellExecutionDisabled(tempDir(), hoisted.home, false)).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  it('replaces spans with the placeholder on the user path when set', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, { disableSkillShellExecution: true })
    writeCommand(cwd, 'st.md', 'status: !`git status`\n```!\npwd\n```')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('st')?.handler('', s.ctx)

    expect(s.execCalls).toEqual([])
    expect(s.sent[0]).toBe(`status: ${SHELL_DISABLED_PLACEHOLDER}\n${SHELL_DISABLED_PLACEHOLDER}`)
  })
})

describe('command precedence and naming conformance', () => {
  it('lets a personal command override a project command of the same name', () => {
    // Claude: across levels, enterprise overrides personal, and personal
    // overrides project.
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'commands', 'deploy.md'), 'PROJECT BODY')
    mkdirSync(join(hoisted.home, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'commands', 'deploy.md'), 'PERSONAL BODY')

    const commands = collectCommands(commandDirs(cwd, hoisted.home, true))
    const deploy = commands.find((c) => c.name === 'deploy')
    expect(deploy && readFileSync(deploy.filePath, 'utf-8')).toBe('PERSONAL BODY')
  })

  it('loads enterprise commands from the managed settings directory with top precedence', async () => {
    const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
    const managedDir = tempDir()
    setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
    try {
      mkdirSync(join(managedDir, '.claude', 'commands'), { recursive: true })
      writeFileSync(join(managedDir, '.claude', 'commands', 'deploy.md'), 'ENTERPRISE BODY')
      mkdirSync(join(hoisted.home, '.claude', 'commands'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'commands', 'deploy.md'), 'PERSONAL BODY')

      const commands = collectCommands(commandDirs(tempDir(), hoisted.home, true))
      const deploy = commands.find((c) => c.name === 'deploy')
      expect(deploy && readFileSync(deploy.filePath, 'utf-8')).toBe('ENTERPRISE BODY')
    } finally {
      setManagedSettingsPath(undefined)
    }
  })

  it('keeps every command name in the tool listing, shortening descriptions when over budget', () => {
    // Claude: "The listing always contains every skill name"; the budget shortens
    // descriptions, never drops names.
    const commands = Array.from({ length: 20 }, (_, i) => ({ name: `cmd-${i}`, description: 'd'.repeat(200) }))
    const text = slashCommandToolDescription(commands, 800)
    for (let i = 0; i < 20; i++) expect(text).toContain(`/cmd-${i}`)
    expect(text).not.toContain('omitted')
  })
})

describe('ARGUMENTS append rule', () => {
  it('appends the arguments only when no placeholder received one, per the documented rule', async () => {
    // Claude: "When no placeholder receives an argument, Claude Code appends
    // them as ARGUMENTS: <value>."
    const cwd = tempDir()
    writeCommand(cwd, 'named.md', '---\narguments: [issue]\n---\nFix $issue please.')
    writeCommand(cwd, 'blind.md', 'Just do the thing.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    // A named placeholder consumed the argument: no append.
    await s.commands.get('named')?.handler('123', s.ctx)
    expect(s.sent.at(-1)).toBe('Fix 123 please.')

    // Nothing consumed the argument: the append carries it.
    await s.commands.get('blind')?.handler('456', s.ctx)
    expect(s.sent.at(-1)).toBe('Just do the thing.\n\nARGUMENTS: 456')
  })
})
