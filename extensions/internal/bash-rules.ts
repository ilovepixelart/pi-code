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

export function matchesBashRules(command: string, rules: string[]): boolean {
  if (hasSubstitution(command)) return false
  const segments = splitSegments(command)
  return segments.length > 0 && segments.every((segment) => rules.some((rule) => matchesRule(segment, rule.trim())))
}
