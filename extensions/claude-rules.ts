/**
 * Claude Rules Extension
 *
 * Replicates Claude Code's rules loading:
 * - Unscoped rules are inlined in full into the system prompt, global
 *   (~/.claude/rules/*.md) and approved-project (.claude/rules/*.md) alike:
 *   Claude loads rules without `paths:` frontmatter at launch with the same
 *   priority as .claude/CLAUDE.md.
 * - Path-scoped rules auto-attach: a rule file may declare `paths:` frontmatter
 *   (a glob or list of globs). Its scope is surfaced upfront as a pointer, and
 *   when a read/edit/write touches a file the globs cover, the rule body is
 *   appended to that tool's result, once per rule per session. This mirrors
 *   Claude Code, which attaches a scoped rule when a matching file is touched
 *   rather than inlining it everywhere. Frontmatter is stripped from rule text.
 *
 * Adapted from the pi v0.74.2 claude-rules example.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { publishInstructionLoad } from './internal/instruction-events.js'
import { type CompiledGlob, compileGlobs, matchesCompiledGlobs } from './internal/path-rules.js'
import { isProjectApproved } from './internal/project-approval.js'
import { findNearestDir } from './internal/project-root.js'
import { stripBlockComments } from './internal/strip-comments.js'

export interface Frontmatter {
  paths: string[]
  body: string
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

function splitInline(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter(Boolean)
}

function parsePaths(frontmatter: string): string[] {
  const lines = frontmatter.split('\n')
  const index = lines.findIndex((line) => /^\s*paths\s*:/.test(line))
  if (index === -1) return []
  const inline = lines[index].replace(/^\s*paths\s*:/, '').trim()
  if (inline) return splitInline(inline)
  const items: string[] = []
  // Matched with string ops rather than a regex: the equivalent pattern needs two
  // adjacent whitespace quantifiers, which backtracks super-linearly on long lines.
  for (let i = index + 1; i < lines.length; i++) {
    const entry = lines[i].trimStart()
    if (!entry.startsWith('-')) break
    const value = entry.slice(1).trim()
    if (!value) break
    items.push(unquote(value))
  }
  return items
}

/** Split YAML-ish frontmatter off the front of a rule file, extracting `paths`. */
export function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { paths: [], body: content }
  return { paths: parsePaths(match[1]), body: content.slice(match[0].length) }
}

/**
 * Whether a file path matches at least one of a rule's `paths:` globs. `*` stays in
 * a segment, `**` crosses directories, a slashless pattern (`*.ts`) matches the
 * basename at any depth (gitignore-style), and a trailing slash (`docs/`) scopes to
 * that directory's contents. `./` and a leading `/` are stripped so a project-root
 * anchored glob resolves the same as a bare one. A bare directory name without a
 * trailing slash or `**` matches a file of that name, not the directory's contents;
 * write `dir/**` to scope to a directory. `relPath` is the touched file relative to
 * the rule set's root.
 */
export function pathMatchesGlobs(relPath: string, globs: string[]): boolean {
  return matchesCompiledGlobs(relPath, compileGlobs(globs))
}

/** A rule pointer line, annotated with its path scope when present. */
export function formatRulePointer(rel: string, paths: string[], base = '.claude/rules'): string {
  const ref = `- ${base}/${rel}`
  return paths.length > 0 ? `${ref} — applies when working on: ${paths.join(', ')}` : ref
}

/** A dirent's kind with symlinks resolved; nulls a dangling link. */
function classifyEntry(entry: fs.Dirent, fullPath: string): { isDir: boolean; isFile: boolean } | null {
  if (!entry.isSymbolicLink()) return { isDir: entry.isDirectory(), isFile: entry.isFile() }
  try {
    const stat = fs.statSync(fullPath)
    return { isDir: stat.isDirectory(), isFile: stat.isFile() }
  } catch {
    return null
  }
}

/** Recursively find all .md files, following symlinks (Claude Code documents symlinked
 * shared rule dirs); `visited` realpaths keep a circular link from recursing forever. */
