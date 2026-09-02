/**
 * Hook configuration: the settings-chain resolution, the hooks loaders (settings
 * files and plugins), the disableAllHooks / allowedHttpHookUrls readers, and the
 * /hooks viewer formatting. Pure config-shape types and loading, no execution.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { readManagedSettings } from '../internal/managed-settings.js'
import { type InstalledPlugin, pluginComponentPath, substitutePluginVars } from '../internal/plugins.js'
import { claudeSettingsChain } from '../internal/settings-chain.js'

export interface HookCommand {
  type?: string
  command: string
  /** exec-form: spawn `command` directly with these args and no shell (shell-form when
   * absent). $ARGUMENTS in each arg is replaced with the event JSON. */
  args?: string[]
  /** Claude's `shell`: "bash" (the default) or "powershell". The default is /bin/sh off
   * Windows; on Windows Git Bash, then PowerShell when Git Bash is absent. Ignored when
   * `args` is set. */
  shell?: string
  timeout?: number
  /** Claude's background contract, honored on `type: "command"` hooks only: `async` runs
   * without blocking its event and with no timeout enforced; `asyncRewake` also runs in
   * the background but keeps its timeout, and wakes the model when the hook exits 2
   * (stderr, or stdout when stderr is empty, feeds back as a new turn). Background hooks
   * render no decision; their JSON `systemMessage`/`additionalContext` reach the model on
   * the next turn, and any still running are killed at session end. */
  async?: boolean
  asyncRewake?: boolean
  /** Claude's permission-rule filter (`"Bash(git *)"`, `"Edit(*.ts)"`): evaluated only
   * on tool events; on any other event a hook carrying `if` never runs. */
  if?: string
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
  /** Dedup scope: unset for settings files (identical handlers collapse across
   * them); a plugin's or skill's copy carries its origin and stays separate. */
  origin?: string
  /** Claude's `once`: remove after the first successful run. Honored only for
   * skill-frontmatter hooks; ignored in settings files and agent frontmatter. */
  once?: boolean
  /** Set after a once-hook's first successful run; collection skips spent hooks. */
  spent?: boolean
}
export interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

/** Whether a hook runs in the background. Claude documents `async`/`asyncRewake` on
 * `type: "command"` hooks only; on any other type the fields are inert and the hook
 * blocks, exactly as Claude runs it. */
export function isBackgroundHook(hook: HookCommand): boolean {
  return (hook.type === undefined || hook.type === 'command') && (hook.async === true || hook.asyncRewake === true)
}
export type HooksConfig = Record<string, HookMatcher[]>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Settings files to read, newest-winning. Project files load only when trusted, each
 * the nearest of its name at or above cwd (bounded at the repository root, matching
 * the approval walk), so a subdirectory session reads the settings that gated it. */
export function hookFiles(cwd: string, home: string, trusted: boolean): string[] {
  return claudeSettingsChain(cwd, home, trusted)
}

/** Claude's `disableAllHooks` setting: the escape hatch a user reaches for when a
 * hook misbehaves, so it is honored before any hook runs. Disabled when managed
 * settings or ANY file in the settings chain sets it to `true`; deliberately not
 * last-file-wins, since a repository file re-enabling the hooks the user just
 * disabled in their own settings would defeat the escape hatch. The chain itself
 * already gates project files on trust (see hookFiles). */
export function readDisableAllHooks(files: string[], managed: Record<string, unknown> = readManagedSettings()): boolean {
  return managed.disableAllHooks === true || readSettingsDisableAllHooks(files)
}

/** The settings-chain half of disableAllHooks alone. Claude: user/project/local
 * disableAllHooks cannot disable hooks configured through managed policy settings,
 * so the caller keeps managed hooks running when only this half is set. */
export function readSettingsDisableAllHooks(files: string[]): boolean {
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

/** Hooks from managed policy settings, one of Claude's hook locations. They run
 * even when user/project/local disableAllHooks is set; only the managed level's
 * own disableAllHooks turns them off (the caller checks that tier). */
export function loadManagedHooks(sources?: Map<HookMatcher, string>, managed: Record<string, unknown> = readManagedSettings()): HooksConfig {
  const config: HooksConfig = {}
  if (isRecord(managed.hooks)) mergeHooksJson(config, JSON.stringify({ hooks: managed.hooks }), 'managed settings', sources)
  return config
}

/** Hooks a skill's frontmatter declares, registered when the skill is invoked and
 * kept for the rest of the session, as Claude documents. They carry a skill origin
 * so dedup keeps them separate from settings copies and `once` is honored. */
export function mergeSkillHooks(config: HooksConfig, skillName: string, hooks: unknown, sources?: Map<HookMatcher, string>): void {
  mergeHooksJson(config, JSON.stringify({ hooks }), `${skillName} (skill)`, sources, `skill:${skillName}`)
}

/** Claude's agent-frontmatter hooks, inside the subagent child: the parent passes
 * them via PI_CODE_AGENT_HOOKS (Stop already converted to SubagentStop), and they
 * run only while this child runs because they die with the process. Returns the
 * agent identity for the child's SubagentStop firing, or undefined outside a
 * subagent or with no hooks passed. */
export function mergeAgentEnvHooks(config: HooksConfig, sources?: Map<HookMatcher, string>): { agent: string; id?: string } | undefined {
  if (process.env.PI_CODE_SUBAGENT !== '1') return undefined
  const raw = process.env.PI_CODE_AGENT_HOOKS
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.agent !== 'string' || !isRecord(parsed.hooks)) return undefined
    mergeHooksJson(config, JSON.stringify({ hooks: parsed.hooks }), `${parsed.agent} (agent)`, sources, `agent:${parsed.agent}`)
    return { agent: parsed.agent, ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}) }
  } catch {
    return undefined
  }
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

