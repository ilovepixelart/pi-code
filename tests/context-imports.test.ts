import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contextImports, {
  additionalDirContextFiles,
  additionalDirsClaudeMdEnabled,
  claudeMdExcludeFiles,
  collectImports,
  createImportBudget,
  EXTERNAL_IMPORT_PROMPT_TITLE,
  expandHome,
  IMPORT_TRUNCATED_MARKER,
  instructionsBlock,
  isExcludedPath,
  MANAGED_CLAUDE_MD_PATH,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  managedClaudeMdPath,
  parseAdditionalDirs,
  readClaudeMdExcludes,
  rootsForImporter,
  setManagedClaudeMdPath,
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

/** Assemble a prompt exactly as pi's buildSystemPrompt does (pinned by the wrapper
 * regression tests above); shared by the ordering tests for the added blocks. */
const assembledPrompt = (files: Array<{ path: string; content: string }>): string => {
  let prompt = 'BASE PROMPT'
  if (files.length === 0) return prompt
  prompt += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n'
  for (const { path: filePath, content } of files) prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`
  prompt += '</project_context>\n'
  return prompt
}

beforeEach(() => {
  hoisted.home = tempDir()
  setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
  // The managed CLAUDE.md file sits alongside managed-settings.json; point it at the
  // same throwaway dir (dirname of the overridden settings path) so tests can write it.
  setManagedClaudeMdPath(join(hoisted.home, 'CLAUDE.md'))
})
afterEach(() => {
  hoisted.home = ''
  setManagedSettingsPath(undefined)
  setManagedClaudeMdPath(undefined)
})

describe('expandHome', () => {
  it('expands ~ and ~/ but leaves other paths alone', () => {
    expect(expandHome('~', '/home/x')).toBe('/home/x')
    expect(expandHome('~/a.md', '/home/x')).toBe(join('/home/x', 'a.md'))
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

  it('charges the import budget in bytes, not UTF-16 units', () => {
    // MAX_IMPORT_BYTES is a byte budget; slicing by string length let CJK text through at
    // three times the budget and never appended the truncation marker.
    const dir = tempDir()
    writeFileSync(join(dir, 'cjk.md'), '漢'.repeat(100))
    const budget = createImportBudget()
    budget.bytes = 100

    const out = collectImports('@cjk.md', dir, dir, [dir], new Set(), { budget })

    expect(out.map((f) => f.body)).toEqual([`${'漢'.repeat(33)}\n${IMPORT_TRUNCATED_MARKER}`])
    expect(budget.bytes).toBe(1)
  })

  it('keeps a fence open across a shorter same-character fence line', () => {
    // CommonMark: a closer must be at least as long as its opener, so the classic
    // three-backtick block quoted inside a four-backtick one is content.
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), '````\n```\n@b.md\n````')
    writeFileSync(join(dir, 'b.md'), 'B')
    expect(collectImports('@a.md', dir, dir, [dir], new Set()).map((f) => f.body)).toEqual(['````\n```\n@b.md\n````'])
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

  it('grants user-config roots to an importer under CLAUDE_CONFIG_DIR', () => {
    // With CLAUDE_CONFIG_DIR set, the user config tree moves; a context file living there
    // must still be able to import from that same relocated config dir.
    const home = tempDir()
    const cwd = tempDir()
    const cfg = tempDir()
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      writeFileSync(join(cfg, 'CLAUDE.md'), 'user context')
      writeFileSync(join(cfg, 'extra.md'), 'user extra')
      const handler = importsFor(join(cfg, 'CLAUDE.md'), home, cwd, '@extra.md')
      expect(handler.map((f) => f.body)).toEqual(['user extra'])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
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

  it('resolves the user settings.json under CLAUDE_CONFIG_DIR, leaving project scope alone', () => {
    const cwd = tempDir()
    const home = tempDir()
    const cfg = tempDir()
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      // The user entry relocates; the approval-gated project entries do not.
      expect(claudeMdExcludeFiles(cwd, home, false)).toEqual([join(cfg, 'settings.json')])
      expect(claudeMdExcludeFiles(cwd, home, true)).toEqual([join(cfg, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
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
  const fire = async (files: Array<{ path: string; content: string }>, cwd: string, systemPrompt = assembledPrompt(files)) => {
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

  it('excludes a .txt context file via a brace-glob claudeMdExcludes', async () => {
    // `{md,txt}` must expand for the .txt block to drop; a literal-brace fallback would
    // match neither and leave both in the prompt. `.log` is outside the group and survives.
    userSettings({ claudeMdExcludes: ['**/*.{md,txt}'] })
    const dir = tempDir()
    const files = [
      { path: join(dir, 'CLAUDE.md'), content: 'MD BODY' },
      { path: join(dir, 'notes.txt'), content: 'TXT BODY' },
      { path: join(dir, 'keep.log'), content: 'LOG BODY' },
    ]

    const result = await fire(files, dir)
    const prompt = result?.systemPrompt ?? ''

    expect(prompt).not.toContain('MD BODY')
    expect(prompt).not.toContain('TXT BODY')
    expect(prompt).toContain('LOG BODY')
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

  it('sorts rule names with pinned en collation regardless of host locale', () => {
    // Czech collation orders ch after h; the default collator follows the host
    // locale, so unpinned sorting reorders prompt content per machine.
    const dir = tempDir()
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'rules', 'h.md'), 'H')
    writeFileSync(join(dir, '.claude', 'rules', 'ci.md'), 'CI')
    writeFileSync(join(dir, '.claude', 'rules', 'ch.md'), 'CH')
    expect(additionalDirContextFiles(dir, false).map((file) => file.content)).toEqual(['CH', 'CI', 'H'])
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
    expect(parseAdditionalDirs('/abs/a, rel/b,~/c', '/home/u', '/cwd')).toEqual([resolve('/abs/a'), resolve('/cwd/rel/b'), resolve('/home/u/c')])
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

/** Wire the extension with an instruction-event bus, session_start and per-turn fire.
 * Shared by the user, project .claude/CLAUDE.md and managed-file describes below. */
const wireWithBus = () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  const emitted: Array<{ channel: string; data: unknown }> = []
  contextImports({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
    events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
  } as never)
  return {
    instructionEvents: () => emitted.filter((entry) => entry.channel === INSTRUCTIONS_CHANNEL).map((entry) => entry.data),
    start: (ctx: Record<string, unknown>) => handlers.get('session_start')?.({}, ctx),
    /** The turn event. `ctx` matters for the external-import dialog, which pi-code asks
     * here because only this event knows which context files pi actually loaded. */
    fire: async (cwd: string, contextFiles: Array<{ path: string; content: string }> = [], systemPrompt = 'BASE', ctx: Record<string, unknown> = {}) => {
      const result = (await handlers.get('before_agent_start')?.({ systemPrompt, systemPromptOptions: { cwd, contextFiles } }, ctx)) as { systemPrompt: string } | undefined
      return result?.systemPrompt ?? systemPrompt
    },
  }
}

/** A session_start ctx that approves the project (Claude-shaped config trusted). */
const approvingCtx = (cwd: string) => ({ cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })

describe('user CLAUDE.md (~/.claude/CLAUDE.md)', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** Write ~/.claude/CLAUDE.md under the mocked home and return its path. */
  const writeUserClaudeMd = (content: string): string => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const file = join(hoisted.home, '.claude', 'CLAUDE.md')
    writeFileSync(file, content)
    return file
  }

  it('loads ~/.claude/CLAUDE.md as a User memory block, announced once at session_start', async () => {
    const file = writeUserClaudeMd('USER GLOBAL RULES')
    const cwd = tempDir()

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain('USER GLOBAL RULES')
    expect(wired.instructionEvents()).toEqual([{ file_path: file, memory_type: 'User', load_reason: 'session_start' }])

    // before_agent_start fires every turn; the User announce must not repeat.
    await wired.fire(cwd)
    expect(wired.instructionEvents()).toHaveLength(1)
  })

  it('places the user block after the managed block and before pi native project blocks', async () => {
    // Claude's order: managed, then user, then project.
    writeUserClaudeMd('USER RULES')
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ claudeMd: 'ORG POLICY' }))
    const cwd = tempDir()
    const native = { path: join(cwd, 'CLAUDE.md'), content: 'PROJECT NATIVE RULES' }

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd, [native], assembledPrompt([native]))

    expect(prompt.indexOf('ORG POLICY')).toBeLessThan(prompt.indexOf('USER RULES'))
    expect(prompt.indexOf('USER RULES')).toBeLessThan(prompt.indexOf('PROJECT NATIVE RULES'))
  })

  it('resolves @imports in the user CLAUDE.md against user-scope roots', async () => {
    // A user-config file may reach the rest of the user config; @extra.md sits in
    // ~/.claude, which only the user-scope roots allow.
    writeUserClaudeMd('USER RULES\n@extra.md')
    writeFileSync(join(hoisted.home, '.claude', 'extra.md'), 'USER EXTRA CONTENT')
    const cwd = tempDir()

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain('USER RULES')
    expect(prompt).toContain('USER EXTRA CONTENT')
  })

  it('excludes the user CLAUDE.md when claudeMdExcludes matches it', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['~/.claude/CLAUDE.md'] }))
    writeUserClaudeMd('USER RULES\n@extra.md')
    writeFileSync(join(hoisted.home, '.claude', 'extra.md'), 'USER EXTRA CONTENT')
    const cwd = tempDir()

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).not.toContain('USER RULES')
    // An excluded file's imports must not be pulled in either.
    expect(prompt).not.toContain('USER EXTRA CONTENT')
    expect(wired.instructionEvents()).toEqual([])
  })

  it('strips block comments from the user CLAUDE.md body', async () => {
    writeUserClaudeMd('USER KEEP\n<!-- user secret -->\nUSER TAIL')
    const cwd = tempDir()

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain('USER KEEP')
    expect(prompt).toContain('USER TAIL')
    expect(prompt).not.toContain('user secret')
  })

  it('does nothing when there is no ~/.claude/CLAUDE.md', async () => {
    const cwd = tempDir()
    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    expect(await wired.fire(cwd)).toBe('BASE')
    expect(wired.instructionEvents()).toEqual([])
  })
})

