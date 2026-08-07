import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { commandNameFor, discoverCommandFiles, expandDynamicContent, parseCommandFile, substituteArgs } from '../extensions/internal/command-file.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseCommandFile', () => {
  it('reads the frontmatter Claude documents and keeps the body', () => {
    const md = ['---', 'description: Ship it', 'argument-hint: [pr]', 'allowed-tools: Bash, Read, Glob', 'model: sonnet', 'disable-model-invocation: true', '---', 'Do the thing with $1.'].join('\n')
    expect(parseCommandFile(md)).toEqual({
      description: 'Ship it',
      argumentHint: '[pr]',
      allowedTools: ['bash', 'read', 'find'],
      model: 'sonnet',
      disableModelInvocation: true,
      body: 'Do the thing with $1.',
    })
  })

  it('grants the base tool for an argument-scoped Claude permission', () => {
    // Claude scopes a grant to arguments; pi's active-tool list has no argument
    // dimension. Keeping the scope in the name matched no pi tool, so this command
    // used to run with no bash at all despite asking for it twice.
    const md = ['---', 'allowed-tools: Bash(git add:*), Bash(git status:*), Read', '---', 'Stage the change.'].join('\n')

    expect(parseCommandFile(md).allowedTools).toEqual(['bash', 'read'])
  })

  it.each([
    ['a flow sequence', 'allowed-tools: [Bash, Read]'],
    ['an indented block list', 'allowed-tools:\n  - Bash\n  - Read'],
    ['an unindented block list', 'allowed-tools:\n- Bash\n- Read'],
    ['quoted items around a blank line', 'allowed-tools:\n  - "Bash"\n\n  - Read'],
  ])('reads %s, which YAML allows and Claude files use', (_label, field) => {
    // A shape the parser misreads yields no names, and a restriction that reads as
    // empty is not applied at all: mangling a valid grant runs the turn wide open.
    expect(parseCommandFile(`---\n${field}\n---\nBody.`).allowedTools).toEqual(['bash', 'read'])
  })

  it('keeps an explicitly empty grant distinct from an absent one', () => {
    // `[]` says no tools and must stay a restriction; no key at all is no restriction.
    expect(parseCommandFile('---\nallowed-tools: []\n---\nBody.').allowedTools).toEqual([])
    expect(parseCommandFile('---\nmodel: sonnet\n---\nBody.').allowedTools).toBeUndefined()
  })

  it('reads a multi-line description rather than falling back to the body', () => {
    const md = ['---', 'description:', '  A long description', 'model: sonnet', '---', 'Body line.'].join('\n')

    expect(parseCommandFile(md).description).toBe('A long description')
    expect(parseCommandFile(md).model).toBe('sonnet')
  })

  it('maps the Claude names of the tools this package registers', () => {
    // Without these, an ordinary research command matched no pi tool and its turn was
    // intersected down to nothing.
    const md = ['---', 'allowed-tools: WebFetch, WebSearch, TodoWrite, Task', '---', 'Research it.'].join('\n')

    expect(parseCommandFile(md).allowedTools).toEqual(['web_fetch', 'web_search', 'todo', 'subagent'])
  })

  it('keeps a comma inside an argument scope out of the entry split', () => {
    // Splitting on every comma made the fragments top-level entries, so a command
    // naming only Bash came away with pi's edit tool active for the turn.
    const md = ['---', 'allowed-tools: Bash(cat, edit, tail)', '---', 'Show it.'].join('\n')

    expect(parseCommandFile(md).allowedTools).toEqual(['bash'])
  })

  it('reads a YAML block list, which Claude command files also use', () => {
    const md = ['---', 'allowed-tools:', '  - Bash(git add:*)', '  - Read', '---', 'Stage it.'].join('\n')

    expect(parseCommandFile(md).allowedTools).toEqual(['bash', 'read'])
  })

  it('leaves a command with only scoped grants able to run', () => {
    const md = ['---', 'allowed-tools: Bash(git commit:*)', '---', 'Commit.'].join('\n')

    // Not [] — an empty grant intersects the active tools to nothing and the turn
    // gets no tools whatsoever.
    expect(parseCommandFile(md).allowedTools).toEqual(['bash'])
  })

  it('falls back to the first body line as description and defaults the rest', () => {
    const parsed = parseCommandFile('Summarize the diff.\nMore detail.')
    expect(parsed.description).toBe('Summarize the diff.')
    expect(parsed.allowedTools).toBeUndefined()
    expect(parsed.disableModelInvocation).toBe(false)
  })
})