/** Claude dedups identical handlers across settings files only; a plugin's copy
 * stays separate, so plugin entries carry their origin into the dedup key. */
function stampOrigin(entries: HookMatcher[], origin: string): void {
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) hook.origin = origin
  }
}

function mergeHooksJson(config: HooksConfig, raw: string, source: string, sources?: Map<HookMatcher, string>, origin?: string): void {
  let parsed: { hooks?: HooksConfig }
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Every hook this source declares is now absent, a policy hook among them, so the
    // failure is named rather than left to look like a file with no hooks in it.
    console.warn(`pi-code-hooks: ignoring the hooks in ${source}: ${error instanceof Error ? error.message : String(error)}`)
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
    if (origin !== undefined) stampOrigin(usable, origin)
    config[event] = [...(config[event] ?? []), ...usable]
    // Each parse produces fresh entry objects, so object identity keys the /hooks
    // viewer's source attribution without touching the entries themselves.
    for (const entry of usable) sources?.set(entry, source)
  }
}

/** Each enabled plugin's hooks (hooks/hooks.json, or wherever the manifest points),
 * with ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA} substituted before parsing so a
 * hook can name its bundled scripts by real path. */
/** The substitution here lands inside raw JSON, so values must arrive escaped:
 * an unescaped Windows root injected \U-style sequences, the parse threw, and
 * every hook the plugin declared silently vanished. */
const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1)

/** A reference Claude refuses to substitute into anything that reaches a shell. */
const USER_CONFIG_REF = /\$\{user_config\./

/**
 * Drop shell-form hook commands that reference `${user_config.*}`. Claude: "Fields that
 * run in a shell reject `${user_config.*}`: substituting a configured value into a shell
 * command would let the shell run whatever that value contains, so the component fails
 * with an error instead." Exec form (`args`) and every other field still substitute, and
 * the documented alternative is reading CLAUDE_PLUGIN_OPTION_<KEY> from the hook's
 * environment. Sibling hooks in the same file are unaffected: one rejected component
 * costs itself, not the plugin's other hooks.
 */
function withoutUserConfigShellCommands(raw: string, source: string): string {
  let parsed: { hooks?: Record<string, unknown> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // mergeHooksJson reports the parse failure
  }
  let dropped = false
  for (const matchers of Object.values(parsed?.hooks ?? {})) {
    if (!Array.isArray(matchers)) continue
    for (const entry of matchers) {
      const record = entry as { hooks?: unknown }
      if (!Array.isArray(record.hooks)) continue
      const kept = record.hooks.filter((hook) => {
        const candidate = hook as { command?: unknown; args?: unknown }
        if (Array.isArray(candidate.args) || typeof candidate.command !== 'string' || !USER_CONFIG_REF.test(candidate.command)) return true
        console.warn(`pi-code-hooks: ignoring a hook in ${source}: a shell-form command cannot reference \${user_config.*}; use exec form with "args", or read CLAUDE_PLUGIN_OPTION_<KEY> from the environment`)
        dropped = true
        return false
      })
      record.hooks = kept
    }
  }
  return dropped ? JSON.stringify(parsed) : raw
}

export function loadPluginHooks(config: HooksConfig, plugins: InstalledPlugin[], sources?: Map<HookMatcher, string>): void {
  for (const plugin of plugins) {
    const declared = plugin.manifest.hooks
    // An inline hooks object; an array is not a valid hooks map (it would parse to
    // numeric event keys), so it falls through to the default path rather than
    // silently registering nothing.
    if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
      const inlineSource = `${plugin.name} (plugin.json)`
      mergeHooksJson(config, substitutePluginVars(withoutUserConfigShellCommands(JSON.stringify({ hooks: declared }), inlineSource), plugin, jsonEscape), inlineSource, sources, `plugin:${plugin.name}`)
      continue
    }
    const file = pluginComponentPath(plugin, typeof declared === 'string' ? declared : path.join('hooks', 'hooks.json'))
    if (file === undefined) continue
    try {
      mergeHooksJson(config, substitutePluginVars(withoutUserConfigShellCommands(fs.readFileSync(file, 'utf-8'), file), plugin, jsonEscape), file, sources, `plugin:${plugin.name}`)
    } catch {
      // a plugin without hooks contributes nothing
    }
  }
}

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
