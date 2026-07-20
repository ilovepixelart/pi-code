import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import contextImports, { collectImports, expandHome, rootsForImporter } from '../extensions/context-imports.ts'

/** Roots granted to `file`, then the imports it actually pulls in. */
const importsFor = (file: string, home: string, cwd: string, content?: string) => {
  const roots = rootsForImporter(file, home, cwd)
  const body = content ?? readFileSync(file, 'utf-8')
  return collectImports(body, dirname(file), home, roots, new Set())
}

// realpath so allowed-root prefix checks hold on macOS (/tmp -> /private/tmp)
const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'ci-')))

describe('expandHome', () => {
  it('expands ~ and ~/ but leaves other paths alone', () => {
    expect(expandHome('~', '/home/x')).toBe('/home/x')
    expect(expandHome('~/a.md', '/home/x')).toBe('/home/x/a.md')
    expect(expandHome('rel.md', '/home/x')).toBe('rel.md')
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

  it('skips an import that resolves to a directory instead of crashing', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'sub'))
    expect(collectImports('@sub', dir, dir, [dir], new Set())).toEqual([])
  })

  it('is cycle-safe', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.md'), '@b.md')
    writeFileSync(join(dir, 'b.md'), '@a.md')
    expect(collectImports('@a.md', dir, dir, [dir], new Set()).map((f) => f.body)).toEqual(['@b.md', '@a.md'])
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
