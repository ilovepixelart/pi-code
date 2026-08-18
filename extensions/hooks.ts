/**
 * Claude Hooks Extension
 *
 * Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events, so
 * a project's existing hooks work under pi:
 * - PreToolUse      -> pi `tool_call` (can block the tool or rewrite its input), plus
 *                      pi `user_bash` for a `!`/`!!` command the user runs directly (the
 *                      model never issues these, so a deny-list guard would otherwise miss
 *                      them). No pi tool call exists there, so the payload reports the
 *                      Claude name "Bash"; a deny hands pi a synthetic failed result so
 *                      the command never runs. UserBashEvent carries no execution result
 *                      and fires only before the command runs, so it has no PostToolUse
 *                      counterpart (pi never delivers the output to observe).
 * - PostToolUse     -> pi `tool_result` (block reasons and additionalContext are
 *                      appended next to the tool result, as Claude documents)
 * - SessionStart    -> pi `session_start` (stdout/additionalContext is injected as
 *                      context before the first prompt via `before_agent_start`)
 * - UserPromptSubmit-> pi `input` (can block the prompt via `handled`, or inject
 *                      additional context by transforming the submitted text)
 * - Stop            -> pi `agent_end` (a block feeds its reason back as a new turn,
 *                      with stop_hook_active as the loop guard)
 * - PreCompact      -> pi `session_before_compact` (fire-and-forget)
 * - PostCompact     -> pi `session_compact` (fire-and-forget)
 * - PostToolUseFailure -> pi `tool_result` error branch (stderr/additionalContext
 *                      appended to the failed result; it cannot block, the tool failed)
 * - SessionEnd      -> pi `session_shutdown` (fire-and-forget)
 * - InstructionsLoaded -> bridged from the shared instruction-events bus:
 *                      context-imports publishes session_start for the context
 *                      files that survived claudeMdExcludes (it owns exclusion,
 *                      so a file it removed from the prompt never announces)
 *                      and include for resolved @imports; claude-rules publishes
 *                      path_glob_match. Strictly observational: exit codes and
 *                      JSON output, systemMessage included, are ignored.
 *
 * Every payload carries session_id, transcript_path (pi's session file), cwd,
 * permission_mode (plan-mode state off the shared bus) and effort; tool events add
 * tool_use_id. Every event honors the universal `systemMessage` output (a
 * user-facing warning).
 * `suppressOutput` is accepted and inert: pi never echoes hook stdout to the
 * transcript in the first place.
 *
 * SubagentStart/SubagentStop ride pi-code's own subagent extension, which publishes
 * child-run lifecycle on the shared bus (notify-style: a child has already exited by
 * the time SubagentStop fires, so its exit-2 block semantics cannot be honored).
 *
 * Hook commands run via `sh -c` with the event JSON on stdin. A PreToolUse
 * hook blocks the tool by exiting 2 (stderr becomes the reason) or by printing
 * `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}` (or the older
 * `{"decision": "block"}`).
 *
 * Config is merged from ~/.claude/settings.json (always) plus the project's
 * .claude/settings.json and settings.local.json (only when the project is
 * trusted, since hooks execute arbitrary shell). Claude's `disableAllHooks`
 * setting (managed settings or any honored file in that chain) short-circuits
 * the load entirely, so no event fires any hook; /hooks prints the resolved
 * chain per event with each entry's source settings file. Matchers follow Claude's rule:
 * `*`/empty match all, plain names are exact (with `|`/`,` list separators), and
 * anything with other regex characters is an unanchored regex. Claude matchers
 * are PascalCase (`Bash`); pi tool names are lowercase (`bash`), so comparison
 * is case-insensitive and folds `-` to `_`.
 *
 * Docs: https://code.claude.com/docs/en/hooks.md
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runAgent } from './internal/agent-run.js'
import { claudeConfigDir } from './internal/config-dir.js'
import { INSTRUCTIONS_CHANNEL, isInstructionLoadEvent } from './internal/instruction-events.js'
import { readManagedSettings } from './internal/managed-settings.js'
import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from './internal/mcp-alias.js'
import { callMcpTool } from './internal/mcp-call.js'
import { completeText } from './internal/model-complete.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from './internal/plan-mode-state.js'
import { type InstalledPlugin, installedPlugins, substitutePluginVars } from './internal/plugins.js'
import { isProjectApproved } from './internal/project-approval.js'
import { findNearestFile, repoRoot } from './internal/project-root.js'
import { isSubagentPhaseEvent, SUBAGENT_CHANNEL } from './internal/subagent-events.js'

// Claude defaults to 600s and lets a timed-out hook proceed; here a timed-out
// PreToolUse or UserPromptSubmit hook fails closed (pi has no permission prompt
// to fall back on), so ten minutes of default budget would wedge the turn for
// ten minutes on a hung hook. Hooks that legitimately run long can raise their
// own per-hook `timeout`.
const DEFAULT_TIMEOUT_S = 60

interface HookCommand {
  type?: string
  command: string
  /** exec-form: spawn `command` directly with these args and no shell (shell-form when
   * absent). $ARGUMENTS in each arg is replaced with the event JSON. */
  args?: string[]
  timeout?: number
  /** http entries: the endpoint POSTed to; `command` mirrors it for dedup and display. */
  url?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  /** prompt entries: the prompt sent to the model (`$ARGUMENTS` = the event JSON). */
  prompt?: string
  /** mcp_tool entries: the connected server and tool to call, with optional input. */
  server?: string
  tool?: string
  input?: Record<string, unknown>
  /** prompt/agent entries: an optional model override; agent adds a system prompt. */
  model?: string
  systemPrompt?: string
}
export interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}
export type HooksConfig = Record<string, HookMatcher[]>

export interface HookDecision {
  block: boolean
  reason?: string
  /** Claude's `permissionDecision: "ask"`: the caller should prompt the user and
   * block only on decline. `block` stays true as the no-UI fallback. */
  ask?: boolean
}
export interface HookRunResult {
  code: number
  stdout: string
  stderr: string
  /** The hook was killed at its timeout, so its exit code carries no verdict. */
  timedOut: boolean
  /** The process errored before delivering a verdict (spawn failure, EIO). */
  spawnFailed?: boolean
}
/** Runs one configured hook entry, whatever its type; boundRunner dispatches. */
export type HookRunner = (hook: HookCommand, payload: unknown, timeoutMs: number) => Promise<HookRunResult>
/** The shell path specifically; the statusline reuses it for its own command. With an
 * `args` array it becomes the exec path: `command` is spawned directly with those args. */
