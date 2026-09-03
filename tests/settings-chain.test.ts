import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { claudeSettingsChain, readSettingsChain } from '../extensions/internal/settings-chain.ts'

describe('readSettingsChain', () => {
  const write = (dir: string, name: string, body: string): string => {
    const file = join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('yields each readable object in chain order, so a later file wins', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const a = write(dir, 'a.json', '{"outputStyle":"first"}')
    const b = write(dir, 'b.json', '{"outputStyle":"second"}')
    expect([...readSettingsChain([a, b])]).toEqual([{ outputStyle: 'first' }, { outputStyle: 'second' }])
  })

  it('skips a missing file rather than ending the chain', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const present = write(dir, 'present.json', '{"a":1}')
    expect([...readSettingsChain([join(dir, 'absent.json'), present])]).toEqual([{ a: 1 }])
  })

  it('skips a corrupt file rather than ending the chain', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const bad = write(dir, 'bad.json', '{ not json')
    const good = write(dir, 'good.json', '{"a":1}')
    expect([...readSettingsChain([bad, good])]).toEqual([{ a: 1 }])
  })

  it('skips JSON that is not an object, including null and an array', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const nul = write(dir, 'null.json', 'null')
    const arr = write(dir, 'arr.json', '[1,2]')
    const str = write(dir, 'str.json', '"text"')
    const good = write(dir, 'good.json', '{"a":1}')
    expect([...readSettingsChain([nul, arr, str, good])]).toEqual([{ a: 1 }])
  })

  it('reads each file only when the caller pulls it, so the chain sees a late write', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'sc-'))
    const first = write(dir, 'first.json', '{"a":1}')
    // Absent when the chain starts: only a read deferred to the second pull sees it.
    const second = join(dir, 'second.json')
    const seen: Record<string, unknown>[] = []
    for (const settings of readSettingsChain([first, second])) {
      seen.push(settings)
      if (seen.length === 1) fs.writeFileSync(second, '{"a":2}')
    }
    expect(seen).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('claudeSettingsChain local file placement', () => {
  const owned = () => true
  const notOwned = () => false

  const repoAt = (): { repo: string; cwd: string } => {
    const repo = fs.mkdtempSync(join(tmpdir(), 'sc-repo-'))
    fs.mkdirSync(join(repo, '.git'))
    const cwd = join(repo, 'src')
    fs.mkdirSync(cwd)
    return { repo, cwd }
  }

  const localFiles = (chain: string[]): string[] => chain.filter((file) => file.endsWith('settings.local.json'))

  it('puts the local file at the repository root, reading a legacy one in the working directory too', () => {
    const { repo, cwd } = repoAt()
    expect(localFiles(claudeSettingsChain(cwd, '/home/u', true, 'linux', owned))).toEqual([join(cwd, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.local.json')])
  })

  // Claude: the file stays beside .claude/settings.json "outside a git repository,
  // when the repository root is your home directory, on Windows, or when the
  // repository root or its .git or .claude entry isn't owned by your user".
  it('keeps the local file in the working directory on Windows', () => {
    const { cwd } = repoAt()
    expect(localFiles(claudeSettingsChain(cwd, '/home/u', true, 'win32', owned))).toEqual([join(cwd, '.claude', 'settings.local.json')])
  })

  it('keeps the local file in the working directory when the root belongs to someone else', () => {
    const { cwd } = repoAt()
    expect(localFiles(claudeSettingsChain(cwd, '/home/u', true, 'linux', notOwned))).toEqual([join(cwd, '.claude', 'settings.local.json')])
  })

  it('keeps the local file in the working directory outside a repository', () => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'sc-plain-'))
    expect(localFiles(claudeSettingsChain(cwd, '/home/u', true, 'linux', owned))).toEqual([join(cwd, '.claude', 'settings.local.json')])
  })

  it('keeps the local file in the working directory when the repository root is home', () => {
    const home = fs.mkdtempSync(join(tmpdir(), 'sc-home-'))
    fs.mkdirSync(join(home, '.git'))
    const cwd = join(home, 'src')
    fs.mkdirSync(cwd)
    expect(localFiles(claudeSettingsChain(cwd, home, true, 'linux', owned))).toEqual([join(cwd, '.claude', 'settings.local.json')])
  })

  it('uses the main checkout in a worktree', () => {
    const parent = fs.mkdtempSync(join(tmpdir(), 'sc-wt-'))
    const main = join(parent, 'main')
    const tree = join(parent, 'feature')
    fs.mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    fs.mkdirSync(tree)
    fs.writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)

    expect(localFiles(claudeSettingsChain(tree, '/home/u', true, 'linux', owned))).toEqual([join(tree, '.claude', 'settings.local.json'), join(main, '.claude', 'settings.local.json')])
  })
})
