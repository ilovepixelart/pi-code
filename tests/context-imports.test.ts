import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contextImports, {
  additionalDirContextFiles,
  additionalDirsClaudeMdEnabled,
  claudeMdExcludeFiles,
  collectImports,
  createImportBudget,
  expandHome,
  IMPORT_TRUNCATED_MARKER,
  instructionsBlock,
  isExcludedPath,
  MANAGED_CLAUDE_MD_PATH,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  parseAdditionalDirs,
  readClaudeMdExcludes,
  rootsForImporter,
} from '../extensions/context-imports.ts'
import { INSTRUCTIONS_CHANNEL } from '../extensions/internal/instruction-events.ts'
import { managedSettingsPath, readManagedSettings, setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'

// The extension reads ~/.claude/settings.json (claudeMdExcludes) and the OS
// managed-settings.json; point both at throwaway dirs so the developer's real
// config cannot influence assertions.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

/** Roots granted to `file`, then the imports it actually pulls in. */
const importsFor = (file: string, home: string, cwd: string, content?: string) => {
  const roots = rootsForImporter(file, home, cwd)
  const body = content ?? readFileSync(file, 'utf-8')
  return collectImports(body, dirname(file), home, roots, new Set())
}

// realpath so allowed-root prefix checks hold on macOS (/tmp -> /private/tmp)
const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'ci-')))

beforeEach(() => {
  hoisted.home = tempDir()
  setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
})
afterEach(() => {
  hoisted.home = ''
  setManagedSettingsPath(undefined)
})

describe('expandHome', () => {
  it('expands ~ and ~/ but leaves other paths alone', () => {
    expect(expandHome('~', '/home/x')).toBe('/home/x')
    expect(expandHome('~/a.md', '/home/x')).toBe('/home/x/a.md')
    expect(expandHome('rel.md', '/home/x')).toBe('rel.md')
  })
})

