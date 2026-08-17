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

function matchesRule(segment: string, rule: string): boolean {
  if (rule.endsWith(':*')) return segment.startsWith(rule.slice(0, -2))
  if (rule.includes('*')) return new RegExp(`^${rule.split('*').map(escapeRegExp).join('[^]*')}$`).test(segment)
  return segment === rule
}

export function matchesBashRules(command: string, rules: string[]): boolean {
  if (hasSubstitution(command)) return false
  const segments = splitSegments(command)
  return segments.length > 0 && segments.every((segment) => rules.some((rule) => matchesRule(segment, rule.trim())))
}
