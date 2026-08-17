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
 * It also rewrites the context blocks pi assembled, by exact-substring
 * replacement of the wrapper reconstructed from each file's path+content (a
 * wrapper that is not found is skipped, never guessed at): a managed-settings
 * `claudeMd` block is prepended at the top of <project_context> (managed
 * settings only; the key is ignored elsewhere and the block is never
 * excludable), files matching the merged `claudeMdExcludes` globs are removed
 * along with their imports, and block-level HTML comments are stripped from
 * every surviving body (see internal/strip-comments).
 *
 * Security: context files can come from an untrusted project, so imports are
 * confined (after resolving symlinks) to the working directory plus its
 * repository root, and for user-config importers the user's own ~/.claude and
 * ~/.pi config roots. An import that escapes those roots (absolute paths,
 * ~/.ssh, ../.. traversal, symlinks) is ignored, so a hostile CLAUDE.md, or a
 * home-level context file whose own directory is $HOME, cannot read arbitrary
 * files into the prompt. Imports inside fenced
 * code blocks are also skipped. One byte-and-file budget is shared by the whole
 * run, so a context file cannot flood the prompt by importing breadth-first;
 * what the budget refused is stated in the prompt rather than dropped silently.
 *
 * It also carries Claude's --add-dir memory loading: with the `add-dir` flag set
 * and CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD in the environment, each
 * additional directory's CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md and
 * (approval-gated) CLAUDE.local.md are appended as extra project_instructions
 * blocks after the native context, their @imports resolved through the shared
 * budgeted resolver with the additional dir as an allowed root. Known gaps,
 * deliberate: pi's getFlag is single-value, so a repeated `--add-dir a --add-dir b`
 * cannot be expressed; the flag accepts a comma-separated value instead. pi has
 * no `--setting-sources`. The permission half of Claude's --add-dir (widening
 * file access) is moot: pi has no path-based permission system to widen.
 *
 * Loads are also announced on the shared instruction-events bus for the
 * InstructionsLoaded hook: `include` for each resolved @import, `session_start`
 * for the native context files that survived claudeMdExcludes plus
 * CLAUDE.local.md and additional-dir files, once per file per session. This
 * extension owns exclusion, so it owns the announcements too: a file the
 * exclusion removed never announces, and the hooks extension only consumes the
 * bus (emit is synchronous, so extension order does not matter).
 *
 * Docs: https://code.claude.com/docs/en/memory.md (imports)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type InstructionLoadEvent, memoryTypeForPath, publishInstructionLoad } from './internal/instruction-events.js'
import { readManagedSettings } from './internal/managed-settings.js'
import { globToRegExpSource } from './internal/path-rules.js'
import { isProjectApproved, isProjectApprovedSilently } from './internal/project-approval.js'
import { ancestorFiles, findNearestFile, repoRoot } from './internal/project-root.js'
import { fenceMarker, stripBlockComments } from './internal/strip-comments.js'

/** Claude documents "a maximum depth of four hops" for recursive imports. */
const MAX_IMPORT_DEPTH = 4
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
  /** The file whose `@path` pulled this one in, for InstructionsLoaded's parent_file_path. */
  parent?: string
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

/** Read one `@path` target, or null when it is unresolvable, already seen, outside `allowedRoots`, excluded, or unreadable. */
function readImport(target: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, isExcluded?: (realPath: string) => boolean): { real: string; body: string } | null {
  const resolved = path.resolve(fromDir, expandHome(target, home))
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return null
  }
  if (seen.has(real)) return null
  if (!isUnder(real, allowedRoots)) return null
  // Checked before the read so an excluded file contributes nothing: no body, no
  // transitive imports, no budget spend, no announce. A post-collection filter
  // would drop the file itself but keep its children.
  if (isExcluded?.(real)) return null
  try {
    // real may be a directory (EISDIR) or vanish after the realpath (ENOENT/EACCES).
    const body = fs.readFileSync(real, 'utf-8')
    // Only a consumed file dedupes: marking a blocked or unreadable target seen
    // would let one reader's failure suppress the import for a later, allowed one.
    seen.add(real)
    return { real, body }
  } catch {
    return null
  }
}

