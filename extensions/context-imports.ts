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
 * It also loads the Claude Code memory locations pi's own loader misses, each
 * through the same exclude/strip/announce/import pipeline: the user-scope
 * ~/.claude/CLAUDE.md (the user's own file, no approval gate, @imports at
 * user-config roots), the project-scope alternate ./.claude/CLAUDE.md (nearest at
 * or above cwd, approval-gated, deduped against pi's native blocks, @imports at
 * project roots), and the enterprise managed CLAUDE.md file deployed beside
 * managed-settings.json.
 *
 * It also rewrites the context blocks pi assembled, by exact-substring
 * replacement of the wrapper reconstructed from each file's path+content (a
 * wrapper that is not found is skipped, never guessed at): the managed claudeMd
 * (the managed CLAUDE.md file first, then the managed-settings `claudeMd` key)
 * and the user CLAUDE.md are prepended at the top of <project_context> in Claude's
 * order (managed, user, then pi's native project blocks; managed is managed-source
 * only and never excludable), files matching the merged `claudeMdExcludes` globs
 * are removed along with their imports, and block-level HTML comments are stripped
 * from every surviving body (see internal/strip-comments).
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
 * for the native context files that survived claudeMdExcludes plus CLAUDE.local.md,
 * the user (User) and project ./.claude/CLAUDE.md (Project), the managed file
 * (Managed) and additional-dir files, once per file per session. This extension
 * owns exclusion, so it owns the announcements too: a file the exclusion removed
 * never announces, and the hooks extension only consumes the bus (emit is
 * synchronous, so extension order does not matter). The managed-settings `claudeMd`
 * key is not a file pi loaded, so like today it is inserted but not announced.
 *
 * Docs: https://code.claude.com/docs/en/memory.md (imports)
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { claudeConfigDir } from './internal/config-dir.js'
import { AGENTS_FILE_NAMES } from './internal/context-files.js'
import { externalImportDecision, externalImportKey, rememberExternalImportDecision } from './internal/external-imports.js'
import { type InstructionLoadEvent, memoryTypeForPath, publishInstructionLoad } from './internal/instruction-events.js'
import { managedSettingsPath, readManagedSettings } from './internal/managed-settings.js'
import { capForContext, sliceBytes } from './internal/output-guard.js'
import { globToRegExpSource } from './internal/path-rules.js'
import { isGatedFileApproved, isProjectApproved, isProjectApprovedSilently } from './internal/project-approval.js'
import { ancestorFiles, findNearestFile, repoRoot } from './internal/project-root.js'
import { claudeSettingsChain, readSettingsChain } from './internal/settings-chain.js'
import { statToken } from './internal/stat-token.js'
import { type Fence, fenceMarker, stepFence, stripBlockComments } from './internal/strip-comments.js'
import { fileToolTarget } from './internal/tool-target.js'

/** Claude documents "a maximum depth of four hops" for recursive imports. */
const MAX_IMPORT_DEPTH = 4

/** Claude loads a context file (CLAUDE.md and friends) of up to 4 MiB in full and
 * skips a larger one. */
const CONTEXT_FILE_MAX_BYTES = 4 * 1024 * 1024

/** One context file's content, or undefined when it is absent, unreadable, or over
 * the 4 MiB limit Claude documents. */
function readContextFile(filePath: string): string | undefined {
  try {
    if (fs.statSync(filePath).size > CONTEXT_FILE_MAX_BYTES) return undefined
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
}
export const MAX_IMPORT_FILES = 50
export const MAX_IMPORT_BYTES = 256 * 1024

export function expandHome(target: string, home: string): string {
  if (target === '~') return home
  if (target.startsWith('~/')) return path.join(home, target.slice(2))
  return target
}

/** Stands for "no boundary" in an allowed-roots list: the grant a project gets when
 * its external imports are approved, where a file may import from anywhere as Claude's
 * dialog allows. A real path never equals it, and realRoots never produces it. */
const ANY_ROOT = '*'

function isUnder(target: string, roots: string[]): boolean {
  return roots.some((root) => root === ANY_ROOT || target === root || target.startsWith(root + path.sep))
}

/** Realpath the roots that exist; used both to seed and to bound the import search. */
function realRoots(candidates: string[]): string[] {
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
  /** Existing files an @import named that resolve outside the importer's allowed
   * roots. Collected so the refusal can be reported rather than left silent. */
  refused: Set<string>
}

export const createImportBudget = (): ImportBudget => ({ files: MAX_IMPORT_FILES, bytes: MAX_IMPORT_BYTES, dropped: 0, refused: new Set() })

/** The `@path` targets of a context file, in document order. Claude Code evaluates
 * imports neither in fenced code blocks (backtick or tilde) nor in inline spans. */
function importTargets(content: string): string[] {
  const targets: string[] = []
  // CommonMark fences: closed only by the same character in a run at least as long
  // as the opener, so a backtick example may hold tilde lines or shorter fences.
  let fence: Fence | null = null
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    const step = stepFence(fence, trimmed, fenceMarker(trimmed))
    fence = step.fence
    if (step.fenced) continue
    // Backreference so a multi-backtick span (``literal `@x` backticks``) strips whole.
    const withoutSpans = line.replace(/(`+)[^`]*?\1/g, '')
    for (const match of withoutSpans.matchAll(/(^|\s)@(\S+)/g)) targets.push(match[2])
  }
  return targets
}

/** Read one `@path` target, or null when it is unresolvable, already seen, outside `allowedRoots`, excluded, or unreadable. */
function readImport(target: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, isExcluded: ((realPath: string) => boolean) | undefined, refused: Set<string>): { real: string; body: string } | null {
  const resolved = path.resolve(fromDir, expandHome(target, home))
  // Always the path the importing file named, never where a symlink pointed: the
  // notice would otherwise hand a repo the real name of whatever the link reaches,
  // which is the disclosure the refusal exists to prevent. An excluded file is not
  // named either, since exclusion removes it from every other surface too.
  const refuse = (): null => {
    if (isExcluded?.(resolved) !== true) refused.add(resolved)
    return null
  }
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    // Not on disk. Still refused when it points outside, so that whether a path is
    // reported never depends on whether it exists: a notice that named only the
    // existing ones would enumerate the filesystem for any repo-controlled file
    // willing to write one @line per guess.
    return isUnder(resolved, allowedRoots) ? null : refuse()
  }
  if (seen.has(real)) return null
  if (!isUnder(real, allowedRoots)) return refuse()
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
    // A file another importer already refused is in context after all; the notice
    // must not claim otherwise.
    refused.delete(resolved)
    return { real, body }
  } catch {
    return null
  }
}

