/**
 * Claude's Read/Edit path-rule matching, applied to allowed-tools grants.
 *
 * Claude consults Read(path) and Edit(path) rules for file access, with Edit
 * rules also governing writes. Patterns follow gitignore syntax with four anchor
 * forms: `//abs` from the filesystem root, `~/` from home, `/` from the project
 * root (the settings source), and bare or `./` from the current directory. As
 * allow rules, a single-segment directory pattern anchors at cwd; a bare
 * filename matches at any depth. `*` stays within one segment, `**` crosses
 * directories. Matching is lexical, on resolved paths; bracket expressions are
 * not supported and match literally, which can only over-block, never widen.
 */

import * as path from 'node:path'

export interface PathAnchors {
  cwd: string
  projectRoot: string
  home: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/** Cap on brace-expanded alternatives per pattern, mirroring Claude's ~1000
 * budget; an over-budget pattern is used unexpanded. */
const BRACE_EXPANSION_LIMIT = 1000

interface BraceGroup {
  start: number
  end: number
  options: string[]
}

/** The `{...}` group opening at `open`, or null when it is unmatched or carries no
 * top-level comma (literal braces). Options are split on commas at the group's own
 * depth so a nested group stays inside one option. */
function parseBraceGroup(pattern: string, open: number): BraceGroup | null {
  let depth = 1
  let optionStart = open + 1
  const options: string[] = []
  for (let i = open + 1; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '{') depth += 1
    else if (ch === ',' && depth === 1) {
      options.push(pattern.slice(optionStart, i))
      optionStart = i + 1
    } else if (ch === '}' && --depth === 0) {
      if (options.length === 0) return null // no top-level comma: literal braces
      options.push(pattern.slice(optionStart, i))
      return { start: open, end: i, options }
    }
  }
  return null
}

/** The first expandable `{...}` group. A comma-less or unmatched `{` is skipped as
 * literal, so the scan can still find an expandable group nested inside it. */
function findBraceGroup(pattern: string): BraceGroup | null {
  for (let open = pattern.indexOf('{'); open !== -1; open = pattern.indexOf('{', open + 1)) {
    const group = parseBraceGroup(pattern, open)
    if (group) return group
  }
  return null
}

/** Bash-style brace expansion of one pattern into its alternatives: each group
 * multiplies out (Cartesian across groups, nested groups recurse). Returns null
 * when the expansion would exceed the budget. */
function expandBraces(pattern: string): string[] | null {
  const group = findBraceGroup(pattern)
  if (group === null) return [pattern]
  const expanded: string[] = []
  for (const option of group.options) {
    const branch = expandBraces(pattern.slice(0, group.start) + option + pattern.slice(group.end + 1))
    if (branch === null) return null
    expanded.push(...branch)
    if (expanded.length > BRACE_EXPANSION_LIMIT) return null
  }
  return expanded
}

/** One glob pattern, braces already expanded, as a regular expression source. */
function translateGlob(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const prevSlash = i === 0 || pattern[i - 1] === '/'
        if (prevSlash && pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*' // `**/` spans zero or more whole directories
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    out += escapeRegExp(ch)
    i += 1
  }
  return out
}

/** One gitignore-style pattern as an anchored regular expression source. Brace
 * groups (`{ts,tsx}`, nested, Cartesian across groups) expand into ORed
 * alternatives; an over-budget expansion falls back to the literal pattern. */
export function globToRegExpSource(pattern: string): string {
  const alternatives = expandBraces(pattern) ?? [pattern]
  if (alternatives.length === 1) return translateGlob(alternatives[0])
  return `(?:${alternatives.map(translateGlob).join('|')})`
}

/** A rule resolved to an absolute glob per its anchor form. */
function resolveRule(rule: string, anchors: PathAnchors): string {
  if (rule.startsWith('//')) return rule.slice(1)
  if (rule.startsWith('~/')) return path.join(anchors.home, rule.slice(2))
  if (rule.startsWith('/')) return path.join(anchors.projectRoot, rule.slice(1))
  const rel = rule.startsWith('./') ? rule.slice(2) : rule
  // A bare filename follows gitignore semantics and matches at any depth under cwd.
  if (!rel.includes('/')) return path.join(anchors.cwd, '**', rel)
  return path.join(anchors.cwd, rel)
}

/** Whether the accessed file matches at least one rule. No rules means no match:
 * a granted-but-scoped tool with an empty scope set stays blocked, never open. */
export function matchesPathRules(filePath: string, rules: string[], anchors: PathAnchors): boolean {
  const target = path.resolve(anchors.cwd, filePath)
  return rules.some((rule) => {
    const trimmed = rule.trim()
    // An empty specifier (`Read()`) matches nothing, so the tool stays blocked
    // rather than falling open, mirroring `Bash()`.
    if (trimmed === '') return false
    const resolved = resolveRule(trimmed, anchors)
    return new RegExp(`^${globToRegExpSource(resolved)}$`).test(target)
  })
}