describe('CLAUDE.local.md', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  const wire = async (cwd: string, ctx: Record<string, unknown>): Promise<string> => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    await handlers.get('session_start')?.({}, ctx)
    const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles: [] } }, {})) as { systemPrompt: string } | undefined
    return result?.systemPrompt ?? 'BASE'
  }

  it('appends approved local context and resolves its imports', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL NOTES\n\n@extra.md')
    writeFileSync(join(cwd, 'extra.md'), 'EXTRA CONTENT')

    const prompt = await wire(cwd, { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

    expect(prompt).toContain('LOCAL NOTES')
    expect(prompt).toContain('EXTRA CONTENT')
  })

  it('loads every CLAUDE.local.md from the repository root down to cwd, root first', async () => {
    // Claude loads local context from the whole hierarchy above the working
    // directory, ordered root down to cwd so the closest file reads last.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, 'CLAUDE.local.md'), 'ROOT NOTES')
    const sub = join(repo, 'src')
    mkdirSync(sub)
    writeFileSync(join(sub, 'CLAUDE.local.md'), 'SUB NOTES')

    const prompt = await wire(sub, { cwd: sub, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

    expect(prompt).toContain('ROOT NOTES')
    expect(prompt).toContain('SUB NOTES')
    expect(prompt.indexOf('ROOT NOTES')).toBeLessThan(prompt.indexOf('SUB NOTES'))
  })

  it('finds CLAUDE.local.md at the repository root from a subdirectory session, imports included', async () => {
    // Claude loads local context from the hierarchy above the working directory; the
    // file's own imports resolve against its directory, so that root must be allowed.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, 'CLAUDE.local.md'), 'ROOT LOCAL NOTES\n\n@extra.md')
    writeFileSync(join(repo, 'extra.md'), 'ROOT EXTRA CONTENT')
    const sub = join(repo, 'src')
    mkdirSync(sub)

    const prompt = await wire(sub, { cwd: sub, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

    expect(prompt).toContain('ROOT LOCAL NOTES')
    expect(prompt).toContain('ROOT EXTRA CONTENT')
  })

  it('ignores local context when the project is not approved', async () => {
    // A cloned repo can ship CLAUDE.local.md; without approval it must not reach the prompt.
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL NOTES')

    const prompt = await wire(cwd, { cwd, isProjectTrusted: () => true, hasUI: false, ui: { notify: () => {} } })

    expect(prompt).not.toContain('LOCAL NOTES')
  })

  it('strips block comments from CLAUDE.local.md bodies', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL KEEP\n<!-- local secret -->\nLOCAL TAIL')

    const prompt = await wire(cwd, { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

    expect(prompt).toContain('LOCAL KEEP')
    expect(prompt).toContain('LOCAL TAIL')
    expect(prompt).not.toContain('local secret')
  })

  it('excludes a CLAUDE.local.md matched by claudeMdExcludes', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/CLAUDE.local.md'] }))
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL NOTES\n@extra.md')
    writeFileSync(join(cwd, 'extra.md'), 'EXTRA CONTENT')

    const prompt = await wire(cwd, { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

    expect(prompt).not.toContain('LOCAL NOTES')
    // An excluded file's imports must not be pulled in either.
    expect(prompt).not.toContain('EXTRA CONTENT')
  })
})

describe('collectImports', () => {
  it('collects an imported file and its transitive imports in order', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), 'A body\n@b.md')
    writeFileSync(join(dir, 'b.md'), 'B body')
    const out = collectImports('see @a.md', dir, dir, [dir], new Set())
    expect(out.map((f) => f.body)).toEqual(['A body\n@b.md', 'B body'])
  })

  it('ignores an unreadable import and does not treat emails as imports', () => {
    const dir = tempDir()
    expect(collectImports('@missing.md and user@example.com', dir, dir, [dir], new Set())).toEqual([])
  })

  it('blocks an absolute import that escapes the allowed roots', () => {
    const dir = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.md'), 'TOP SECRET')
    expect(collectImports(`@${join(outside, 'secret.md')}`, dir, dir, [dir], new Set())).toEqual([])
  })

  it('blocks a symlink that points outside the allowed roots', () => {
    const dir = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.md'), 'TOP SECRET')
    symlinkSync(join(outside, 'secret.md'), join(dir, 'link.md'))
    expect(collectImports('@link.md', dir, dir, [dir], new Set())).toEqual([])
  })

  it('skips imports inside fenced code blocks', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'b.md'), 'B')
    expect(collectImports('```\n@b.md\n```', dir, dir, [dir], new Set())).toEqual([])
  })

  it('skips imports inside tilde-fenced code blocks', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'b.md'), 'B')
    expect(collectImports('~~~\n@b.md\n~~~', dir, dir, [dir], new Set())).toEqual([])
  })

  it('skips imports inside inline code spans, as Claude Code documents', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'b.md'), 'B')
    writeFileSync(join(dir, 'c.md'), 'C')
    const out = collectImports('mention `@b.md` in prose but import @c.md', dir, dir, [dir], new Set())
    expect(out.map((o) => o.body)).toEqual(['C'])
  })

  it('skips imports inside double-backtick code spans', () => {
    // Multi-backtick spans are the standard way to quote literal backticks.
    const dir = tempDir()
    writeFileSync(join(dir, 'b.md'), 'B')
    expect(collectImports('see ``@b.md`` for details', dir, dir, [dir], new Set())).toEqual([])
  })

  it('does not let a tilde line close a backtick fence', () => {
    // A fence only closes with the character that opened it; a backtick-fenced
    // example showing a tilde fence must stay fenced throughout.
    const dir = tempDir()
    writeFileSync(join(dir, 'b.md'), 'B')
    expect(collectImports('```\n~~~\n@b.md\n~~~\n```', dir, dir, [dir], new Set())).toEqual([])
  })

  it('skips an import that resolves to a directory instead of crashing', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'sub'))
    expect(collectImports('@sub', dir, dir, [dir], new Set())).toEqual([])
  })

  it('does not follow an import commented out inside an imported file', () => {
    // A commented-out @import in a top-level file never expands (the wiring
    // strips comments before scanning); an imported file must behave the same.
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), '<!-- @b.md -->')
    writeFileSync(join(dir, 'b.md'), 'B body')
    const out = collectImports('@a.md', dir, dir, [dir], new Set())
    expect(out.map((f) => f.body)).toEqual(['<!-- @b.md -->'])
  })

  it('skips an excluded import before reading it: no children, no budget spent', () => {
    // Exclusion must apply during the recursion: a post-collection filter drops
    // the excluded file itself but leaves its transitive imports in the prompt
    // and lets its body drain the shared byte budget.
    const dir = tempDir()
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'secret.md'), 'SECRET\n@child.md')
    writeFileSync(join(dir, 'docs', 'child.md'), 'CHILD')
    const budget = createImportBudget()

    const out = collectImports('@docs/secret.md', dir, dir, [dir], new Set(), { budget, isExcluded: (real) => real.endsWith('secret.md') })

    expect(out).toEqual([])
    expect(budget.files).toBe(MAX_IMPORT_FILES)
    expect(budget.bytes).toBe(MAX_IMPORT_BYTES)
  })

  it('is cycle-safe', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), '@b.md')
    writeFileSync(join(dir, 'b.md'), '@a.md')
    expect(collectImports('@a.md', dir, dir, [dir], new Set()).map((f) => f.body)).toEqual(['@b.md', '@a.md'])
  })

  it('stops after four hops, the depth Claude documents', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), 'A\n@b.md')
    writeFileSync(join(dir, 'b.md'), 'B\n@c.md')
    writeFileSync(join(dir, 'c.md'), 'C\n@d.md')
    writeFileSync(join(dir, 'd.md'), 'D\n@e.md')
    writeFileSync(join(dir, 'e.md'), 'E')
    const out = collectImports('see @a.md', dir, dir, [dir], new Set())
    expect(out.map((f) => f.body.split('\n')[0])).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('import budget', () => {
  /** A directory of `count` one-byte files plus a context body importing all of them. */
  const fanOut = (count: number) => {
    const dir = tempDir()
    const names = Array.from({ length: count }, (_, i) => `f${i}.md`)
    for (const name of names) writeFileSync(join(dir, name), 'x')
    return { dir, body: names.map((name) => `@${name}`).join('\n') }
  }

  it('collects at most MAX_IMPORT_FILES files and counts the rest as dropped', () => {
    const excess = 10
    const { dir, body } = fanOut(MAX_IMPORT_FILES + excess)
    const budget = createImportBudget()

    const out = collectImports(body, dir, dir, [dir], new Set(), { budget })

    expect(out).toHaveLength(MAX_IMPORT_FILES)
    expect(budget.dropped).toBe(excess)
  })

  it('truncates the body that outruns the byte budget and marks the cut', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'big.md'), 'a'.repeat(MAX_IMPORT_BYTES + 1024))
    const budget = createImportBudget()

    const out = collectImports('@big.md', dir, dir, [dir], new Set(), { budget })

    expect(out).toHaveLength(1)
    expect(out[0].body.endsWith(IMPORT_TRUNCATED_MARKER)).toBe(true)
    expect(out[0].body.replace(`\n${IMPORT_TRUNCATED_MARKER}`, '').length).toBeLessThanOrEqual(MAX_IMPORT_BYTES)
    expect(budget.bytes).toBe(0)
  })

  it('spends one budget across every context file, not one per file', () => {
    const { dir, body } = fanOut(MAX_IMPORT_FILES)
    writeFileSync(join(dir, 'extra.md'), 'extra')
    const budget = createImportBudget()

    collectImports(body, dir, dir, [dir], new Set(), { budget })
    const second = collectImports('@extra.md', dir, dir, [dir], new Set(), { budget })

    expect(second).toEqual([])
    expect(budget.dropped).toBe(1)
  })
})