describe('external import approval', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  const homeFile = (name: string, body: string): string => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const file = join(hoisted.home, '.claude', name)
    writeFileSync(file, body)
    return file
  }

  /** A context file at `dir/name` with `body`, returned as pi would report it. */
  const contextFile = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), body)
    return { path: join(dir, name), content: body }
  }

  const ctxWith = (cwd: string, answer: () => Promise<boolean>, asked: string[][], hasUI = true) => ({
    cwd,
    isProjectTrusted: () => true,
    hasUI,
    ui: {
      notify: () => {},
      confirm: async (title: string, body: string) => {
        if (title !== EXTERNAL_IMPORT_PROMPT_TITLE) return true // the project-trust dialog
        asked.push([title, body])
        return await answer()
      },
    },
  })

  /** Start a session and run one turn, both against the same context. */
  const session = async (cwd: string, native: Array<{ path: string; content: string }>, ctx: Record<string, unknown>) => {
    const wired = wireWithBus()
    await wired.start(ctx)
    return await wired.fire(cwd, native, assembledPrompt(native), ctx)
  }

  // Claude: "The first time Claude Code encounters external imports in a project, it
  // shows an approval dialog listing the files."
  it('asks once, listing the external file, and loads it when allowed', async () => {
    const cwd = tempDir()
    const external = homeFile('my-project-instructions.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(cwd, 'CLAUDE.md', 'PROJECT RULES\n@~/.claude/my-project-instructions.md')]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked).toHaveLength(1)
    expect(asked[0][1]).toContain(external)
    expect(prompt).toContain('PERSONAL INSTRUCTIONS')
  })

  // Claude: "If you decline, the imports stay disabled and the dialog doesn't appear again."
  it('keeps a refusal and never asks that project again', async () => {
    const cwd = tempDir()
    homeFile('my-project-instructions.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(cwd, 'CLAUDE.md', '@~/.claude/my-project-instructions.md')]
    const asked: string[][] = []

    const first = await session(
      cwd,
      native,
      ctxWith(cwd, async () => false, asked),
    )
    expect(first).not.toContain('PERSONAL INSTRUCTIONS')

    const second = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked).toHaveLength(1)
    expect(second).not.toContain('PERSONAL INSTRUCTIONS')
  })

  it('remembers an approval and never asks that project again', async () => {
    const cwd = tempDir()
    homeFile('my-project-instructions.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(cwd, 'CLAUDE.md', '@~/.claude/my-project-instructions.md')]
    const asked: string[][] = []

    await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )
    const second = await session(
      cwd,
      native,
      ctxWith(cwd, async () => false, asked),
    )

    expect(asked).toHaveLength(1)
    expect(second).toContain('PERSONAL INSTRUCTIONS')
  })

  it('does not ask when no import reaches outside the project', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'style.md'), 'STYLE BODY')
    const native = [contextFile(cwd, 'CLAUDE.md', 'PROJECT RULES\n@style.md')]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked).toHaveLength(0)
    expect(prompt).toContain('STYLE BODY')
  })

  it('refuses without asking when there is no interface to ask through', async () => {
    // A headless run has no user to answer, and an unanswered question is not consent.
    const cwd = tempDir()
    homeFile('my-project-instructions.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(cwd, 'CLAUDE.md', '@~/.claude/my-project-instructions.md')]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked, false),
    )

    expect(asked).toHaveLength(0)
    expect(prompt).not.toContain('PERSONAL INSTRUCTIONS')
  })

  it('does not widen what a user-scope file may already read', async () => {
    // The user CLAUDE.md loads its own imports either way; approving a repository must
    // not turn it into a reader of the whole filesystem.
    const cwd = tempDir()
    homeFile('my-project-instructions.md', 'PERSONAL INSTRUCTIONS')
    const outside = tempDir()
    writeFileSync(join(outside, 'elsewhere.md'), 'ELSEWHERE BODY')
    writeFileSync(join(hoisted.home, '.claude', 'CLAUDE.md'), `@${join(outside, 'elsewhere.md')}`)
    const native = [contextFile(cwd, 'CLAUDE.md', '@~/.claude/my-project-instructions.md')]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(prompt).toContain('PERSONAL INSTRUCTIONS')
    expect(prompt).not.toContain('ELSEWHERE BODY')
  })

  // The dialog is only worth anything if it names everything the approval lets in.
  // These are the shapes that made it name less than it granted.
  it('lists a target reached through a file inside the project', async () => {
    // The recursion keeps the widened roots, so a repo-controlled file one hop in is a
    // way to reach anything without the dialog ever naming it.
    const cwd = tempDir()
    const listed = homeFile('listed.md', 'LISTED BODY')
    const outside = tempDir()
    const hidden = join(outside, 'hidden.md')
    writeFileSync(hidden, 'HIDDEN BODY')
    writeFileSync(join(cwd, 'notes.md'), `NOTES\n@${hidden}`)
    const native = [contextFile(cwd, 'CLAUDE.md', `@${listed}\n@notes.md`)]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked[0][1]).toContain(hidden)
    expect(prompt).toContain('HIDDEN BODY')
  })

  it('lists a target held by the CLAUDE.md that sits beside an AGENTS.md', async () => {
    // pi loads the AGENTS.md; pi-code adds the CLAUDE.md beside it and widens both.
    const cwd = tempDir()
    const listed = homeFile('listed.md', 'LISTED BODY')
    const hidden = homeFile('hidden.md', 'HIDDEN BODY')
    writeFileSync(join(cwd, 'CLAUDE.md'), `@${hidden}`)
    const native = [contextFile(cwd, 'AGENTS.md', `@${listed}`)]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked[0][1]).toContain(hidden)
    expect(prompt).toContain('HIDDEN BODY')
  })

  it('does not list an import claudeMdExcludes already removes', async () => {
    // It can never load, so asking about it only pads the list.
    const cwd = tempDir()
    const excluded = homeFile('excluded.md', 'EXCLUDED BODY')
    const listed = homeFile('listed.md', 'LISTED BODY')
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/excluded.md'] }))
    const native = [contextFile(cwd, 'CLAUDE.md', `@${excluded}\n@${listed}`)]
    const asked: string[][] = []

    const prompt = await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked[0][1]).toContain(listed)
    expect(asked[0][1]).not.toContain(excluded)
    expect(prompt).not.toContain('EXCLUDED BODY')
  })

  it('does not list an import that is commented out', async () => {
    const cwd = tempDir()
    const listed = homeFile('listed.md', 'LISTED BODY')
    const native = [contextFile(cwd, 'CLAUDE.md', `<!-- @/etc/passwd -->\n@${listed}`)]
    const asked: string[][] = []

    await session(
      cwd,
      native,
      ctxWith(cwd, async () => true, asked),
    )

    expect(asked[0][1]).toContain(listed)
    expect(asked[0][1]).not.toContain('/etc/passwd')
  })

  it('does not ask about a file inside the project reached through a non-canonical cwd', async () => {
    // --resume and the SDK can hand over an unresolved cwd; asking the user to trust
    // the repository over one of its own files is a question that is not real.
    const parent = tempDir()
    const real = join(parent, 'proj')
    mkdirSync(real)
    writeFileSync(join(real, 'notes.md'), 'NOTES BODY')
    const native = [contextFile(real, 'CLAUDE.md', '@notes.md')]
    const link = join(parent, 'link')
    symlinkSync(real, link)
    const asked: string[][] = []

    const prompt = await session(
      link,
      [{ path: join(link, 'CLAUDE.md'), content: native[0].content }],
      ctxWith(link, async () => true, asked),
    )

    expect(asked).toHaveLength(0)
    expect(prompt).toContain('NOTES BODY')
  })

  it('keeps a refusal when the next session starts inside a package of the same checkout', async () => {
    // The decision is keyed on the checkout, not on the nearest package.json, so a
    // repository cannot move its own key by adding a marker one directory down.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    homeFile('personal.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(repo, 'CLAUDE.md', '@~/.claude/personal.md')]
    const pkg = join(repo, 'pkg')
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'package.json'), '{}')
    const asked: string[][] = []

    await session(
      repo,
      native,
      ctxWith(repo, async () => false, asked),
    )
    await session(
      pkg,
      native,
      ctxWith(pkg, async () => true, asked),
    )

    expect(asked).toHaveLength(1)
  })

  it('keeps a refusal when the same checkout is reached through a symlink', async () => {
    const parent = tempDir()
    const repo = join(parent, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    homeFile('personal.md', 'PERSONAL INSTRUCTIONS')
    const native = [contextFile(repo, 'CLAUDE.md', '@~/.claude/personal.md')]
    const link = join(parent, 'link')
    symlinkSync(repo, link)
    const asked: string[][] = []

    await session(
      repo,
      native,
      ctxWith(repo, async () => false, asked),
    )
    await session(
      link,
      [{ path: join(link, 'CLAUDE.md'), content: native[0].content }],
      ctxWith(link, async () => true, asked),
    )

    expect(asked).toHaveLength(1)
  })
})