/**
 * Collect the contents of every file transitively imported via `@path`, in
 * discovery order. Imports are resolved through symlinks and kept within
 * `allowedRoots` (which must already be realpath'd).
 */
export function collectImports(content: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, budget: ImportBudget = createImportBudget(), depth = 0, importer?: string, isExcluded?: (realPath: string) => boolean): ImportedFile[] {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const out: ImportedFile[] = []
  for (const target of importTargets(content)) {
    // Checked before the read so an exhausted budget costs no I/O.
    if (budget.files === 0 || budget.bytes === 0) {
      budget.dropped += 1
      continue
    }
    const file = readImport(target, fromDir, home, allowedRoots, seen, isExcluded)
    if (!file) continue
    budget.files -= 1
    const kept = file.body.slice(0, budget.bytes)
    budget.bytes -= kept.length
    const body = kept.length < file.body.length ? `${kept.trim()}\n${IMPORT_TRUNCATED_MARKER}` : kept.trim()
    // Comments are stripped before the scan for further imports, so a
    // commented-out @import stays dead at every depth, matching the top level
    // (whose bodies arrive here already stripped by the caller).
    out.push({ path: file.real, body, parent: importer }, ...collectImports(stripBlockComments(kept), path.dirname(file.real), home, allowedRoots, seen, budget, depth + 1, file.real, isExcluded))
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
  if (fromUserConfig) return realRoots([cwd, ...userRoots])
  // A non-config file is bounded at the repository root: that covers an ancestor
  // context file (a repo-root CLAUDE.md or CLAUDE.local.md in a subdirectory
  // session, where cwd alone silently dropped its relative imports) without
  // granting the importer's own directory. pi also loads home-level context
  // files (~/AGENTS.md) that sit outside the config roots; their directory is
  // $HOME, and allowing it would let @.ssh/... read into every session's prompt.
  return realRoots([cwd, repoRoot(cwd) ?? cwd])
}

/** Claude's env gate for loading memory files from --add-dir directories. */
export const ADDITIONAL_DIRS_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'

/** Whether the env gate is on. Claude documents `=1`; any value that is not
 * empty/0/false/no counts, so `=true` behaves as a user would expect. */
export function additionalDirsClaudeMdEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[ADDITIONAL_DIRS_ENV]?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false' && value !== 'no'
}

/** Additional directories from the `add-dir` flag value. pi's getFlag is
 * single-value, so a repeated `--add-dir a --add-dir b` cannot be expressed;
 * a comma-separated value (`--add-dir a,b`) carries multiple dirs instead.
 * `~` expands to home and relative paths resolve against cwd. */
export function parseAdditionalDirs(flagValue: unknown, home: string, cwd: string): string[] {
  if (typeof flagValue !== 'string') return []
  return flagValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(cwd, expandHome(entry, home)))
}

/** The memory files Claude loads from one --add-dir directory when the env gate
 * is set: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md and CLAUDE.local.md.
 * The local file is approval-gated like the session's own CLAUDE.local.md, so
 * `includeLocal` reflects that decision. Missing or unreadable files are skipped. */