describe('extension wiring', () => {
  it('appends only imported content within the project root', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'style.md'), 'Two-space indent.')
    const claudeMd = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMd, 'Root rules.\n@style.md')

    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)

    const event = {
      systemPrompt: 'BASE with @style.md line already loaded',
      systemPromptOptions: { cwd: dir, contextFiles: [{ path: claudeMd, content: 'Root rules.\n@style.md' }] },
    }
    const result = (await handlers.get('before_agent_start')?.(event)) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('## Imported context (@)')
    expect(result.systemPrompt).toContain('Two-space indent.')
    // base content appears once (from the original prompt), not re-injected
    expect(result.systemPrompt.match(/Root rules\./g)).toBeNull()
  })

  it('tells the model how many imports the budget skipped', async () => {
    const dir = tempDir()
    const excess = 3
    const names = Array.from({ length: MAX_IMPORT_FILES + excess }, (_, i) => `f${i}.md`)
    for (const name of names) writeFileSync(join(dir, name), 'x')
    const content = names.map((name) => `@${name}`).join('\n')
    const claudeMd = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMd, content)

    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)

    const event = { systemPrompt: 'BASE', systemPromptOptions: { cwd: dir, contextFiles: [{ path: claudeMd, content }] } }
    const result = (await handlers.get('before_agent_start')?.(event)) as { systemPrompt: string }

    expect(result.systemPrompt).toContain(`${excess} further @import`)
  })

  it('returns nothing when there are no context files', async () => {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    expect(await handlers.get('before_agent_start')?.({ systemPrompt: 'X', systemPromptOptions: { cwd: '/tmp', contextFiles: [] } })).toBeUndefined()
  })
})

describe('user config is off limits to project context files', () => {
  /** Fake home with a credential file, plus a separate project checkout. */
  const scenario = () => {
    const home = tempDir()
    const cwd = tempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), 'OAUTH_TOKEN')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'user context')
    return { home, cwd }
  }

  it('refuses a project file importing the user config', () => {
    const { home, cwd } = scenario()
    writeFileSync(join(cwd, 'CLAUDE.md'), '@~/.claude/.credentials.json')

    const handler = importsFor(join(cwd, 'CLAUDE.md'), home, cwd)
    expect(handler).toEqual([])
  })

  it('still lets a user config file import from the user config', () => {
    const { home, cwd } = scenario()
    writeFileSync(join(home, '.claude', 'extra.md'), 'user extra')

    const handler = importsFor(join(home, '.claude', 'CLAUDE.md'), home, cwd, '@~/.claude/extra.md')
    expect(handler.map((f) => f.body)).toEqual(['user extra'])
  })

  it('still lets a project file import within the project', () => {
    const { home, cwd } = scenario()
    writeFileSync(join(cwd, 'notes.md'), 'project notes')

    const handler = importsFor(join(cwd, 'CLAUDE.md'), home, cwd, '@notes.md')
    expect(handler.map((f) => f.body)).toEqual(['project notes'])
  })
})

describe('home-level context files are confined to the repository', () => {
  it('blocks a home-level context file importing a home sibling outside the repo root', () => {
    // pi natively loads home-level context files such as ~/AGENTS.md, which sit
    // outside ~/.claude and ~/.pi. Granting the importer's own directory as a
    // root would make all of $HOME importable (@.ssh/..., @.claude/...) from
    // every session; the bound is the repository root instead.
    const home = tempDir()
    const repo = join(home, 'proj')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(home, 'secret.md'), 'HOME SECRET')
    writeFileSync(join(home, 'AGENTS.md'), '@secret.md')

    expect(importsFor(join(home, 'AGENTS.md'), home, repo)).toEqual([])
  })

  it('still resolves a repo-root context file import from a subdirectory session', () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'src')
    mkdirSync(sub)
    writeFileSync(join(repo, 'style.md'), 'REPO STYLE')
    writeFileSync(join(repo, 'CLAUDE.md'), 'Rules.\n@style.md')

    expect(importsFor(join(repo, 'CLAUDE.md'), tempDir(), sub).map((f) => f.body)).toEqual(['REPO STYLE'])
  })
})