export type HookCommandRunner = (command: string, payload: unknown, timeoutMs: number, projectDir?: string, args?: string[]) => Promise<HookRunResult>

/** Settings files to read, newest-winning. Project files load only when trusted, each
 * the nearest of its name at or above cwd (bounded at the repository root, matching
 * the approval walk), so a subdirectory session reads the settings that gated it. */
export function hookFiles(cwd: string, home: string, trusted: boolean): string[] {
  const files = [path.join(claudeConfigDir(home), 'settings.json')]
  if (!trusted) return files
  for (const name of ['settings.json', 'settings.local.json']) {
    files.push(findNearestFile(cwd, path.join('.claude', name)) ?? path.join(cwd, '.claude', name))
  }
  return files
}

/** Claude's `disableAllHooks` setting: the escape hatch a user reaches for when a
 * hook misbehaves, so it is honored before any hook runs. Disabled when managed
 * settings or ANY file in the settings chain sets it to `true`; deliberately not
 * last-file-wins, since a repository file re-enabling the hooks the user just
 * disabled in their own settings would defeat the escape hatch. The chain itself
 * already gates project files on trust (see hookFiles). */
export function readDisableAllHooks(files: string[], managed: Record<string, unknown> = readManagedSettings()): boolean {
  if (managed.disableAllHooks === true) return true
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (isRecord(parsed) && parsed.disableAllHooks === true) return true
    } catch {
      // missing or invalid file: skip
    }
  }
  return false
}

/** Claude's `allowedHttpHookUrls` setting: URL patterns http hooks may target, with
 * `*` as a wildcard. Per Claude's documentation: undefined (no source sets the key)
 * means no restrictions, an empty array blocks every http hook, and arrays merge
 * across settings sources. Merging is a union of managed settings plus every file in
 * the chain; the chain already gates project files on trust (see hookFiles), and a
 * trusted project can run arbitrary shell hooks anyway, so letting it extend the
 * allowlist is no escalation. */
export function readAllowedHttpHookUrls(files: string[], managed: Record<string, unknown> = readManagedSettings()): string[] | undefined {
  let found: string[] | undefined
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return
    found = [...(found ?? []), ...value.filter((entry): entry is string => typeof entry === 'string')]
  }
  collect(managed.allowedHttpHookUrls)
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (isRecord(parsed)) collect(parsed.allowedHttpHookUrls)
    } catch {
      // missing or invalid file: skip
    }
  }
  return found
}

/** Whether an http hook may target `url`. `*` in an allowlist entry matches any run
 * of characters; everything else is literal and the whole URL must match. An
 * undefined allowlist means the setting is absent, so there are no restrictions. */
export function httpUrlAllowed(url: string, allowlist: string[] | undefined): boolean {
  if (allowlist === undefined) return true
  return allowlist.some((pattern) => {
    const literal = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    return new RegExp(`^${literal.join('.*')}$`).test(url)
  })
}

export function loadHooks(files: string[], sources?: Map<HookMatcher, string>): HooksConfig {
  const config: HooksConfig = {}
  for (const file of files) {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    mergeHooksJson(config, raw, file, sources)
  }
  return config
}

function mergeHooksJson(config: HooksConfig, raw: string, source: string, sources?: Map<HookMatcher, string>): void {
  let parsed: { hooks?: HooksConfig }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  for (const [event, matchers] of Object.entries(parsed?.hooks ?? {})) {
    if (!Array.isArray(matchers)) continue
    // Entries are validated here rather than where they run: a hand-edited settings
    // file that writes `hooks` as an object instead of a list used to throw out of
    // the tool_call handler, and pi turns that into an error result, so every tool
    // call for the rest of the session failed with an opaque type error.
    const usable = matchers.filter((entry) => isUsableMatcher(entry, source, event))
    if (usable.length === 0) continue
    config[event] = [...(config[event] ?? []), ...usable]
    // Each parse produces fresh entry objects, so object identity keys the /hooks
    // viewer's source attribution without touching the entries themselves.
    for (const entry of usable) sources?.set(entry, source)
  }
}

/** Each enabled plugin's hooks (hooks/hooks.json, or wherever the manifest points),
 * with ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA} substituted before parsing so a
 * hook can name its bundled scripts by real path. */
export function loadPluginHooks(config: HooksConfig, plugins: InstalledPlugin[], sources?: Map<HookMatcher, string>): void {
  for (const plugin of plugins) {
    const declared = plugin.manifest.hooks
    // An inline hooks object; an array is not a valid hooks map (it would parse to
    // numeric event keys), so it falls through to the default path rather than
    // silently registering nothing.
    if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
      mergeHooksJson(config, substitutePluginVars(JSON.stringify({ hooks: declared }), plugin), `${plugin.name} (plugin.json)`, sources)
      continue
    }
    const file = path.resolve(plugin.root, typeof declared === 'string' ? declared : path.join('hooks', 'hooks.json'))
    try {
      mergeHooksJson(config, substitutePluginVars(fs.readFileSync(file, 'utf-8'), plugin), file, sources)
    } catch {
      // a plugin without hooks contributes nothing
    }
  }
}

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

/** A matcher entry pi-code can run: an object whose `hooks` is a list. Anything else
 * is reported by name and skipped, so one bad entry costs its own hooks, not the
 * session's tool calls. */
function isUsableMatcher(entry: unknown, file: string, event: string): entry is HookMatcher {
  const candidate = entry as HookMatcher | null
  if (candidate === null || typeof candidate !== 'object') {
    console.warn(`pi-code-hooks: ignoring a non-object ${event} entry in ${file}`)
    return false
  }
  if (candidate.hooks !== undefined && !Array.isArray(candidate.hooks)) {
    console.warn(`pi-code-hooks: ignoring ${event} entry in ${file}: "hooks" must be a list`)
    return false
  }
  if (candidate.matcher !== undefined && typeof candidate.matcher !== 'string') {
    console.warn(`pi-code-hooks: ignoring ${event} entry in ${file}: "matcher" must be a string`)
    return false
  }
  return true
}

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

/** A hook entry's display identity for the /hooks viewer: the command for shell
 * hooks, otherwise the type-qualified url / prompt / server:tool. A missing field
 * is named rather than hidden, since a misconfigured entry is exactly what the
 * viewer exists to surface. */