describe('substituteArgs', () => {
  it('fills $ARGUMENTS, $@ and positionals, with defaults for missing ones', () => {
    expect(substituteArgs('all: $ARGUMENTS', 'a b c')).toBe('all: a b c')
    expect(substituteArgs('first: $1, second: $2', 'a b')).toBe('first: a, second: b')
    expect(substituteArgs('missing: ${2:-none}', 'a')).toBe('missing: none')
    // An unfilled positional must not leak the literal token to the model.
    expect(substituteArgs('bare: $3', 'a')).toBe('bare: ')
  })

  it('keeps quoted arguments together', () => {
    expect(substituteArgs('$1|$2', '"two words" second')).toBe('two words|second')
  })
})

describe('discoverCommandFiles', () => {
  it('walks subdirectories and names them with Claude namespacing', () => {
    const root = tempDir()
    mkdirSync(join(root, 'frontend'), { recursive: true })
    writeFileSync(join(root, 'hello.md'), 'hi')
    writeFileSync(join(root, 'frontend', 'build.md'), 'build')

    const found = discoverCommandFiles(root)
    const names = found.map((f) => f.name).sort()
    expect(names).toEqual(['frontend:build', 'hello'])
  })

  it('returns nothing for a missing directory', () => {
    expect(discoverCommandFiles(join(tempDir(), 'absent'))).toEqual([])
  })
})

describe('commandNameFor', () => {
  it('joins nested segments with colons and drops the extension', () => {
    expect(commandNameFor('a/b/c.md')).toBe('a:b:c')
    expect(commandNameFor('top.md')).toBe('top')
  })
})

describe('expandDynamicContent', () => {
  const exec = async (command: string) => ({ stdout: `out:${command}`, stderr: '', code: 0, killed: false })

  it('runs !`cmd` spans and substitutes their output', async () => {
    const out = await expandDynamicContent('status: !`git status`', tempDir(), exec)
    expect(out).toBe('status: out:git status')
  })

  it('reports a failing command instead of pasting silence', async () => {
    const failing = async () => ({ stdout: '', stderr: 'boom', code: 1, killed: false })
    const out = await expandDynamicContent('x: !`bad`', tempDir(), failing)
    expect(out).toContain('bad')
    expect(out).toContain('boom')
  })

  it('inlines @file references relative to the working directory', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'notes.md'), 'FILE_BODY')
    const out = await expandDynamicContent('see @notes.md', cwd, exec)
    expect(out).toContain('FILE_BODY')
    expect(out).toContain('notes.md')
  })

  it('leaves an unreadable or escaping @ref as written', async () => {
    const cwd = tempDir()
    expect(await expandDynamicContent('@missing.md', cwd, exec)).toContain('@missing.md')
    // A traversal must not read a file that really exists outside the project: the
    // previous non-existent path bailed in the catch and never reached the guard.
    const parent = tempDir()
    const child = join(parent, 'proj')
    mkdirSync(child, { recursive: true })
    writeFileSync(join(parent, 'secret.txt'), 'SECRET_BODY')
    const escaped = await expandDynamicContent('leak: @../secret.txt', child, exec)
    expect(escaped).not.toContain('SECRET_BODY')
    expect(escaped).toContain('@../secret.txt')
  })

  it('ignores an @ref inside a fenced code block', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'notes.md'), 'FILE_BODY')
    const out = await expandDynamicContent('```\n@notes.md\n```', cwd, exec)
    expect(out).not.toContain('FILE_BODY')
  })
})