describe('blocked imports and dedupe', () => {
  it('does not let a blocked import suppress the same file for a later allowed reader', () => {
    // A project context file references a home file it may not read; the user's own
    // config, processed later with home in its roots, must still get it.
    const home = tempDir()
    const project = tempDir()
    writeFileSync(join(home, 'style.md'), 'STYLE RULES')
    const seen = new Set<string>()

    expect(collectImports('@~/style.md', project, home, [project], seen)).toEqual([])

    const allowed = collectImports('@~/style.md', home, home, [home], seen)
    expect(allowed.map((f) => f.body)).toEqual(['STYLE RULES'])
  })
})

describe('managed settings', () => {
  it('locates managed-settings.json per platform', () => {
    expect(managedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(managedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
    expect(managedSettingsPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  })

  it('does not use the deprecated ProgramData path on Windows', () => {
    expect(managedSettingsPath('win32')).not.toContain('ProgramData')
  })

  it('reads the managed settings object through the test seam', () => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ claudeMd: 'ORG POLICY' }))
    expect(readManagedSettings().claudeMd).toBe('ORG POLICY')
  })

  it('returns an empty object for a missing or malformed file', () => {
    expect(readManagedSettings()).toEqual({})
    writeFileSync(join(hoisted.home, 'managed-settings.json'), 'not json')
    expect(readManagedSettings()).toEqual({})
    writeFileSync(join(hoisted.home, 'managed-settings.json'), '["array"]')
    expect(readManagedSettings()).toEqual({})
  })
})

describe('claudeMdExcludes settings chain', () => {
  it('reads user settings always and project settings only when approved', () => {
    const cwd = tempDir()
    const home = tempDir()
    expect(claudeMdExcludeFiles(cwd, home, false)).toEqual([join(home, '.claude', 'settings.json')])
    expect(claudeMdExcludeFiles(cwd, home, true)).toEqual([join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')])
  })

  it('merges exclude globs across settings files and managed settings', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'user.json'), JSON.stringify({ claudeMdExcludes: ['**/a.md'] }))
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ claudeMdExcludes: ['**/b.md'] }))
    const merged = readClaudeMdExcludes([join(dir, 'user.json'), join(dir, 'project.json'), join(dir, 'absent.json')], { claudeMdExcludes: ['**/c.md'] })
    expect(merged).toEqual(['**/a.md', '**/b.md', '**/c.md'])
  })

  it('ignores a non-array claudeMdExcludes and non-string entries', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'user.json'), JSON.stringify({ claudeMdExcludes: 'not-an-array' }))
    expect(readClaudeMdExcludes([join(dir, 'user.json')], { claudeMdExcludes: [42, '', '**/ok.md'] })).toEqual(['**/ok.md'])
  })
})

describe('isExcludedPath', () => {
  const home = '/home/u'

  it('matches an exact absolute path', () => {
    expect(isExcludedPath('/repo/docs/CLAUDE.md', ['/repo/docs/CLAUDE.md'], home)).toBe(true)
    expect(isExcludedPath('/repo/docs/CLAUDE.md', ['/repo/other/CLAUDE.md'], home)).toBe(false)
  })

  it('matches ** across directories from an absolute anchor', () => {
    expect(isExcludedPath('/repo/a/b/CLAUDE.md', ['/repo/**/CLAUDE.md'], home)).toBe(true)
    expect(isExcludedPath('/repo/CLAUDE.md', ['/repo/**/CLAUDE.md'], home)).toBe(true)
    expect(isExcludedPath('/elsewhere/CLAUDE.md', ['/repo/**/CLAUDE.md'], home)).toBe(false)
  })

  it('matches a relative glob at any depth', () => {
    expect(isExcludedPath('/x/y/AGENTS.md', ['AGENTS.md'], home)).toBe(true)
    expect(isExcludedPath('/x/y/AGENTS.md', ['**/AGENTS.md'], home)).toBe(true)
    expect(isExcludedPath('/x/y/vendor/CLAUDE.md', ['vendor/CLAUDE.md'], home)).toBe(true)
    expect(isExcludedPath('/x/y/CLAUDE.md', ['vendor/CLAUDE.md'], home)).toBe(false)
  })

  it('expands ~ to the home directory', () => {
    expect(isExcludedPath('/home/u/.claude/CLAUDE.md', ['~/.claude/CLAUDE.md'], home)).toBe(true)
    expect(isExcludedPath('/home/other/.claude/CLAUDE.md', ['~/.claude/CLAUDE.md'], home)).toBe(false)
  })

  it('does not match a partial filename and ignores empty globs', () => {
    expect(isExcludedPath('/repo/CLAUDE.md.bak', ['/repo/CLAUDE.md'], home)).toBe(false)
    expect(isExcludedPath('/repo/CLAUDE.md', ['', '   '], home)).toBe(false)
  })
})