function hookIdentity(hook: HookCommand | null | undefined): string {
  // A hand-edited settings file can leave a null (or otherwise empty) entry in a
  // hooks array; name it rather than let it crash the viewer that exists to surface
  // exactly this kind of misconfiguration.
  const record: Partial<HookCommand> = hook ?? {}
  const type = record.type ?? 'command'
  if (type === 'http') return `http: ${record.url ?? record.command ?? '(missing url)'}`
  if (type === 'prompt' || type === 'agent') return `${type}: ${record.prompt ?? record.command ?? '(missing prompt)'}`
  if (type === 'mcp_tool') return `mcp_tool: ${record.server ?? '(missing server)'}:${record.tool ?? '(missing tool)'}`
  return `command: ${record.command ?? '(missing command)'}`
}

/** Render the resolved hooks config as a readable per-event summary for /hooks:
 * one line per configured hook with its matcher, identity and, when known, the
 * settings file it came from. Pure formatting of already-resolved data. */
export function formatHooksSummary(config: HooksConfig, sources?: Map<HookMatcher, string>): string {
  const lines: string[] = []
  for (const [event, matchers] of Object.entries(config)) {
    const entryLines: string[] = []
    for (const entry of matchers) {
      const matcher = entry.matcher || '*'
      const source = sources?.get(entry)
      const suffix = source ? ` (${source})` : ''
      for (const hook of entry.hooks ?? []) {
        entryLines.push(`  [${matcher}] ${hookIdentity(hook)}${suffix}`)
      }
    }
    if (entryLines.length > 0) lines.push(`${event}:`, ...entryLines)
  }
  if (lines.length === 0) return 'No hooks configured. Add a "hooks" section to ~/.claude/settings.json or .claude/settings.json.'
  return lines.join('\n')
}

function tryParseJson(text: string): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; updatedInput?: unknown }; decision?: string; reason?: string; continue?: boolean; stopReason?: string; systemMessage?: string } | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Map a hook's exit code / output to a block-or-allow decision. */
export function interpretHookResult(code: number, stdout: string, stderr: string): HookDecision {
  if (code === 2) return { block: true, reason: stderr.trim() || 'Blocked by hook' }
  const parsed = tryParseJson(stdout)
  const specific = parsed?.hookSpecificOutput
  // Claude's "ask" prompts the user; the tool_call handler turns this into a
  // ctx.ui.confirm and blocks only on decline. block:true is the fallback for a
  // headless run with no dialog to show, which is the safe reading on a gated path.
  if (specific?.permissionDecision === 'ask') return { block: true, ask: true, reason: specific.permissionDecisionReason ?? 'A hook asks you to confirm this tool call.' }
  if (specific?.permissionDecision === 'deny') return { block: true, reason: specific.permissionDecisionReason ?? 'Blocked by hook' }
  if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Blocked by hook' }
  if (parsed?.continue === false) return { block: true, reason: parsed.stopReason ?? 'Blocked by hook' }
  return { block: false }
}

/** Memory backstop for a runaway hook. A decision payload is orders of magnitude smaller. */
const MAX_HOOK_OUTPUT = 1_000_000

/** Conventional exit code for a killed-on-timeout command, as `timeout(1)` reports it. */
const TIMEOUT_EXIT_CODE = 124

/**
 * Kill the shell and everything it spawned. `sh -c 'a; b'` forks, so signalling the
 * direct child alone leaves a grandchild alive holding stdout/stderr.
 */
function killTree(child: ChildProcess): void {
  try {
    // Negative pid targets the whole process group, which `detached` gave the shell.
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
  } catch {
    // Group already reaped, or the platform refused it; fall through to the direct kill.
  }
  child.kill('SIGKILL')
}

export const runHookCommand: HookCommandRunner = (command, payload, timeoutMs, projectDir, args) =>
  new Promise((resolve) => {
    // Absolute path so the shell can't be resolved through an attacker-controlled PATH.
    // `detached` makes the shell its own process group leader so the timeout can kill
    // the descendants too. CLAUDE_PROJECT_DIR is Claude's documented way for a hook to
    // reference project files regardless of the shell's cwd. CLAUDECODE=1 marks every
    // subprocess Claude spawns, so it is set on the child unconditionally.
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1' }
    if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir
    // An exec-form hook (an `args` array) spawns the executable directly with those args
    // and no shell, so shell metacharacters in the args arrive literally; $ARGUMENTS in
    // each arg is replaced with the event JSON by a replacer function (so $$/$& in the
    // payload survive verbatim). Without args it stays the shell path. Both share the
    // same detached process group, so killTree reaches the descendants either way.
    const file = Array.isArray(args) ? command : '/bin/sh'
    const spawnArgs = Array.isArray(args) ? args.map((arg) => substituteArguments(arg, payload)) : ['-c', command]
    const child = spawn(file, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: HookRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // Resolve from the timer itself rather than waiting for `close`: `close` fires only
    // once every stdio pipe is closed, and a grandchild that inherited them can hold the
    // promise pending long past the timeout, stalling the tool call that awaits it.
    const timer = setTimeout(() => {
      killTree(child)
      finish({ code: TIMEOUT_EXIT_CODE, stdout, stderr, timedOut: true })
    }, timeoutMs)
    // Decode on the stream: concatenating Buffers as strings mangles a multi-byte
    // character split across chunks, and a mangled byte in a hook's deny decision makes
    // it unparseable, which reads as an allow.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_HOOK_OUTPUT) stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_HOOK_OUTPUT) stderr += chunk
    })
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr, timedOut: false }))
    // Marked rather than silently read as a clean run: under fd exhaustion a
    // deny-list guard that never spawned would otherwise pass as an allow.
    child.on('error', (error) => finish({ code: 0, stdout, stderr: stderr || error.message, timedOut: false, spawnFailed: true }))
    // A hook that exits without reading stdin (e.g. `exit 2`) closes the pipe first,
    // so ignore EPIPE on this write rather than crashing the host process.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
  })

/** `$VAR` / `${VAR}` in header values, from allowlisted env vars only; a reference
 * to an unlisted variable becomes an empty string, as Claude documents. */
