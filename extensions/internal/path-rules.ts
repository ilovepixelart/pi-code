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

/** One gitignore-style pattern as an anchored regular expression source. */
export function globToRegExpSource(pattern: string): string {
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
