import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contextImports, { EXTERNAL_IMPORT_PROMPT_TITLE, instructionsBlock, MAX_IMPORT_FILES, setManagedClaudeMdPath } from '../extensions/context-imports.ts'
import { INSTRUCTIONS_CHANNEL } from '../extensions/internal/instruction-events.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'

// The extension reads the user's and the managed configuration; both point at throwaway
// directories so the developer's real config cannot influence assertions.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

// realpath so allowed-root prefix checks hold on macOS (/tmp -> /private/tmp)
const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

beforeEach(() => {
  hoisted.home = tempDir('options-home-')
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'options-agent-'))
  setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
  setManagedClaudeMdPath(join(hoisted.home, 'managed', 'CLAUDE.md'))
})
afterEach(() => {
  hoisted.home = ''
  setManagedSettingsPath(undefined)
  setManagedClaudeMdPath(undefined)
})

type ContextFile = { path: string; content: string }

/** Write a file under `root`, creating its directories, and return its path. */
const write = (root: string, relative: string, content: string): string => {
  const file = join(root, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  return file
}

/** A repository root with the memory file pi loads natively from it. */
const projectWith = (memory: string, name = 'CLAUDE.md'): { cwd: string; native: ContextFile[] } => {
  const cwd = tempDir('options-cwd-')
  mkdirSync(join(cwd, '.git'))
  return { cwd, native: [{ path: write(cwd, name, memory), content: memory }] }
}

const PROJECT_MEMORY = 'PROJECT MEMORY\n\n<!-- note -->\n\n@docs/inside.md\n'

/** A home and a project holding every memory source Claude loads at launch. */
const memoryFixture = (): { cwd: string; native: ContextFile[] } => {
  const home = hoisted.home
  write(home, 'managed/CLAUDE.md', 'MANAGED FILE')
  write(home, 'managed-settings.json', JSON.stringify({ claudeMd: 'MANAGED KEY' }))
  write(home, '.claude/CLAUDE.md', 'USER MEMORY\n\n@~/.claude/notes.md\n')
  write(home, '.claude/notes.md', 'USER IMPORT')
  const project = projectWith(PROJECT_MEMORY)
  write(project.cwd, 'docs/inside.md', 'PROJECT IMPORT')
  write(project.cwd, '.claude/CLAUDE.md', 'ALTERNATE MEMORY')
  write(project.cwd, 'CLAUDE.local.md', 'LOCAL MEMORY')
  return project
}

const approvingCtx = (cwd: string) => ({ cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

/** Approves the project and declines its imports from outside it. */
const decliningExternals = (cwd: string) => ({ ...approvingCtx(cwd), ui: { notify: () => {}, confirm: async (title: string) => title !== EXTERNAL_IMPORT_PROMPT_TITLE } })

/** The extension wired and its session started for `cwd`. `turn` fires one
 * before_agent_start, `loads` lists what was announced on the instruction bus. */
const startedIn = async (cwd: string, given: { flags?: Record<string, unknown>; ctx?: Record<string, unknown> } = {}) => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  const emitted: Array<{ channel: string; data: unknown }> = []
  contextImports({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
    events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    registerFlag: () => {},
    getFlag: (name: string) => given.flags?.[name],
  } as never)
  const ctx = given.ctx ?? approvingCtx(cwd)
  await handlers.get('session_start')?.({}, ctx)
  return {
    turn: async (event: unknown) => (await handlers.get('before_agent_start')?.(event, ctx)) as { systemPrompt: string } | undefined,
    loads: () => emitted.filter((entry) => entry.channel === INSTRUCTIONS_CHANNEL).map((entry) => entry.data),
  }
}

/** The prompt as pi before 0.86 assembled it, which that runtime hands over as a fixed
 * string. */
const assembledPrompt = (files: ContextFile[]): string => `BASE PROMPT\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${files.map((file) => `${instructionsBlock(file.path, file.content)}\n\n`).join('')}</project_context>\n`

const fixedEvent = (cwd: string, native: ContextFile[]) => ({ systemPrompt: assembledPrompt(native), systemPromptOptions: { cwd, contextFiles: native.map((file) => ({ ...file })) } })

/** A before_agent_start event shaped like pi 0.86 and later: the prompt re-renders from the
 * options, in that runtime's section layout, until a prompt is forced. */
const renderingEvent = (cwd: string, native: ContextFile[], given: { appendSystemPrompt?: string; forceSystemPrompt?: string } = {}) => {
  const systemPromptOptions = { cwd, contextFiles: native.map((file) => ({ ...file })), appendSystemPrompt: given.appendSystemPrompt ?? '', forceSystemPrompt: given.forceSystemPrompt }
  return {
    systemPromptOptions,
    get systemPrompt(): string {
      if (systemPromptOptions.forceSystemPrompt !== undefined) return systemPromptOptions.forceSystemPrompt
      const sections = ['BASE PROMPT']
      if (systemPromptOptions.appendSystemPrompt) sections.push(`<addendum>\n${systemPromptOptions.appendSystemPrompt}\n</addendum>`)
      const blocks = systemPromptOptions.contextFiles.map((file) => instructionsBlock(file.path, file.content))
      if (blocks.length > 0) sections.push(`<project_context>\n${['Project-specific instructions and guidelines:', ...blocks].join('\n\n')}\n</project_context>`)
      return sections.join('\n\n')
    },
  }
}

const paths = (files: ContextFile[]): string[] => files.map((file) => file.path)

describe('on a runtime that re-renders the prompt from its options', () => {
  it("places the user CLAUDE.md ahead of pi's context files", async () => {
    // Claude loads user memory before the project's. Rewriting the rendered text missed
    // its anchor from pi 0.86 on and put the block in a second <project_context>.
    const user = write(hoisted.home, '.claude/CLAUDE.md', 'USER MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([{ path: user, content: 'USER MEMORY' }, ...native])
    expect(event.systemPrompt.split('<project_context>')).toHaveLength(2)
  })

  it('returns nothing and leaves the options alone when there is nothing to add', async () => {
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native, { appendSystemPrompt: 'USER APPEND' })

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions).toEqual({ cwd, contextFiles: native, appendSystemPrompt: 'USER APPEND', forceSystemPrompt: undefined })
  })

  it('orders the context files by directory, local memory last at each level', async () => {
    // Claude: managed, user, then each directory from the root down to the working
    // directory, and in a directory CLAUDE.md, .claude/CLAUDE.md, the rules, CLAUDE.local.md.
    const home = hoisted.home
    const user = write(home, '.claude/CLAUDE.md', 'USER MEMORY')
    const userRule = write(home, '.claude/rules/u.md', 'USER RULE')
    const root = tempDir('options-root-')
    mkdirSync(join(root, '.git'))
    const cwd = join(root, 'packages', 'app')
    const rootMemory = write(root, 'CLAUDE.md', 'ROOT MEMORY')
    const rootRule = write(root, '.claude/rules/r.md', 'ROOT RULE')
    const rootLocal = write(root, 'CLAUDE.local.md', 'ROOT LOCAL')
    const appMemory = write(cwd, 'CLAUDE.md', 'APP MEMORY')
    const appAlternate = write(cwd, '.claude/CLAUDE.md', 'APP ALTERNATE')
    const appLocal = write(cwd, 'CLAUDE.local.md', 'APP LOCAL')
    // pi hands over its own files root first, and claude-rules adds the rules after them.
    const native = [
      { path: rootMemory, content: 'ROOT MEMORY' },
      { path: appMemory, content: 'APP MEMORY' },
      { path: userRule, content: 'USER RULE' },
      { path: rootRule, content: 'ROOT RULE' },
    ]
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([user, userRule, rootMemory, rootRule, rootLocal, appMemory, appAlternate, appLocal])
  })

  it('adds the CLAUDE.md beside an AGENTS.md right after it', async () => {
    const { cwd, native } = projectWith('AGENTS BODY', 'AGENTS.md')
    const claude = write(cwd, 'CLAUDE.md', 'CLAUDE BODY\n')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([...native, { path: claude, content: 'CLAUDE BODY' }])
  })

  it("keeps a context file from outside the project ahead of the project's", async () => {
    // pi loads its own global context file, which belongs to no directory on the way to
    // the working directory.
    const global = write(hoisted.home, '.pi/agent/AGENTS.md', 'GLOBAL BODY')
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n<!-- note -->')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, [...native, { path: global, content: 'GLOBAL BODY' }])

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([global, native[0].path])
  })

  it("places the user's rules ahead of a context file in the home directory", async () => {
    // A project under home has the home directory on its way up, where pi finds a context
    // file of its own. The user's rules are user memory and still come first.
    const home = hoisted.home
    const userRule = write(home, '.claude/rules/u.md', 'USER RULE')
    const homeLevel = write(home, 'AGENTS.md', 'HOME BODY')
    const cwd = join(home, 'work', 'project')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const memory = write(cwd, 'CLAUDE.md', 'PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, [
      { path: homeLevel, content: 'HOME BODY' },
      { path: memory, content: 'PROJECT MEMORY' },
      { path: userRule, content: 'USER RULE' },
    ])

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([userRule, homeLevel, memory])
  })

  it('orders a project inside the user config directory by its directories', async () => {
    // A checkout under ~/.claude is a project: only the user's own rules there are user
    // memory.
    const root = join(hoisted.home, '.claude', 'checkout')
    mkdirSync(join(root, '.git'), { recursive: true })
    const cwd = join(root, 'packages', 'app')
    const rootMemory = write(root, 'CLAUDE.md', 'ROOT MEMORY')
    const rootLocal = write(root, 'CLAUDE.local.md', 'ROOT LOCAL')
    const appMemory = write(cwd, 'CLAUDE.md', 'APP MEMORY')
    const appLocal = write(cwd, 'CLAUDE.local.md', 'APP LOCAL')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, [
      { path: rootMemory, content: 'ROOT MEMORY' },
      { path: appMemory, content: 'APP MEMORY' },
    ])

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([rootMemory, rootLocal, appMemory, appLocal])
  })

  it('places a file handed over by another loader by what its path says it is', async () => {
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const handedOver = [{ path: join(cwd, 'CLAUDE.local.md'), content: 'LOCAL' }, { path: join(cwd, '.claude', 'CLAUDE.md'), content: 'ALTERNATE' }, ...native]
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, handedOver)

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([native[0].path, join(cwd, '.claude', 'CLAUDE.md'), join(cwd, 'CLAUDE.local.md')])
  })

  it('places .claude/CLAUDE.md and the CLAUDE.md beside an AGENTS.md ahead of the rules', async () => {
    // The rules reach the options before this extension adds its files, so the order has
    // to come from what each file is, not from when it was added.
    const { cwd, native } = projectWith('AGENTS BODY', 'AGENTS.md')
    const rule = write(cwd, '.claude/rules/r.md', 'RULE')
    const claude = write(cwd, 'CLAUDE.md', 'CLAUDE BODY')
    const alternate = write(cwd, '.claude/CLAUDE.md', 'ALTERNATE')
    const local = write(cwd, 'CLAUDE.local.md', 'LOCAL')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, [...native, { path: rule, content: 'RULE' }])

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([native[0].path, claude, alternate, rule, local])
  })

  it('strips block comments from an imported file', async () => {
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n@docs/inside.md')
    const inside = write(cwd, 'docs/inside.md', 'Shown.\n\n<!-- maintainer note -->\n\nAlso shown.')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    const imported = event.systemPromptOptions.contextFiles.find((file) => file.path === inside)
    expect(imported?.content).toContain('Shown.')
    expect(imported?.content).toContain('Also shown.')
    expect(imported?.content).not.toContain('maintainer note')
  })

  it('places an imported file after the file that imports it', async () => {
    // Claude loads an import "alongside the CLAUDE.md that references" it: its own entry,
    // right after the importer, a nested import after the import that names it.
    const home = hoisted.home
    const user = write(home, '.claude/CLAUDE.md', 'USER MEMORY\n\n@~/.claude/notes.md')
    const notes = write(home, '.claude/notes.md', 'USER IMPORT')
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n@docs/inside.md')
    const inside = write(cwd, 'docs/inside.md', 'INSIDE\n\n@deeper.md')
    const deeper = write(cwd, 'docs/deeper.md', 'DEEPER')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([{ path: user, content: 'USER MEMORY\n\n@~/.claude/notes.md' }, { path: notes, content: 'USER IMPORT' }, ...native, { path: inside, content: 'INSIDE\n\n@deeper.md' }, { path: deeper, content: 'DEEPER' }])
  })

  it('strips block comments from the context files in the options', async () => {
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n<!-- maintainer note -->\n\nAfter the note.')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual(paths(native))
    const [memory] = event.systemPromptOptions.contextFiles
    expect(memory.content).toContain('PROJECT MEMORY')
    expect(memory.content).toContain('After the note.')
    expect(memory.content).not.toContain('maintainer note')
  })

  it('removes an excluded file from the options', async () => {
    const { cwd, native } = projectWith('PROJECT MEMORY')
    write(hoisted.home, '.claude/settings.json', JSON.stringify({ claudeMdExcludes: [native[0].path] }))
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([])
  })

  it('removes every file when memory is disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
    write(hoisted.home, '.claude/CLAUDE.md', 'USER MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    write(cwd, 'CLAUDE.local.md', 'LOCAL MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([])
  })

  it('places managed memory first and keeps it under an exclude', async () => {
    // "Managed policy CLAUDE.md files cannot be excluded."
    const home = hoisted.home
    const managed = write(home, 'managed/CLAUDE.md', 'MANAGED FILE')
    write(home, 'managed-settings.json', JSON.stringify({ claudeMd: 'MANAGED KEY', claudeMdExcludes: ['**/CLAUDE.md'] }))
    write(home, '.claude/CLAUDE.md', 'USER MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: managed, content: 'MANAGED FILE' },
      { path: 'managed-settings.json (claudeMd)', content: 'MANAGED KEY' },
    ])
  })

  it('appends the refused imports to the appended instructions', async () => {
    // The list is a notice, not a file, so it is no context file entry.
    const secret = write(hoisted.home, 'secret.md', 'SECRET BODY')
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n@~/secret.md')
    const session = await startedIn(cwd, { ctx: decliningExternals(cwd) })
    const event = renderingEvent(cwd, native, { appendSystemPrompt: 'USER APPEND' })

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual(native)
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(`USER APPEND\n\n## Imports not loaded (@)\n\nThese files resolve outside what the file importing them may read, so their contents are not in context:\n\n- ${secret}`)
  })

  it('appends the budget notice to the appended instructions', async () => {
    const extra = 2
    const names = Array.from({ length: MAX_IMPORT_FILES + extra }, (_, index) => `n${String(index).padStart(2, '0')}.md`)
    const { cwd, native } = projectWith(`PROJECT MEMORY\n\n${names.map((name) => `@docs/${name}`).join('\n')}`)
    for (const name of names) write(cwd, `docs/${name}`, `BODY OF ${name}`)
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toHaveLength(1 + MAX_IMPORT_FILES)
    expect(event.systemPromptOptions.appendSystemPrompt).toContain(`${extra} further @imports were skipped`)
  })

  it('adds an approved import from outside the project as a context file', async () => {
    const secret = write(hoisted.home, 'shared.md', 'SHARED BODY')
    const { cwd, native } = projectWith('PROJECT MEMORY\n\n@~/shared.md')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([...native, { path: secret, content: 'SHARED BODY' }])
    expect(event.systemPromptOptions.appendSystemPrompt).toBe('')
  })

  it('puts the user CLAUDE.md into the one <project_context> of a forced prompt', async () => {
    // A forced prompt is text in the layout pi 0.86 and later renders, where one newline
    // follows the opener.
    write(hoisted.home, '.claude/CLAUDE.md', 'USER MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native, { forceSystemPrompt: renderingEvent(cwd, native).systemPrompt })

    const result = await session.turn(event)

    expect(result?.systemPrompt).toBe(`BASE PROMPT\n\n<project_context>\nProject-specific instructions and guidelines:\n\n${instructionsBlock(join(hoisted.home, '.claude', 'CLAUDE.md'), 'USER MEMORY')}\n\n${instructionsBlock(native[0].path, 'PROJECT MEMORY')}\n</project_context>`)
  })

  it('adds additional directory memory as context files', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const extraDir = tempDir('options-extra-')
    const extra = write(extraDir, 'CLAUDE.md', 'EXTRA MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    write(cwd, 'CLAUDE.local.md', 'LOCAL MEMORY')
    const session = await startedIn(cwd, { flags: { 'add-dir': extraDir } })
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(event.systemPromptOptions.contextFiles).toEqual([...native, { path: join(cwd, 'CLAUDE.local.md'), content: 'LOCAL MEMORY' }, { path: extra, content: 'EXTRA MEMORY' }])
  })

  it('keeps the memory in the options when the prompt was forced', async () => {
    // A provider that rebuilds the prompt from the options still reads them, and the
    // forced text is rewritten the way a fixed prompt is.
    const user = write(hoisted.home, '.claude/CLAUDE.md', 'USER MEMORY')
    const { cwd, native } = projectWith('PROJECT MEMORY')
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native, { forceSystemPrompt: assembledPrompt(native) })

    const result = await session.turn(event)

    expect(result?.systemPrompt).toContain('USER MEMORY')
    expect(event.systemPromptOptions.contextFiles).toEqual([{ path: user, content: 'USER MEMORY' }, ...native])
  })

  it('announces the loads a runtime that does not re-render announces', async () => {
    const { cwd, native } = memoryFixture()
    const fixed = await startedIn(cwd)
    await fixed.turn(fixedEvent(cwd, native))
    const rendering = await startedIn(cwd)
    await rendering.turn(renderingEvent(cwd, native))

    expect(rendering.loads()).toEqual(fixed.loads())
    expect(rendering.loads()).toHaveLength(7)
  })

  it('delivers every memory source in Claude order', async () => {
    const { cwd, native } = memoryFixture()
    const home = hoisted.home
    const session = await startedIn(cwd)
    const event = renderingEvent(cwd, native)

    expect(await session.turn(event)).toBeUndefined()

    expect(paths(event.systemPromptOptions.contextFiles)).toEqual([
      join(home, 'managed', 'CLAUDE.md'),
      'managed-settings.json (claudeMd)',
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.claude', 'notes.md'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, 'docs', 'inside.md'),
      join(cwd, '.claude', 'CLAUDE.md'),
      join(cwd, 'CLAUDE.local.md'),
    ])
  })
})

