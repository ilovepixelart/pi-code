/**
 * Claude's Read/Edit path-rule matching, applied to allowed-tools grants.
 *
 * Claude consults Read(path) and Edit(path) rules for file access, with Edit
 * rules also governing writes. Patterns follow gitignore syntax with four anchor
 * forms: `//abs` from the filesystem root, `~/` from home, `/` from the project
 * root (the settings source), and bare or `./` from the current directory. As
 * allow rules, a single-segment directory pattern anchors at cwd; a bare
 * filename matches at any depth. `*` stays within one segment, `**` crosses
 * directories. Matching is lexical, on resolved paths. Bracket expressions parse
 * per Claude's documented glob contract: `[abc]` classes with ranges and `!`
 * negation, an unreadable `[` making the pattern match nothing, and `\[` for a
 * literal bracket.
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

/** The end index of a bracket expression starting at `start` (`[`), or -1 when it
 * cannot be read as one, which per Claude makes the whole pattern invalid. A `]`
 * directly after the opening (or after a leading negation) is a literal member. */
function bracketEnd(pattern: string, start: number): number {
  let i = start + 1
  if (pattern[i] === '!' || pattern[i] === '^') i += 1
  if (pattern[i] === ']') i += 1
  for (; i < pattern.length; i += 1) {
    if (pattern[i] === ']') return i
  }
  return -1
}

/** A bracket expression body as a regex character class, escaping regex-relevant
 * characters while keeping `-` ranges; a leading `!` (or `^`) negates. */
function bracketClass(body: string): string {
  const negated = body.startsWith('!') || body.startsWith('^')
  const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, (ch) => `\\${ch}`)
  return `[${negated ? '^' : ''}${members}]`
}

/** A `*` run starting at `i`: a double star followed by a slash spans whole
 * directories, a bare double star crosses segments, and a single `*` stays within
 * one. Returns the regex source and the index after the run. */
function translateStar(pattern: string, i: number): { source: string; next: number } {
  if (pattern[i + 1] === '*') {
    const prevSlash = i === 0 || pattern[i - 1] === '/'
    if (prevSlash && pattern[i + 2] === '/') return { source: '(?:[^/]+/)*', next: i + 3 }
    return { source: '.*', next: i + 2 }
  }
  return { source: '[^/]*', next: i + 1 }
}

function translateGlob(pattern: string): string | null {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    // Claude: to match a literal bracket, escape it; the escape consumes both chars.
    if (ch === '\\' && (pattern[i + 1] === '[' || pattern[i + 1] === ']')) {
      out += escapeRegExp(pattern[i + 1])
      i += 2
      continue
    }
    // Claude: `[` starts a bracket expression such as `[abc]`; a `[` that cannot be
    // read as one makes the pattern invalid, matching nothing.
    if (ch === '[') {
      const end = bracketEnd(pattern, i)
      if (end === -1) return null
      out += bracketClass(pattern.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (ch === '*') {
      const star = translateStar(pattern, i)
      out += star.source
      i = star.next
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

/** A regex source that matches nothing: the compiled form of an invalid pattern. */
const NEVER_MATCH = '(?!)'

/** One gitignore-style pattern as an anchored regular expression source. Brace
 * groups (`{ts,tsx}`, nested, Cartesian across groups) expand into ORed
 * alternatives; an over-budget expansion falls back to the literal pattern. An
 * invalid pattern (an unreadable bracket expression) matches nothing, as Claude
 * documents, rather than matching its literal spelling. */
export function globToRegExpSource(pattern: string): string {
  const alternatives = expandBraces(pattern) ?? [pattern]
  const sources = alternatives.map(translateGlob)
  if (sources.includes(null)) return NEVER_MATCH
  if (sources.length === 1) return sources[0] as string
  return `(?:${sources.join('|')})`
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

/** One rule glob precompiled for repeated matching: its anchored regex, and whether
 * it applies to the basename (a slashless pattern, gitignore-style) or the full
 * root-relative path. */
export interface CompiledGlob {
  regex: RegExp
  matchesBasename: boolean
}

let globsCompiled = 0
let globsEvaluated = 0

/** Test seam: cumulative compiled-glob work, for asserting that callers compile
 * each glob once upfront and stop evaluating rules that no longer apply. */
export function globCompileStats(): { compiled: number; evaluated: number } {
  return { compiled: globsCompiled, evaluated: globsEvaluated }
}

/** Rule `paths:` globs compiled once for repeated matching, with claude-rules'
 * pathMatchesGlobs semantics: `./` and leading `/` anchors are stripped, a trailing
 * slash scopes to the directory's contents, and blank entries drop out. */
/** Claude's shared list budget: rule patterns past ~1000 compiled entries are
 * ignored rather than compiled without bound. */
const LIST_PATTERN_BUDGET = 1000

export function compileGlobs(globs: string[]): CompiledGlob[] {
  const compiled: CompiledGlob[] = []
  for (const raw of globs) {
    if (compiled.length >= LIST_PATTERN_BUDGET) break
    let glob = raw.trim()
    if (!glob) continue
    if (glob.startsWith('./')) glob = glob.slice(2)
    else if (glob.startsWith('/')) glob = glob.slice(1)
    // A trailing slash means the directory's contents, like gitignore; `docs/` alone
    // would compile to `^docs/$` and match nothing.
    if (glob.endsWith('/')) glob += '**'
    globsCompiled += 1
    compiled.push({ regex: new RegExp(`^${globToRegExpSource(glob)}$`), matchesBasename: !glob.includes('/') })
  }
  return compiled
}

/** Whether a root-relative path matches at least one compiled glob. No globs means
 * no match. */
export function matchesCompiledGlobs(relPath: string, globs: CompiledGlob[]): boolean {
  globsEvaluated += 1
  const posix = relPath.split(path.sep).join('/')
  const base = posix.split('/').pop() ?? posix
  return globs.some((glob) => glob.regex.test(glob.matchesBasename ? base : posix))
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
