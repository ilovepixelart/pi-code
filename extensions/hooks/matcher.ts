/**
 * The matcher engine: compiling a Claude matcher string (exact-name list or regex)
 * to a memoized form, testing it against tool/source names, and resolving the hook
 * commands an event fires. Owns the module-level compiled-matcher cache.
 */

import type { HookCommand, HookMatcher } from './config.js'

/** Claude's rule: a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|`
 * is a list of exact names; anything else is an unanchored regex. */
const EXACT_MATCHER = /^[\w\- ,|]*$/

/** Claude names are PascalCase and keep dashes (`Bash`, `mcp__brave-search__x`);
 * pi names are lowercase with underscores, so comparison folds both. */
function foldName(name: string): string {
  return name.toLowerCase().replaceAll('-', '_')
}

/** A matcher string's compiled form: a set of folded exact names, or a regex. */
type CompiledMatcher = { tokens: Set<string> } | { regex: RegExp }

function exactTokens(matcher: string): Set<string> {
  return new Set(
    matcher
      .split(/[|,]/)
      .map((token) => foldName(token.trim()))
      .filter(Boolean),
  )
}

/** Hook config is static per session and dispatch consults every matcher on every
 * event, so each matcher string compiles once. Matchers are few; the bound is a
 * safety net, clearing the (cheap to rebuild) cache rather than evicting. */
const compiledMatchers = new Map<string, CompiledMatcher>()
const COMPILED_MATCHER_BOUND = 1000

let matcherCompiles = 0

/** Test seam: matcher compilations performed, for asserting memoization. */
export function matcherCompileCount(): number {
  return matcherCompiles
}

/** Test seam: drop compiled matchers so a test observes fresh compiles. */
export function resetMatcherCache(): void {
  compiledMatchers.clear()
  matcherCompiles = 0
}

function compileMatcher(matcher: string): CompiledMatcher {
  const cached = compiledMatchers.get(matcher)
  if (cached !== undefined) return cached
  matcherCompiles += 1
  let compiled: CompiledMatcher
  if (EXACT_MATCHER.test(matcher)) {
    compiled = { tokens: exactTokens(matcher) }
  } else {
    try {
      compiled = { regex: new RegExp(matcher, 'i') }
    } catch {
      // An invalid regex matcher falls back to exact-name matching, as before.
      compiled = { tokens: exactTokens(matcher) }
    }
  }
  if (compiledMatchers.size >= COMPILED_MATCHER_BOUND) compiledMatchers.clear()
  compiledMatchers.set(matcher, compiled)
  return compiled
}

function matcherApplies(matcher: string | undefined, names: readonly string[]): boolean {
  if (!matcher || matcher === '*') return true
  const compiled = compileMatcher(matcher)
  if ('regex' in compiled) {
    const { regex } = compiled
    return names.some((name) => regex.test(name))
  }
  const { tokens } = compiled
  return names.some((name) => tokens.has(foldName(name)))
}

/** A hook entry pi-code can run: a shell command, an http POST, an in-process
 * prompt, an mcp_tool call, or an agent subagent. An agent hook with no runner
 * registered is still matched here and resolves non-blocking at run time, the same
 * way a prompt hook with no model does. */
function isRunnableHook(hook: HookCommand): boolean {
  if (hook.type === 'http') return typeof hook.url === 'string' && /^https?:\/\//.test(hook.url)
  if (hook.type === 'prompt' || hook.type === 'agent') return typeof hook.prompt === 'string' && hook.prompt.length > 0
  if (hook.type === 'mcp_tool') return typeof hook.server === 'string' && typeof hook.tool === 'string'
  return typeof hook.command === 'string' && (hook.type === undefined || hook.type === 'command')
}

/** The synthetic identity of a non-shell hook entry: an http/prompt/agent/mcp_tool
 * entry has no `command`, so its url / prompt / server:tool stands in. A shell hook
 * (undefined or `command` type) already has one, so this is undefined. */
function syntheticCommand(hook: HookCommand): string | undefined {
  if (hook.type === 'http') return hook.url
  if (hook.type === 'prompt' || hook.type === 'agent') return hook.prompt
  if (hook.type === 'mcp_tool') return `${hook.server}:${hook.tool}`
  return undefined
}

/** A matched entry with its `command` filled in: mirroring the synthetic identity into
 * `command` keeps dedup, timeout messages and display working for non-shell hooks. */
function withCommand(raw: HookCommand): HookCommand {
  const identity = syntheticCommand(raw)
  return identity !== undefined && typeof raw.command !== 'string' ? { ...raw, command: identity } : raw
}

/** Command specs whose matcher applies to any of the given tool/source names.
 * Multiple candidates let one event offer both the pi name and its Claude alias. */
export function matchingCommands(matchers: HookMatcher[] | undefined, names: string | readonly string[]): HookCommand[] {
  const candidates = typeof names === 'string' ? [names] : names
  const result: HookCommand[] = []
  const seen = new Set<string>()
  for (const entry of matchers ?? []) {
    if (!matcherApplies(entry.matcher, candidates)) continue
    for (const raw of (entry.hooks ?? []).filter(isRunnableHook)) {
      const hook = withCommand(raw)
      // Claude runs a handler defined in more than one settings file once.
      if (seen.has(hook.command)) continue
      seen.add(hook.command)
      result.push(hook)
    }
  }
  return result
}