/** Optional controls for a collection run: the byte/file budget shared across the
 * whole run, the path of the file this content came from (seeds each top-level
 * import's `parent`), and the exclusion predicate. Recursion depth is internal. */
export interface CollectImportsOptions {
  budget?: ImportBudget
  importer?: string
  isExcluded?: (realPath: string) => boolean
}

/** The parts of a collection run that stay fixed across the recursion: resolution
 * roots, the seen/budget accumulators, and the exclusion predicate. Only content,
 * fromDir, depth and the parent path change from one level to the next. */
interface ImportScan {
  home: string
  allowedRoots: string[]
  seen: Set<string>
  budget: ImportBudget
  isExcluded?: (realPath: string) => boolean
}

/** One recursion level: read the imports named in `content`, then recurse into each. */
function collectFrom(scan: ImportScan, content: string, fromDir: string, depth: number, importer?: string): ImportedFile[] {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const out: ImportedFile[] = []
  for (const target of importTargets(content)) {
    // Checked before the read so an exhausted budget costs no I/O.
    if (scan.budget.files === 0 || scan.budget.bytes === 0) {
      scan.budget.dropped += 1
      continue
    }
    const file = readImport(target, fromDir, scan.home, scan.allowedRoots, scan.seen, scan.isExcluded, scan.budget.refused)
    if (!file) continue
    scan.budget.files -= 1
    // The budget is bytes: a string slice counts UTF-16 units and lets CJK text through
    // at three times the budget without ever reaching the truncation marker.
    const kept = sliceBytes(file.body, scan.budget.bytes)
    scan.budget.bytes -= Buffer.byteLength(kept)
    const body = kept.length < file.body.length ? `${kept.trim()}\n${IMPORT_TRUNCATED_MARKER}` : kept.trim()
    // Comments are stripped before the scan for further imports, so a
    // commented-out @import stays dead at every depth, matching the top level
    // (whose bodies arrive here already stripped by the caller).
    out.push({ path: file.real, body, parent: importer }, ...collectFrom(scan, stripBlockComments(kept), path.dirname(file.real), depth + 1, file.real))
  }
  return out
}

/**
 * Collect the contents of every file transitively imported via `@path`, in
 * discovery order. Imports are resolved through symlinks and kept within
 * `allowedRoots` (which must already be realpath'd).
 */
export function collectImports(content: string, fromDir: string, home: string, allowedRoots: string[], seen: Set<string>, options: CollectImportsOptions = {}): ImportedFile[] {
  const scan: ImportScan = { home, allowedRoots, seen, budget: options.budget ?? createImportBudget(), isExcluded: options.isExcluded }
  return collectFrom(scan, content, fromDir, 0, options.importer)
}

/**
 * Roots an importing file may pull from.
 *
 * A context file under the user's own config may reach the whole config; a project
 * file may not. `~/.claude` holds `.credentials.json`, global settings and every
 * project's transcripts, so granting those roots to a cloned repo's `CLAUDE.md`
 * would let it read them into the system prompt.
 */
export function rootsForImporter(importer: string, home: string, cwd: string, externalApproved = false): string[] {
  const userRoots = realRoots([claudeConfigDir(home), path.join(home, '.pi')])
  const [real] = realRoots([importer])
  const fromUserConfig = real !== undefined && isUnder(real, userRoots)
  if (fromUserConfig) return realRoots([cwd, ...userRoots])
  // The project was asked about its external imports and allowed them, so a project
  // file may reach outside, as Claude's dialog grants. The widening is deliberately
  // only for project files: a user-scope file's roots are its own config, and an
  // approval given to a repository must not extend them.
  if (externalApproved) return [ANY_ROOT]
  // A non-config file is bounded at the repository root: that covers an ancestor
  // context file (a repo-root CLAUDE.md or CLAUDE.local.md in a subdirectory
  // session, where cwd alone silently dropped its relative imports) without
  // granting the importer's own directory. pi also loads home-level context
  // files (~/AGENTS.md) that sit outside the config roots; their directory is
  // $HOME, and allowing it would let @.ssh/... read into every session's prompt.
  return realRoots([cwd, repoRoot(cwd) ?? cwd])
}

/** Claude's env gate for loading memory files from --add-dir directories. */
const ADDITIONAL_DIRS_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'

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
      // Pinned locale: the default collator follows the host locale, which
      // reorders names like ch/ci/h and makes prompt content machine-dependent.
      .sort((a, b) => a.localeCompare(b, 'en'))
    candidates.push(...names.map((name) => path.join(rulesDir, name)))
  } catch {
    // no rules directory in this additional dir
  }
  if (includeLocal) candidates.push(path.join(dir, 'CLAUDE.local.md'))
  const files: Array<{ path: string; content: string }> = []
  for (const candidate of candidates) {
    const content = readContextFile(candidate)
    if (content !== undefined) files.push({ path: candidate, content })
  }
  return files
}

/** Path label given to the managed claudeMd settings-key block; not a file pi loaded. */
export const MANAGED_CLAUDE_MD_PATH = 'managed-settings.json (claudeMd)'

let managedClaudeMdPathOverride: string | undefined

/** Test seam mirroring setManagedSettingsPath: point the managed CLAUDE.md file
 * readers consult at a writable directory. */
export function setManagedClaudeMdPath(file?: string): void {
  managedClaudeMdPathOverride = file
}

/** The managed CLAUDE.md file path: alongside managed-settings.json, in the same OS
 * directory IT deploys the enterprise policy to (managed-settings.ts owns that
 * directory per platform). Organizations ship a CLAUDE.md there to load before user
 * and project context. Overridable for tests. */
export function managedClaudeMdPath(): string {
  return managedClaudeMdPathOverride ?? path.join(path.dirname(managedSettingsPath()), 'CLAUDE.md')
}