describe('imports refused for resolving outside the project', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** Trusts the project but declines its external imports, so the refusal path runs.
   * The two dialogs are told apart by title. */
  const decliningExternal = (cwd: string) => ({
    cwd,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { notify: () => {}, confirm: async (title: string) => title !== EXTERNAL_IMPORT_PROMPT_TITLE },
  })

  // Claude shows an approval dialog listing external imports; pi-code refuses them.
  // Refusing silently is the part that misleads: the file looks loaded and its
  // instructions are simply absent, with nothing anywhere saying so.
  it('names the refused file in the prompt instead of dropping it silently', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    const secret = join(outside, 'shared.md')
    writeFileSync(secret, 'SHARED INSTRUCTIONS')
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, `PROJECT RULES\n@${secret}`)
    const native = [{ path: claudeMd, content: `PROJECT RULES\n@${secret}` }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('## Imports not loaded (@)')
    expect(prompt).toContain(`\n- ${secret}`)
    // The body itself never enters context; only the fact that it was refused.
    expect(prompt).not.toContain('SHARED INSTRUCTIONS')
  })

  it('reports a refused import even when nothing else imported', async () => {
    // With no successful import there is no "Imported context" section to hang the
    // notice on, which is exactly the case that used to say nothing at all.
    const cwd = tempDir()
    const outside = tempDir()
    const shared = join(outside, 'only.md')
    writeFileSync(shared, 'SHARED ONLY')
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, `@${shared}`)
    const native = [{ path: claudeMd, content: `@${shared}` }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('## Imports not loaded (@)')
    expect(prompt).toContain(`\n- ${shared}`)
    expect(prompt).not.toContain('SHARED ONLY')
  })

  // The notice must not become a filesystem oracle. A repo-controlled CLAUDE.md can
  // name any absolute path it likes; if only the existing ones came back, that file
  // would enumerate the machine one @line at a time, straight into the model's context.
  it('reports an external target that does not exist exactly like one that does', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    const present = join(outside, 'here.md')
    const absent = join(outside, 'not-here.md')
    writeFileSync(present, 'PRESENT BODY')
    const body = `@${present}\n@${absent}`
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, body)
    const native = [{ path: claudeMd, content: body }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain(`\n- ${present}`)
    expect(prompt).toContain(`\n- ${absent}`)
  })

  it('names the path the importing file wrote, never where a symlink pointed', async () => {
    // Reporting the resolved target would hand a repo the real name of whatever the
    // link reaches, which is the same disclosure the refusal exists to prevent.
    const cwd = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'client-acme-notes.md'), 'SECRET BODY')
    const link = join(cwd, 'link.md')
    symlinkSync(join(outside, 'client-acme-notes.md'), link)
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, '@link.md')
    const native = [{ path: claudeMd, content: '@link.md' }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain(`\n- ${link}`)
    expect(prompt).not.toContain('client-acme-notes.md')
    expect(prompt).not.toContain('SECRET BODY')
  })

  it('does not list a file another context file legitimately imported', async () => {
    // The worktree recipe: the project CLAUDE.md may not reach ~/.claude, but the user
    // CLAUDE.md may, and it imports the same file. Saying it is "not in context" while
    // its body sits above in the same prompt is simply false.
    const cwd = tempDir()
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const shared = join(hoisted.home, '.claude', 'shared.md')
    writeFileSync(shared, 'SHARED BODY')
    writeFileSync(join(hoisted.home, '.claude', 'CLAUDE.md'), '@shared.md')
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, `@${shared}`)
    const native = [{ path: claudeMd, content: `@${shared}` }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('SHARED BODY')
    expect(prompt).not.toContain('## Imports not loaded (@)')
  })

  it('does not name a file claudeMdExcludes already removed', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    const secret = join(outside, 'excluded.md')
    writeFileSync(secret, 'EXCLUDED BODY')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/excluded.md'] }))
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, `@${secret}`)
    const native = [{ path: claudeMd, content: `@${secret}` }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).not.toContain('## Imports not loaded (@)')
  })

  it('says nothing when every import resolved', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'style.md'), 'STYLE BODY')
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, 'PROJECT RULES\n@style.md')
    const native = [{ path: claudeMd, content: 'PROJECT RULES\n@style.md' }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('STYLE BODY')
    expect(prompt).not.toContain('## Imports not loaded (@)')
  })

  it('does not report an import that is merely missing', async () => {
    // A typo is not an escape; only a file that exists and sits outside is refused.
    const cwd = tempDir()
    const claudeMd = join(cwd, 'CLAUDE.md')
    writeFileSync(claudeMd, 'PROJECT RULES\n@nope.md')
    const native = [{ path: claudeMd, content: 'PROJECT RULES\n@nope.md' }]

    const wired = wireWithBus()
    await wired.start(decliningExternal(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).not.toContain('## Imports not loaded (@)')
  })
})

