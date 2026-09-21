import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkoutRoot, gitRoot, repoRoot, sameLocation } from '../extensions/internal/project-root.ts'
import { makeWorktree } from './worktree-fixture.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'root-'))

describe('repoRoot', () => {
  // Claude's project is the repository. package.json used to count as a marker too,
  // which made every package of a monorepo its own project for memory, settings,
  // CLAUDE_PROJECT_DIR and trust, and let a repository move its own project root by
  // adding a file.
  it('is the repository, not the nearest package', () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const pkg = join(repo, 'packages', 'api')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{}')

    expect(repoRoot(pkg)).toBe(repo)
  })

  it('is undefined outside a repository, however many package.json files are above', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{}')
    const sub = join(dir, 'src')
    mkdirSync(sub)

    expect(repoRoot(sub)).toBeUndefined()
  })

  // Claude: settings.local.json comes from "the file at the main checkout's root", and
  // "all worktrees and subdirectories within the same repo share one auto memory
  // directory". A worktree is not its own project.
  it('resolves a worktree to its main checkout', () => {
    const parent = tempDir()
    const main = join(parent, 'main')
    const tree = join(parent, 'feature')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'gitdir'), `${join(tree, '.git')}\n`)

    expect(repoRoot(tree)).toBe(main)
    expect(repoRoot(join(tree, 'src'))).toBe(main)
  })

  it('does not follow a worktree pointer the main checkout does not point back from', () => {
    // The .git FILE is attacker-writable: an unpacked archive can ship one. Followed as
    // text, `gitdir: ../../.git/worktrees/x` made two directories up the repository root,
    // which widened the CLAUDE.md import boundary to it: `@../../.ssh/id_rsa` was read
    // into the prompt. git always writes <main>/.git/worktrees/<name>/gitdir pointing
    // back at the worktree's .git, and nothing outside the archive can be made to.
    const parent = tempDir()
    const main = join(parent, 'main')
    const tree = join(parent, 'unpacked')
    mkdirSync(join(main, '.git', 'worktrees', 'x'), { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'x')}\n`)
    expect(repoRoot(tree)).toBe(tree)

    writeFileSync(join(main, '.git', 'worktrees', 'x', 'gitdir'), `${join(parent, 'some-other-tree', '.git')}\n`)
    expect(repoRoot(tree)).toBe(tree)
  })

  it('follows a relative back-pointer, which git 2.48 and later can write', () => {
    const parent = tempDir()
    const main = join(parent, 'main')
    const tree = join(parent, 'feature')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(tree, '.git'), 'gitdir: ../main/.git/worktrees/feature\n')
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'gitdir'), '../../../../feature/.git\n')
    expect(repoRoot(tree)).toBe(main)
  })

  it('names the worktree, not the main checkout, as the root a session runs in', () => {
    // repoRoot is the key for shared state; the project a session works in is its own checkout.
    const { main, tree } = makeWorktree(tempDir())
    mkdirSync(join(tree, 'src'))

    expect(checkoutRoot(join(tree, 'src'))).toBe(tree)
    expect(repoRoot(join(tree, 'src'))).toBe(main)
  })

  it('names the repository root from a subdirectory, and the directory itself outside one', () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'src'))
    expect(checkoutRoot(join(repo, 'src'))).toBe(repo)

    const outside = tempDir()
    expect(checkoutRoot(outside)).toBe(outside)
  })

  it('leaves the checkout as its own root when the .git file says something else', () => {
    // A submodule's .git file points at <super>/.git/modules/<name>, not worktrees, and
    // an unreadable or malformed one must not resolve to a guess.
    const parent = tempDir()
    const sub = join(parent, 'vendor')
    mkdirSync(sub)
    writeFileSync(join(sub, '.git'), `gitdir: ${join(parent, '.git', 'modules', 'vendor')}\n`)
    expect(repoRoot(sub)).toBe(sub)

    const broken = tempDir()
    writeFileSync(join(broken, '.git'), 'not a gitdir line\n')
    expect(repoRoot(broken)).toBe(broken)

    // A line that is not a gitdir pointer but does name a worktree path: only the
    // prefix check tells the two apart.
    const spoofed = tempDir()
    writeFileSync(join(spoofed, '.git'), `notgitdir: ${join(parent, 'elsewhere', '.git', 'worktrees', 'x')}\n`)
    expect(repoRoot(spoofed)).toBe(spoofed)
  })

  it('gitRoot reports the checkout itself, unresolved', () => {
    // The worktree it actually is, for callers that need to know they are in one.
    const parent = tempDir()
    const main = join(parent, 'main')
    const tree = join(parent, 'feature')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'gitdir'), `${join(tree, '.git')}\n`)

    expect(gitRoot(tree)).toBe(tree)
    expect(repoRoot(tree)).toBe(main)
  })
})

describe('sameLocation', () => {
  it('is true for a path and itself, and false for two different directories', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))

    expect(sameLocation(join(dir, 'a'), join(dir, 'a'))).toBe(true)
    expect(sameLocation(join(dir, 'a'), join(dir, 'b'))).toBe(false)
  })

  it('sees through a symlinked directory, the way a stow-managed ~/.claude is laid out', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'dotfiles', 'claude', 'rules'), { recursive: true })
    mkdirSync(join(dir, 'home'))
    symlinkSync(join(dir, 'dotfiles', 'claude'), join(dir, 'home', '.claude'))

    expect(sameLocation(join(dir, 'home', '.claude', 'rules'), join(dir, 'dotfiles', 'claude', 'rules'))).toBe(true)
  })

  it('compares by resolved path when neither exists, without throwing', () => {
    const dir = tempDir()

    expect(sameLocation(join(dir, 'gone', '..', 'missing'), join(dir, 'missing'))).toBe(true)
    expect(sameLocation(join(dir, 'missing'), join(dir, 'other'))).toBe(false)
  })
})
