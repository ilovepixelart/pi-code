/**
 * Claude Rules Extension
 *
 * Replicates Claude Code's rules loading:
 * - Unscoped global rules (~/.claude/rules/*.md) are inlined in full into the system prompt.
 * - Path-scoped global rules and all project rules (.claude/rules/*.md) are listed as
 *   pointers the agent reads on demand.
 *
 * Path-scoped rules: a rule file may declare `paths:` frontmatter (a glob or
 * list of globs). Pointers surface that scope so the agent knows to read the
 * rule when working on matching files. Frontmatter is stripped from inlined
 * global rules.
 *
 * Adapted from the pi v0.74.2 claude-rules example.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { isProjectApproved } from './internal/project-approval.js'

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

interface ProjectRule {
  rel: string
  paths: string[]
}

interface GlobalRules {
  inline: string
  scoped: ProjectRule[]
}

/** Unscoped global rules are inlined; path-scoped ones keep their scope as pointers,
 * mirroring Claude Code, where scoped rules attach only to matching files. */
function readGlobalRules(globalRulesDir: string): GlobalRules {
  const inline: string[] = []
  const scoped: ProjectRule[] = []
  for (const file of findMarkdownFiles(globalRulesDir)) {
    let parsed: Frontmatter
    try {
      parsed = parseFrontmatter(fs.readFileSync(path.join(globalRulesDir, file), 'utf-8'))
    } catch {
      continue // one unreadable rule must not take down session start
    }
    if (parsed.paths.length > 0) scoped.push({ rel: file, paths: parsed.paths })
    else if (parsed.body.trim().length > 0) inline.push(parsed.body.trim())
  }
  return { inline: inline.join('\n\n'), scoped }
}

function readProjectRules(projectRulesDir: string): ProjectRule[] {
  return findMarkdownFiles(projectRulesDir).map((rel) => {
    try {
      return { rel, paths: parseFrontmatter(fs.readFileSync(path.join(projectRulesDir, rel), 'utf-8')).paths }
    } catch {
      return { rel, paths: [] }
    }
  })
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
  const globalRulesDir = path.join(os.homedir(), '.claude', 'rules')
  let globalRules: GlobalRules = { inline: '', scoped: [] }
  let projectRules: ProjectRule[] = []

  pi.on('session_start', async (_event, ctx) => {
    globalRules = readGlobalRules(globalRulesDir)
    // Project rule filenames and their paths: frontmatter are surfaced in the system prompt.
    // isProjectTrusted alone is true for a repo pi never asked about; see project-approval.
    const approved = await isProjectApproved(ctx)
    projectRules = approved ? readProjectRules(path.join(ctx.cwd, '.claude', 'rules')) : []

    const hasGlobal = globalRules.inline.length > 0 || globalRules.scoped.length > 0
    if (hasGlobal || projectRules.length > 0) {
      ctx.ui.notify(`Rules loaded: global ${hasGlobal ? 'yes' : 'no'}, project ${projectRules.length}`, 'info')
    }
  })

  pi.on('before_agent_start', async (event) => {
    let addition = ''

    if (globalRules.inline.length > 0 || globalRules.scoped.length > 0) {
      addition += `\n\n## Global Rules`
      if (globalRules.inline.length > 0) {
        addition += `\n\nThese rules always apply:\n\n${globalRules.inline}`
      }
      if (globalRules.scoped.length > 0) {
        const scopedList = globalRules.scoped.map((rule) => formatRulePointer(rule.rel, rule.paths, '~/.claude/rules')).join('\n')
        addition += `\n\nPath-scoped global rules, available in ~/.claude/rules/:\n\n${scopedList}\n\nRead the relevant rule file with the read tool before working on the files it covers.`
      }
    }

    if (projectRules.length > 0) {
      const rulesList = projectRules.map((rule) => formatRulePointer(rule.rel, rule.paths)).join('\n')
      addition += `\n\n## Project Rules\n\nThe following project rules are available in .claude/rules/:\n\n${rulesList}\n\nRead the relevant rule file with the read tool before working on the files it covers; rules with an "applies when" scope are path-scoped.`
    }

    if (addition.length === 0) return

    return { systemPrompt: event.systemPrompt + addition }
  })
}
