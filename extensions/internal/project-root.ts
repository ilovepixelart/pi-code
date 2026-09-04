/**
 * Upward search for project configuration, shared across extensions.
 *
 * Claude anchors project config (.claude/*, .mcp.json, CLAUDE.local.md) at the
 * project root, so a session started in a subdirectory must still find it. The
 * walk runs from cwd up to the repository root and no further: without the bound,
 * config planted in a world-writable ancestor such as /tmp would be offered to
 * every session beneath it. With no project marker the extent is unknown, so only
 * cwd is considered. The project-approval walk uses the same markers, so whatever
 * these find is exactly what that walk gated.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The project root marker. `.git` is a file in worktrees and submodules, a directory
 * in an ordinary clone.
 *
 * Only `.git`: a package.json marker would make every package of a monorepo its own
 * project (its own memory directory, settings.local.json, CLAUDE_PROJECT_DIR and trust
 * decision), and a repository can add a package.json wherever it likes, so a marker it
 * controls is a marker it can move. Claude's project is the repository. */
export const ROOT_MARKERS = ['.git']

/** Project root at or above `from`, or undefined outside a repository. */
export function repoRoot(from: string): string | undefined {
  const root = gitRoot(from)
  if (root === undefined) return undefined
  return mainCheckout(root)
}

/** The git checkout at or above `from`, or undefined outside one.
 *
 * Narrower than repoRoot on purpose: repoRoot resolves a worktree to its main checkout,
 * which is the right key for shared state (settings.local.json, auto memory) but is a
 * sibling of the worktree, never an ancestor. The upward walks above bound themselves
 * here instead, since a boundary that is not on the path from cwd to / is never reached
 * and the walk would run on to the filesystem root. `.git` cannot be committed into a
 * repository, so it is not a marker the repository can add to move its own key.
 */
export function gitRoot(from: string): string | undefined {
  let currentDir = from
  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git'))) return currentDir
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

/** The main checkout for a git directory.
 *
 * A worktree carries a `.git` FILE holding `gitdir: <main>/.git/worktrees/<name>`, so
 * resolving it gives the checkout the repository's state actually belongs to. Claude
 * reads settings.local.json from "the file at the main checkout's root" and shares one
 * auto memory directory across "all worktrees and subdirectories within the same repo",
 * so a worktree is not its own project. An unreadable or unexpected `.git` file leaves
 * the directory as its own root, which is the safe direction. */
function mainCheckout(root: string): string {
  const dotGit = path.join(root, '.git')
  let pointer: string
  try {
    if (!fs.statSync(dotGit).isFile()) return root
    pointer = fs.readFileSync(dotGit, 'utf-8')
  } catch {
    return root
  }
  // Parsed rather than matched: the file is one `gitdir: <path>` line, and a regex
  // over an arbitrary-length path is a backtracking cost for nothing.
  const [firstLine = ''] = pointer.split('\n')
  const prefix = 'gitdir:'
  if (!firstLine.startsWith(prefix)) return root
  const target = firstLine.slice(prefix.length).trim()
  if (!target) return root
  // <main>/.git/worktrees/<name> -> <main>
  const worktreeDir = path.resolve(root, target)
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
  const cut = worktreeDir.lastIndexOf(marker)
  if (cut === -1) return root
  return worktreeDir.slice(0, cut)
}

function statOf(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function findNearest(cwd: string, relative: string, wantDir: boolean): string | null {
  const boundary = gitRoot(cwd) ?? cwd
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    const stat = statOf(candidate)
    if (stat && (wantDir ? stat.isDirectory() : stat.isFile())) return candidate

    if (currentDir === boundary) return null
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}

/** Nearest `relative` directory at or above `cwd`, stopping at the repository root. */
export function findNearestDir(cwd: string, relative: string): string | null {
  return findNearest(cwd, relative, true)
}

/** Nearest `relative` file at or above `cwd`, stopping at the repository root. */
export function findNearestFile(cwd: string, relative: string): string | null {
  return findNearest(cwd, relative, false)
}

/** Every `relative` directory between cwd and the repository root, nearest first,
 * matching Claude's "every .claude/<kind> between the working directory and the
 * repository root" discovery where the entry closest to cwd wins a name clash. */
export function ancestorDirs(cwd: string, relative: string): string[] {
  const boundary = gitRoot(cwd) ?? cwd
  const found: string[] = []
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    if (statOf(candidate)?.isDirectory()) found.push(candidate)
    if (currentDir === boundary) break
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }
  return found
}

/** Every `relative` file between the repository root and cwd, ordered root first,
 * matching Claude's root-down ordering for hierarchy-loaded context. */
export function ancestorFiles(cwd: string, relative: string): string[] {
  const boundary = gitRoot(cwd) ?? cwd
  const found: string[] = []
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    if (statOf(candidate)?.isFile()) found.push(candidate)
    if (currentDir === boundary) break
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }
  return found.reverse()
}