describe('subdirectory context files load on demand', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** Wire the extension with a bus and expose the handlers, so a tool_result can fire. */
  const wireTools = () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const emitted: Array<{ channel: string; data: unknown }> = []
    contextImports({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    } as never)
    return {
      handlers,
      instructionEvents: () => emitted.filter((entry) => entry.channel === INSTRUCTIONS_CHANNEL).map((entry) => entry.data),
    }
  }

  const readResult = (relPath: string) => ({ toolName: 'read', input: { path: relPath }, content: [{ type: 'text', text: 'FILE BODY' }], isError: false })
  const texts = (result: unknown): string[] => ((result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text ?? '')

  const writeAt = (dir: string, name: string, body: string): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, body)
    return file
  }

  // Claude: "Claude also discovers CLAUDE.md and CLAUDE.local.md files in subdirectories
  // under your current working directory. Instead of loading them at launch, they are
  // included when Claude reads files in those subdirectories."
  it('attaches a subdirectory CLAUDE.md when a file there is read, once per session', async () => {
    const cwd = tempDir()
    const file = writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))

    const first = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })
    expect(texts(first).join('\n')).toContain('SRC RULES')
    // The tool's own output survives; the memory is appended after it.
    expect(texts(first)).toContain('FILE BODY')
    expect(wired.instructionEvents()).toContainEqual({ file_path: file, memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: join(cwd, 'src', 'a.ts') })

    const second = await wired.handlers.get('tool_result')?.(readResult(join('src', 'b.ts')), { cwd })
    expect(texts(second).join('\n')).not.toContain('SRC RULES')
  })

  it('attaches every level between the touched file and cwd, deepest last', async () => {
    const cwd = tempDir()
    writeAt(cwd, 'CLAUDE.md', 'ROOT RULES')
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')
    writeAt(join(cwd, 'src', 'api'), 'CLAUDE.md', 'API RULES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'api', 'h.ts')), { cwd })
    const joined = texts(result).join('\n')

    expect(joined).toContain('SRC RULES')
    expect(joined).toContain('API RULES')
    expect(joined.indexOf('SRC RULES')).toBeLessThan(joined.indexOf('API RULES'))
    // cwd's own CLAUDE.md is loaded at launch, never on demand.
    expect(joined).not.toContain('ROOT RULES')
  })

  it('attaches a subdirectory CLAUDE.local.md after the CLAUDE.md beside it', async () => {
    const cwd = tempDir()
    // A nested CLAUDE.local.md needs a recorded approval, not the "nothing here to
    // gate" shortcut, so the project carries Claude-shaped config and a root local
    // file: together they make session_start ask, and the answer is stored.
    writeAt(join(cwd, '.claude'), 'settings.json', '{}')
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'ROOT LOCAL NOTES')
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')
    const local = writeAt(join(cwd, 'src'), 'CLAUDE.local.md', 'SRC LOCAL NOTES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })
    const joined = texts(result).join('\n')

    expect(joined.indexOf('SRC RULES')).toBeLessThan(joined.indexOf('SRC LOCAL NOTES'))
    expect(wired.instructionEvents()).toContainEqual({ file_path: local, memory_type: 'Local', load_reason: 'nested_traversal', trigger_file_path: join(cwd, 'src', 'a.ts') })
  })

  it('resolves the subdirectory file own @imports', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES\n@style.md')
    writeAt(join(cwd, 'src'), 'style.md', 'SRC STYLE BODY')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).toContain('SRC STYLE BODY')
  })

  it('still attaches when the session was started through a symlinked path', async () => {
    // A symlinked checkout reports real paths from the file tools while cwd is the
    // link; comparing the two unresolved turns the whole feature off silently.
    const real = tempDir()
    writeAt(join(real, 'src'), 'CLAUDE.md', 'SRC RULES')
    const linkParent = tempDir()
    const cwd = join(linkParent, 'project')
    symlinkSync(real, cwd)

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).toContain('SRC RULES')
  })

  it('attaches through a symlinked directory that stays inside the project', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')
    symlinkSync(join(cwd, 'src'), join(cwd, 'alias'))

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('alias', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).toContain('SRC RULES')
  })

  it('attaches nothing for a file outside the working directory', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    writeAt(outside, 'CLAUDE.md', 'OUTSIDE RULES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join(outside, 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('OUTSIDE RULES')
  })

  // A repo commits what it likes, symlinks included. The launch-time import path
  // realpaths and confines for exactly this reason; the on-demand path must too.
  it('does not attach a context file that is a symlink out of the project', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    symlinkSync(join(outside, 'id_rsa'), join(cwd, 'src', 'CLAUDE.md'))

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('PRIVATE KEY MATERIAL')
  })

  it('does not follow a symlinked subdirectory out of the project', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    writeAt(outside, 'CLAUDE.md', 'OUTSIDE TREE RULES')
    symlinkSync(outside, join(cwd, 'vendor'))

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('vendor', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('OUTSIDE TREE RULES')
  })

  it('caps what one tool result can carry, like every other tool output', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'HEAD RULES\n'.padEnd(300_000, 'x'))

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).toContain('HEAD RULES')
    expect(texts(result).join('\n').length).toBeLessThan(120_000)
  })

  it('does not re-attach a file already in the system prompt', async () => {
    // The repo-root CLAUDE.md is loaded at launch; a nested file importing it would
    // otherwise pay for the whole body a second time on every subtree read.
    const cwd = tempDir()
    const root = writeAt(cwd, 'CLAUDE.md', 'ROOT RULES')
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES\n@../CLAUDE.md')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    await wired.handlers.get('before_agent_start')?.({ systemPrompt: assembledPrompt([{ path: root, content: 'ROOT RULES' }]), systemPromptOptions: { cwd, contextFiles: [{ path: root, content: 'ROOT RULES' }] } }, {})
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).toContain('SRC RULES')
    expect(texts(result).join('\n')).not.toContain('ROOT RULES')
  })

  it('withholds a nested CLAUDE.local.md the approval walk never sees', async () => {
    // hasClaudeShapedConfig only looks for CLAUDE.local.md at or above cwd, so a repo
    // whose only Claude artifact is one in a subdirectory reads as nothing to gate.
    // That must not be the way in for the one file class approval exists to withhold.
    const cwd = tempDir()
    writeFileSync(join(cwd, 'package.json'), '{}')
    writeAt(join(cwd, 'src'), 'CLAUDE.local.md', 'UNTRUSTED LOCAL NOTES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => true, hasUI: false, ui: { notify: () => {} } })
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('UNTRUSTED LOCAL NOTES')
  })

  it('attaches for the file_path spelling of the tool input as well as path', async () => {
    // pi's edit and write tools accept file_path as an alias; a model that uses it
    // would otherwise get a successful edit and no memory.
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.({ toolName: 'edit', input: { file_path: join('src', 'a.ts') }, content: [{ type: 'text', text: 'FILE BODY' }], isError: false }, { cwd })

    expect(texts(result).join('\n')).toContain('SRC RULES')
  })

  it('does not load a below-cwd file external import even in an approved project', async () => {
    // The dialog names what it asks about, and it is asked at the start of a turn from
    // what the launch-time expansion refused. A file below cwd is reached mid-turn,
    // where nothing can be listed and nothing can be asked, so its external imports
    // stay refused and are reported rather than riding in on an answer to a different
    // question.
    const cwd = tempDir()
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const approved = join(hoisted.home, '.claude', 'approved.md')
    const unlisted = join(hoisted.home, '.claude', 'unlisted.md')
    writeFileSync(approved, 'APPROVED EXTERNAL BODY')
    writeFileSync(unlisted, 'UNLISTED EXTERNAL BODY')
    writeFileSync(join(cwd, 'CLAUDE.md'), `@${approved}`)
    writeAt(join(cwd, 'src'), 'CLAUDE.md', `SRC RULES\n@${unlisted}`)

    const wired = wireTools()
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } }
    await wired.handlers.get('session_start')?.({}, ctx)
    const native = [{ path: join(cwd, 'CLAUDE.md'), content: `@${approved}` }]
    const prompt = (await wired.handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles: native } }, ctx)) as { systemPrompt: string }
    // The dialog named the root file's import, and that one loaded.
    expect(prompt.systemPrompt).toContain('APPROVED EXTERNAL BODY')

    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })
    const joined = texts(result).join('\n')

    expect(joined).toContain('SRC RULES')
    expect(joined).not.toContain('UNLISTED EXTERNAL BODY')
    expect(joined).toContain('## Imports not loaded (@)')
    expect(joined).toContain(unlisted)
  })

  it('says which of a nested file imports it would not load', async () => {
    const cwd = tempDir()
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    const external = join(hoisted.home, '.claude', 'shared.md')
    writeFileSync(external, 'SHARED EXTERNAL BODY')
    writeFileSync(join(cwd, 'CLAUDE.md'), `@${external}`)
    writeAt(join(cwd, 'src'), 'CLAUDE.md', `SRC RULES\n@${external}`)

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async (title: string) => title !== EXTERNAL_IMPORT_PROMPT_TITLE } })
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })
    const joined = texts(result).join('\n')

    expect(joined).not.toContain('SHARED EXTERNAL BODY')
    expect(joined).toContain('## Imports not loaded (@)')
    expect(joined).toContain(external)
  })

  it('attaches nothing when the project is not approved', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'UNTRUSTED SRC RULES')
    // Claude-shaped config with no recorded decision: repo-controlled text stays out.
    writeAt(join(cwd, '.claude'), 'settings.json', '{}')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => true, hasUI: false, ui: { notify: () => {} } })
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('UNTRUSTED SRC RULES')
  })

  it('honors claudeMdExcludes for a subdirectory file', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'EXCLUDED SRC RULES')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/src/CLAUDE.md'] }))

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))
    const result = await wired.handlers.get('tool_result')?.(readResult(join('src', 'a.ts')), { cwd })

    expect(texts(result).join('\n')).not.toContain('EXCLUDED SRC RULES')
  })

  it('attaches nothing on a failed tool call or a non-file tool', async () => {
    const cwd = tempDir()
    writeAt(join(cwd, 'src'), 'CLAUDE.md', 'SRC RULES')

    const wired = wireTools()
    await wired.handlers.get('session_start')?.({}, approvingCtx(cwd))

    const failed = await wired.handlers.get('tool_result')?.({ ...readResult(join('src', 'a.ts')), isError: true }, { cwd })
    expect(texts(failed).join('\n')).not.toContain('SRC RULES')
    const other = await wired.handlers.get('tool_result')?.({ ...readResult(join('src', 'a.ts')), toolName: 'bash' }, { cwd })
    expect(texts(other).join('\n')).not.toContain('SRC RULES')
  })
})

