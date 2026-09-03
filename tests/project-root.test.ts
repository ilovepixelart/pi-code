import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { gitRoot, repoRoot } from '../extensions/internal/project-root.ts'

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

    expect(repoRoot(tree)).toBe(main)
    expect(repoRoot(join(tree, 'src'))).toBe(main)
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
  })

  it('gitRoot reports the checkout itself, unresolved', () => {
    // The worktree it actually is, for callers that need to know they are in one.
    const parent = tempDir()
    const main = join(parent, 'main')
    const tree = join(parent, 'feature')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)

    expect(gitRoot(tree)).toBe(tree)
    expect(repoRoot(tree)).toBe(main)
  })
})
