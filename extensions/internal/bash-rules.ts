/**
 * Claude's `Bash(...)` argument scopes, enforced at tool_call time.
 *
 * A scope like `git add:*` narrows a bash grant to matching commands. pi's
 * active-tool set has no argument dimension, so commands.ts grants `bash` and
 * checks each call here instead. Matching follows Claude's documented forms:
 * a bare specifier is an exact match, `prefix:*` matches any command starting
 * with the prefix, and `*` elsewhere is a wildcard. Every segment of a compound
 * command must match some rule, and substitution or an unbalanced quote fails
 * closed, as plan mode's guard does.
 */

import { hasSubstitution, splitSegments } from './shell-split.js'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * One rule against one command segment, per Claude's permission table:
 * - `*` stands in for whatever text is in its place.
 * - a trailing `*` with a space before it also matches the bare command, but only when
 *   it is the rule's only wildcard (`* --help *` does not match `npm --help`).
 * - that space is part of the rule, so `ls *` does not match `lsof` while `ls*` does.
 * - `:*` is an equivalent spelling of a trailing ` *`, recognized only at the end; a
 *   colon anywhere else is a literal character.
 */
function matchesRule(segment: string, rule: string): boolean {
  const normalized = rule.endsWith(':*') ? `${rule.slice(0, -2)} *` : rule
  if (normalized.endsWith(' *') && normalized.indexOf('*') === normalized.length - 1 && segment === normalized.slice(0, -2)) return true
  if (normalized.includes('*')) return new RegExp(`^${normalized.split('*').map(escapeRegExp).join('[^]*')}$`).test(segment)
  return segment === normalized
}

/** Leading `VAR=value` assignments, which Claude strips before matching an `if` pattern. */
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/

/** The bodies of `$(...)`, `` `...` ``, `<(...)` and `>(...)`, which run commands of their own. */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = []
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`|[<>]\(([^()]*)\)/g)) {
    const body = match[1] ?? match[2] ?? match[3]
    if (body?.trim()) bodies.push(body.trim())
  }
  return bodies
}

/** Whether the first word of a segment is something only the shell can resolve. */
const headUnresolvable = (segment: string): boolean => /[$`]/.test(segment.split(/\s+/, 1)[0] ?? '')

/** Whether a pattern names more than the command itself, like `git push *` against `git *`. */
const namesMoreThanCommand = (rule: string): boolean => rule.split('*', 1)[0].trim().includes(' ')

/**
 * Claude's `if` filter for a Bash call, which decides whether a hook gets to SEE the
 * call. That makes it the mirror of a permission rule: a grant must hold for every
 * segment and fails closed on anything it cannot read, while this runs the hook when any
 * segment matches and when the input cannot be resolved at all. Claude: "When Claude Code
 * can't determine which commands the Bash input runs, it runs your hook regardless of the
 * pattern. Because the `if` filter is best-effort, use the permission system rather than
 * a hook to enforce a hard allow or deny."
 *
 * Each top-level segment is checked with its leading assignments stripped, and so is the
 * body of every substitution, since one can sit at any argument position. An unresolvable
 * command name runs the hook whatever the pattern; a substitution anywhere runs it when
 * the pattern names more than the command.
 */
export function matchesBashIfFilter(command: string, rule: string): boolean {
  const trimmed = rule.trim()
  const candidates = splitSegments(command).flatMap((segment) => {
    const stripped = segment.replace(LEADING_ASSIGNMENTS, '')
    return [stripped, ...substitutionBodies(stripped).flatMap((body) => splitSegments(body).map((inner) => inner.replace(LEADING_ASSIGNMENTS, '')))]
  })
  if (candidates.some((candidate) => matchesRule(candidate, trimmed))) return true
  if (candidates.some(headUnresolvable)) return true
  return namesMoreThanCommand(trimmed) && (hasSubstitution(command) || /\$[A-Za-z_{]/.test(command))
}

export function matchesBashRules(command: string, rules: string[]): boolean {
  if (hasSubstitution(command)) return false
  const segments = splitSegments(command)
  return segments.length > 0 && segments.every((segment) => rules.some((rule) => matchesRule(segment, rule.trim())))
}