describe('CLAUDE.md beside an AGENTS.md pi loaded instead', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  // Claude Code reads CLAUDE.md and never AGENTS.md, and its documented recipe for a
  // repository that already has an AGENTS.md is a CLAUDE.md that imports it plus
  // Claude-specific instructions below. pi picks one context file per directory and
  // prefers AGENTS.md, so that exact layout loses the Claude-specific half.
  it('loads the sibling CLAUDE.md that pi passed over', async () => {
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    const claude = join(cwd, 'CLAUDE.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(claude, '@AGENTS.md\n\n## Claude Code\n\nUse plan mode under src/billing/.')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('Use plan mode under src/billing/.')
    expect(wired.instructionEvents()).toContainEqual({ file_path: claude, memory_type: 'Project', load_reason: 'session_start' })
  })

  it('does not repeat the AGENTS.md body that the sibling CLAUDE.md imports', async () => {
    // The documented recipe opens with @AGENTS.md, and pi already injected that file.
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(join(cwd, 'CLAUDE.md'), '@AGENTS.md\n\nCLAUDE EXTRA')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('CLAUDE EXTRA')
    expect(prompt.split('SHARED AGENT RULES').length - 1).toBe(1)
  })

  it('resolves the sibling CLAUDE.md own imports', async () => {
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'CLAUDE HEAD\n@style.md')
    writeFileSync(join(cwd, 'style.md'), 'CLAUDE STYLE BODY')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).toContain('CLAUDE STYLE BODY')
  })

  it('leaves a repository that has no AGENTS.md alone', async () => {
    // pi loads CLAUDE.md itself here; a second block would duplicate it.
    const cwd = tempDir()
    const claude = join(cwd, 'CLAUDE.md')
    writeFileSync(claude, 'ONLY CLAUDE RULES')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const native = [{ path: claude, content: 'ONLY CLAUDE RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt.split('ONLY CLAUDE RULES').length - 1).toBe(1)
  })

  it('does not add a CLAUDE.md pi already loaded itself', async () => {
    // Whatever pi's per-directory precedence does today, a file already in the prompt
    // must never come back as a second block.
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    const claude = join(cwd, 'CLAUDE.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(claude, 'ALREADY LOADED RULES')
    const native = [
      { path: agents, content: 'SHARED AGENT RULES' },
      { path: claude, content: 'ALREADY LOADED RULES' },
    ]

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt.match(/ALREADY LOADED RULES/g)).toHaveLength(1)
  })

  it('does not also import the sibling CLAUDE.md that another context file references', async () => {
    // The sibling gets its own block, so an @CLAUDE.md elsewhere must resolve to
    // nothing rather than repeat the body under Imported context.
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES\n@CLAUDE.md')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'SIBLING BODY')
    const native = [{ path: agents, content: 'SHARED AGENT RULES\n@CLAUDE.md' }]

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt.match(/SIBLING BODY/g)).toHaveLength(1)
  })

  it('does not emit a second block when the sibling is also the .claude/CLAUDE.md', async () => {
    // Running inside a .claude directory that holds both files: the sibling search and
    // the ./.claude/CLAUDE.md alternate resolve to the same file.
    const repo = tempDir()
    // A root marker, so the ./.claude/CLAUDE.md search walks up out of cwd and the
    // approval flow records a decision.
    mkdirSync(join(repo, '.git'))
    const cwd = join(repo, '.claude')
    mkdirSync(cwd, { recursive: true })
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'DOUBLE BLOCK RULES')
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt.match(/DOUBLE BLOCK RULES/g)).toHaveLength(1)
  })

  it('does not load the sibling CLAUDE.md when the project is not approved', async () => {
    // It is repo-controlled text, gated like every other project-scope file.
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'UNTRUSTED CLAUDE RULES')

    const wired = wireWithBus()
    await wired.start({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).not.toContain('UNTRUSTED CLAUDE RULES')
  })

  it('honors claudeMdExcludes for the sibling CLAUDE.md', async () => {
    const cwd = tempDir()
    const agents = join(cwd, 'AGENTS.md')
    writeFileSync(agents, 'SHARED AGENT RULES')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'EXCLUDED CLAUDE RULES')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/CLAUDE.md'] }))

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const native = [{ path: agents, content: 'SHARED AGENT RULES' }]
    const prompt = await wired.fire(cwd, native, assembledPrompt(native))

    expect(prompt).not.toContain('EXCLUDED CLAUDE RULES')
  })
})