function interpolateHeaders(headers: Record<string, string> | undefined, allowed: string[] | undefined): Record<string, string> {
  const allowedSet = new Set(allowed ?? [])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = value.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_token, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? ''
      return allowedSet.has(name) ? (process.env[name] ?? '') : ''
    })
  }
  return out
}

/**
 * Claude's `type: "http"` hook: the payload POSTs as JSON and only a 2xx response
 * with a valid JSON body renders a decision, read exactly like command stdout.
 * Everything else, including non-2xx statuses, connection failures and timeouts,
 * is a non-blocking error by contract, so none of these outcomes ever reports
 * `timedOut`, which PreToolUse fails closed on. Claude's `allowedHttpHookUrls`
 * allowlist gates the fetch itself: a URL matching no entry is never contacted,
 * so a settings file cannot point a hook at an arbitrary endpoint and exfiltrate
 * the payload; when the setting is absent there are no restrictions, as Claude
 * documents. A blocked hook renders no decision, like every other http failure.
 */
export async function runHttpHook(hook: { type?: string; command: string; url?: string; headers?: Record<string, string>; allowedEnvVars?: string[] }, payload: unknown, timeoutMs: number, allowedUrls?: string[]): Promise<HookRunResult> {
  const url = hook.url ?? hook.command
  if (!httpUrlAllowed(url, allowedUrls)) return { code: 1, stdout: '', stderr: `${url} does not match allowedHttpHookUrls; the hook was not called`, timedOut: false }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...interpolateHeaders(hook.headers, hook.allowedEnvVars) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.text()).slice(0, MAX_HOOK_OUTPUT)
    if (!response.ok) return { code: 1, stdout: '', stderr: `HTTP ${response.status} from ${url}`, timedOut: false }
    if (body.trim().length === 0) return { code: 0, stdout: '', stderr: '', timedOut: false }
    try {
      JSON.parse(body)
    } catch {
      return { code: 1, stdout: '', stderr: `non-JSON response from ${url}`, timedOut: false }
    }
    return { code: 0, stdout: body, stderr: '', timedOut: false }
  } catch (error) {
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false }
  }
}

/** System prompt turning a prompt hook into a structured decision, so its reply
 * flows through interpretHookResult exactly like a command hook's stdout. */
const PROMPT_HOOK_SYSTEM = [
  'You are a Claude Code hook evaluating whether an action should proceed.',
  'Respond with ONLY a JSON object and nothing else:',
  '{"hookSpecificOutput":{"permissionDecision":"allow"|"deny"|"ask","permissionDecisionReason":"<short reason>"}}',
  'Use "allow" to let the action proceed, "deny" to block it, "ask" to require the user to confirm.',
].join('\n')

/**
 * Claude's `type: "prompt"` hook: the prompt (with `$ARGUMENTS` replaced by the
 * event JSON) is evaluated by the model, which returns a JSON decision. pi runs it
 * in-process via completeText and returns the reply as stdout so the existing
 * decision parser handles it. No model (headless) or a provider error is
 * non-blocking; only an abort at the timeout fails closed, like the other hooks.
 */
/** Replace `$ARGUMENTS` with the event JSON via a replacer function, so `$`-sequences
 * in the payload (`$$`, `$&`, `` $` ``, `$'`) are inserted literally, not read as
 * `String.replace` patterns. Prompt and agent hooks feed the result to the model. */
function substituteArguments(prompt: string | undefined, payload: unknown): string {
  const json = JSON.stringify(payload)
  return (prompt ?? '').replaceAll('$ARGUMENTS', () => json)
}

/** Classify a model/agent failure: the deadline is authoritative via the signal (the
 * subagent runner rejects with a plain Error on abort, so an error-name check alone
 * fails open), so a fired signal is a timeout (PreToolUse fails closed); anything else
 * produced no verdict and is non-blocking. */
function abortAwareFailure(signal: AbortSignal, error: unknown): HookRunResult {
  const aborted = signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  return { code: aborted ? TIMEOUT_EXIT_CODE : 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: aborted }
}

export async function runPromptHook(hook: HookCommand, payload: unknown, model: Model<Api> | undefined, timeoutMs: number): Promise<HookRunResult> {
  if (!model) return { code: 1, stdout: '', stderr: 'no model available for prompt hook', timedOut: false }
  // A replacer function, so `$$`/`$&`/`` $` ``/`$'` inside the payload JSON are inserted
  // verbatim rather than read as replacement patterns (a Bash `echo $$` is a common trigger).
  const prompt = substituteArguments(hook.prompt, payload)
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const { text: answer } = await completeText(model, prompt, { system: PROMPT_HOOK_SYSTEM, maxTokens: 512, signal })
    return { code: 0, stdout: answer, stderr: '', timedOut: false }
  } catch (error) {
    return abortAwareFailure(signal, error)
  }
}

/**
 * Claude's `type: "mcp_tool"` hook: call a tool on an already-connected MCP server
 * and treat its text output like command stdout. pi reaches the server through the
 * mcp-call seam the mcp extension registers. Like http, it never fails closed: a
 * missing server, a tool error, or the deadline is non-blocking.
 */
export async function runMcpToolHook(hook: HookCommand, payload: unknown, timeoutMs: number): Promise<HookRunResult> {
  if (!hook.server || !hook.tool) return { code: 1, stdout: '', stderr: 'mcp_tool hook needs server and tool', timedOut: false }
  const input = hook.input && typeof hook.input === 'object' ? hook.input : (payload as Record<string, unknown>)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<HookRunResult>((resolve) => {
    timer = setTimeout(() => resolve({ code: 1, stdout: '', stderr: `mcp_tool hook timed out after ${timeoutMs}ms`, timedOut: false }), timeoutMs)
  })
  const call = callMcpTool(hook.server, hook.tool, input)
    .then((result): HookRunResult => ({ code: result.isError ? 1 : 0, stdout: result.text, stderr: '', timedOut: false }))
    .catch((error): HookRunResult => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false }))
  try {
    return await Promise.race([call, deadline])
  } finally {
    // Left running, the deadline timer pins the event loop for the full timeout
    // after the call resolves, delaying exit in a one-shot headless run.
    clearTimeout(timer)
  }
}

/**
 * Claude's experimental `type: "agent"` hook: spawn a subagent (Read/Grep/Glob) to
 * verify a condition, then return its final text as a JSON decision, parsed by the
 * same interpreter as a command hook. pi reaches the subagent through the agent-run
 * seam the subagent extension registers. Like the prompt hook, only an abort at the
 * deadline fails closed; a missing runner or a crashed agent is non-blocking.
 */
