import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import commandsExtension, { collectCommands, commandDirs } from '../extensions/commands.ts'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
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
  const execCalls: Array<{ shell: string; env?: Record<string, string> }> = []
  let active = ['bash', 'read', 'edit', 'write']
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
    exec: async (_file: string, args: string[], opts?: { env?: Record<string, string> }) => {
      execCalls.push({ shell: args[1], env: opts?.env })
      return { stdout: `ran:${args[1]}`, stderr: '', code: 0, killed: false }
    },
    sendUserMessage: (text: string) => {
      sent.push(text)
    },
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => {
      active = next
      toolSets.push(next)
    },
  }
  commandsExtension(pi as never)
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: { confirm: async () => trusted, notify: () => {} },
  }
  return { handlers, commands, sent, toolSets, execCalls, ctx, activeTools: () => active }
}

describe('commands extension', () => {
  it('registers a nested command under its namespaced name and drives a turn with substituted args', async () => {
    const cwd = tempDir()
    writeCommand(cwd, join('frontend', 'build.md'), '---\ndescription: Build it\nargument-hint: [target]\n---\nBuild $1 now.')
    const s = setup(cwd)
    await s.handlers.get('session_start')?.({}, s.ctx)

    expect([...s.commands.keys()]).toEqual(['frontend:build'])
    expect(s.commands.get('frontend:build')?.description).toBe('Build it [target]')

    await s.commands.get('frontend:build')?.handler('web', s.ctx)
    expect(s.sent).toEqual(['Build web now.'])
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