describe('pi wrapper format regression', () => {
  // pi-code rewrites the assembled prompt by exact-substring replacement of the
  // wrapper it reconstructs from path+content. These tests pin pi's wrapper format:
  // if pi ever changes it, they must fail loudly, because every rewrite silently
  // degrades to a no-op skip.
  it('pins the wrapper pi assembles in its own source', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'system-prompt.js'), 'utf-8')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts pi's literal source text, placeholders included
    expect(source).toContain('`<project_instructions path="${filePath}">\\n${content}\\n</project_instructions>\\n\\n`')
    expect(source).toContain('"\\n\\n<project_context>\\n\\n"')
    expect(source).toContain('"Project-specific instructions and guidelines:\\n\\n"')
    expect(source).toContain('"</project_context>\\n"')
  })

  it('finds the reconstructed wrapper inside a realistically assembled prompt', () => {
    const files = [
      { path: '/repo/CLAUDE.md', content: 'Root rules.' },
      { path: '/repo/sub/CLAUDE.md', content: 'Sub rules.\nSecond line.' },
    ]
    // Assembled exactly as pi's buildSystemPrompt does (see the source pin above).
    let prompt = 'BASE PROMPT'
    prompt += '\n\n<project_context>\n\n'
    prompt += 'Project-specific instructions and guidelines:\n\n'
    for (const { path: filePath, content } of files) prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`
    prompt += '</project_context>\n'

    for (const file of files) expect(prompt).toContain(instructionsBlock(file.path, file.content))
  })
})

describe('system prompt rewriting: managed claudeMd, excludes, comment strip', () => {
  /** Assemble a prompt exactly as pi's buildSystemPrompt does (pinned above). */
  const assembled = (files: Array<{ path: string; content: string }>): string => {
    let prompt = 'BASE PROMPT'
    if (files.length === 0) return prompt
    prompt += '\n\n<project_context>\n\n'
    prompt += 'Project-specific instructions and guidelines:\n\n'
    for (const { path: filePath, content } of files) prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`
    prompt += '</project_context>\n'
    return prompt
  }

  const fire = async (files: Array<{ path: string; content: string }>, cwd: string, systemPrompt = assembled(files)) => {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    return (await handlers.get('before_agent_start')?.({ systemPrompt, systemPromptOptions: { cwd, contextFiles: files } })) as { systemPrompt: string } | undefined
  }

  const userSettings = (settings: Record<string, unknown>) => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify(settings))
  }

  const managedSettings = (settings: Record<string, unknown>) => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify(settings))
  }

  it('prepends managed claudeMd, removes excluded blocks, and strips comments from survivors', async () => {
    managedSettings({ claudeMd: 'ORG POLICY' })
    userSettings({ claudeMdExcludes: ['**/vendor/CLAUDE.md'] })
    const dir = tempDir()
    mkdirSync(join(dir, 'vendor'))
    const files = [
      { path: join(dir, 'CLAUDE.md'), content: 'Keep me.\n<!-- maintainer note -->\nAnd me.' },
      { path: join(dir, 'vendor', 'CLAUDE.md'), content: 'VENDOR RULES' },
    ]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).toContain(instructionsBlock(MANAGED_CLAUDE_MD_PATH, 'ORG POLICY'))
    expect(prompt).not.toContain('VENDOR RULES')
    expect(prompt).not.toContain('maintainer note')
    expect(prompt).toContain('Keep me.')
    expect(prompt).toContain('And me.')
    // Managed content loads before user and project context files.
    expect(prompt.indexOf('ORG POLICY')).toBeGreaterThan(prompt.indexOf('<project_context>'))
    expect(prompt.indexOf('ORG POLICY')).toBeLessThan(prompt.indexOf('Keep me.'))
    // The rewrite keeps the surviving block in pi's exact wrapper shape.
    expect(prompt).toContain(instructionsBlock(files[0].path, 'Keep me.\nAnd me.'))
  })

  it('adds a project_context block when pi loaded no context files', async () => {
    managedSettings({ claudeMd: 'ORG POLICY' })

    const result = await fire([], tempDir())
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).toContain('<project_context>')
    expect(prompt).toContain(instructionsBlock(MANAGED_CLAUDE_MD_PATH, 'ORG POLICY'))
    expect(prompt).toContain('</project_context>')
  })

  it('ignores claudeMd in user settings: the key is managed-only', async () => {
    userSettings({ claudeMd: 'USER SNEAK' })
    expect(await fire([], tempDir())).toBeUndefined()
  })

  it('ignores an empty or non-string managed claudeMd', async () => {
    managedSettings({ claudeMd: '   ' })
    expect(await fire([], tempDir())).toBeUndefined()
    managedSettings({ claudeMd: 42 })
    expect(await fire([], tempDir())).toBeUndefined()
  })

  it('skips the imports of an excluded context file', async () => {
    userSettings({ claudeMdExcludes: ['**/CLAUDE.md'] })
    const dir = tempDir()
    writeFileSync(join(dir, 'extra.md'), 'PULLED IN')
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'SKIP ME\n@extra.md' }]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).not.toContain('SKIP ME')
    expect(prompt).not.toContain('PULLED IN')
  })

  it('does not load the transitive imports of an excluded @import', async () => {
    // The excluded file's children must not ride in: exclusion applies during
    // the recursion, so the excluded target is never read or recursed into.
    userSettings({ claudeMdExcludes: ['**/secret.md'] })
    const dir = tempDir()
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'secret.md'), 'SECRET BODY\n@child.md')
    writeFileSync(join(dir, 'docs', 'child.md'), 'CHILD BODY')
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'Rules.\n@docs/secret.md' }]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).not.toContain('SECRET BODY')
    expect(prompt).not.toContain('CHILD BODY')
  })

  it('never excludes the managed claudeMd block', async () => {
    managedSettings({ claudeMd: 'ORG POLICY', claudeMdExcludes: ['**'] })
    const dir = tempDir()
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'PROJECT RULES' }]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).not.toContain('PROJECT RULES')
    expect(prompt).toContain('ORG POLICY')
  })

  it('merges managed claudeMdExcludes with user settings', async () => {
    userSettings({ claudeMdExcludes: ['**/a/CLAUDE.md'] })
    managedSettings({ claudeMdExcludes: ['**/b/CLAUDE.md'] })
    const dir = tempDir()
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    const files = [
      { path: join(dir, 'a', 'CLAUDE.md'), content: 'FROM A' },
      { path: join(dir, 'b', 'CLAUDE.md'), content: 'FROM B' },
      { path: join(dir, 'CLAUDE.md'), content: 'FROM ROOT' },
    ]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).not.toContain('FROM A')
    expect(prompt).not.toContain('FROM B')
    expect(prompt).toContain('FROM ROOT')
  })

  it('strips comments from imported file bodies', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'extra.md'), 'IMPORTED KEEP\n<!-- imported secret -->\nIMPORTED TAIL')
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'Rules.\n@extra.md' }]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).toContain('IMPORTED KEEP')
    expect(prompt).toContain('IMPORTED TAIL')
    expect(prompt).not.toContain('imported secret')
  })

  it('does not expand an import mentioned only inside a stripped comment', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'hidden.md'), 'HIDDEN CONTENT')
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'Body.\n<!--\n@hidden.md\n-->' }]

    const result = await fire(files, dir)

    expect(result?.systemPrompt ?? '').not.toContain('HIDDEN CONTENT')
  })

  it('does not expand an import commented out inside an imported file', async () => {
    // The reference is stripped from the rendered output, so the expansion must
    // not happen either: a.md's commented-out @b.md stays dead at every depth.
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), '<!-- @b.md -->')
    writeFileSync(join(dir, 'b.md'), 'B SECRET CONTENT')
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'Body.\n@a.md' }]

    const result = await fire(files, dir)

    expect(result?.systemPrompt ?? '').not.toContain('B SECRET CONTENT')
  })

  it('skips the rewrite when the reconstructed wrapper is not in the prompt', async () => {
    // A prompt that does not carry pi's wrapper (format drift) must never be
    // corrupted; with nothing else to add the handler stays silent.
    const dir = tempDir()
    const files = [{ path: join(dir, 'CLAUDE.md'), content: 'Rules.\n<!-- note -->' }]

    expect(await fire(files, dir, 'BASE PROMPT WITHOUT WRAPPER')).toBeUndefined()
  })
})