describe('project CLAUDE.md alternate location (./.claude/CLAUDE.md)', () => {
  let savedAgentDir: string | undefined
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'ci-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** Write ./.claude/CLAUDE.md under `dir` and return its path. */
  const writeDotClaudeMd = (dir: string, content: string): string => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const file = join(dir, '.claude', 'CLAUDE.md')
    writeFileSync(file, content)
    return file
  }

  const declining = (cwd: string) => ({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })

  it('loads the nearest ./.claude/CLAUDE.md as a Project block when the project is approved', async () => {
    const cwd = tempDir()
    const file = writeDotClaudeMd(cwd, 'DOT CLAUDE RULES')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain(instructionsBlock(file, 'DOT CLAUDE RULES'))
    expect(wired.instructionEvents()).toContainEqual({ file_path: file, memory_type: 'Project', load_reason: 'session_start' })
  })

  it('does not load ./.claude/CLAUDE.md when the project is not approved', async () => {
    // A cloned repo can ship .claude/CLAUDE.md; without approval it must not reach the prompt.
    const cwd = tempDir()
    writeDotClaudeMd(cwd, 'DOT CLAUDE RULES')

    const wired = wireWithBus()
    await wired.start(declining(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).not.toContain('DOT CLAUDE RULES')
  })

  it('finds ./.claude/CLAUDE.md at the repository root from a subdirectory session, imports included', async () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const file = writeDotClaudeMd(repo, 'ROOT DOT RULES\n@style.md')
    writeFileSync(join(repo, '.claude', 'style.md'), 'DOT STYLE CONTENT')
    const sub = join(repo, 'src')
    mkdirSync(sub)

    const wired = wireWithBus()
    await wired.start(approvingCtx(sub))
    const prompt = await wired.fire(sub)

    expect(prompt).toContain('ROOT DOT RULES')
    expect(prompt).toContain('DOT STYLE CONTENT')
    expect(wired.instructionEvents()).toContainEqual({ file_path: file, memory_type: 'Project', load_reason: 'session_start' })
  })

  it('resolves @imports of ./.claude/CLAUDE.md against project roots', async () => {
    // The importer sits in .claude; @../notes.md climbs to the project root, which
    // the project-scope roots (cwd, repo root) allow.
    const cwd = tempDir()
    writeDotClaudeMd(cwd, 'DOT RULES\n@../notes.md')
    writeFileSync(join(cwd, 'notes.md'), 'PROJECT NOTES CONTENT')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain('PROJECT NOTES CONTENT')
  })

  it('dedupes against a native context file: no double block if pi already loaded it', async () => {
    const cwd = tempDir()
    const file = writeDotClaudeMd(cwd, 'DOT CLAUDE RULES')
    const native = { path: file, content: 'DOT CLAUDE RULES' }

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd, [native], assembledPrompt([native]))

    expect(prompt.match(/DOT CLAUDE RULES/g)).toHaveLength(1)
  })

  it('excludes ./.claude/CLAUDE.md when claudeMdExcludes matches, imports and all', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/.claude/CLAUDE.md'] }))
    const cwd = tempDir()
    writeDotClaudeMd(cwd, 'DOT CLAUDE RULES\n@notes.md')
    writeFileSync(join(cwd, 'notes.md'), 'PROJECT NOTES CONTENT')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).not.toContain('DOT CLAUDE RULES')
    expect(prompt).not.toContain('PROJECT NOTES CONTENT')
    expect(wired.instructionEvents()).toEqual([])
  })

  it('strips block comments from ./.claude/CLAUDE.md', async () => {
    const cwd = tempDir()
    writeDotClaudeMd(cwd, 'DOT KEEP\n<!-- dot secret -->\nDOT TAIL')

    const wired = wireWithBus()
    await wired.start(approvingCtx(cwd))
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain('DOT KEEP')
    expect(prompt).toContain('DOT TAIL')
    expect(prompt).not.toContain('dot secret')
  })
})