/** The managed CLAUDE.md file body, or '' when absent or unreadable. */
function readManagedClaudeMdFile(): string {
  try {
    return fs.readFileSync(managedClaudeMdPath(), 'utf-8')
  } catch {
    return ''
  }
}

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

/** Insert a block at the top of <project_context>, before the files pi loaded;
 * when pi assembled no context block, add one in pi's shape. Used for the blocks
 * Claude loads ahead of pi's native project context: managed claudeMd (file then
 * key) and the user CLAUDE.md. Each call prepends, so the last block inserted ends
 * up highest, which is how the managed/user/native order is built (see caller). */
function withTopBlock(prompt: string, block: string): string {
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
  return claudeSettingsChain(cwd, home, approved)
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
  for (const settings of readSettingsChain(files)) collect(settings.claudeMdExcludes)
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

/** Apply claudeMdExcludes and comment-stripping to pi's native context blocks,
 * rewriting the assembled prompt by exact substring: an excluded file's block is
 * removed, a surviving file's block is replaced with its comment-stripped body. A
 * wrapper not found in the prompt is skipped rather than risk corrupting it.
 * Returns the rewritten prompt and the files that survived exclusion (stripped). */
function rewriteNativeBlocks(prompt: string, native: Array<{ path: string; content: string }>, excluded: (absPath: string) => boolean): { prompt: string; changed: boolean; kept: Array<{ path: string; content: string }> } {
  let changed = false
  const kept: Array<{ path: string; content: string }> = []
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
    kept.push({ path: file.path, content: stripped })
  }
  return { prompt, changed, kept }
}

/** Claude's --add-dir memory files, minus any pi already loaded natively (added to
 * `seenSet` here so an @import cannot pull one in twice) and any the excludes drop
 * or that strip to nothing. Each survivor is comment-stripped and tagged with its
 * additional dir, so its relative imports can resolve from there. */
