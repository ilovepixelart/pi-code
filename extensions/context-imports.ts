/**
 * Context Imports Extension
 *
 * pi loads CLAUDE.md / AGENTS.md context files natively but does not resolve
 * Claude Code's `@path` imports inside them, and skips CLAUDE.local.md
 * entirely. This fills both gaps: on before_agent_start it reads the
 * already-loaded context files from systemPromptOptions, resolves any `@path`
 * imports (recursive, depth-capped, cycle-safe, budget-capped; ~ expands to
 * home, relative paths resolve against the importing file), and appends the
 * imported content plus the approval-gated CLAUDE.local.md body. The base
 * files pi already injected are never re-appended.
 *
 * Security: context files can come from an untrusted project, so imports are
 * confined (after resolving symlinks) to the working directory and the user's
 * own ~/.claude and ~/.pi config roots. An import that escapes those roots
 * (absolute paths, ~/.ssh, ../.. traversal, symlinks) is ignored, so a hostile
 * CLAUDE.md cannot read arbitrary files into the prompt. Imports inside fenced
 * code blocks are also skipped. One byte-and-file budget is shared by the whole
 * run, so a context file cannot flood the prompt by importing breadth-first;
 * what the budget refused is stated in the prompt rather than dropped silently.
 *
 * Docs: https://code.claude.com/docs/en/memory.md (imports)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { isProjectApproved } from './internal/project-approval.js'

const MAX_IMPORT_DEPTH = 5
export const MAX_IMPORT_FILES = 50
export const MAX_IMPORT_BYTES = 256 * 1024

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

/** Appended to the last body the byte budget could only partly pay for. */
export const IMPORT_TRUNCATED_MARKER = '[truncated: import byte budget exhausted]'

/** Remaining import allowance, shared across every context file of one run. */
export interface ImportBudget {
  files: number
  bytes: number
  dropped: number
}

export const createImportBudget = (): ImportBudget => ({ files: MAX_IMPORT_FILES, bytes: MAX_IMPORT_BYTES, dropped: 0 })

function fenceMarker(lineStart: string): string | null {
  if (lineStart.startsWith('```')) return '`'
  if (lineStart.startsWith('~~~')) return '~'
  return null
}

/** The `@path` targets of a context file, in document order. Claude Code evaluates
 * imports neither in fenced code blocks (backtick or tilde) nor in inline spans. */
function importTargets(content: string): string[] {
  const targets: string[] = []
  // A fence only closes with the character that opened it: a backtick-fenced
  // example may legitimately contain tilde-fence lines, and vice versa.
  let fence: string | null = null
  for (const line of content.split('\n')) {
    const marker = fenceMarker(line.trimStart())
    if (marker !== null && (fence === null || fence === marker)) {
      fence = fence === null ? marker : null
      continue
    }
    if (fence !== null) continue
    // Backreference so a multi-backtick span (``literal `@x` backticks``) strips whole.
    const withoutSpans = line.replace(/(`+)[^`]*?\1/g, '')
    for (const match of withoutSpans.matchAll(/(^|\s)@(\S+)/g)) targets.push(match[2])
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
export function collectImports(content: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, budget: ImportBudget = createImportBudget(), depth = 0): ImportedFile[] {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const out: ImportedFile[] = []
  for (const target of importTargets(content)) {
    // Checked before the read so an exhausted budget costs no I/O.
    if (budget.files === 0 || budget.bytes === 0) {
      budget.dropped += 1
      continue
    }
    const file = readImport(target, fromDir, home, allowedRoots, seen)
    if (!file) continue
    budget.files -= 1
    const kept = file.body.slice(0, budget.bytes)
    budget.bytes -= kept.length
    const body = kept.length < file.body.length ? `${kept.trim()}\n${IMPORT_TRUNCATED_MARKER}` : kept.trim()
    out.push({ path: file.real, body }, ...collectImports(kept, path.dirname(file.real), home, allowedRoots, seen, budget, depth + 1))
  }
  return out
}

/**
 * Roots an importing file may pull from.
 *
 * A context file under the user's own config may reach the whole config; a project
 * file may not. `~/.claude` holds `.credentials.json`, global settings and every
 * project's transcripts, so granting those roots to a cloned repo's `CLAUDE.md`
 * would let it read them into the system prompt.
 */
export function rootsForImporter(importer: string, home: string, cwd: string): string[] {
  const userRoots = realRoots([path.join(home, '.claude'), path.join(home, '.pi')])
  const [real] = realRoots([importer])
  const fromUserConfig = real !== undefined && isUnder(real, userRoots)
  return fromUserConfig ? realRoots([cwd, ...userRoots]) : realRoots([cwd])
}

export default function contextImportsExtension(pi: ExtensionAPI) {
  let localContext: { path: string; content: string } | null = null

  pi.on('session_start', async (_event, ctx) => {
    // CLAUDE.local.md is Claude Code's personal sidecar of CLAUDE.md; pi's own loader
    // skips it. A cloned repo can ship one, so it is gated like other project config.
    localContext = null
    const candidate = path.join(ctx.cwd, 'CLAUDE.local.md')
    if (!fs.existsSync(candidate)) return
    if (!(await isProjectApproved(ctx))) return
    try {
      localContext = { path: candidate, content: fs.readFileSync(candidate, 'utf-8') }
    } catch {
      // unreadable: treat as absent
    }
  })

  pi.on('before_agent_start', async (event) => {
    const contextFiles: Array<{ path: string; content: string }> = [...(event.systemPromptOptions?.contextFiles ?? [])]
    if (localContext) contextFiles.push(localContext)
    if (contextFiles.length === 0) return

    const home = os.homedir()
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd()
    // Seed with the loaded context file paths so pi's own files are never re-imported.
    const seen = realRoots(contextFiles.map((file) => file.path))
    const seenSet = new Set(seen)

    const imported: ImportedFile[] = []
    // One budget for the whole run, so N context files cannot each spend a full one.
    const budget = createImportBudget()
    for (const file of contextFiles) {
      // Roots are scoped per importing file: a project file never reaches user config.
      const allowedRoots = rootsForImporter(file.path, home, cwd)
      imported.push(...collectImports(file.content, path.dirname(file.path), home, allowedRoots, seenSet, budget))
    }

    let addition = ''
    if (localContext && localContext.content.trim().length > 0) {
      addition += `\n\n## CLAUDE.local.md\n\n${localContext.content.trim()}`
    }
    if (imported.length > 0) {
      const section = imported.map((entry) => `### ${entry.path}\n\n${entry.body}`).join('\n\n')
      const notice = budget.dropped === 0 ? '' : `\n\n${budget.dropped} further @imports were skipped: the import budget (${MAX_IMPORT_FILES} files, ${MAX_IMPORT_BYTES} bytes) is spent.`
      addition += `\n\n## Imported context (@)\n\n${section}${notice}`
    }
    if (addition.length === 0) return

    return { systemPrompt: event.systemPrompt + addition }
  })
}