export async function runAgentHook(hook: HookCommand, payload: unknown, timeoutMs: number, sessionModelId: string | undefined): Promise<HookRunResult> {
  const prompt = substituteArguments(hook.prompt, payload)
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const answer = await runAgent({ prompt, model: hook.model ?? sessionModelId, systemPrompt: hook.systemPrompt, signal })
    return { code: 0, stdout: answer, stderr: '', timedOut: false }
  } catch (error) {
    return abortAwareFailure(signal, error)
  }
}

/** The text of the last assistant message in a turn, for Claude's Stop-hook
 * `last_assistant_message`. Thinking and tool calls are dropped; a plain-string
 * content is returned as-is. */
export function lastAssistantText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

/** Claude overrides a Stop hook after it blocks this many times in a row with no user
 * progress, ending the turn with a warning rather than looping forever. */
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8

/** The consecutive-block cap for the Stop hook: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP when it
 * is a positive integer, else the default. A non-positive or malformed value falls back
 * to the default rather than capping at zero (which would suppress the very first block). */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? '', 10)
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_STOP_HOOK_BLOCK_CAP
}

/** Above 2^31-1 ms Node clamps a timer to 1ms, which would kill the hook instantly. */
const MAX_TIMEOUT_S = 2_147_483

function timeoutMs(command: HookCommand): number {
  // Non-positive values fall back to the default: a 0ms timer would fire before the
  // hook runs, and a timed-out PreToolUse hook fails closed, bricking the tool.
  const declared = command.timeout
  const seconds = typeof declared === 'number' && declared > 0 ? Math.min(declared, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S
  return seconds * 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Claude's updatedInput replaces the whole tool_input, and pi's tool_call contract is
 * in-place mutation, so the target object is emptied and refilled rather than reassigned. */
function replaceRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

/** Claude surfaces a hook error notice; on ungated events the action proceeds, while
 * PreToolUse and UserPromptSubmit additionally fail closed on the same results (see
 * their spawnFailed checks). Silence would hide that a guard never ran. */
function surfaceHookFailures(commands: HookCommand[], results: HookRunResult[], notify?: SystemMessageSink): void {
  if (!notify) return
  for (const [i, result] of results.entries()) {
    if (result.spawnFailed) notify(`Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}`)
  }
}

/** Run PreToolUse hooks for a tool, in parallel as Claude does; the first blocking
 * verdict in config order wins. For MCP tools the matcher sees both the pi name and
 * the Claude alias, and the payload reports the alias, which is the name a
 * Claude-written hook script expects in tool_name. Every hook sees the original
 * tool input; hookSpecificOutput.updatedInput replaces the input in place as each
 * hook completes, so with several rewrites the last to finish takes effect, which
 * is Claude's documented (non-deterministic) behavior. */
export async function runPreToolUse(config: HooksConfig, toolName: string, toolInput: unknown, runner: HookRunner, claudeName?: string, onSystemMessage?: SystemMessageSink): Promise<HookDecision> {
  const names = claudeName ? [toolName, claudeName] : [toolName]
  const commands = matchingCommands(config.PreToolUse, names)
  const results = await Promise.all(
    commands.map((command) =>
      runner(command, { hook_event_name: 'PreToolUse', tool_name: claudeName ?? toolName, tool_input: toolInput }, timeoutMs(command)).then((result) => {
        const updated = tryParseJson(result.stdout)?.hookSpecificOutput?.updatedInput
        if (isRecord(updated) && isRecord(toolInput)) replaceRecord(toolInput, updated)
        return result
      }),
    ),
  )
  surfaceHookFailures(commands, results, onSystemMessage)
  for (const [i, result] of results.entries()) {
    // A killed hook never reached its verdict, and SIGKILL leaves a null exit code that
    // would otherwise read as a clean allow. Fail closed instead.
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(commands[i])}ms: ${commands[i].command}` }
    // A hook that never spawned (EMFILE, missing /bin/sh) reached no verdict either;
    // its code 0 must fail closed like a timeout, not read as an allow exactly when
    // the machine is degraded.
    if (result.spawnFailed) return { block: true, reason: `Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}` }
  }
  if (onSystemMessage) surfaceSystemMessages(results, onSystemMessage)
  // A hard deny wins over an ask, matching Claude's deny > ask > allow precedence:
  // scan for any deny first, and only fall back to the first ask.
  let ask: HookDecision | undefined
  for (const result of results) {
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block && !decision.ask) return decision
    if (decision.ask && ask === undefined) ask = decision
  }
  return ask ?? { block: false }
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<HookRunResult[]> {
  return await Promise.all(commands.map((command) => runner(command, payload, timeoutMs(command))))
}

type SystemMessageSink = (message: string) => void

/** Claude's universal systemMessage output field: a warning surfaced to the user. */
function surfaceSystemMessages(results: HookRunResult[], notify: SystemMessageSink): void {
  for (const result of results) {
    const message = tryParseJson(result.stdout)?.systemMessage
    if (message) notify(message)
  }
}

export interface PromptDecision {
  block: boolean
  reason?: string
  context: string
}

/** Additional context a UserPromptSubmit hook contributes: an explicit
 * hookSpecificOutput.additionalContext, or the raw stdout of a plain exit-0 hook. */
function promptContext(stdout: string): string {
  const parsed = tryParseJson(stdout)
  if (parsed) return parsed.hookSpecificOutput?.additionalContext ?? ''
  return stdout.trim()
}

/** Run UserPromptSubmit hooks, in parallel as Claude does: the first blocking
 * verdict in config order wins; otherwise their additional context is concatenated
 * in config order for injection ahead of the prompt. */
export async function runUserPromptSubmit(config: HooksConfig, prompt: string, runner: HookRunner, onSystemMessage?: SystemMessageSink): Promise<PromptDecision> {
  const commands = matchingCommands(config.UserPromptSubmit, 'UserPromptSubmit')
  const results = await Promise.all(commands.map((command) => runner(command, { hook_event_name: 'UserPromptSubmit', prompt }, timeoutMs(command))))
  surfaceHookFailures(commands, results, onSystemMessage)
  for (const [i, result] of results.entries()) {
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(commands[i])}ms: ${commands[i].command}`, context: '' }
    // No verdict was delivered, so fail closed like a timeout (see runPreToolUse).
    if (result.spawnFailed) return { block: true, reason: `Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}`, context: '' }
  }
  if (onSystemMessage) surfaceSystemMessages(results, onSystemMessage)
  const contexts: string[] = []
  for (const result of results) {
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return { block: true, reason: decision.reason, context: '' }
    const context = promptContext(result.stdout)
    if (context) contexts.push(context)
  }
  return { block: false, context: contexts.join('\n') }
}