function additionalDirExtras(addDirs: string[], seenSet: Set<string>, excluded: (absPath: string) => boolean, includeLocal: boolean): Array<{ path: string; content: string; dir: string }> {
  const extras: Array<{ path: string; content: string; dir: string }> = []
  for (const dir of addDirs) {
    for (const file of additionalDirContextFiles(dir, includeLocal)) {
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
  return extras
}

/** The parts of one launch-time expansion that every file shares: where it runs, what
 * has already been read, the budget they all draw on, and whether this project's
 * external imports were approved. */
interface ExpansionContext {
  home: string
  cwd: string
  seen: Set<string>
  excluded: (absPath: string) => boolean
  budget: ImportBudget
  externalApproved: boolean
}

/** Resolve every context and additional-dir file's @imports through the one shared
 * budget, each with roots scoped to the importing file so a project file never
 * reaches user config unless the project's external imports were approved. */
function expandImports(contextFiles: Array<{ path: string; content: string }>, extras: Array<{ path: string; content: string; dir: string }>, run: ExpansionContext): ImportedFile[] {
  const imported: ImportedFile[] = []
  const options = { budget: run.budget, isExcluded: run.excluded }
  for (const file of contextFiles) {
    const allowedRoots = rootsForImporter(file.path, run.home, run.cwd, run.externalApproved)
    imported.push(...collectImports(file.content, path.dirname(file.path), run.home, allowedRoots, run.seen, { ...options, importer: file.path }))
  }
  for (const extra of extras) {
    // The additional dir itself is an allowed root, so its files' relative imports
    // resolve even from .claude/rules two levels down.
    const allowedRoots = [...realRoots([extra.dir]), ...rootsForImporter(extra.path, run.home, run.cwd)]
    imported.push(...collectImports(extra.content, path.dirname(extra.path), run.home, allowedRoots, run.seen, { ...options, importer: extra.path }))
  }
  return imported
}

/** The external-import dialog's title. Exported so a test can tell it apart from the
 * project-trust dialog by identity rather than by matching a prefix that a retitle
 * would silently break. */
export const EXTERNAL_IMPORT_PROMPT_TITLE = 'Load imports from outside this project?'

/** Ask about the imports the expansion just refused for leaving the project.
 *
 * The list is the refusals the enforcing path produced, not a second enumeration of
 * what it might refuse: same files, same depth, same resolution, same exclusions. That
 * is the only way the dialog can promise it names everything the approval lets in.
 */
async function askExternalImports(ctx: ExtensionContext, root: string, refused: ReadonlySet<string>): Promise<boolean> {
  const listed = [...refused]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => `  ${file}`)
    .join('\n')
  const body = `${root}\n\nIts context files import these files from outside the project:\n\n${listed}\n\nThey will be read into every session's context. Only allow this for repositories you trust.`
  return await ctx.ui.confirm(EXTERNAL_IMPORT_PROMPT_TITLE, body)
}

/** Every context file that could load on demand for a touched directory, shallowest
 * first, so the deepest instructions are read last as they are at launch. */
function* nestedCandidates(touchedDir: string, realCwd: string): Generator<{ file: string; dir: string; name: string }> {
  for (const dir of nestedContextDirs(touchedDir, realCwd)) {
    for (const name of NESTED_CONTEXT_NAMES) yield { file: path.join(dir, name), dir, name }
  }
}

/** Everything the on-demand load needs from the session and the tool call, grouped so
 * the per-file worker stays a three-argument function. */
interface NestedLoadContext {
  home: string
  cwd: string
  realCwd: string
  projectRoot: string
  excludeGlobs: string[]
  /** The file whose access triggered the load, for trigger_file_path. */
  touched: string
  /** Paths already in the system prompt, so a nested @import does not repeat one. */
  launchLoaded: string[]
}

/** One nested context file's block and the instruction loads it should announce, or
 * nothing to attach: absent, excluded, empty, or reaching outside the project. `read`
 * reports whether the file was there at all, so a file that exists is only ever
 * attached once while a missing one can still appear later in the session. */
function nestedContextBlock(file: string, dir: string, load: NestedLoadContext): { read: boolean; text?: string; events?: InstructionLoadEvent[] } {
  if (isExcludedPath(file, load.excludeGlobs, load.home)) return { read: false }
  // The file itself may be a link out of the project, whatever its directory is.
  const [real] = realRoots([file])
  if (real === undefined || !isUnder(real, [load.realCwd])) return { read: false }
  const content = readContextFile(real)
  if (content === undefined) return { read: false }
  const body = stripBlockComments(content).trim()
  if (body.length === 0) return { read: true }
  // Its own @imports resolve at project roots, on a budget of their own: this load is
  // outside the launch-time expansion the shared budget covers. The launch-time paths
  // seed the seen set, so a nested file importing the root CLAUDE.md does not pay for
  // a body already in the system prompt.
  const seen = new Set([...load.launchLoaded, real])
  const budget = createImportBudget()
  const imports = collectImports(content, dir, load.home, rootsForImporter(real, load.home, load.cwd), seen, {
    importer: real,
    isExcluded: (absPath) => isExcludedPath(absPath, load.excludeGlobs, load.home),
    budget,
  })
  return {
    read: true,
    // The refusal notice rides along, so an import this file names and does not get is
    // as visible here as it is at launch.
    text: [instructionsBlock(file, body), ...imports.map((entry) => `### ${entry.path}\n\n${stripBlockComments(entry.body)}`)].join('\n\n') + refusedImportsAddition(budget.refused),
    events: [
      { file_path: file, memory_type: memoryTypeForPath(file, load.home, load.projectRoot), load_reason: 'nested_traversal', trigger_file_path: load.touched },
      ...imports.map((entry) => ({
        file_path: entry.path,
        memory_type: memoryTypeForPath(entry.path, load.home, load.projectRoot),
        load_reason: 'include',
        parent_file_path: file,
      })),
    ],
  }
}

/** The context files Claude loads on demand rather than at launch, in the order it
 * reads them within a directory. */
const NESTED_CONTEXT_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'] as const

/** The directories between a touched file and cwd, nearest cwd first.
 *
 * Claude loads CLAUDE.md from cwd and every directory above it at launch, and the
 * ones below "are included when Claude reads files in those directories"
 * (memory.md). Only the strictly-below range belongs here; cwd's own file is
 * already in the prompt. A file outside cwd contributes nothing.
 */
function nestedContextDirs(from: string, cwd: string): string[] {
  const dirs: string[] = []
  let current = from
  while (current !== cwd && current !== path.dirname(current)) {
    dirs.unshift(current)
    current = path.dirname(current)
  }
  // The walk reached the filesystem root without meeting cwd, so the file is outside
  // it: nothing below cwd to load. A file in cwd itself ends the loop with no dirs.
  return current === cwd ? dirs : []
}

/** The blocks and instruction loads for one touched directory. `loaded` is the
 * session's set of already-attached files and is updated in place, so a file that
 * exists is attached once and a missing one can still appear later. */
function nestedContextAttachments(touchedDir: string, load: NestedLoadContext, loaded: Set<string>, localsApproved: boolean): { bodies: string[]; events: InstructionLoadEvent[] } {
  const bodies: string[] = []
  const events: InstructionLoadEvent[] = []
  for (const { file, dir, name } of nestedCandidates(touchedDir, load.realCwd)) {
    if (loaded.has(file)) continue
    // A CLAUDE.local.md needs a decision, never the "nothing here to gate" shortcut:
    // the approval walk only looks at or above cwd, so this is the one door it cannot
    // see (see isGatedFileApproved).
    if (name === 'CLAUDE.local.md' && !localsApproved) continue
    const block = nestedContextBlock(file, dir, load)
    if (block.read) loaded.add(file)
    if (block.text === undefined) continue
    bodies.push(block.text)
    events.push(...(block.events ?? []))
  }
  return { bodies, events }
}

/** The CLAUDE.md files pi passed over.
 *
 * Claude Code reads CLAUDE.md and never AGENTS.md, and its documented recipe for a
 * repository that already has an AGENTS.md is a CLAUDE.md that imports it and adds
 * Claude-specific instructions below (memory.md, "AGENTS.md"). pi loads one context
 * file per directory and prefers AGENTS.md, so on exactly that layout the
 * Claude-specific half never reaches the prompt. Each one found here is loaded like
 * any other project file: exclude-checked, comment-stripped, imports expanded.
 *
 * The `@AGENTS.md` the recipe opens with costs nothing: pi's own file paths already
 * seed the import seen-set, so the body it names is not injected a second time. */
function siblingClaudeMdFiles(native: Array<{ path: string; content: string }>): Array<{ path: string; content: string }> {
  const loaded = new Set(realRoots(native.map((file) => file.path)))
  const found: Array<{ path: string; content: string }> = []
  for (const file of native) {
    if (!AGENTS_FILE_NAMES.has(path.basename(file.path))) continue
    // CLAUDE.md only: pi also answers to CLAUDE.MD, but Claude Code reads the one
    // spelling, and on a case-insensitive filesystem looking for both finds the same
    // file twice under two names.
    const candidate = path.join(path.dirname(file.path), 'CLAUDE.md')
    const [real] = realRoots([candidate])
    if (real !== undefined && loaded.has(real)) continue
    const content = readContextFile(candidate)
    if (content === undefined) continue
    found.push({ path: candidate, content })
  }
  return found
}

/** The CLAUDE.md files pi passed over, appended as project_instructions blocks in the
 * ./CLAUDE.md slot, ahead of the ./.claude/CLAUDE.md alternate and the locals. */
function siblingClaudeMdAddition(siblings: Array<{ path: string; content: string }>, home: string, projectRoot: string, announce: (event: InstructionLoadEvent) => void): string {
  let addition = ''
  for (const sibling of siblings) {
    if (sibling.content.trim().length === 0) continue
    announce({ file_path: sibling.path, memory_type: memoryTypeForPath(sibling.path, home, projectRoot), load_reason: 'session_start' })
    addition += `\n\n${instructionsBlock(sibling.path, sibling.content.trim())}`
  }
  return addition
}

/** The project-scope ./.claude/CLAUDE.md appended as a project_instructions block,
 * announced as it is added (only when non-empty, matching what reaches the prompt).
 * Claude reads project instructions from ./CLAUDE.md OR ./.claude/CLAUDE.md; pi loads
 * the former natively, so this fills the alternate location as an extra project block. */
function projectContextAddition(kept: { path: string; content: string } | undefined, home: string, projectRoot: string, announce: (event: InstructionLoadEvent) => void): string {
  if (kept === undefined || kept.content.trim().length === 0) return ''
  announce({ file_path: kept.path, memory_type: memoryTypeForPath(kept.path, home, projectRoot), load_reason: 'session_start' })
  return `\n\n${instructionsBlock(kept.path, kept.content.trim())}`
}

/** The CLAUDE.local.md bodies appended after the native context, announced as they
 * are added (only the non-empty ones, matching what actually reaches the prompt). */
function localContextAddition(keptLocals: Array<{ path: string; content: string }>, announce: (event: InstructionLoadEvent) => void): string {
  let addition = ''
  for (const local of keptLocals) {
    if (local.content.trim().length > 0) {
      addition += `\n\n## CLAUDE.local.md (${local.path})\n\n${local.content.trim()}`
      announce({ file_path: local.path, memory_type: 'Local', load_reason: 'session_start' })
    }
  }
  return addition
}

/** The --add-dir memory files appended as extra project_instructions blocks.
 * Additional dirs are extra working directories, so their files are Project-typed
 * regardless of where the dir sits (Local for a CLAUDE.local.md). */
function additionalDirsAddition(extras: Array<{ path: string; content: string; dir: string }>, announce: (event: InstructionLoadEvent) => void): string {
  let addition = ''
  for (const extra of extras) {
    addition += `\n\n${instructionsBlock(extra.path, extra.content)}`
    announce({ file_path: extra.path, memory_type: path.basename(extra.path) === 'CLAUDE.local.md' ? 'Local' : 'Project', load_reason: 'session_start' })
  }
  return addition
}

/** The refusal notice: every existing file an @import named that its importer may not
 * reach. Claude asks about these through an approval dialog and loads the ones you
 * allow; pi-code refuses them, and this is what says so. Silence was the real defect:
 * the importing file looks loaded and its instructions are simply not there. */
function refusedImportsAddition(refused: Set<string>): string {
  if (refused.size === 0) return ''
  const list = [...refused]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => `- ${file}`)
    .join('\n')
  return `\n\n## Imports not loaded (@)\n\nThese files resolve outside what the file importing them may read, so their contents are not in context:\n\n${list}`
}