describe('on a runtime that does not re-render the prompt', () => {
  it('appends the memory to the prompt text and leaves the options as found', async () => {
    // Pins the text pi before 0.86 receives for every memory source at once. The expected
    // value is what the extension produced before it learned to edit the options.
    const { cwd, native } = memoryFixture()
    const home = hoisted.home
    const session = await startedIn(cwd)
    const event = fixedEvent(cwd, native)

    const result = await session.turn(event)

    expect(result?.systemPrompt).toBe(
      [
        'BASE PROMPT',
        '<project_context>',
        'Project-specific instructions and guidelines:',
        `<project_instructions path="${join(home, 'managed', 'CLAUDE.md')}">\nMANAGED FILE\n</project_instructions>`,
        '<project_instructions path="managed-settings.json (claudeMd)">\nMANAGED KEY\n</project_instructions>',
        `<project_instructions path="${join(home, '.claude', 'CLAUDE.md')}">\nUSER MEMORY\n\n@~/.claude/notes.md\n</project_instructions>`,
        `<project_instructions path="${join(cwd, 'CLAUDE.md')}">\nPROJECT MEMORY\n\n\n@docs/inside.md\n\n</project_instructions>`,
        '</project_context>\n',
        `<project_instructions path="${join(cwd, '.claude', 'CLAUDE.md')}">\nALTERNATE MEMORY\n</project_instructions>`,
        `## CLAUDE.local.md (${join(cwd, 'CLAUDE.local.md')})`,
        'LOCAL MEMORY',
        '## Imported context (@)',
        `### ${join(cwd, 'docs', 'inside.md')}`,
        'PROJECT IMPORT',
        `### ${join(home, '.claude', 'notes.md')}`,
        'USER IMPORT',
      ].join('\n\n'),
    )
    expect(event.systemPromptOptions).toEqual({ cwd, contextFiles: native })
  })
})