/** pi's lifecycle vocabularies differ from Claude's documented ones. The matcher is
 * offered both spellings so existing configs keep firing either way, and the payload
 * reports the Claude value, which is what a Claude-written hook script parses. */
const SESSION_START_SOURCE: Record<string, string> = { startup: 'startup', new: 'clear', resume: 'resume', fork: 'fork' }
const PRECOMPACT_TRIGGER: Record<string, string> = { manual: 'manual', threshold: 'auto', overflow: 'auto' }
const SESSION_END_REASON: Record<string, string> = { quit: 'prompt_input_exit', new: 'clear', resume: 'resume', reload: 'other', fork: 'other' }

/** The raw pi value plus its Claude spelling, deduplicated, for matcher candidates. */
function claudeSpelling(map: Record<string, string>, raw: string): { names: string[]; value: string } {
  const value = map[raw] ?? raw
  return { names: value === raw ? [raw] : [raw, value], value }
}

/** The feedback lines one PostToolUse/PostToolUseFailure result appends next to the
 * tool result: a block notice (exit-2 stderr, or decision:block on success) followed
 * by any additionalContext. A failed tool cannot be blocked, so its stderr is shown
 * but never a decision:block verdict. */
function postToolFeedback(result: HookRunResult, eventName: string, isError: boolean): string[] {
  const lines: string[] = []
  const parsed = tryParseJson(result.stdout)
  // A failed tool cannot be blocked, but the hook's stderr is still shown; on
  // success, exit-2 / decision:block feed back as a block notice.
  if (!result.timedOut && result.code === 2) lines.push(`${eventName} hook: ${result.stderr.trim() || (isError ? 'hook reported an error' : 'Blocked by hook')}`)
  else if (!isError && parsed?.decision === 'block') lines.push(`PostToolUse hook: ${parsed.reason ?? 'Blocked by hook'}`)
  const context = parsed?.hookSpecificOutput?.additionalContext
  if (context) lines.push(context)
  return lines
}

/** A blocked tool_call verdict carrying pi 0.84.1's `terminate` flag (#7715): with it set on
 * an all-terminating tool batch, pi skips the automatic follow-up model call that a plain
 * block would otherwise pay for. `terminate` is not on the installed 0.84.0
 * ToolCallEventResult type, so it is attached through this superset shape (rather than a cast
 * that would drop it at runtime); the wave's dep bump to ^0.84.2 lands the real declaration. */
function blockedToolCall(reason: string | undefined): { block: true; reason?: string; terminate: true } {
  return { block: true, reason, terminate: true }
}

