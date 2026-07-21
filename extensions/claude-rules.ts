/**
 * Claude Rules Extension
 *
 * Replicates Claude Code's rules loading:
 * - Global rules (~/.claude/rules/*.md) are inlined in full into the system prompt.
 * - Project rules (.claude/rules/*.md) are listed as pointers the agent can read on demand.
 *
 * Path-scoped rules: a rule file may declare `paths:` frontmatter (a glob or
 * list of globs). Project-rule pointers surface that scope so the agent knows
 * to read the rule when working on matching files. Frontmatter is stripped
 * from inlined global rules.
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

/** A project-rule pointer line, annotated with its path scope when present. */
export function formatRulePointer(rel: string, paths: string[]): string {
  const ref = `- .claude/rules/${rel}`
  return paths.length > 0 ? `${ref} — applies when working on: ${paths.join(', ')}` : ref
}

/** Recursively find all .md files in a directory. */
function findMarkdownFiles(dir: string, basePath = ''): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results // a missing or unreadable directory must not take down session start
  }
  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(relativePath)
    }
  }
  return results
}

function readGlobalRules(globalRulesDir: string): string {
  return findMarkdownFiles(globalRulesDir)
    .map((file) => {
      try {
        return parseFrontmatter(fs.readFileSync(path.join(globalRulesDir, file), 'utf-8')).body.trim()
      } catch {
        return '' // one unreadable rule must not take down session start
      }
    })
    .filter((content) => content.length > 0)
    .join('\n\n')
}

interface ProjectRule {
  rel: string
  paths: string[]
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
  let globalRules = ''
  let projectRules: ProjectRule[] = []

  pi.on('session_start', async (_event, ctx) => {
    globalRules = readGlobalRules(globalRulesDir)
    // Project rule filenames and their paths: frontmatter are surfaced in the system prompt.
    // isProjectTrusted alone is true for a repo pi never asked about; see project-approval.
    const approved = await isProjectApproved(ctx)
    projectRules = approved ? readProjectRules(path.join(ctx.cwd, '.claude', 'rules')) : []

    if (globalRules.length > 0 || projectRules.length > 0) {
      ctx.ui.notify(`Rules loaded: global ${globalRules.length > 0 ? 'yes' : 'no'}, project ${projectRules.length}`, 'info')
    }
  })

  pi.on('before_agent_start', async (event) => {
    let addition = ''

    if (globalRules.length > 0) {
      addition += `\n\n## Global Rules\n\nThese rules always apply:\n\n${globalRules}`
    }

    if (projectRules.length > 0) {
      const rulesList = projectRules.map((rule) => formatRulePointer(rule.rel, rule.paths)).join('\n')
      addition += `\n\n## Project Rules\n\nThe following project rules are available in .claude/rules/:\n\n${rulesList}\n\nRead the relevant rule file with the read tool before working on the files it covers; rules with an "applies when" scope are path-scoped.`
    }

    if (addition.length === 0) return

    return { systemPrompt: event.systemPrompt + addition }
  })
}
