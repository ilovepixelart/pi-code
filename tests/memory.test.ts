import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// homedir cannot be spied on an ESM namespace, so the module is mocked instead.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

import { capIndexForPrompt, INDEX_MAX_BYTES, INDEX_MAX_LINES, memoryDir, migrateLegacyStore, projectSlug, removeIndexLine, slugifyName, upsertIndexLine } from '../extensions/memory.ts'

describe('memory helpers', () => {
  it('slugs project paths into directory names', () => {
    // Readable dashed path plus a short digest that keeps distinct paths distinct.
    expect(projectSlug('/Users/alex/Documents/pi-code')).toMatch(/^-Users-alex-Documents-pi-code-[0-9a-f]{8}$/)
    expect(projectSlug('C:\\Users\\alex\\Documents\\pi-code')).toMatch(/^C-Users-alex-Documents-pi-code-[0-9a-f]{8}$/)
    expect(memoryDir('/tmp/x')).toContain(path.join('.pi', 'agent', 'memory', projectSlug('/tmp/x')))
  })

  it('distinguishes paths that collapse to the same dashed slug', () => {
    // Every separator becomes a dash, so /a/b, /a-b and \\a\\b used to share one store.
    const slashed = projectSlug('/a/b')
    expect(slashed).not.toBe(projectSlug('/a-b'))
    expect(projectSlug('/a/b')).toBe(slashed)
  })

  it('treats a windows drive letter case-insensitively', () => {
    // C: and c: name the same location on Windows; two stores would split the index.
    expect(projectSlug('C:\\Users\\alex\\code')).toBe(projectSlug('c:\\Users\\alex\\code'))
  })

  it('caps the injected index by lines and bytes, reporting what was dropped', () => {
    const small = '# Memory index\n- [a](a.md): first\n'
    expect(capIndexForPrompt(small)).toBe(small)

    const many = ['# Memory index', ...Array.from({ length: INDEX_MAX_LINES + 20 }, (_, i) => `- [m${i}](m${i}.md): entry ${i}`)].join('\n')
    const cappedLines = capIndexForPrompt(many)
    expect(cappedLines.split('\n').length).toBeLessThanOrEqual(INDEX_MAX_LINES + 2)
    expect(cappedLines).toContain('memories not shown')

    const fat = `# Memory index\n- [big](big.md): ${'x'.repeat(INDEX_MAX_BYTES * 2)}`
    expect(Buffer.byteLength(capIndexForPrompt(fat), 'utf-8')).toBeLessThanOrEqual(INDEX_MAX_BYTES + 200)
  })

  it('slugifies memory names', () => {
    expect(slugifyName('User prefers TABS!')).toBe('user-prefers-tabs')
    expect(slugifyName('///')).toBe('memory')
  })

  it('upserts index lines and creates a header', () => {
    const first = upsertIndexLine('', 'no-dashes', 'never use em dashes')
    expect(first).toContain('# Memory index')
    expect(first).toContain('- [no-dashes](no-dashes.md): never use em dashes')

    const replaced = upsertIndexLine(first, 'no-dashes', 'updated description')
    expect(replaced).toContain('updated description')
    expect(replaced.match(/no-dashes\.md/g)).toHaveLength(1)
  })

  it('removes index lines and empties the index when last one goes', () => {
    const index = upsertIndexLine(upsertIndexLine('', 'a', 'first'), 'b', 'second')
    const removed = removeIndexLine(index, 'a')
    expect(removed).not.toContain('](a.md)')
    expect(removed).toContain('](b.md)')
    const emptied = removeIndexLine(removeIndexLine(index, 'a'), 'b')
    expect(emptied).toBe('# Memory index\n')
  })

  it('saving a memory does not delete an entry that merely mentions it', () => {
    const index = '# Memory index\n- [notes](notes.md): see [build](build.md): for context\n- [build](build.md): old steps\n'
    const updated = upsertIndexLine(index, 'build', 'new steps')
    expect(updated).toContain('- [notes](notes.md):')
    expect(updated).toContain('- [build](build.md): new steps')
    expect(updated.split('\n').filter((l) => l.startsWith('- [build](build.md)'))).toHaveLength(1)
  })

  it('removing a memory keeps an entry that merely mentions it', () => {
    const index = '# Memory index\n- [notes](notes.md): see [build](build.md): for context\n- [build](build.md): steps\n'
    const remaining = removeIndexLine(index, 'build')
    expect(remaining).toContain('- [notes](notes.md):')
    expect(remaining).not.toContain('- [build](build.md)')
  })

  it('flattens a multi-line description into one index line', () => {
    // A newline in the description would break every later line-based match.
    expect(upsertIndexLine('', 'a', 'line one\nline two')).toBe('# Memory index\n- [a](a.md): line one line two\n')
  })
})

describe('migrateLegacyStore', () => {
  it('renames a pre-digest store to the current slug, once, without clobbering', () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    hoisted.home = home
    const cwd = '/proj/app'
    const legacy = join(home, '.pi', 'agent', 'memory', '-proj-app')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'MEMORY.md'), '- [a](a.md): kept\n')

    migrateLegacyStore(cwd)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(memoryDir(cwd), 'MEMORY.md'), 'utf-8')).toContain('kept')

    // A second run with a fresh legacy dir must not overwrite the migrated store.
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'MEMORY.md'), '- [b](b.md): newer\n')
    migrateLegacyStore(cwd)
    expect(readFileSync(join(memoryDir(cwd), 'MEMORY.md'), 'utf-8')).toContain('kept')
    rmSync(home, { recursive: true, force: true })
    hoisted.home = ''
  })
})