function findMarkdownFiles(dir: string, basePath = '', visited = new Set<string>()): string[] {
  const results: string[] = []
  try {
    const real = fs.realpathSync(dir)
    if (visited.has(real)) return results
    visited.add(real)
  } catch {
    return results
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results // a missing or unreadable directory must not take down session start
  }
  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    const fullPath = path.join(dir, entry.name)
    const kind = classifyEntry(entry, fullPath)
    if (!kind) continue
    if (kind.isDir) {
      results.push(...findMarkdownFiles(fullPath, relativePath, visited))
    } else if (kind.isFile && entry.name.endsWith('.md')) {
      results.push(relativePath)
    }
  }
  return results
}

interface ScopedRule {
  rel: string
  paths: string[]
  /** The rule text, attached when a matching file is touched. */
  body: string
}

interface RuleSet {
  inline: string[]
  scoped: ScopedRule[]
}

const EMPTY_RULES: RuleSet = { inline: [], scoped: [] }

/** Unscoped rules are inlined; path-scoped ones keep their scope as pointers,
 * mirroring Claude Code, where scoped rules attach only to matching files. */
function readRules(rulesDir: string): RuleSet {
  const inline: string[] = []
  const scoped: ScopedRule[] = []
  for (const file of findMarkdownFiles(rulesDir)) {
    let parsed: Frontmatter
    try {
      parsed = parseFrontmatter(fs.readFileSync(path.join(rulesDir, file), 'utf-8'))
    } catch {
      continue // one unreadable rule must not take down session start
    }
    // Rule bodies get the same block-level comment strip as CLAUDE.md files
    // before they reach the prompt or attach to a tool result.
    const body = stripBlockComments(parsed.body).trim()
    // A body that strips to nothing has nothing to inline or attach; attaching
    // an empty text block to a tool result is rejected by the API when the
    // result's content is a block array (image-bearing results).
    if (body.length === 0) continue
    if (parsed.paths.length > 0) scoped.push({ rel: file, paths: parsed.paths, body })
    else inline.push(body)
  }
  return { inline, scoped }
}

/** The system-prompt section for one rule set: inlined bodies, then scoped pointers. */
function rulesSection(title: string, rules: RuleSet, base: string): string {
  if (rules.inline.length === 0 && rules.scoped.length === 0) return ''
  let section = `\n\n## ${title}`
  if (rules.inline.length > 0) {
    section += `\n\nThese rules always apply:\n\n${rules.inline.join('\n\n')}`
  }
  if (rules.scoped.length > 0) {
    const scopedList = rules.scoped.map((rule) => formatRulePointer(rule.rel, rule.paths, base)).join('\n')
    section += `\n\nPath-scoped rules, available in ${base}/:\n\n${scopedList}\n\nRead the relevant rule file with the read tool before working on the files it covers.`
  }
  return section
}

/** A scoped rule resolved to the root its globs match against, ready to attach. */
interface AttachTarget {
  /** The rule's `paths:` globs as written, reported on the instruction-events bus. */
  globs: string[]
  /** The globs precompiled once at session start for the per-tool-result scan. */
  compiled: CompiledGlob[]
  body: string
  /** The absolute directory `paths:` globs are matched relative to. */
  root: string
  /** The rule file's absolute path, reported on the instruction-events bus. */
  file: string
  /** Claude's memory_type for the rule's origin: global rules are User config. */
  memoryType: 'User' | 'Project'
}

// Module level because the working list lives in each extension instance's closure.
let pendingScopedRules = 0

/** Test seam: scoped rules still awaiting attachment in the current session, for
 * asserting that a fully attached rule leaves the per-tool-result working list. */