export function additionalDirContextFiles(dir: string, includeLocal: boolean): Array<{ path: string; content: string }> {
  const candidates = [path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md')]
  const rulesDir = path.join(dir, '.claude', 'rules')
  try {
    const names = fs
      .readdirSync(rulesDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    candidates.push(...names.map((name) => path.join(rulesDir, name)))
  } catch {
    // no rules directory in this additional dir
  }
  if (includeLocal) candidates.push(path.join(dir, 'CLAUDE.local.md'))
  const files: Array<{ path: string; content: string }> = []
  for (const candidate of candidates) {
    try {
      files.push({ path: candidate, content: fs.readFileSync(candidate, 'utf-8') })
    } catch {
      // absent or unreadable: treat as not there
    }
  }
  return files
}

/** Path label given to the managed claudeMd block; not a file pi loaded. */
export const MANAGED_CLAUDE_MD_PATH = 'managed-settings.json (claudeMd)'

/** pi's exact per-file wrapper inside <project_context>, reconstructed from
 * path+content for exact-substring rewriting. tests/context-imports.test.ts pins
 * this format against pi's own source so drift fails loudly instead of silently
 * turning every rewrite into a no-op. */
export function instructionsBlock(filePath: string, content: string): string {
  return `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`
}

/** pi's <project_context> opener, the anchor the managed block is inserted after. */
const CONTEXT_OPENER = '<project_context>\n\nProject-specific instructions and guidelines:\n\n'

/** Remove a context block, preferring the shape pi assembles (trailing blank line). */
function removeBlock(prompt: string, wrapper: string): string | null {
  for (const needle of [`${wrapper}\n\n`, wrapper]) {
    const at = prompt.indexOf(needle)
    if (at !== -1) return prompt.slice(0, at) + prompt.slice(at + needle.length)
  }
  return null
}

/** Replace one context block. String#replace is unsafe here: `$&` and friends in
 * file content are replacement patterns. Splice by index instead. */
function replaceBlock(prompt: string, wrapper: string, replacement: string): string | null {
  const at = prompt.indexOf(wrapper)
  if (at === -1) return null
  return prompt.slice(0, at) + replacement + prompt.slice(at + wrapper.length)
}

/** Insert the managed claudeMd block at the top of <project_context>, before the
 * files pi loaded (Claude documents managed claudeMd loading before user and
 * project CLAUDE.md); when pi assembled no context block, add one in pi's shape. */
function withManagedBlock(prompt: string, block: string): string {
  for (const anchor of [CONTEXT_OPENER, '<project_context>\n\n']) {
    const at = prompt.indexOf(anchor)
    if (at === -1) continue
    const insert = at + anchor.length
    return `${prompt.slice(0, insert)}${block}\n\n${prompt.slice(insert)}`
  }
  return `${prompt}\n\n${CONTEXT_OPENER}${block}\n\n</project_context>\n`
}

/** Settings files whose `claudeMdExcludes` merge, following the hooks/memory
 * chain: user settings always, the project's settings.json and
 * settings.local.json (nearest at or above cwd) only when the project is
 * approved. Managed settings are read separately by the caller. */
export function claudeMdExcludeFiles(cwd: string, home: string, approved: boolean): string[] {
  const files = [path.join(home, '.claude', 'settings.json')]
  if (!approved) return files
  for (const name of ['settings.json', 'settings.local.json']) {
    files.push(findNearestFile(cwd, path.join('.claude', name)) ?? path.join(cwd, '.claude', name))
  }
  return files
}

/** Merged `claudeMdExcludes` globs across the settings chain plus managed
 * settings. Exclusion lists union rather than override: any scope may add
 * exclusions, none may remove another's. */
export function readClaudeMdExcludes(files: string[], managed: Record<string, unknown>): string[] {
  const globs: string[] = []
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim().length > 0) globs.push(entry)
    }
  }
  for (const file of files) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (settings === null || typeof settings !== 'object') continue
      collect((settings as Record<string, unknown>).claudeMdExcludes)
    } catch {
      // missing or invalid settings file: skip
    }
  }
  collect(managed.claudeMdExcludes)
  return globs
}

/** Whether an absolute context-file path matches one of the exclude globs. Globs
 * match absolute paths: `~/` expands to home, a leading `/` anchors at the
 * filesystem root, and a relative glob matches at any depth (gitignore-style).
 * Matching runs on the path without its leading slash so `**` and `**\/`, which
 * span whole segments, can reach a root-anchored path. */
