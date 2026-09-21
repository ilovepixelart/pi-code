import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A linked worktree laid out as git writes it: the worktree's `.git` is a file naming
 * `<main>/.git/worktrees/<name>`, and that directory's `gitdir` points back at the
 * worktree's `.git`. repoRoot follows the pointer only when the main checkout points back.
 */
export function makeWorktree(parent: string): { main: string; tree: string } {
  const main = join(parent, 'main')
  const tree = join(parent, 'feature')
  const admin = join(main, '.git', 'worktrees', 'feature')
  mkdirSync(admin, { recursive: true })
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`)
  writeFileSync(join(admin, 'gitdir'), `${join(tree, '.git')}\n`)
  return { main, tree }
}