describe('managed CLAUDE.md file', () => {
  /** Write the managed CLAUDE.md file (alongside managed-settings.json) and return its path. */
  const writeManagedFile = (content: string): string => {
    const file = managedClaudeMdPath()
    writeFileSync(file, content)
    return file
  }

  const writeManagedSettings = (settings: Record<string, unknown>): void => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify(settings))
  }

  const writeUserSettings = (settings: Record<string, unknown>): void => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify(settings))
  }

  it('loads the managed CLAUDE.md file as a Managed block, announced at session_start', async () => {
    const file = writeManagedFile('ORG FILE POLICY')
    const cwd = tempDir()

    const wired = wireWithBus()
    const prompt = await wired.fire(cwd)

    expect(prompt).toContain(instructionsBlock(file, 'ORG FILE POLICY'))
    expect(wired.instructionEvents()).toEqual([{ file_path: file, memory_type: 'Managed', load_reason: 'session_start' }])

    // before_agent_start fires every turn; the Managed announce must not repeat.
    await wired.fire(cwd)
    expect(wired.instructionEvents()).toHaveLength(1)
  })

  it('loads the managed file before user and project context', async () => {
    const file = writeManagedFile('ORG FILE POLICY')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'CLAUDE.md'), 'USER RULES')
    const cwd = tempDir()
    const native = { path: join(cwd, 'CLAUDE.md'), content: 'PROJECT NATIVE RULES' }

    const wired = wireWithBus()
    await wired.start({ cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })
    const prompt = await wired.fire(cwd, [native], assembledPrompt([native]))

    expect(prompt).toContain(instructionsBlock(file, 'ORG FILE POLICY'))
    expect(prompt.indexOf('ORG FILE POLICY')).toBeLessThan(prompt.indexOf('USER RULES'))
    expect(prompt.indexOf('USER RULES')).toBeLessThan(prompt.indexOf('PROJECT NATIVE RULES'))
  })

  it('merges the managed file before the managed settings-key when both exist', async () => {
    // File content first, then the settings-key content, both managed policy.
    const file = writeManagedFile('ORG FILE POLICY')
    writeManagedSettings({ claudeMd: 'ORG KEY POLICY' })
    const cwd = tempDir()

    const prompt = await wireWithBus().fire(cwd)

    expect(prompt).toContain(instructionsBlock(file, 'ORG FILE POLICY'))
    expect(prompt).toContain(instructionsBlock(MANAGED_CLAUDE_MD_PATH, 'ORG KEY POLICY'))
    expect(prompt.indexOf('ORG FILE POLICY')).toBeLessThan(prompt.indexOf('ORG KEY POLICY'))
  })

  it('never excludes the managed file, even with a catch-all claudeMdExcludes', async () => {
    writeManagedFile('ORG FILE POLICY')
    writeUserSettings({ claudeMdExcludes: ['**'] })
    const cwd = tempDir()
    const native = { path: join(cwd, 'CLAUDE.md'), content: 'PROJECT RULES' }

    const prompt = await wireWithBus().fire(cwd, [native], assembledPrompt([native]))

    expect(prompt).toContain('ORG FILE POLICY')
    expect(prompt).not.toContain('PROJECT RULES')
  })

  it('strips block comments from the managed file body', async () => {
    writeManagedFile('ORG KEEP\n<!-- managed note -->\nORG TAIL')
    const cwd = tempDir()

    const prompt = await wireWithBus().fire(cwd)

    expect(prompt).toContain('ORG KEEP')
    expect(prompt).toContain('ORG TAIL')
    expect(prompt).not.toContain('managed note')
  })

  it('does nothing when there is no managed file and no managed key', async () => {
    expect(await wireWithBus().fire(tempDir())).toBe('BASE')
  })
})