export default function hooksExtension(pi: ExtensionAPI) {
  let config: HooksConfig = {}
  let projectDir = ''
  /** Claude's allowedHttpHookUrls allowlist, resolved from the settings chain. */
  let allowedHttpHookUrls: string[] | undefined
  let pendingSessionContext: string[] = []
  let stopHookActive = false
  /** Consecutive Stop-hook blocks with no user progress between them. Reset on user input
   * and on a non-blocking Stop; at the cap the continuation is suppressed and the turn ends. */
  let stopHookBlockCount = 0
  let sessionCtx: ExtensionContext | undefined
  /** Claude's disableAllHooks escape hatch was set somewhere in the honored chain. */
  let hooksDisabled = false
  /** Which settings file each resolved entry came from, for the /hooks viewer. */
  const hookSources = new Map<HookMatcher, string>()
  /** Claude sends session_id, transcript_path, cwd and effort on every payload. */
  const commonPayload = (ctx: ExtensionContext): Record<string, unknown> => {
    const common: Record<string, unknown> = { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, permission_mode: permissionMode }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) common.transcript_path = transcript
    if (ctx.thinkingLevel) common.effort = { level: ctx.thinkingLevel }
    return common
  }
  /** A runner bound to the firing context, filling the common fields into each
   * payload and dispatching on the entry's type. */
  const boundRunner =
    (ctx: ExtensionContext, extra?: Record<string, unknown>): HookRunner =>
    (hook, payload, ms) => {
      const merged = { ...commonPayload(ctx), ...extra, ...(payload as Record<string, unknown>) }
      if (hook.type === 'http') return runHttpHook(hook, merged, ms, allowedHttpHookUrls)
      if (hook.type === 'prompt') return runPromptHook(hook, merged, ctx.model, ms)
      if (hook.type === 'agent') return runAgentHook(hook, merged, ms, (ctx.model as { id?: string } | undefined)?.id)
      if (hook.type === 'mcp_tool') return runMcpToolHook(hook, merged, ms)
      return runHookCommand(hook.command, merged, ms, projectDir, hook.args)
    }
  // Claude matchers name MCP tools mcp__<server>__<tool>; pi-code registers them as
  // <server>_<tool>. The mcp extension publishes the mapping on pi's shared bus.
  const mcpAliases = new Map<string, string>()
  pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
    if (!isMcpToolAliases(data)) return
    mcpAliases.clear()
    for (const entry of data) mcpAliases.set(entry.pi, entry.claude)
  })
  // Claude's permission_mode: pi has no permission system, but pi-code's plan mode is
  // the documented "plan" mode; its extension publishes the state on the shared bus.
  let permissionMode = 'default'
  pi.events.on(PLAN_MODE_CHANNEL, (data) => {
    if (isPlanModeState(data)) permissionMode = data.active ? 'plan' : 'default'
  })
  // Claude's InstructionsLoaded hook has NO decision control: exit codes are
  // ignored and every JSON output field (systemMessage included) is discarded, so
  // dispatch is fire-and-forget on all paths. Two documented load reasons can
  // never fire honestly and are deliberate gaps, not approximations:
  // `nested_traversal` (pi does not lazily load a nested CLAUDE.md on subdirectory
  // entry) and `compact` (pi does not re-load instruction files after compaction).
  const fireInstructionsLoaded = (payload: Record<string, unknown>): void => {
    if (!sessionCtx) return
    const commands = matchingCommands(config.InstructionsLoaded, String(payload.load_reason))
    if (commands.length === 0) return
    void runNotifyHooks(commands, { hook_event_name: 'InstructionsLoaded', ...payload }, boundRunner(sessionCtx)).catch(() => {})
  }
  // Every load rides the shared bus: context-imports publishes session_start for
  // the context files that survived claudeMdExcludes and include for resolved
  // @imports (deduped there, once per file per session); claude-rules publishes
  // path_glob_match when a scoped rule attaches. Consuming the bus rather than
  // iterating raw contextFiles keeps this extension from announcing a file the
  // exclusion removed from the prompt; bus emit is synchronous, so the events
  // arrive regardless of extension load order.
  pi.events.on(INSTRUCTIONS_CHANNEL, (data) => {
    if (!isInstructionLoadEvent(data)) return
    fireInstructionsLoaded({ ...data })
  })

  // Subagent lifecycle arrives over the bus without a pi context; the session context
  // captured at session_start supplies the common payload fields.
  pi.events.on(SUBAGENT_CHANNEL, async (data) => {
    if (!isSubagentPhaseEvent(data) || !sessionCtx) return
    const ctx = sessionCtx
    const eventName = data.phase === 'start' ? 'SubagentStart' : 'SubagentStop'
    const payload = { hook_event_name: eventName, agent_type: data.agentType, agent_id: data.agentId }
    try {
      const results = await runNotifyHooks(matchingCommands(config[eventName], data.agentType), payload, boundRunner(ctx))
      surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    } catch {
      // The bus outlives the session: an event landing between /new disposing this
      // ctx and the next session_start hits disposed getters, and nothing awaits a
      // bus listener, so a throw here would escape as an unhandled rejection.
    }
  })

  pi.on('session_start', async (event, ctx) => {
    sessionCtx = ctx
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while a Stop-hook continuation streak is in flight; it must not
    // carry into the next session, so reset before any early return (disableAllHooks below).
    stopHookActive = false
    stopHookBlockCount = 0
    const trusted = await isProjectApproved(ctx)
    // Claude's CLAUDE_PROJECT_DIR is the project root, not the session cwd; a hook
    // referencing $CLAUDE_PROJECT_DIR/.claude/hooks/helper.sh must resolve from a
    // subdirectory session too.
    projectDir = repoRoot(ctx.cwd) ?? ctx.cwd
    const files = hookFiles(ctx.cwd, os.homedir(), trusted)
    hookSources.clear()
    allowedHttpHookUrls = readAllowedHttpHookUrls(files)
    // The disableAllHooks escape hatch, checked before any config loads: with no
    // config resolved, no event, plugin hooks included, can fire a hook.
    hooksDisabled = readDisableAllHooks(files)
    if (hooksDisabled) {
      config = {}
      pendingSessionContext = []
      return
    }
    config = loadHooks(files, hookSources)
    // Plugins are user-installed and enabled by user settings (see installedPlugins),
    // so a checked-out repo cannot toggle which code-bearing plugin hooks run.
    loadPluginHooks(config, installedPlugins(os.homedir()), hookSources)
    // "reload" re-fires in-process with the same conversation and would double-run hooks;
    // a fork is a genuine session begin, which Claude reports as source "fork".
    if (event.reason === 'reload') return
    const source = claudeSpelling(SESSION_START_SOURCE, event.reason)
    const commands = matchingCommands(config.SessionStart, source.names)
    const payload = { hook_event_name: 'SessionStart', source: source.value }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    pendingSessionContext = results.map((result) => promptContext(result.stdout)).filter(Boolean)
  })

  // Claude adds a SessionStart hook's additionalContext (or plain stdout) to the
  // conversation before the first prompt; pi's seam for that is a message injected
  // on the next agent start. The session_start InstructionsLoaded events arrive
  // over the bus from context-imports, which owns claudeMdExcludes; announcing
  // the raw contextFiles here would fire for a file the exclusion removed.
  pi.on('before_agent_start', async () => {
    if (pendingSessionContext.length === 0) return
    const content = pendingSessionContext.join('\n')
    pendingSessionContext = []
    return { message: { customType: 'claude-hook-context', content, display: false } }
  })

  pi.on('tool_call', async (event, ctx) => {
    const decision = await runPreToolUse(config, event.toolName, event.input, boundRunner(ctx, { tool_use_id: event.toolCallId }), mcpAliases.get(event.toolName), (message) => ctx.ui.notify(message, 'warning'))
    if (!decision.block) return undefined
    // Claude's "ask": prompt the user and let the call through if they approve.
    // With no UI (headless) the block stands, which is the safe default.
    if (decision.ask && ctx.hasUI) {
      const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, decision.reason ?? 'A hook asks you to confirm this tool call.')
      return approved ? undefined : blockedToolCall(decision.reason)
    }
    return blockedToolCall(decision.reason)
  })

  // Claude's PostToolUse (success) and PostToolUseFailure (error) both feed their
  // hook's output back next to the tool result: a decision:block reason (or exit-2
  // stderr) and additionalContext are appended, which is where Claude documents they
  // land. The failure branch shows the hook's stderr to the model too ("Shows stderr
  // to Claude; the tool already failed"), it just cannot block a call that failed.
  pi.on('tool_result', async (event, ctx) => {
    const alias = mcpAliases.get(event.toolName)
    const names = alias ? [event.toolName, alias] : [event.toolName]
    const response = { content: event.content, details: event.details, isError: event.isError }
    const eventName = event.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const commands = matchingCommands(event.isError ? config.PostToolUseFailure : config.PostToolUse, names)
    if (commands.length === 0) return
    const payload = { hook_event_name: eventName, tool_name: alias ?? event.toolName, tool_input: event.input, tool_response: response }
    const run = boundRunner(ctx, { tool_use_id: event.toolCallId })
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    const feedback = results.flatMap((result) => postToolFeedback(result, eventName, event.isError))
    if (feedback.length === 0) return
    return { content: [...event.content, ...feedback.map((text) => ({ type: 'text' as const, text }))] }
  })

  // Claude's PreToolUse for Bash, extended to a command the user runs directly with the
  // `!`/`!!` prefix. pi fires user_bash before executing it, and the model never sees it,
  // so without this a guard that blocks `git push -f` from the model would not stop the
  // same command typed by hand. There is no pi tool call, so the matcher sees both pi's
  // "bash" and the Claude name "Bash" (exactly as an MCP alias is bridged) and the payload
  // reports "Bash", the tool_name a Claude-written PreToolUse Bash hook expects. The
  // payload carries no tool_use_id (no model tool call produced it). UserBashEventResult
  // exposes no block flag: a deny is enforced through `result` ("extension handled
  // execution, use this result"), a synthetic failed BashResult that stands in for the
  // command so it never runs and its deny reason shows as the output. The event delivers
  // no execution result and fires only before the command runs, so there is deliberately
  // no PostToolUse for it.
  pi.on('user_bash', async (event, ctx) => {
    const decision = await runPreToolUse(config, 'bash', { command: event.command }, boundRunner(ctx), 'Bash', (message) => ctx.ui.notify(message, 'warning'))
    if (!decision.block) return undefined
    // Claude's "ask": prompt before running and let the command through on approval; with
    // no UI (headless) the block stands, the same safe default as the tool_call path.
    if (decision.ask && ctx.hasUI) {
      const approved = await ctx.ui.confirm('Allow this command?', decision.reason ?? 'A hook asks you to confirm this command.')
      if (approved) return undefined
    }
    const reason = decision.reason ?? 'Command blocked by hook'
    return { result: { output: `Blocked by hook: ${reason}`, exitCode: 1, cancelled: false, truncated: false } }
  })

  pi.on('input', async (event, ctx) => {
    // Only genuine user input; extension-injected messages (plan-mode, subagent) are not
    // prompts the user submitted.
    if (event.source === 'extension') return { action: 'continue' }
    // Genuine user input is progress, so it breaks a Stop-hook continuation streak: the
    // block cap counts only consecutive blocks with nothing from the user in between.
    stopHookBlockCount = 0
    const decision = await runUserPromptSubmit(config, event.text, boundRunner(ctx), (message) => ctx.ui.notify(message, 'warning'))
    if (decision.block) {
      // pi's input result has no reason channel, so surface why before consuming it.
      ctx.ui.notify(decision.reason ?? 'Prompt blocked by hook', 'error')
      return { action: 'handled' }
    }
    // Claude injects a UserPromptSubmit hook's context ahead of the prompt; transform is
    // pi's seam for rewriting the submitted text.
    if (decision.context) return { action: 'transform', text: `${decision.context}\n\n${event.text}` }
    return { action: 'continue' }
  })

  // Claude's Stop hook can prevent stopping: a block feeds its reason back as a new
  // turn, and stop_hook_active in the payload tells the next firing it is already
  // continuing from a stop hook, which is the hook script's documented loop guard.
  // Only exit 2 and decision:"block" continue; continue:false means "stay stopped".
  //
  // On agent_end rather than agent_settled: agent_settled is only emitted after every
  // agent_end handler returns, and a peer extension (plan mode) blocks its agent_end
  // handler on a UI dialog, which would starve the Stop hook and idle notification
  // until the user answers it. agent_end can fire slightly early before a rare
  // automatic retry or compaction; that is the better tradeoff.
  pi.on('agent_end', async (event, ctx) => {
    // Claude's Notification event, for the one type pi can honestly source: the
    // agent finished and is waiting for input (idle_prompt). Observational only;
    // exit codes and JSON output are ignored, as Claude documents for this event.
    const notifyCommands = matchingCommands(config.Notification, ['idle_prompt'])
    if (notifyCommands.length > 0) {
      void runNotifyHooks(notifyCommands, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'pi is waiting for your input' }, boundRunner(ctx)).catch(() => {})
    }

    const commands = matchingCommands(config.Stop, 'Stop')
    if (commands.length === 0) {
      stopHookActive = false
      return
    }
    // Claude's Stop payload carries the turn's final assistant text so a hook need
    // not re-read the transcript; included only when there is one.
    const lastText = lastAssistantText((event as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [])
    const payload = { hook_event_name: 'Stop', stop_hook_active: stopHookActive, ...(lastText ? { last_assistant_message: lastText } : {}) }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    const block = results
      .filter((result) => !result.timedOut)
      .map((result) => {
        if (result.code === 2) return { block: true, reason: result.stderr.trim() || 'Stop blocked by hook' }
        const parsed = tryParseJson(result.stdout)
        if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Stop blocked by hook' }
        return { block: false, reason: '' }
      })
      .find((verdict) => verdict.block)
    if (!block) {
      // A non-blocking Stop breaks the streak: the next block starts a fresh count.
      stopHookActive = false
      stopHookBlockCount = 0
      return
    }
    stopHookBlockCount += 1
    const cap = stopHookBlockCap()
    if (stopHookBlockCount >= cap) {
      // Claude overrides a Stop hook that has blocked cap times in a row with no user
      // progress: suppress the continuation, warn, and let the turn end so the loop cannot
      // run forever. Reset the count so a later run (or user turn) starts clean.
      stopHookActive = false
      stopHookBlockCount = 0
      ctx.ui.notify(`Stop hook block cap reached (${cap} consecutive blocks); ending the turn.`, 'warning')
      return
    }
    stopHookActive = true
    pi.sendMessage({ customType: 'claude-stop-hook', content: block.reason, display: true }, { triggerTurn: true })
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const trigger = claudeSpelling(PRECOMPACT_TRIGGER, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.PreCompact, trigger.names), { hook_event_name: 'PreCompact', trigger: trigger.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  pi.on('session_compact', async (event, ctx) => {
    const trigger = claudeSpelling(PRECOMPACT_TRIGGER, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.PostCompact, trigger.names), { hook_event_name: 'PostCompact', trigger: trigger.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  pi.on('session_shutdown', async (event, ctx) => {
    const reason = claudeSpelling(SESSION_END_REASON, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.SessionEnd, reason.names), { hook_event_name: 'SessionEnd', reason: reason.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  // Claude's /hooks manages hook configuration; pi-code's is a viewer: hook failures
  // are otherwise opaque, so showing the resolved chain per event, with the settings
  // file each entry came from, is the debugging surface.
  pi.registerCommand('hooks', {
    description: 'Show the hook configuration resolved from settings',
    handler: async (_args, ctx) => {
      if (hooksDisabled) {
        ctx.ui.notify('All hooks are disabled by the disableAllHooks setting.', 'info')
        return
      }
      ctx.ui.notify(formatHooksSummary(config, hookSources), 'info')
    },
  })
}
