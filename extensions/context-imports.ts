/**
 * Context Imports Extension
 *
 * pi loads CLAUDE.md / AGENTS.md context files natively but does not resolve
 * Claude Code's `@path` imports inside them. This fills that one gap: on
 * before_agent_start it reads the already-loaded context files from
 * systemPromptOptions, resolves any `@path` imports (recursive, depth-capped,
 * cycle-safe; ~ expands to home, relative paths resolve against the importing
 * file), and appends ONLY the imported content. pi already injected the base
 * files, so nothing is duplicated.
 *
 * Security: context files can come from an untrusted project, so imports are
 * confined (after resolving symlinks) to the working directory and the user's
 * own ~/.claude and ~/.pi config roots. An import that escapes those roots
 * (absolute paths, ~/.ssh, ../.. traversal, symlinks) is ignored, so a hostile
 * CLAUDE.md cannot read arbitrary files into the prompt. Imports inside fenced
 * code blocks are also skipped.
 *
 * Docs: https://code.claude.com/docs/en/memory.md (imports)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const MAX_IMPORT_DEPTH = 5

export function expandHome(target: string, home: string): string {
  if (target === '~') return home
  if (target.startsWith('~/')) return path.join(home, target.slice(2))
  return target
}

function isUnder(target: string, roots: string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(root + path.sep))
}

/** Realpath the roots that exist; used both to seed and to bound the import search. */
export function realRoots(candidates: string[]): string[] {
  const roots: string[] = []
  for (const candidate of candidates) {
    try {
      roots.push(fs.realpathSync(candidate))
    } catch {
      // a root that does not exist has nothing under it to allow
    }
  }
  return roots
}

export interface ImportedFile {
  path: string
  body: string
}

/** The `@path` targets of a context file, in document order, skipping fenced code blocks. */
function importTargets(content: string): string[] {
  const targets: string[] = []
  let inFence = false
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(/(^|\s)@(\S+)/g)) targets.push(match[2])
  }
  return targets
}

/** Read one `@path` target, or null when it is unresolvable, already seen, outside `allowedRoots`, or unreadable. */
function readImport(target: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>): { real: string; body: string } | null {
  const resolved = path.resolve(fromDir, expandHome(target, home))
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return null
  }
  if (seen.has(real)) return null
  seen.add(real)
  if (!isUnder(real, allowedRoots)) return null
  try {
    // real may be a directory (EISDIR) or vanish after the realpath (ENOENT/EACCES).
    return { real, body: fs.readFileSync(real, 'utf-8') }
  } catch {
    return null
  }
}

/**
 * Collect the contents of every file transitively imported via `@path`, in
 * discovery order. Imports are resolved through symlinks and kept within
 * `allowedRoots` (which must already be realpath'd).
 */
export function collectImports(content: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, depth = 0): ImportedFile[] {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const out: ImportedFile[] = []
  for (const target of importTargets(content)) {
    const file = readImport(target, fromDir, home, allowedRoots, seen)
    if (!file) continue
    out.push({ path: file.real, body: file.body.trim() }, ...collectImports(file.body, path.dirname(file.real), home, allowedRoots, seen, depth + 1))
  }
  return out
}

export default function contextImportsExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const contextFiles: Array<{ path: string; content: string }> = event.systemPromptOptions?.contextFiles ?? []
    if (contextFiles.length === 0) return

    const home = os.homedir()
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd()
    const allowedRoots = realRoots([cwd, path.join(home, '.claude'), path.join(home, '.pi')])
    // Seed with the loaded context file paths so pi's own files are never re-imported.
    const seen = realRoots(contextFiles.map((file) => file.path))
    const seenSet = new Set(seen)

    const imported: ImportedFile[] = []
    for (const file of contextFiles) {
      imported.push(...collectImports(file.content, path.dirname(file.path), home, allowedRoots, seenSet))
    }
    if (imported.length === 0) return

    const section = imported.map((entry) => `### ${entry.path}\n\n${entry.body}`).join('\n\n')
    return { systemPrompt: `${event.systemPrompt}\n\n## Imported context (@)\n\n${section}` }
  })
}
