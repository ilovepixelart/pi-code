/**
 * settings.json `env` injection.
 *
 * Claude Code lets any settings scope carry an `env` object whose keys are exported
 * into the session's environment. This extension applies that chain to process.env:
 * managed-settings.json (enterprise policy), ~/.claude/settings.json (user), the
 * project's .claude/settings.json plus settings.local.json, and the `--settings` flag
 * (internal/cli-settings).
 *
 * Two things run this. The factory body applies managed + user immediately (as pi
 * loads extensions), so those variables are present before the first turn; a session
 * that never approves a project still gets them. session_start refreshes and, only
 * when the project is approved, folds in the project scope. The project scope stays
 * approval-gated on purpose: a checked-out repository's env can redirect providers
 * (ANTHROPIC_BASE_URL and friends), so an untrusted repo must not reach process.env.
 *
 * Precedence is per key, managed > `--settings` > project (settings.local.json
 * overlaying settings.json inside the project scope) > user, matching Claude's
 * settings precedence: a scope only supplies keys it names and never wipes another
 * scope's keys. The flag's env is the user's own input and is not sanitized. Values
 * must be strings; a number or boolean is coerced via String, anything else is
 * skipped.
 *
 * A settings value replaces a value inherited from the shell, as Claude documents
 * ("Claude Code writes each env entry into the process environment, replacing the
 * value inherited from the shell"), and an empty string is the documented way to
 * override an export that cannot be unset. The original value of each key is
 * recorded so a later apply that no longer defines the key restores the shell's
 * value (or deletes a key the shell never had), so an approved project's env
 * cannot leak into a later session or project that does not define it. The keys a
 * repository must not control are dropped from the project scope before any of
 * this (see sanitizeProjectEnv).
 *
 * Docs: https://code.claude.com/docs/en/settings.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readManagedSettings } from './internal/managed-settings.js'
import { approvalRecheck, isProjectApprovedSilently } from './internal/project-approval.js'
import { claudeSettingsChain, claudeSettingsSources, type SettingsScope, type SettingsSource } from './internal/settings-chain.js'
import { watchSettingsFiles } from './internal/settings-watch.js'
import { isRecord } from './internal/values.js'

/** The `env` object of one settings scope, coerced to string values. A string is kept
 * as-is, a number or boolean becomes its String() form, and anything else (object,
 * array, null) is dropped, matching Claude which only injects string-valued env. */
export function envFromSettings(settings: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(settings) || !isRecord(settings.env)) return out
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

/** Merge the env scopes with Claude's per-key settings precedence managed >
 * `--settings` > project > user: lower scopes are laid down first and higher ones
 * overlay, so each key takes its highest-precedence value and no scope wipes
 * another's keys. */
export function mergeEnvScopes(managed: Record<string, string>, user: Record<string, string>, project: Record<string, string>, flag: Record<string, string> = {}): Record<string, string> {
  return { ...user, ...project, ...flag, ...managed }
}

/** Assign the merged env into `env`. Every settings value applies, replacing a
 * shell-inherited value, as Claude documents; an empty string is the documented
 * override for an export that cannot be unset. `owned` records each key's original
 * value at first ownership, so a later apply that drops the key restores the
 * shell's value (or deletes a key the shell never had) rather than leaking a stale
 * setting into the rest of the process. */
export function applyEnvSettings(merged: Record<string, string>, env: NodeJS.ProcessEnv, owned: Map<string, string | undefined>): void {
  // Restore any key an earlier apply set that the current merge dropped. Iterate a
  // copy since `owned` is mutated.
  for (const [key, original] of Array.from(owned.entries())) {
    if (key in merged) continue
    if (original === undefined) delete env[key]
    else env[key] = original
    owned.delete(key)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!owned.has(key)) owned.set(key, env[key])
    env[key] = value
  }
}

function readSettingsFile(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (isRecord(parsed)) return parsed
  } catch {
    // missing or invalid file: no env from this scope
  }
  return {}
}

/** The env of the chain entries in the given scopes, later files winning. */
function scopeEnv(sources: SettingsSource[], scopes: readonly SettingsScope[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const source of sources) {
    if (scopes.includes(source.scope)) Object.assign(merged, envFromSettings(readSettingsFile(source.file)))
  }
  return merged
}