export function isExcludedPath(absPath: string, globs: string[], home: string): boolean {
  const target = absPath.split(path.sep).join('/').replace(/^\//, '')
  return globs.some((raw) => {
    let glob = expandHome(raw.trim(), home).split(path.sep).join('/')
    if (glob.length === 0) return false
    if (glob.startsWith('/')) glob = glob.slice(1)
    else if (!glob.startsWith('**/')) glob = `**/${glob}`
    return new RegExp(`^${globToRegExpSource(glob)}$`).test(target)
  })
}

export default function contextImportsExtension(pi: ExtensionAPI) {
  let localContexts: Array<{ path: string; content: string }> = []
  // Whether project settings may contribute claudeMdExcludes; decided at session
  // start with the silent check, so no prompt fires mid-flight.
  let projectApproved = false
  // Instruction loads already announced on the shared bus, keyed reason:path.
  // before_agent_start fires every turn, so without this a configured
  // InstructionsLoaded hook would fire once per file per turn.
  const announced = new Set<string>()
  const announce = (event: InstructionLoadEvent): void => {
    const key = `${event.load_reason}:${event.file_path}`
    if (announced.has(key)) return
    announced.add(key)
    publishInstructionLoad(pi.events, event)
  }

  // Claude's --add-dir. Only the memory-loading half is meaningful here: pi has
  // no path-based permission system, so there is no access grant to mirror.
  // Optional-called so the extension still wires under stub hosts without flags.
  pi.registerFlag?.('add-dir', {
    description: 'Additional working directories; with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD set, their CLAUDE.md memory files load too (comma-separated)',
    type: 'string',
  })

  pi.on('session_start', async (_event, ctx) => {
    // pi's ctx.reload() rebuilds extension instances, so this set never survives
    // a reload anyway; a reload simply re-fires InstructionsLoaded once per file,
    // which is fine, since a reload re-loads the instruction files.
    announced.clear()
    // CLAUDE.local.md is Claude Code's personal sidecar of CLAUDE.md; pi's own loader
    // skips it. A cloned repo can ship one, so it is gated like other project config.
    // Claude loads local context from the whole hierarchy above the working
    // directory, ordered root down to cwd; the walk is bounded at the repository
    // root like every other project-config search here.
    localContexts = []
    const candidates = ancestorFiles(ctx.cwd, 'CLAUDE.local.md')
    if (candidates.length > 0 && (await isProjectApproved(ctx))) {
      for (const candidate of candidates) {
        try {
          localContexts.push({ path: candidate, content: fs.readFileSync(candidate, 'utf-8') })
        } catch {
          // unreadable: treat as absent
        }
      }
    }
    // Read after the local-context flow so an approval it just recorded is honored.
    projectApproved = isProjectApprovedSilently(ctx)
  })

  pi.on('before_agent_start', async (event) => {
    const home = os.homedir()
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd()
    const native: Array<{ path: string; content: string }> = event.systemPromptOptions?.contextFiles ?? []

    const managed = readManagedSettings()
    const excludeGlobs = readClaudeMdExcludes(claudeMdExcludeFiles(cwd, home, projectApproved), managed)
    const excluded = (absPath: string): boolean => isExcludedPath(absPath, excludeGlobs, home)
    const projectRoot = repoRoot(cwd) ?? cwd

    let prompt = event.systemPrompt
    let changed = false

    // claudeMdExcludes drops an excluded file's block from the assembled prompt and
    // from import expansion; surviving blocks get block-level comments stripped.
    // Both rewrite by exact substring: a wrapper that is not found in the prompt is
    // skipped rather than risk corrupting it.
    const keptNative: Array<{ path: string; content: string }> = []
    for (const file of native) {
      const wrapper = instructionsBlock(file.path, file.content)
      if (excluded(file.path)) {
        const removed = removeBlock(prompt, wrapper)
        if (removed !== null) {
          prompt = removed
          changed = true
        }
        continue
      }
      const stripped = stripBlockComments(file.content)
      if (stripped !== file.content) {
        const replaced = replaceBlock(prompt, wrapper, instructionsBlock(file.path, stripped))
        if (replaced !== null) {
          prompt = replaced
          changed = true
        }
      }
      keptNative.push({ path: file.path, content: stripped })
      // Exclusion is owned here, so the session_start InstructionsLoaded events
      // for pi's native context files are published here too, only for files
      // that actually survived it: Claude fires no event for a file it never
      // loaded. The hooks extension consumes them off the shared bus.
      announce({ file_path: file.path, memory_type: memoryTypeForPath(file.path, home, projectRoot), load_reason: 'session_start' })
    }

    // Managed claudeMd is honored from managed settings ONLY (the key is ignored in
    // user and project settings) and is never excludable; it loads before user and
    // project context, so it goes to the top of the <project_context> block.
    const managedClaudeMd = typeof managed.claudeMd === 'string' ? stripBlockComments(managed.claudeMd).trim() : ''
    if (managedClaudeMd.length > 0) {
      prompt = withManagedBlock(prompt, instructionsBlock(MANAGED_CLAUDE_MD_PATH, managedClaudeMd))
      changed = true
    }

    const keptLocals = localContexts.filter((local) => !excluded(local.path)).map((local) => ({ path: local.path, content: stripBlockComments(local.content) }))
    const contextFiles = [...keptNative, ...keptLocals]

    // Seed with every loaded context file path, excluded ones included, so pi's own
    // files are never re-imported and an excluded file cannot return as an import.
    const seen = realRoots([...native, ...localContexts].map((file) => file.path))
    const seenSet = new Set(seen)

    // Claude's --add-dir memory loading, env-gated. The files join the seen set
    // before import expansion so an @import cannot pull one in twice, and they get
    // the same exclude and comment-strip treatment as native context files.
    const addDirs = additionalDirsClaudeMdEnabled() ? parseAdditionalDirs(pi.getFlag?.('add-dir'), home, cwd) : []
    const extras: Array<{ path: string; content: string; dir: string }> = []
    for (const dir of addDirs) {
      for (const file of additionalDirContextFiles(dir, projectApproved)) {
        const [real] = realRoots([file.path])
        const key = real ?? file.path
        if (seenSet.has(key)) continue // pi already loaded it natively
        seenSet.add(key)
        if (excluded(file.path)) continue
        const stripped = stripBlockComments(file.content)
        if (stripped.trim().length === 0) continue
        extras.push({ path: file.path, content: stripped, dir })
      }
    }

    const imported: ImportedFile[] = []
    // One budget for the whole run, so N context files cannot each spend a full one.
    // Exclusion applies inside the recursion: an excluded @import is skipped before
    // it is read, so its transitive imports never load and it spends no budget.
    const budget = createImportBudget()
    for (const file of contextFiles) {
      // Roots are scoped per importing file: a project file never reaches user config.
      const allowedRoots = rootsForImporter(file.path, home, cwd)
      imported.push(...collectImports(file.content, path.dirname(file.path), home, allowedRoots, seenSet, budget, 0, file.path, excluded))
    }
    for (const extra of extras) {
      // The additional dir itself is an allowed root, so its files' relative
      // imports resolve even from .claude/rules two levels down.
      const allowedRoots = [...realRoots([extra.dir]), ...rootsForImporter(extra.path, home, cwd)]
      imported.push(...collectImports(extra.content, path.dirname(extra.path), home, allowedRoots, seenSet, budget, 0, extra.path, excluded))
    }

    let addition = ''
    for (const local of keptLocals) {
      if (local.content.trim().length > 0) {
        addition += `\n\n## CLAUDE.local.md (${local.path})\n\n${local.content.trim()}`
        announce({ file_path: local.path, memory_type: 'Local', load_reason: 'session_start' })
      }
    }
    for (const extra of extras) {
      addition += `\n\n${instructionsBlock(extra.path, extra.content)}`
      // Additional dirs are extra working directories, so their memory files are
      // Project-typed regardless of where the dir sits (Local for CLAUDE.local.md).
      announce({ file_path: extra.path, memory_type: path.basename(extra.path) === 'CLAUDE.local.md' ? 'Local' : 'Project', load_reason: 'session_start' })
    }
    if (imported.length > 0) {
      const section = imported.map((entry) => `### ${entry.path}\n\n${stripBlockComments(entry.body)}`).join('\n\n')
      const notice = budget.dropped === 0 ? '' : `\n\n${budget.dropped} further @imports were skipped: the import budget (${MAX_IMPORT_FILES} files, ${MAX_IMPORT_BYTES} bytes) is spent.`
      addition += `\n\n## Imported context (@)\n\n${section}${notice}`
      for (const entry of imported) {
        announce({ file_path: entry.path, memory_type: memoryTypeForPath(entry.path, home, projectRoot), load_reason: 'include', ...(entry.parent === undefined ? {} : { parent_file_path: entry.parent }) })
      }
    }
    if (!changed && addition.length === 0) return

    return { systemPrompt: prompt + addition }
  })
}