describe('additionalDirContextFiles', () => {
  it('collects CLAUDE.md, .claude/CLAUDE.md, sorted .claude/rules/*.md and CLAUDE.local.md', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'CLAUDE.md'), 'ROOT')
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'DOT')
    writeFileSync(join(dir, '.claude', 'rules', 'b.md'), 'RULE B')
    writeFileSync(join(dir, '.claude', 'rules', 'a.md'), 'RULE A')
    writeFileSync(join(dir, '.claude', 'rules', 'notes.txt'), 'NOT MD')
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'LOCAL')

    expect(additionalDirContextFiles(dir, true)).toEqual([
      { path: join(dir, 'CLAUDE.md'), content: 'ROOT' },
      { path: join(dir, '.claude', 'CLAUDE.md'), content: 'DOT' },
      { path: join(dir, '.claude', 'rules', 'a.md'), content: 'RULE A' },
      { path: join(dir, '.claude', 'rules', 'b.md'), content: 'RULE B' },
      { path: join(dir, 'CLAUDE.local.md'), content: 'LOCAL' },
    ])
  })

  it('skips missing files and withholds CLAUDE.local.md when not approved', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'CLAUDE.md'), 'ROOT')
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'LOCAL')
    expect(additionalDirContextFiles(dir, false)).toEqual([{ path: join(dir, 'CLAUDE.md'), content: 'ROOT' }])
    expect(additionalDirContextFiles(tempDir(), true)).toEqual([])
  })
})

describe('parseAdditionalDirs', () => {
  it('splits a comma-separated --add-dir value, expanding ~ and resolving relative paths against cwd', () => {
    expect(parseAdditionalDirs('/abs/a, rel/b,~/c', '/home/u', '/cwd')).toEqual(['/abs/a', '/cwd/rel/b', '/home/u/c'])
  })

  it('returns nothing for a missing, boolean, or empty flag value', () => {
    expect(parseAdditionalDirs(undefined, '/home/u', '/cwd')).toEqual([])
    expect(parseAdditionalDirs(true, '/home/u', '/cwd')).toEqual([])
    expect(parseAdditionalDirs('  ,  ', '/home/u', '/cwd')).toEqual([])
  })
})