export function pendingScopedRuleCount(): number {
  return pendingScopedRules
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
  const globalRulesDir = path.join(os.homedir(), '.claude', 'rules')
  let globalRules: RuleSet = EMPTY_RULES
  let projectRules: RuleSet = EMPTY_RULES
  // The base a scoped-rule pointer is written against, so the model's read resolves.
  // The project rules dir may sit at an ancestor of cwd, where a cwd-relative
  // '.claude/rules' would point the read at a path that does not exist.
  let projectRulesBase = '.claude/rules'
  // Scoped rules still awaiting a matching touch. An attached rule leaves the
  // list, so each attaches at most once and the per-tool-result scan shrinks.
  let attachTargets: AttachTarget[] = []

  pi.on('session_start', async (_event, ctx) => {
    globalRules = readRules(globalRulesDir)
    // Project rules are repository text landing in the system prompt, so they load
    // only once the project is approved. isProjectTrusted alone is true for a repo
    // pi never asked about; see project-approval.
    const approved = await isProjectApproved(ctx)
    // Nearest at-or-above cwd, so a subdirectory session still reads the rules the
    // approval walk gated on.
    const projectRulesDir = approved ? findNearestDir(ctx.cwd, path.join('.claude', 'rules')) : null
    projectRules = projectRulesDir ? readRules(projectRulesDir) : EMPTY_RULES

    // Global globs are relative to cwd; project globs to the project root (the dir
    // holding .claude), so `db/**` in a repo rule matches repo-relative paths even
    // from a subdirectory session. Globs compile here, once per session, rather
    // than on every tool result; rebuilt per session so a re-run re-attaches.
    const projectRoot = projectRulesDir ? path.dirname(path.dirname(projectRulesDir)) : ctx.cwd
    attachTargets = [
      ...globalRules.scoped.map((rule) => ({ globs: rule.paths, compiled: compileGlobs(rule.paths), body: rule.body, root: ctx.cwd, file: path.join(globalRulesDir, rule.rel), memoryType: 'User' as const })),
      ...projectRules.scoped.map((rule) => ({ globs: rule.paths, compiled: compileGlobs(rule.paths), body: rule.body, root: projectRoot, file: path.join(projectRulesDir ?? path.join(ctx.cwd, '.claude', 'rules'), rule.rel), memoryType: 'Project' as const })),
    ]
    pendingScopedRules = attachTargets.length
    // Relative to cwd, which the read tool resolves: an ancestor dir yields a
    // `../…/.claude/rules` the model can follow, where a bare '.claude/rules'
    // would point at a nonexistent path under the subdirectory.
    projectRulesBase = projectRulesDir === null ? '.claude/rules' : path.relative(ctx.cwd, projectRulesDir) || '.claude/rules'

    const hasGlobal = globalRules.inline.length > 0 || globalRules.scoped.length > 0
    const projectCount = projectRules.inline.length + projectRules.scoped.length
    if (hasGlobal || projectCount > 0) {
      ctx.ui.notify(`Rules loaded: global ${hasGlobal ? 'yes' : 'no'}, project ${projectCount}`, 'info')
    }
  })

  pi.on('before_agent_start', async (event) => {
    // Global first: Claude loads user-level rules before project rules, so project
    // rules read later and take priority.
    const addition = rulesSection('Global Rules', globalRules, '~/.claude/rules') + rulesSection('Project Rules', projectRules, projectRulesBase)
    if (addition.length === 0) return

    return { systemPrompt: event.systemPrompt + addition }
  })

  // Lazy attach: when a file tool touches a path a scoped rule covers, append the
  // rule body to that tool's result so it enters context, once per rule per session.
  // This mirrors Claude Code, which attaches a scoped rule when a matching file is
  // read or edited rather than inlining it upfront.
  pi.on('tool_result', async (event, ctx) => {
    if (attachTargets.length === 0) return
    if (event.isError) return
    if (event.toolName !== 'read' && event.toolName !== 'edit' && event.toolName !== 'write') return
    const rel = (event.input as { path?: unknown } | undefined)?.path
    if (typeof rel !== 'string' || rel.length === 0) return
    const abs = path.resolve(ctx.cwd, rel)

    const bodies: string[] = []
    const remaining: AttachTarget[] = []
    for (const target of attachTargets) {
      const relativeToRoot = path.relative(target.root, abs)
      // A file outside the rule root cannot match its project-relative globs. Test for
      // a real parent-traversal segment, not a leading '..' (a file named `..config` is
      // inside the root).
      const outsideRoot = relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)
      if (outsideRoot || !matchesCompiledGlobs(relativeToRoot, target.compiled)) {
        remaining.push(target)
        continue
      }
      bodies.push(target.body)
      // The lazy attach is Claude's path_glob_match instruction load; the hooks
      // extension bridges the bus event to the InstructionsLoaded hook. Leaving
      // the working list also bounds the events to one per rule per session.
      publishInstructionLoad(pi.events, { file_path: target.file, memory_type: target.memoryType, load_reason: 'path_glob_match', globs: target.globs, trigger_file_path: abs })
    }
    attachTargets = remaining
    pendingScopedRules = attachTargets.length
    if (bodies.length === 0) return
    return { content: [...event.content, ...bodies.map((text) => ({ type: 'text' as const, text }))] }
  })
}