describe('context file size limit', () => {
  it('skips a CLAUDE.local.md larger than 4 MiB instead of loading it', async () => {
    // Claude: "Claude Code loads a CLAUDE.md file of up to 4 MiB in full and
    // skips a larger file."
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), `HUGE START\n${'x'.repeat(4 * 1024 * 1024)}`)

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    contextImports({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    await handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => true, hasUI: true, ui: { notify: () => {}, confirm: async () => true } })
    const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd, contextFiles: [] } }, {})) as { systemPrompt: string } | undefined

    expect(result?.systemPrompt ?? 'BASE').not.toContain('HUGE START')
  })
})

describe('managed-settings.d drop-ins', () => {
  it('merges managed-settings.d/*.json after the base file, alphabetically, with the documented rules', async () => {
    // Claude merges managed-settings.json first, then every *.json in the
    // directory alphabetically: single values replace, lists union with
    // duplicates removed, nested blocks merge key by key; hidden files and
    // non-json files are ignored.
    const dir = tempDir()
    const file = join(dir, 'managed-settings.json')
    writeFileSync(file, JSON.stringify({ model: 'sonnet', permissions: { deny: ['Bash(rm *)'] }, env: { A: '1' } }))
    mkdirSync(join(dir, 'managed-settings.d'))
    writeFileSync(join(dir, 'managed-settings.d', '20-later.json'), JSON.stringify({ model: 'haiku', env: { C: '3' } }))
    writeFileSync(join(dir, 'managed-settings.d', '10-early.json'), JSON.stringify({ model: 'opus', permissions: { deny: ['Bash(rm *)', 'WebFetch'] }, env: { B: '2' } }))
    writeFileSync(join(dir, 'managed-settings.d', '.hidden.json'), JSON.stringify({ model: 'ignored' }))
    writeFileSync(join(dir, 'managed-settings.d', 'notes.txt'), 'not json')

    const merged = readManagedSettings(file)
    expect(merged.model).toBe('haiku')
    expect((merged.permissions as { deny: string[] }).deny).toEqual(['Bash(rm *)', 'WebFetch'])
    expect(merged.env).toEqual({ A: '1', B: '2', C: '3' })
  })
})