/** The `## Imported context (@)` section for every resolved @import, with the
 * budget-exhaustion notice, announcing each as an `include`. Empty when nothing
 * was imported. */
function importedAddition(imported: ImportedFile[], budget: ImportBudget, home: string, projectRoot: string, announce: (event: InstructionLoadEvent) => void): string {
  if (imported.length === 0) return ''
  const section = imported.map((entry) => `### ${entry.path}\n\n${stripBlockComments(entry.body)}`).join('\n\n')
  const notice = budget.dropped === 0 ? '' : `\n\n${budget.dropped} further @imports were skipped: the import budget (${MAX_IMPORT_FILES} files, ${MAX_IMPORT_BYTES} bytes) is spent.`
  for (const entry of imported) {
    announce({ file_path: entry.path, memory_type: memoryTypeForPath(entry.path, home, projectRoot), load_reason: 'include', ...(entry.parent === undefined ? {} : { parent_file_path: entry.parent }) })
  }
  return `\n\n## Imported context (@)\n\n${section}${notice}`
}

/** Prepend the managed and user memory blocks Claude loads ahead of pi's native project
 * context, top to bottom: managed file, managed key, then the user CLAUDE.md. withTopBlock
 * prepends, so they are inserted bottom-up (user, then managed key, then managed file just
 * below) to land in that order. keptUser was already exclude-checked and comment-stripped by
 * the caller like every other file; the managed claudeMd is never excludable and comes from
 * two managed-only surfaces, the settings key (ignored in user/project settings) and the file
 * IT deploys beside managed-settings.json, re-read every turn so a policy change applies
 * immediately (only its announce is deduped per session). Returns the grown prompt, whether
 * anything was added, and the managed file body (reused for the import memo key). */
function prependMemoryBlocks(prompt: string, changed: boolean, keptUser: { path: string; content: string } | undefined, managed: Record<string, unknown>, announce: (event: InstructionLoadEvent) => void): { prompt: string; changed: boolean; managedFile: string } {
  if (keptUser !== undefined && keptUser.content.trim().length > 0) {
    prompt = withTopBlock(prompt, instructionsBlock(keptUser.path, keptUser.content.trim()))
    changed = true
    announce({ file_path: keptUser.path, memory_type: 'User', load_reason: 'session_start' })
  }
  const managedKey = typeof managed.claudeMd === 'string' ? stripBlockComments(managed.claudeMd).trim() : ''
  if (managedKey.length > 0) {
    prompt = withTopBlock(prompt, instructionsBlock(MANAGED_CLAUDE_MD_PATH, managedKey))
    changed = true
  }
  const managedFile = stripBlockComments(readManagedClaudeMdFile()).trim()
  if (managedFile.length > 0) {
    prompt = withTopBlock(prompt, instructionsBlock(managedClaudeMdPath(), managedFile))
    changed = true
    announce({ file_path: managedClaudeMdPath(), memory_type: 'Managed', load_reason: 'session_start' })
  }
  return { prompt, changed, managedFile }
}

/** Everything the import expansion depends on, hashed to a memo key: a turn whose inputs
 * match a prior key and whose recorded mtimes are unchanged reuses the previous expansion
 * outright. The native/local paths, the user/project-.claude additions, and the managed file
 * body seed the "seen" set, so a change in which of them exist (even an excluded one that
 * never reaches contextFiles) changes the key; the managed file is re-read every turn, so a
 * change in its content re-expands and keeps the seed self-consistent. */
function buildImportMemoKey(input: {
  cwd: string
  home: string
  projectApproved: boolean
  externalApproved: boolean
  addDirsRaw: string
  excludeGlobs: string[]
  native: Array<{ path: string; content: string }>
  localContexts: Array<{ path: string; content: string }>
  userContext: { path: string; content: string } | undefined
  projectDotClaude: { path: string; content: string } | undefined
  managedFile: string
  contextFiles: Array<{ path: string; content: string }>
}): string {
  const keyHash = createHash('sha256')
  keyHash.update(`${input.cwd}\0${input.home}\0${input.projectApproved}\0${input.externalApproved}\0${input.addDirsRaw}\0${input.excludeGlobs.join(',')}\0`)
  for (const file of [...input.native, ...input.localContexts]) keyHash.update(`${file.path}\0`)
  if (input.userContext !== undefined) keyHash.update(`${input.userContext.path}\0`)
  if (input.projectDotClaude !== undefined) keyHash.update(`${input.projectDotClaude.path}\0`)
  keyHash.update(`${input.managedFile}\0`)
  for (const file of input.contextFiles) keyHash.update(`${file.path}\0${file.content}\0`)
  return keyHash.digest('hex')
}