/** Keys a checked-out repository must not control even once trusted, per Claude's
 * documented drop list: variables that choose where config and files are written
 * (redirecting later home-scope reads and every subprocess), variables that export
 * session content, and variables that change how the agent starts or syncs.
 * PI_CODING_AGENT_DIR is pi's own config-dir analogue of CLAUDE_CONFIG_DIR, and the
 * PI_CODE_ prefix covers pi-code's own control variables (see isRepoHostileEnvKey). */
const REPO_HOSTILE_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'OTEL_LOG_RAW_API_BODIES',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_SYNC_PLUGINS',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'PI_CODING_AGENT_DIR',
])

/** Whether a repository's settings must not set this key: Claude's documented drop list,
 * the XDG_ family, and pi-code's own PI_CODE_ control variables. The last matter because
 * they are read as instructions rather than data: PI_CODE_SUBAGENT makes a session believe
 * it is a subagent child, which suppresses the USER's own SessionStart, UserPromptSubmit,
 * Stop and SessionEnd hooks and their auto memory, and PI_CODE_AGENT_HOOKS is then parsed
 * into hook definitions, which are shell commands. Approving a repository means running the
 * config it ships, never silently disabling the user's own guardrails. */
function isRepoHostileEnvKey(key: string): boolean {
  return REPO_HOSTILE_ENV_KEYS.has(key) || key.startsWith('XDG_') || key.startsWith('PI_CODE_')
}

/** Drop the keys a repository's settings must not set, warning each, as Claude
 * documents ("Claude Code drops each one and logs a warning"). Set them in the
 * shell, user settings, or managed settings instead. */
export function sanitizeProjectEnv(env: Record<string, string>, warn: (key: string) => void = (key) => console.warn(`pi-code-env: dropping ${key} from project settings env (a checked-out repository must not control it; set it in user or managed settings)`)): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (isRepoHostileEnvKey(key)) warn(key)
    else kept[key] = value
  }
  return kept
}

export default function envSettingsExtension(pi: ExtensionAPI) {
  const owned = new Map<string, string | undefined>()
  /** Stops the watcher of the previous session, as the hooks extension does. */
  let disposeWatch: () => void = () => {}

  /** Every scope resolved through the shared chain, so placement and the
   * `--setting-sources` filter match every other consumer: the shared settings.json
   * comes from the session's own directory and never an ancestor, settings.local.json
   * from the repository root. The project scope is read only when approved. */
  const apply = (home: string, cwd: string, approved: boolean): void => {
    const sources = claudeSettingsSources(cwd, home, approved)
    const project = sanitizeProjectEnv(scopeEnv(sources, ['project', 'local']))
    applyEnvSettings(mergeEnvScopes(envFromSettings(readManagedSettings()), scopeEnv(sources, ['user']), project, scopeEnv(sources, ['flag'])), process.env, owned)
  }

  // Factory time: managed + user only. Approval needs the session ctx, so the project
  // scope waits for session_start; running here means these vars land before the first
  // turn. pi parses flags after loading, so the --settings level also waits.
  apply(os.homedir(), process.cwd(), false)

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const home = os.homedir()
    const approved = isProjectApprovedSilently(ctx)
    // The watcher's reapply closes over the cwd value, never ctx: the poll has no awaiter,
    // and every getter of a replaced session's ctx throws, which would exit pi.
    const cwd = ctx.cwd
    // A reload asks again rather than reusing `approved`: see approvalRecheck.
    const stillApproved = approvalRecheck(ctx)
    const reapply = (): void => apply(home, cwd, approved && stillApproved())
    reapply()
    // Claude: "Claude Code watches your settings files and reloads them when they change,
    // so it applies most edits to the running session without a restart." `env` is not
    // one of the restart-only keys (model, effortLevel/modelSettings, outputStyle), so an
    // edit has to reach process.env now rather than at the next session. applyEnvSettings
    // tracks what it owns, so a key removed from the file is restored, not left behind.
    disposeWatch()
    disposeWatch = watchSettingsFiles(claudeSettingsChain(cwd, home, approved), reapply)
  })

  pi.on('session_shutdown', async () => {
    disposeWatch()
    disposeWatch = () => {}
    // pi's CLI loads a fresh extension instance for every session replacement, and its
    // empty `owned` cannot restore what this one set: everything is handed back here, and
    // the next instance re-applies managed and user env at factory time, as at startup.
    applyEnvSettings({}, process.env, owned)
  })
}