describe('additionalDirsClaudeMdEnabled', () => {
  it('is off when the env var is unset, empty, 0, false or no', () => {
    for (const value of [undefined, '', ' ', '0', 'false', 'FALSE', 'no']) {
      expect(additionalDirsClaudeMdEnabled({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: value })).toBe(false)
    }
  })

  it('is on for 1, true, or any other value', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(additionalDirsClaudeMdEnabled({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: value })).toBe(true)
    }
  })
})

describe('--add-dir additional directories', () => {
  let savedEnv: string | undefined
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
    delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
    else process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = savedEnv
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** Wire the extension against a stub pi carrying flags and a shared bus. */
  const wire = (flag?: unknown) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const flags: Array<{ name: string; options: Record<string, unknown> }> = []
    const emitted: Array<{ channel: string; data: unknown }> = []
    contextImports({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerFlag: (name: string, options: Record<string, unknown>) => flags.push({ name, options }),
      getFlag: () => flag,
      events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    } as never)
    return {
      handlers,
      flags,
      instructionEvents: () => emitted.filter((entry) => entry.channel === INSTRUCTIONS_CHANNEL).map((entry) => entry.data),
      start: (ctx: Record<string, unknown>) => handlers.get('session_start')?.({}, ctx),
      fire: async (cwd: string, contextFiles: Array<{ path: string; content: string }> = []) => {
        const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles } }, {})) as { systemPrompt: string } | undefined
        return result?.systemPrompt ?? 'BASE'
      },
    }
  }

  it('registers the add-dir CLI flag as a string flag', () => {
    const { flags } = wire()
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('add-dir')
    expect(flags[0].options.type).toBe('string')
  })

  it('appends an additional dir CLAUDE.md as a project_instructions block when the env gate is set', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA DIR RULES')

    const prompt = await wire(extra).fire(tempDir())

    expect(prompt).toContain(instructionsBlock(join(extra, 'CLAUDE.md'), 'EXTRA DIR RULES'))
  })

  it('does not load additional dir context without the env gate', async () => {
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA DIR RULES')

    const prompt = await wire(extra).fire(tempDir())

    expect(prompt).not.toContain('EXTRA DIR RULES')
  })

  it('accepts a comma-separated value for multiple additional dirs', async () => {
    // pi's getFlag is single-value, so a repeated --add-dir cannot be expressed;
    // a comma-separated value stands in for it.
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const first = tempDir()
    const second = tempDir()
    writeFileSync(join(first, 'CLAUDE.md'), 'FIRST DIR RULES')
    writeFileSync(join(second, 'CLAUDE.md'), 'SECOND DIR RULES')

    const prompt = await wire(`${first},${second}`).fire(tempDir())

    expect(prompt).toContain('FIRST DIR RULES')
    expect(prompt).toContain('SECOND DIR RULES')
  })

  it('resolves @imports of additional dir files with the additional dir as an allowed root', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA NOTES\n@style.md')
    writeFileSync(join(extra, 'style.md'), 'EXTRA STYLE RULES')

    const prompt = await wire(extra).fire(tempDir())

    expect(prompt).toContain('EXTRA NOTES')
    expect(prompt).toContain('EXTRA STYLE RULES')
  })

  it('loads the additional dir CLAUDE.local.md only when the project is approved', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA DIR RULES')
    writeFileSync(join(extra, 'CLAUDE.local.md'), 'EXTRA LOCAL NOTES')
    const cwd = tempDir()

    const approved = wire(extra)
    await approved.start({ cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })
    expect(await approved.fire(cwd)).toContain('EXTRA LOCAL NOTES')

    const declined = wire(extra)
    await declined.start({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })
    const prompt = await declined.fire(cwd)
    expect(prompt).toContain('EXTRA DIR RULES')
    expect(prompt).not.toContain('EXTRA LOCAL NOTES')
  })

  it('honors claudeMdExcludes for additional dir files', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/CLAUDE.md'] }))
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA DIR RULES')

    const prompt = await wire(extra).fire(tempDir())

    expect(prompt).not.toContain('EXTRA DIR RULES')
  })

  it('reuses the expanded imports across turns until an imported file actually changes', async () => {
    // before_agent_start fires every turn; re-reading and re-recursing every @import
    // per turn is wasted I/O when nothing changed. The expansion is memoized and
    // validated by mtime: an edit that bumps the mtime is picked up, and the memo
    // serves the run when mtimes are unchanged.
    const cwd = tempDir()
    writeFileSync(join(cwd, 'extra.md'), 'ORIGINAL IMPORT BODY')
    // Pin the mtime to a whole second: the filesystem stores sub-ms precision that
    // utimesSync cannot reproduce, and the memo compares mtimeMs exactly.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000)
    utimesSync(join(cwd, 'extra.md'), pinned, pinned)
    const files = [{ path: join(cwd, 'CLAUDE.md'), content: 'Rules.\n@extra.md' }]
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    const fireOnce = async () => (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles: files } })) as { systemPrompt: string } | undefined

    const first = await fireOnce()
    expect(first?.systemPrompt).toContain('ORIGINAL IMPORT BODY')

    // Rewrite the import with the SAME mtime AND the same byte length: the stat token
    // (mtime plus size) is unchanged, so the memo must serve the cached body (this is
    // the perf property under test; a per-turn re-read would see the edit). A
    // different-length edit would trip the size half of the token, covered separately.
    const sameLengthEdit = 'SILENT SAME EDIT'.padEnd('ORIGINAL IMPORT BODY'.length, '.')
    expect(Buffer.byteLength(sameLengthEdit)).toBe(Buffer.byteLength('ORIGINAL IMPORT BODY'))
    writeFileSync(join(cwd, 'extra.md'), sameLengthEdit)
    utimesSync(join(cwd, 'extra.md'), pinned, pinned)
    const second = await fireOnce()
    expect(second?.systemPrompt).toContain('ORIGINAL IMPORT BODY')
    expect(second?.systemPrompt).not.toContain(sameLengthEdit)

    // An edit that bumps the mtime invalidates the memo and is picked up.
    writeFileSync(join(cwd, 'extra.md'), 'UPDATED IMPORT BODY')
    utimesSync(join(cwd, 'extra.md'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const third = await fireOnce()
    expect(third?.systemPrompt).toContain('UPDATED IMPORT BODY')
  })

  it('invalidates the memo when an imported file changes size at the same mtime', async () => {
    // The memo revalidates on mtime AND size, like memory.ts's stat token: a
    // length-changing rewrite that lands within one mtime tick would otherwise be
    // served stale. Pin the same whole-second mtime across the edit so only the size
    // differs, and the memo must still invalidate.
    const cwd = tempDir()
    writeFileSync(join(cwd, 'extra.md'), 'SHORT BODY')
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000)
    utimesSync(join(cwd, 'extra.md'), pinned, pinned)
    const files = [{ path: join(cwd, 'CLAUDE.md'), content: 'Rules.\n@extra.md' }]
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    const fireOnce = async () => (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles: files } })) as { systemPrompt: string } | undefined

    const first = await fireOnce()
    expect(first?.systemPrompt).toContain('SHORT BODY')

    writeFileSync(join(cwd, 'extra.md'), 'A MUCH LONGER REPLACEMENT BODY')
    utimesSync(join(cwd, 'extra.md'), pinned, pinned)
    const second = await fireOnce()
    expect(second?.systemPrompt).toContain('A MUCH LONGER REPLACEMENT BODY')
  })

  it('publishes session_start and include instruction events once per session', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    const extra = tempDir()
    writeFileSync(join(extra, 'CLAUDE.md'), 'EXTRA NOTES\n@style.md')
    writeFileSync(join(extra, 'style.md'), 'EXTRA STYLE RULES')

    const cwd = tempDir()
    const wired = wire(extra)
    await wired.fire(cwd)
    expect(wired.instructionEvents()).toEqual([
      { file_path: join(extra, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' },
      { file_path: join(extra, 'style.md'), memory_type: 'Project', load_reason: 'include', parent_file_path: join(extra, 'CLAUDE.md') },
    ])

    // before_agent_start fires every turn; the events must not repeat.
    await wired.fire(cwd)
    expect(wired.instructionEvents()).toHaveLength(2)
  })

  it('publishes a session_start event per native context file plus an include event naming the importer', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'extra.md'), 'PULLED IN')

    const wired = wire()
    await wired.fire(cwd, [{ path: join(cwd, 'CLAUDE.md'), content: 'Rules.\n@extra.md' }])

    expect(wired.instructionEvents()).toEqual([
      { file_path: join(cwd, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' },
      { file_path: join(cwd, 'extra.md'), memory_type: 'Project', load_reason: 'include', parent_file_path: join(cwd, 'CLAUDE.md') },
    ])
  })

  it('publishes session_start only for native context files that survived claudeMdExcludes', async () => {
    // Claude fires no InstructionsLoaded for a file it never loaded, so a file
    // claudeMdExcludes removed from the prompt must not announce.
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/vendor/CLAUDE.md'] }))
    const cwd = tempDir()
    mkdirSync(join(cwd, 'vendor'))

    const wired = wire()
    await wired.fire(cwd, [
      { path: join(cwd, 'CLAUDE.md'), content: 'KEEP' },
      { path: join(cwd, 'vendor', 'CLAUDE.md'), content: 'VENDOR RULES' },
    ])

    expect(wired.instructionEvents()).toEqual([{ file_path: join(cwd, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' }])
  })

  it('re-publishes instruction events after a session_start: a reload re-loads instructions', async () => {
    const cwd = tempDir()
    const files = [{ path: join(cwd, 'CLAUDE.md'), content: 'Rules.' }]
    const wired = wire()

    await wired.fire(cwd, files)
    await wired.fire(cwd, files)
    expect(wired.instructionEvents()).toHaveLength(1) // once per session, not per turn

    await wired.start({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })
    await wired.fire(cwd, files)
    expect(wired.instructionEvents()).toHaveLength(2)
  })

  it('publishes a Local session_start event for a loaded CLAUDE.local.md', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL NOTES')

    const wired = wire()
    await wired.start({ cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })
    await wired.fire(cwd)

    expect(wired.instructionEvents()).toEqual([{ file_path: join(cwd, 'CLAUDE.local.md'), memory_type: 'Local', load_reason: 'session_start' }])
  })
})