export default function contextImportsExtension(pi: ExtensionAPI) {
  let localContexts: Array<{ path: string; content: string }> = []
  // ~/.claude/CLAUDE.md, Claude's user-scope memory (all projects). The user's own
  // file, so it needs no project approval; read once at session start like the
  // locals, so a mid-session body edit applies next session, matching Claude.
  let userContext: { path: string; content: string } | undefined
  // The project-scope alternate location ./.claude/CLAUDE.md. pi loads ./CLAUDE.md
  // natively but not this one; repo-controlled, so it is approval-gated like the
  // locals and read once at session start.
  let projectDotClaude: { path: string; content: string } | undefined
  // Whether a file that is itself the thing to gate may be read. Decided at session
  // start like the flag below, from the session context, which is where the trust
  // capability lives; a tool_result context carries no approval state.
  let gatedFilesApproved = false
  // Whether project settings may contribute claudeMdExcludes; decided at session
  // start with the silent check, so no prompt fires mid-flight.
  let projectApproved = false
  // Every context file the last turn put in the system prompt, so a nested file's
  // @import cannot pay for a body that is already there.
  let launchLoadedPaths: string[] = []
  // Nested CLAUDE.md/CLAUDE.local.md files already attached this session, so a second
  // read in the same subtree does not repeat them.
  const nestedLoaded = new Set<string>()
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

  // before_agent_start fires every turn, but its inputs almost never change
  // mid-session. The settings-derived environment (managed settings, exclude
  // globs, repo root) is cached per cwd, and the whole import expansion is
  // memoized on its inputs and revalidated by a stat token (mtime and size): a
  // turn where nothing changed costs a handful of stats instead of re-reading and
  // re-recursing every @import. A brand-new file satisfying a previously missing
  // @import is picked up when any recorded stat token moves (or next session),
  // which is already fresher than Claude, which loads context once at session start.
  let envCache: { cwd: string; managed: Record<string, unknown>; excludeGlobs: string[]; projectRoot: string } | undefined
  let importMemo:
    | {
        key: string
        extras: Array<{ path: string; content: string; dir: string }>
        imported: ImportedFile[]
        budget: ImportBudget
        tokens: Array<[string, string]>
      }
    | undefined
  const memoIsFresh = (memo: NonNullable<typeof importMemo>): boolean => {
    try {
      return memo.tokens.every(([file, token]) => statToken(file) === token)
    } catch {
      return false // a recorded file vanished: re-expand
    }
  }
  // Memo lookup or recompute: a turn whose key matches the previous expansion and
  // whose recorded stat tokens are all unchanged reuses that expansion outright;
  // otherwise the imports are re-expanded and the memo (with a fresh revalidation
  // set) is rebuilt for next turn.
  const resolveImports = (
    memoKey: string,
    files: { native: Array<{ path: string; content: string }>; context: Array<{ path: string; content: string }>; siblings: Array<{ path: string; content: string }> },
    run: { home: string; cwd: string; excluded: (absPath: string) => boolean; externalApproved: boolean },
  ): { extras: Array<{ path: string; content: string; dir: string }>; budget: ImportBudget; imported: ImportedFile[] } => {
    if (importMemo?.key === memoKey && memoIsFresh(importMemo)) {
      const { extras, budget, imported } = importMemo
      return { extras, budget, imported }
    }
    // Seed with every loaded context file path, excluded ones included, so pi's own
    // files are never re-imported and an excluded file cannot return as an import.
    // The user, project-.claude and managed-file additions join the seed too, so a
    // context file's @import cannot pull any of them in a second time.
    const ownPaths = [...files.native, ...localContexts, ...files.siblings].map((file) => file.path)
    if (userContext !== undefined) ownPaths.push(userContext.path)
    if (projectDotClaude !== undefined) ownPaths.push(projectDotClaude.path)
    ownPaths.push(managedClaudeMdPath())
    const seenSet = new Set(realRoots(ownPaths))

    // Claude's --add-dir memory loading, env-gated. The files join the seen set
    // before import expansion so an @import cannot pull one in twice, and they get
    // the same exclude and comment-strip treatment as native context files.
    const addDirs = additionalDirsClaudeMdEnabled() ? parseAdditionalDirs(pi.getFlag?.('add-dir'), run.home, run.cwd) : []
    const extras = additionalDirExtras(addDirs, seenSet, run.excluded, projectApproved)

    // One budget for the whole run, so N context files cannot each spend a full one.
    // Exclusion applies inside the recursion: an excluded @import is skipped before
    // it is read, so its transitive imports never load and it spends no budget.
    const budget = createImportBudget()
    const imported = expandImports(files.context, extras, { ...run, seen: seenSet, budget })

    // Revalidation set: every file the expansion read, plus each add-dir itself
    // (a directory's mtime moves when a memory file is added or removed there).
    const tokens: Array<[string, string]> = []
    try {
      for (const file of [...extras.map((extra) => extra.path), ...imported.map((entry) => entry.path)]) tokens.push([file, statToken(file)])
      for (const dir of addDirs) tokens.push([dir, statToken(dir)])
      importMemo = { key: memoKey, extras, budget, imported, tokens }
    } catch {
      importMemo = undefined // a file moved mid-expansion: just recompute next turn
    }
    return { extras, budget, imported }
  }

  // Claude's --add-dir. Only the memory-loading half is meaningful here: pi has
  // no path-based permission system, so there is no access grant to mirror.
  // Optional-called so the extension still wires under stub hosts without flags.
  pi.registerFlag?.('add-dir', {
    description: 'Additional working directories; with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD set, their CLAUDE.md memory files load too (comma-separated)',
    type: 'string',
  })

  /** The session-scope memory session_start loads: the user's own CLAUDE.md, plus
   * CLAUDE.local.md and ./.claude/CLAUDE.md from an approved project. Claude:
   * CLAUDE_CODE_DISABLE_CLAUDE_MDS "prevent[s] loading any CLAUDE.md memory files
   * into context, including user, project, and auto memory files", so a disabled run
   * returns empty state and skips isProjectApproved's trust prompt entirely: there is
   * nothing left for it to gate. Extracted so session_start itself stays a thin
   * dispatcher; before_agent_start's own excluded() check covers pi's native files,
   * which this cannot reach since pi loads those itself. */
  async function loadSessionMemory(ctx: ExtensionContext): Promise<{ userContext?: { path: string; content: string }; localContexts: Array<{ path: string; content: string }>; projectDotClaude?: { path: string; content: string } }> {
    if (process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1') return { localContexts: [] }

    // ~/.claude/CLAUDE.md, Claude's user-scope memory. The user's own file, so no
    // project approval is required; a missing file simply leaves it unset.
    const userClaudeMd = path.join(claudeConfigDir(os.homedir()), 'CLAUDE.md')
    const userContent = readContextFile(userClaudeMd)
    const memory: { userContext?: { path: string; content: string }; localContexts: Array<{ path: string; content: string }>; projectDotClaude?: { path: string; content: string } } = {
      userContext: userContent !== undefined ? { path: userClaudeMd, content: userContent } : undefined,
      localContexts: [],
    }

    // CLAUDE.local.md is Claude Code's personal sidecar of CLAUDE.md; pi's own loader
    // skips it. A cloned repo can ship one, so it is gated like other project config.
    // Claude loads local context from the whole hierarchy above the working
    // directory, ordered root down to cwd; the walk is bounded at the repository
    // root like every other project-config search here. The project-scope alternate
    // ./.claude/CLAUDE.md (nearest at or above cwd) is repo-controlled too, so both
    // ride the one approval decision.
    const candidates = ancestorFiles(ctx.cwd, 'CLAUDE.local.md')
    const dotClaudeMd = findNearestFile(ctx.cwd, path.join('.claude', 'CLAUDE.md'))
    if ((candidates.length === 0 && dotClaudeMd === null) || !(await isProjectApproved(ctx))) return memory

    for (const candidate of candidates) {
      const content = readContextFile(candidate)
      if (content !== undefined) memory.localContexts.push({ path: candidate, content })
    }
    if (dotClaudeMd !== null) {
      const content = readContextFile(dotClaudeMd)
      if (content !== undefined) memory.projectDotClaude = { path: dotClaudeMd, content }
    }
    return memory
  }

  pi.on('session_start', async (_event, ctx) => {
    // pi's ctx.reload() rebuilds extension instances, so this set never survives
    // a reload anyway; a reload simply re-fires InstructionsLoaded once per file,
    // which is fine, since a reload re-loads the instruction files.
    announced.clear()
    envCache = undefined
    importMemo = undefined
    const memory = await loadSessionMemory(ctx)
    localContexts = memory.localContexts
    userContext = memory.userContext
    projectDotClaude = memory.projectDotClaude
    // Read after the local-context flow so an approval it just recorded is honored.
    projectApproved = isProjectApprovedSilently(ctx)
    gatedFilesApproved = isGatedFileApproved(ctx)
  })

  /** The launch-time expansion, asking about what it refuses for leaving the project
   * when this project has not been asked yet.
   *
   * Claude asks once per project and remembers the answer either way. The list is what
   * this very expansion refused, so it names exactly the files the answer governs, and
   * on approval the expansion is simply redone with the wider roots. */
  const expandAskingAboutExternals = async (
    cwd: string,
    ctx: ExtensionContext | undefined,
    expandWith: (externalApproved: boolean) => { extras: Array<{ path: string; content: string; dir: string }>; budget: ImportBudget; imported: ImportedFile[] },
  ): Promise<{ extras: Array<{ path: string; content: string; dir: string }>; budget: ImportBudget; imported: ImportedFile[] }> => {
    const key = externalImportKey(cwd)
    const decided = externalImportDecision(key)
    const result = expandWith(decided === true)
    if (decided !== null || result.budget.refused.size === 0 || ctx?.hasUI !== true) return result
    const approved = await askExternalImports(ctx, key, result.budget.refused)
    rememberExternalImportDecision(key, approved)
    return approved ? expandWith(true) : result
  }

  pi.on('before_agent_start', async (event, ctx) => {
    const home = os.homedir()
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd()
    const native: Array<{ path: string; content: string }> = event.systemPromptOptions?.contextFiles ?? []

    if (envCache?.cwd !== cwd) {
      const managedNow = readManagedSettings()
      envCache = { cwd, managed: managedNow, excludeGlobs: readClaudeMdExcludes(claudeMdExcludeFiles(cwd, home, projectApproved), managedNow), projectRoot: repoRoot(cwd) ?? cwd }
    }
    const { managed, excludeGlobs, projectRoot } = envCache
    // CLAUDE_CODE_DISABLE_CLAUDE_MDS also covers pi's own auto-discovered native context
    // files ("including... auto memory files"), which session_start's gate cannot reach
    // since pi loads them itself. Routing through the exclusion path already used for
    // claudeMdExcludes drops the block, strips the InstructionsLoaded event, and skips
    // import expansion for it, exactly as an excluded file already does.
    const excluded = (absPath: string): boolean => process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1' || isExcludedPath(absPath, excludeGlobs, home)

    // claudeMdExcludes drops an excluded file's block from the assembled prompt and
    // from import expansion; surviving blocks get block-level comments stripped.
    const rewrite = rewriteNativeBlocks(event.systemPrompt, native, excluded)
    let prompt = rewrite.prompt
    let changed = rewrite.changed
    // Exclusion is owned here, so the session_start InstructionsLoaded events for
    // pi's native context files are published here too, only for files that
    // survived it: Claude fires no event for a file it never loaded. The hooks
    // extension consumes them off the shared bus.
    for (const file of rewrite.kept) {
      announce({ file_path: file.path, memory_type: memoryTypeForPath(file.path, home, projectRoot), load_reason: 'session_start' })
    }

    // The user CLAUDE.md is the user's own file (no approval gate) but respects
    // claudeMdExcludes and comment-stripping like every other file. It is kept here so it
    // both gets its own block (via prependMemoryBlocks) and joins the import-expansion set
    // below, so its @imports resolve.
    const keptUser = userContext !== undefined && !excluded(userContext.path) ? { path: userContext.path, content: stripBlockComments(userContext.content) } : undefined

    // Prepend the managed and user memory blocks (managed file, managed key, user), the
    // blocks Claude loads ahead of pi's native project context. managedFile comes back
    // because it also seeds the import memo key below.
    const top = prependMemoryBlocks(prompt, changed, keptUser, managed, announce)
    prompt = top.prompt
    changed = top.changed
    const managedFile = top.managedFile

    const keptLocals = localContexts.filter((local) => !excluded(local.path)).map((local) => ({ path: local.path, content: stripBlockComments(local.content) }))

    // Repo-controlled text, so gated on the same approval as the locals and the
    // ./.claude/CLAUDE.md; read here rather than at session start because only the
    // turn's contextFiles say which file pi actually chose per directory.
    const keptSiblings = (projectApproved ? siblingClaudeMdFiles(native) : []).filter((sibling) => !excluded(sibling.path)).map((sibling) => ({ path: sibling.path, content: stripBlockComments(sibling.content) }))

    // ./.claude/CLAUDE.md, deduped against pi's native context so that if pi ever
    // loads it too there is no double block, then exclude-checked and comment-stripped
    // like the rest. Its @imports resolve at project roots (rootsForImporter).
    const nativeReal = new Set(realRoots(native.map((file) => file.path)))
    const [dotReal] = projectDotClaude !== undefined ? realRoots([projectDotClaude.path]) : []
    const siblingReal = new Set(realRoots(keptSiblings.map((sibling) => sibling.path)))
    const keptProjectDotClaude = projectDotClaude !== undefined && !(dotReal !== undefined && (nativeReal.has(dotReal) || siblingReal.has(dotReal))) && !excluded(projectDotClaude.path) ? { path: projectDotClaude.path, content: stripBlockComments(projectDotClaude.content) } : undefined

    // The user CLAUDE.md and ./.claude/CLAUDE.md join the import-expansion set so their
    // @imports resolve (each at roots scoped to it, via rootsForImporter); their own
    // bodies are placed separately, so expansion only surfaces what they import.
    const contextFiles = [...rewrite.kept, ...(keptUser !== undefined ? [keptUser] : []), ...keptSiblings, ...(keptProjectDotClaude !== undefined ? [keptProjectDotClaude] : []), ...keptLocals]

    // Everything the expansion depends on, hashed: a turn whose inputs match the memo
    // and whose recorded mtimes are unchanged reuses the previous expansion outright.
    const addDirsRaw = additionalDirsClaudeMdEnabled() ? String(pi.getFlag?.('add-dir') ?? '') : ''
    const expandWith = (externalApproved: boolean) => {
      const memoKey = buildImportMemoKey({ cwd, home, projectApproved, externalApproved, addDirsRaw, excludeGlobs, native, localContexts, userContext, projectDotClaude, managedFile, contextFiles })
      return resolveImports(memoKey, { native, context: contextFiles, siblings: keptSiblings }, { home, cwd, excluded, externalApproved })
    }

    // Claude's external-import dialog. Asked from the refusals the expansion just
    // produced, so the files named are exactly the files the answer governs, and asked
    // here rather than at session start because only this event knows which context
    // files pi actually loaded. Once per project: the answer is remembered either way.
    const { extras, budget, imported } = await expandAskingAboutExternals(cwd, ctx, expandWith)
    launchLoadedPaths = realRoots([...contextFiles.map((file) => file.path), ...imported.map((entry) => entry.path)])

    // Project memory precedes local memory, so the ./.claude/CLAUDE.md block leads the
    // additions, ahead of the CLAUDE.local.md bodies.
    let addition = siblingClaudeMdAddition(keptSiblings, home, projectRoot, announce)
    addition += projectContextAddition(keptProjectDotClaude, home, projectRoot, announce)
    addition += localContextAddition(keptLocals, announce)
    addition += additionalDirsAddition(extras, announce)
    addition += importedAddition(imported, budget, home, projectRoot, announce)
    addition += refusedImportsAddition(budget.refused)
    if (!changed && addition.length === 0) return

    return { systemPrompt: prompt + addition }
  })

  // Claude's nested traversal: CLAUDE.md and CLAUDE.local.md below the working
  // directory are not loaded at launch but "are included when Claude reads files in
  // those subdirectories" (memory.md). pi's loader stops at cwd, so the whole
  // below-cwd range is missing; this attaches each one to the tool result that
  // touched its directory, which is the same seam claude-rules uses for a scoped
  // rule. Once per file per session, ordered shallowest first so the deepest
  // instructions are read last, matching the launch-time ordering.
  pi.on('tool_result', async (event, ctx) => {
    const rel = fileToolTarget(event)
    if (rel === undefined) return
    // Repo-controlled text, gated like every other project file this extension adds.
    if (!projectApproved) return
    // Realpath both sides: the walk below is lexical, so a symlinked subdirectory
    // would otherwise carry it straight out of the project.
    const [realCwd = ctx.cwd] = realRoots([ctx.cwd])
    const touched = path.resolve(ctx.cwd, rel)
    // The directory, not the file: a write creates its target, and a read of a path
    // that has since moved should still contribute what its directory holds.
    const [touchedDir] = realRoots([path.dirname(touched)])
    if (touchedDir === undefined) return

    const home = os.homedir()
    const projectRoot = repoRoot(ctx.cwd) ?? ctx.cwd
    const excludeGlobs = readClaudeMdExcludes(claudeMdExcludeFiles(ctx.cwd, home, projectApproved), readManagedSettings())
    const load: NestedLoadContext = { home, cwd: ctx.cwd, realCwd, projectRoot, excludeGlobs, touched, launchLoaded: launchLoadedPaths }
    const { bodies, events } = nestedContextAttachments(touchedDir, load, nestedLoaded, gatedFilesApproved)
    for (const loaded of events) announce(loaded)
    if (bodies.length === 0) return
    // Capped like every other tool output: one read in a deep subtree must not be
    // able to spend the context window on memory files.
    return { content: [...event.content, { type: 'text' as const, text: capForContext(bodies.join('\n\n')) }] }
  })
}
