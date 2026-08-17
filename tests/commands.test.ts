import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import commandsExtension, { collectCommands, commandDirs } from '../extensions/commands.ts'

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
})

describe('collectCommands', () => {
  it('lets a project command override a user command of the same name', () => {
    const cwd = tempDir()
    writeCommand(hoisted.home, 'ship.md', 'user version')
    writeCommand(cwd, 'ship.md', 'project version')
    const found = collectCommands(commandDirs(cwd, hoisted.home, true))
    expect(found).toHaveLength(1)
    expect(found[0].filePath).toContain(cwd)
  })
})

const setup = (cwd: string, trusted = true) => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  const sent: string[] = []
  const toolSets: string[][] = []
  const notices: string[] = []
  const execCalls: Array<{ file: string; args: string[]; shell: string; timeout?: number; env?: Record<string, string> }> = []
  const execResult = { stderr: '', code: 0, killed: false }
  let active = ['bash', 'read', 'edit', 'write']
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
    exec: async (file: string, args: string[], opts?: { timeout?: number; env?: Record<string, string> }) => {
      execCalls.push({ file, args, shell: args[1], timeout: opts?.timeout, env: opts?.env })
      return { stdout: `ran:${args[1]}`, ...execResult }
    },
    sendUserMessage: (text: string) => {
      sent.push(text)
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
  }
  const modelSets: string[] = []
  const available = [
    { id: 'gemma4', name: 'Gemma 4' },
    { id: 'claude-opus-5', name: 'Opus' },
    { id: 'claude-fable-5', name: 'Fable' },
  ]
  commandsExtension(pi as never)
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
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
  return { handlers, commands, sent, toolSets, notices, execCalls, ctx, modelSets, activeTools: () => active, failExec: (result: { stderr: string; code: number }) => Object.assign(execResult, result) }
}

describe('commands extension', () => {
  it('registers a nested command under its namespaced name and drives a turn with substituted args', async () => {
    const cwd = tempDir()
    writeCommand(cwd, join('frontend', 'build.md'), '---\ndescription: Build it\nargument-hint: [target]\n---\nBuild $0 now.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    expect([...s.commands.keys()]).toEqual(['frontend:build'])
    expect(s.commands.get('frontend:build')?.description).toBe('Build it [target]')

    await s.commands.get('frontend:build')?.handler('web', s.ctx)
    expect(s.sent).toEqual(['Build web now.'])
  })

  it('leaves ${user_config.*} literal in an ordinary (non-plugin) command', async () => {
    const cwd = tempDir()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} under test
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

  it('keeps the restriction in place for the turn, restoring only when it ends', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'safe.md', '---\nallowed-tools: Read\n---\nLook only.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('safe')?.handler('', s.ctx)

    // sendUserMessage is fire-and-forget, so restoring inside the handler would put
    // the full set back before the agent ever read it: the restriction must outlive
    // the handler and end with the turn.
    expect(s.toolSets[0]).toEqual(['read'])
    expect(s.activeTools()).toEqual(['read'])

    await s.handlers.get('turn_end')?.({}, s.ctx)
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
    await s.handlers.get('turn_end')?.({}, s.ctx)

    expect(s.activeTools()).toEqual(['bash', 'read', 'edit', 'write'])
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
  it('switches to the command model for the turn and restores it on turn_end', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'deep.md', '---\nmodel: opus\n---\nThink hard.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('deep')?.handler('', s.ctx)
    // opus fuzzy-matches claude-opus-5 among the available models.
    expect(s.modelSets).toEqual(['claude-opus-5'])
    await s.handlers.get('turn_end')?.({}, s.ctx)
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
    await s.handlers.get('turn_end')?.({}, s.ctx)
    const before = s.modelSets.length
    await s.commands.get('exact')?.handler('', s.ctx)
    expect(s.modelSets.at(-1)).toBe('claude-opus-5')
    await s.handlers.get('turn_end')?.({}, s.ctx)
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

  it('does not register commands from a plugin nobody enabled', async () => {
    const cwd = tempDir()
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'dormant', '1.0.0')
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, 'commands', 'x.md'), 'body')
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

  it('removes disallowed-tools for the turn and restores them after', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'ro.md', '---\ndisallowed-tools: Edit, Write\n---\nLook, do not touch.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ro')?.handler('', s.ctx)

    expect(s.activeTools()).toEqual(['bash', 'read'])
    await s.handlers.get('turn_end')?.({}, s.ctx)
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

describe('shell frontmatter', () => {
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

  it('falls back to /bin/sh when no PowerShell binary is installed', async () => {
    const cwd = tempDir()
    // hoisted.pwshBinary stays undefined: the resolver finds nothing, as on this mac.
    writeCommand(cwd, 'ps.md', '---\nshell: powershell\n---\nfiles: !`Get-ChildItem`')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('ps')?.handler('', s.ctx)

    expect(s.execCalls[0].file).toBe('/bin/sh')
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

    expect(s.execCalls[0].file).toBe('/bin/sh')
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

  it('stops enforcing when the turn ends', async () => {
    const cwd = tempDir()
    writeCommand(cwd, 'stage.md', '---\nallowed-tools: Bash(git add:*)\n---\nStage it.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)
    await s.commands.get('stage')?.handler('', s.ctx)
    await s.handlers.get('turn_end')?.({}, s.ctx)

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

    await s.handlers.get('turn_end')?.({}, s.ctx)
    expect(await s.handlers.get('tool_call')?.({ toolName: 'read', input: { path: 'src/secret.ts' } }, s.ctx)).toBeUndefined()
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
