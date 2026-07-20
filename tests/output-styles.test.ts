import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import outputStyles, { loadStyles, parseStyle, readActiveStyleName, styleDirs, styleForName } from '../extensions/output-styles.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'os-'))

describe('parseStyle', () => {
  it('reads name and description from frontmatter and trims the body', () => {
    const md = '---\nname: Explanatory\ndescription: Teach while you work\n---\nExplain your reasoning.\n'
    expect(parseStyle(md, 'fallback')).toEqual({ name: 'Explanatory', description: 'Teach while you work', body: 'Explain your reasoning.' })
  })

  it('falls back to the filename when name is absent and keeps the whole body', () => {
    expect(parseStyle('Just a persona.', 'concise')).toEqual({ name: 'concise', description: '', body: 'Just a persona.' })
  })

  it('parses CRLF frontmatter (Windows-authored files)', () => {
    const md = '---\r\nname: Terse\r\ndescription: Few words\r\n---\r\nBe terse.\r\n'
    expect(parseStyle(md, 'fallback')).toEqual({ name: 'Terse', description: 'Few words', body: 'Be terse.' })
  })
})

describe('styleDirs', () => {
  it('returns the project output-styles directory only when trusted', () => {
    const cwd = tempDir()
    const home = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    expect(styleDirs(cwd, home, true)).toEqual([join(cwd, '.claude', 'output-styles')])
    expect(styleDirs(cwd, home, false)).toEqual([])
  })
})

describe('loadStyles', () => {
  it('loads styles and lets a project style override a user style of the same name', () => {
    const userDir = tempDir()
    const projectDir = tempDir()
    writeFileSync(join(userDir, 'a.md'), '---\nname: shared\n---\nUSER')
    writeFileSync(join(projectDir, 'a.md'), '---\nname: shared\n---\nPROJECT')
    writeFileSync(join(projectDir, 'b.md'), '---\nname: extra\n---\nOTHER')

    const styles = loadStyles([userDir, projectDir])
    expect(styles.find((s) => s.name === 'shared')?.body).toBe('PROJECT')
    expect(styles.map((s) => s.name).sort()).toEqual(['extra', 'shared'])
  })
})

describe('readActiveStyleName', () => {
  it('returns the outputStyle from the last file that sets it', () => {
    const dir = tempDir()
    const user = join(dir, 'user.json')
    const local = join(dir, 'local.json')
    writeFileSync(user, JSON.stringify({ outputStyle: 'Explanatory' }))
    writeFileSync(local, JSON.stringify({ outputStyle: 'Concise' }))
    expect(readActiveStyleName([user, join(dir, 'absent.json'), local])).toBe('Concise')
  })

  it('returns undefined when no file sets outputStyle', () => {
    const dir = tempDir()
    const file = join(dir, 's.json')
    writeFileSync(file, JSON.stringify({ other: true }))
    expect(readActiveStyleName([file])).toBeUndefined()
  })
})

describe('styleForName', () => {
  const styles = [
    { name: 'a', description: '', body: 'A' },
    { name: 'b', description: '', body: 'B' },
  ]

  it('finds the matching style, or nothing for an unknown/undefined name', () => {
    expect(styleForName(styles, 'b')?.body).toBe('B')
    expect(styleForName(styles, 'z')).toBeUndefined()
    expect(styleForName(styles, undefined)).toBeUndefined()
  })
})

describe('extension wiring', () => {
  it('appends the active style body and the command persists a new choice', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'output-styles', 'explain.md'), '---\nname: Explain\n---\nExplain everything.')
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: 'Explain' }))

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const notes: string[] = []
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
    } as never)

    const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: (m: string) => notes.push(m), select: async () => 'Explain' } }
    await handlers.get('session_start')?.({}, ctx)
    const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(result.systemPrompt).toContain('## Output Style: Explain')
    expect(result.systemPrompt).toContain('Explain everything.')

    await commands.get('output-style')?.handler('', ctx)
    const saved = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'))
    expect(saved.outputStyle).toBe('Explain')
  })

  it('does not load a project style when the project is untrusted', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'output-styles', 'evil.md'), '---\nname: Evil\n---\nInjected instructions.')
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: 'Evil' }))

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    outputStyles({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn), registerCommand: () => {} } as never)

    const ctx = { cwd, hasUI: true, isProjectTrusted: () => false, ui: { notify: () => {} } }
    await handlers.get('session_start')?.({}, ctx)
    const result = await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})
    expect(result).toBeUndefined()
  })
})
