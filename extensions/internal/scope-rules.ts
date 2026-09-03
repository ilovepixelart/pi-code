/**
 * Claude's argument scopes for the two tools whose specifier is neither a bash
 * command nor a file path: `WebFetch(domain:host)` and `Agent(AgentName)`.
 *
 * pi's active-tool set has no argument dimension, so commands.ts grants the base
 * tool and checks each call here, the way it already does for `Bash(...)` scopes.
 * Both matchers fail closed: a scope this module cannot interpret matches nothing
 * rather than reading as the unscoped grant the author did not write.
 *
 * Claude's parameter form `Tool(param:value)` is deliberately absent. The
 * permissions reference restricts it to deny and ask rules ("An allow rule for one
 * parameter value wouldn't establish that the call is safe overall, so allow rules
 * continue to use each tool's own specifier syntax"), and every scope reaching this
 * module comes from an allow surface: a command's `allowed-tools`.
 */

/** Regex specials except `*`, which carries the rule's own wildcard meaning. */
const escapeExceptStar = (text: string): string => text.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)

/** A hostname pattern segment: `*` matches any text that does not cross a dot. */
const hostPattern = (pattern: string): string => escapeExceptStar(pattern).replaceAll('*', '[^.]*')

/** Lowercased, with the trailing `.` the reference strips from both sides removed. */
const canonicalHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '')

/** The hostname of a fetch target, or '' when the url does not parse. */
function hostnameOf(url: string): string {
  try {
    return canonicalHost(new URL(url).hostname)
  } catch {
    return ''
  }
}

/** The host pattern of one `domain:` scope, or undefined for any other spelling.
 * WebFetch has exactly one documented specifier syntax, so an unrecognized scope is
 * not a wider grant, it is a rule that matches nothing. */
function domainPattern(rule: string): string | undefined {
  const trimmed = rule.trim()
  const colon = trimmed.indexOf(':')
  if (colon === -1 || trimmed.slice(0, colon).trim().toLowerCase() !== 'domain') return undefined
  const pattern = canonicalHost(trimmed.slice(colon + 1))
  return pattern === '' ? undefined : pattern
}

function matchesDomainRule(host: string, rule: string): boolean {
  const pattern = domainPattern(rule)
  if (pattern === undefined) return false
  if (pattern === '*') return true
  // A leading `*.` is the one wildcard that crosses dots: it stands for one or more
  // whole labels, so it covers `a.b.example.com` while leaving the apex unmatched.
  if (pattern.startsWith('*.')) return new RegExp(String.raw`^(?:[^.]+\.)+${hostPattern(pattern.slice(2))}$`).test(host)
  return new RegExp(`^${hostPattern(pattern)}$`).test(host)
}

/**
 * Claude: "WebFetch rules use a `domain:` prefix and match against the hostname of
 * the requested URL. Matching is case-insensitive, supports `*` wildcards, and strips
 * a trailing `.` from both the rule and the hostname."
 */
export function matchesDomainRules(url: string, rules: string[]): boolean {
  const host = hostnameOf(url)
  if (host === '') return false
  return rules.some((rule) => matchesDomainRule(host, rule))
}

/**
 * Claude: "Permission syntax: `Skill(name)` for exact match, `Skill(name *)` for
 * prefix match with any arguments."
 *
 * The invocation is the skill name and its arguments as one string, the shape pi's
 * `slash_command` tool takes; a leading `/` is optional there, so it is stripped
 * before matching. Only the two documented forms are interpreted. A rule spelled any
 * other way, `commit:*` included, matches nothing rather than widening the grant.
 */
export function matchesSkillRules(invocation: string, rules: string[]): boolean {
  const call = invocation.trim().replace(/^\//, '').trim()
  if (call === '') return false
  return rules.some((raw) => {
    const rule = raw.trim()
    if (rule === '') return false
    if (!rule.endsWith(' *')) return rule === call
    // The space before the trailing `*` is part of the rule, so `review-pr *` covers
    // `review-pr` and `review-pr 123` but never the longer name `review-pretend`.
    const prefix = rule.slice(0, -2).trimEnd()
    return prefix !== '' && (call === prefix || call.startsWith(`${prefix} `))
  })
}

/** The `agent` of one call or task entry, when it has one. */
const agentNameOf = (value: unknown): string | undefined => {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  return typeof record?.agent === 'string' ? record.agent : undefined
}

/** Every agent name one subagent call names, across all three modes: `agent` for
 * single, and the `agent` of each entry in `tasks` (parallel) or `chain` (sequential).
 * One collector, so a rule checked against single mode cannot be quietly skipped for
 * the two modes that carry their names in an array. */
export function agentNamesIn(input: unknown): string[] {
  const raw = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const listed = ['tasks', 'chain'].flatMap((key) => (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []))
  return [input, ...listed].map(agentNameOf).filter((name): name is string => name !== undefined)
}

/**
 * Claude: "Use `Agent(AgentName)` rules to control which subagents Claude can use."
 *
 * Every agent the call names must match, not just the first. A subagent call carries
 * names in `agent`, `tasks[].agent` and `chain[].agent`; gating one field would let
 * parallel or chain mode route around the rule. A call naming no agent cannot be
 * checked against the scope, so it fails closed too.
 */
export function matchesAgentRules(names: string[], rules: string[]): boolean {
  if (names.length === 0) return false
  return names.every((name) => rules.some((rule) => rule.trim() !== '' && rule.trim() === name.trim()))
}
