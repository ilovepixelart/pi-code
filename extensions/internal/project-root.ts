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

/** Project root markers ending the walk. `.git` is a file in worktrees and submodules. */
export const ROOT_MARKERS = ['.git', 'package.json']

/** Project root at or above `from`, or undefined when no marker is found. */
export function repoRoot(from: string): string | undefined {
  let currentDir = from
  while (true) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(currentDir, marker)))) return currentDir
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

function statOf(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function findNearest(cwd: string, relative: string, wantDir: boolean): string | null {
  const boundary = repoRoot(cwd) ?? cwd
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
  const boundary = repoRoot(cwd) ?? cwd
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
  const boundary = repoRoot(cwd) ?? cwd
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
