/**
 * Claude Commands Extension
 *
 * Registers Claude Code's custom slash commands with pi directly, rather than
 * handing `.claude/commands` to pi's prompt-template loader. Owning registration
 * is what makes the rest of Claude's command contract reachable: `$ARGUMENTS` and
 * positional substitution, `` !`cmd` `` bash output, `@file` inlining, subdirectory
 * commands (named by file name alone, as Claude documents; subdirectories only
 * organize the files), and the
 * `allowed-tools`, `argument-hint` and `model` frontmatter (`model` switches the
 * session model for the command's run via `pi.setModel`, restored on agent_end).
 * `shell: powershell` runs a command's injected spans through PowerShell when a
 * pwsh binary is installed, falling back to /bin/sh so the command still works
 * without one.
 *
 * Commands are also exposed to the model through a `slash_command` tool
 * (Claude's SlashCommand tool), listing every discovered command whose file
 * does not set `disable-model-invocation: true`. Only the command files this
 * extension discovers are listed: pi built-ins and pi-code's own UI commands
 * are user surfaces, not model surfaces. The model path is expansion only: the
 * expanded body comes back as the tool result (sendUserMessage would spawn a
 * second turn), `allowed-tools`/`disallowed-tools`/`model:` are not applied
 * (applying them from inside a tool call would narrow the running batch and
 * scope unrelated parallel tool calls, and the agent_end restore would lift
 * the grant before the next model step could rely on it), and `!` spans are
 * never executed on the model's demand: pi has no permission engine to gate
 * repo-authored shell, so each span is replaced with Claude's
 * "[shell command execution disabled by policy]" placeholder. The same
 * placeholder is applied on every path when the `disableSkillShellExecution`
 * settings key is set (user settings always, project settings when trusted,
 * managed-settings.json as policy).
 *
 * A project command body is repository-controlled text that can run shell
 * commands and read files, so project commands load only once the project is
 * approved. That closes the "skills / commands are not trust-gated" limitation
 * for commands; skills remain pi-loader territory.
 *
 * Docs: https://code.claude.com/docs/en/slash-commands.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { matchesBashRules } from './internal/bash-rules.js'
import { type CommandExec, type DiscoveredCommand, discoverCommandFiles, expandDynamicContent, type ParsedCommand, type PathRuleTool, parseCommandFile, resolvePowershellBinary, spanExec, substituteArgsDetailed, substituteVars } from './internal/command-file.js'
import { claudeConfigDir } from './internal/config-dir.js'
import { managedSettingsFile, readManagedSettings } from './internal/managed-settings.js'
import { capForContext } from './internal/output-guard.js'
import { matchesPathRules } from './internal/path-rules.js'
import { type InstalledPlugin, installedPlugins } from './internal/plugins.js'
import { isProjectApproved } from './internal/project-approval.js'
import { ancestorDirs, repoRoot } from './internal/project-root.js'
import { claudeSettingsChain } from './internal/settings-chain.js'
import { createTurnOverride } from './internal/turn-override.js'

/** Just enough of pi's Model to match and restore; getAvailable returns these. */
interface ModelLike {
  id: string
  name?: string
  contextWindow?: number
}

/** Resolve a command's `model:` frontmatter to an available model. Claude accepts a
 * tier alias (sonnet/opus/haiku/fable), a concrete id, or `inherit`; pi matches by
 * exact id first, then a substring of the id or name (the same fuzzy rule the
 * subagent uses). `inherit` and an unresolvable name leave the model unchanged. */
function resolveCommandModel(model: string | undefined, available: ReadonlyArray<ModelLike>): ModelLike | undefined {
  if (!model || model.toLowerCase() === 'inherit') return undefined
  const needle = model.toLowerCase()
  return available.find((m) => m.id.toLowerCase() === needle) ?? available.find((m) => m.id.toLowerCase().includes(needle) || (m.name ?? '').toLowerCase().includes(needle))
}

/** Substitute ${CLAUDE_*} into a path rule. A variable that expands to an absolute
 * path at the anchor position (e.g. Read(${CLAUDE_PROJECT_DIR}/docs/**)) names that
 * exact location, so it is marked with Claude's `//` filesystem-absolute anchor;
 * otherwise resolveRule reads the single leading slash as project-relative and
 * re-anchors it under the project root, where it can never match. */
function substitutePathRule(rule: string, vars: Record<string, string | undefined>): string {
  const substituted = substituteVars(rule, vars)
  return rule.trimStart().startsWith('${CLAUDE_') && path.isAbsolute(substituted) ? `/${substituted}` : substituted
}

/** The path rules that survive an allowed-tools intersection: only the tools the
 * grant kept get their scopes, each rule ${CLAUDE_*}-substituted like the body. */
function scopedPathRules(pathRules: Partial<Record<PathRuleTool, string[]>>, granted: string[], vars: Record<string, string | undefined>): Partial<Record<PathRuleTool, string[]>> {
  const result: Partial<Record<PathRuleTool, string[]>> = {}
  for (const [tool, rules] of Object.entries(pathRules)) {
    if (granted.includes(tool)) result[tool as PathRuleTool] = rules.map((rule) => substitutePathRule(rule, vars))
  }
  return result
}

/** Wall-clock budget for one injected span: the Bash tool's documented 2-minute
 * default, which is what Claude runs these commands under. */
const BASH_TIMEOUT_MS = 120_000

/** Context fields pi provides that Claude's ${CLAUDE_*} variables read from. */
interface VarContext {
  sessionManager?: { getSessionId?: () => string }
  thinkingLevel?: string
  model?: ModelLike
  modelRegistry?: { getAvailable(): ReadonlyArray<ModelLike> }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Existing `.claude/commands` directories in Claude's precedence order (later
 * directories win in collectCommands): project first, then personal, then the
 * enterprise directory beside the managed settings file, per "enterprise
 * overrides personal, and personal overrides project". The project directories
 * are included only for approved projects. */
export function commandDirs(cwd: string, home: string, trusted: boolean): string[] {
  const candidates: string[] = []
  // Claude scans every .claude/commands between cwd and the repository root, the
  // nearest winning an intra-project name clash: root-first with the nearest last.
  if (trusted) candidates.push(...ancestorDirs(cwd, path.join('.claude', 'commands')).reverse())
  candidates.push(path.join(claudeConfigDir(home), 'commands'), path.join(path.dirname(managedSettingsFile()), '.claude', 'commands'))
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}

/** All commands across the given directories, later directories winning by name. */
export function collectCommands(dirs: string[]): DiscoveredCommand[] {
  const byName = new Map<string, DiscoveredCommand>()
  for (const dir of dirs) {
    for (const found of discoverCommandFiles(dir)) byName.set(found.name, found)
  }
  return [...byName.values()]
}

/** A plugin's command files, namespaced `plugin:name` as Claude registers them.
 * The manifest may point `commands` somewhere else; the default is `commands/`. */
function pluginCommands(plugins: InstalledPlugin[]): DiscoveredCommand[] {
  const found: DiscoveredCommand[] = []
  for (const plugin of plugins) {
    const declared = plugin.manifest.commands
    const dirs = (Array.isArray(declared) ? declared : [typeof declared === 'string' ? declared : 'commands']).map((entry) => path.resolve(plugin.root, String(entry)))
    for (const dir of dirs) {
      for (const command of discoverCommandFiles(dir)) {
        found.push({ name: `${plugin.name}:${command.name}`, filePath: command.filePath, plugin: { root: plugin.root, dataDir: plugin.dataDir, ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}) } })
      }
    }
  }
  return found
}

/** Claude's replacement text for a `!` span it refuses to execute. */
export const SHELL_DISABLED_PLACEHOLDER = '[shell command execution disabled by policy]'

type CommandPlugin = NonNullable<DiscoveredCommand['plugin']>

/**
 * Whether `disableSkillShellExecution` is set: the Claude settings key that
 * replaces every `` !`cmd` `` and ```` ```! ```` span in skills and custom
 * commands with SHELL_DISABLED_PLACEHOLDER instead of executing it. Read from
 * user settings always, the project's settings.json/settings.local.json only
 * when the project is trusted, and managed-settings.json as policy. Any layer
 * setting it true wins: a repository's `false` must not lift the user's or the
 * organization's policy, so this fails closed rather than last-file-wins.
 */
export function shellExecutionDisabled(cwd: string, home: string, trusted: boolean): boolean {
  if (readManagedSettings().disableSkillShellExecution === true) return true
  const files = claudeSettingsChain(cwd, home, trusted)
  return files.some((file) => {
    try {
      return (JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>).disableSkillShellExecution === true
    } catch {
      return false // missing or invalid file: not a policy statement
    }
  })
}

/** The ${CLAUDE_*} substitution sources for one command invocation. */
function commandVars(ctx: { cwd: string }, filePath: string, plugin?: CommandPlugin): Record<string, string | undefined> {
  const varCtx = ctx as unknown as VarContext
  return {
    CLAUDE_SESSION_ID: varCtx.sessionManager?.getSessionId?.(),
    CLAUDE_EFFORT: varCtx.thinkingLevel,
    CLAUDE_SKILL_DIR: path.dirname(filePath),
    CLAUDE_PROJECT_DIR: repoRoot(ctx.cwd) ?? ctx.cwd,
    CLAUDE_PLUGIN_ROOT: plugin?.root,
    CLAUDE_PLUGIN_DATA: plugin?.dataDir,
  }
}

/** The exec seam expandCommand runs spans through; pi itself satisfies it. */
interface SpanRunner {
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>
}

/**
 * A command body expanded to the text a turn (or a tool result) carries:
 * argument and named substitution, ${CLAUDE_*} and plugin variables, `!` spans
 * and `@file` inlining, plus Claude's `ARGUMENTS:` append when the body never
 * read what was passed. Throws when an injected span fails, so a caller never
 * sees a half-expanded body. With `allowShell: false` no span executes at all;
 * each is replaced by SHELL_DISABLED_PLACEHOLDER, which is how both the model
 * path and the disableSkillShellExecution setting keep repo-authored shell
 * from running.
 */
export async function expandCommand(runner: SpanRunner, parsed: ParsedCommand, args: string, ctx: { cwd: string }, filePath: string, plugin?: CommandPlugin, options?: { allowShell?: boolean }): Promise<string> {
  const projectRoot = repoRoot(ctx.cwd) ?? ctx.cwd
  const vars = commandVars(ctx, filePath, plugin)
  const { text: withArgs, consumed } = substituteArgsDetailed(parsed.body, args, parsed.argumentNames ?? [])
  // `${user_config.KEY}` is a plugin-command variable only; leave it literal in an
  // ordinary command so a body that happens to contain the syntax is not stripped.
  const substituted = substituteVars(withArgs, vars)
  const withVars = plugin ? substituted.replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => plugin.userConfig?.[key] ?? '') : substituted

  const exec: CommandExec =
    (options?.allowShell ?? true)
      ? async (script) => {
          // Hooks get CLAUDE_PROJECT_DIR, and a command's shell span is the same kind of
          // project-scoped script. pi.exec takes no env, so it is set in the script.
          // stderr merges into stdout, as the Bash tool runs these for Claude. The
          // resolver is passed by its imported binding so tests can stub the lookup.
          const run = spanExec(parsed.shell, projectRoot, script, resolvePowershellBinary)
          const result = await runner.exec(run.command, run.args, { cwd: ctx.cwd, timeout: BASH_TIMEOUT_MS })
          // pwsh cannot merge a native command's stderr in-script (spanExec sets
          // mergeStreams), so it is appended here; the sh script merges via 2>&1.
          const stdout = run.mergeStreams ? result.stdout + result.stderr : result.stdout
          return { stdout, stderr: result.stderr, code: result.code }
        }
      : async () => ({ stdout: SHELL_DISABLED_PLACEHOLDER, stderr: '', code: 0 })
  let expanded = await expandDynamicContent(withVars, ctx.cwd, exec, parsed.shell === 'powershell' ? 'powershell' : 'bash')

  // Claude appends the raw arguments when the command never read them, so what
  // the user typed still reaches the model.
  if (args.trim().length > 0 && !consumed) expanded += `\n\nARGUMENTS: ${args.trim()}`
  return expanded
}

export interface SlashCommandEntry {
  name: string
  description: string
  argumentHint?: string
  /** `when_to_use:` trigger text, appended to this entry's line in the tool listing. */
  whenToUse?: string
}

/** One listed command's cap inside the tool description, as Claude cuts an
 * oversized description rather than dropping the command. */
const ENTRY_CHAR_CAP = 1536

/** Claude's default character budget for the SlashCommand tool description. */
const DEFAULT_TOOL_CHAR_BUDGET = 15_000

/** The description budget: SLASH_COMMAND_TOOL_CHAR_BUDGET when set, else about
 * 1% of the model's context window (1% of the tokens at ~4 characters per token
 * is window / 25), else Claude's documented default. */
export function slashCommandBudget(contextWindow: number | undefined, env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.SLASH_COMMAND_TOOL_CHAR_BUDGET ?? '', 10)
  if (Number.isInteger(override) && override > 0) return override
  if (contextWindow && contextWindow > 0) return Math.floor(contextWindow / 25)
  return DEFAULT_TOOL_CHAR_BUDGET
}

/** The slash_command tool description: usage framing plus the budgeted command
 * list, each entry `/name - description (argument-hint)`. */
export function slashCommandToolDescription(commands: SlashCommandEntry[], budget: number): string {
  // Claude: "The listing always contains every skill name"; the budget shortens
  // descriptions (later entries lose theirs first), never drops a name, so an
  // omitted-but-invocable command can no longer contradict the listing.
  const lines = commands.map((command) => `/${command.name}`)
  let used = lines.reduce((total, line) => total + line.length + 1, 0)
  for (const [index, command] of commands.entries()) {
    const hintSuffix = command.argumentHint ? ` (${command.argumentHint})` : ''
    // when_to_use is model-facing trigger text, appended after the description and before
    // the argument hint; it shares the per-entry cap and never reaches the user surface.
    const whenSuffix = command.whenToUse ? ` ${command.whenToUse}` : ''
    const entry = `/${command.name} - ${command.description}${whenSuffix}${hintSuffix}`.slice(0, ENTRY_CHAR_CAP)
    const growth = entry.length - lines[index].length
    if (used + growth > budget) continue
    used += growth
    lines[index] = entry
  }
  return ["Execute a custom slash command on the user's behalf. The command expands to instructions for you to follow in this conversation.", '', 'Available commands:', ...lines].join('\n')
}

export default function commandsExtension(pi: ExtensionAPI) {
  const registered = new Set<string>()
  /** Every command file discovered for the current session, by name, for the
   * slash_command tool to resolve against. Rebuilt on each session_start (a resume,
   * fork, or new session can land on a different project) so the model never resolves
   * a command left over from a previous project's session. Kept fresh even for names
   * already registered. */
  const discovered = new Map<string, DiscoveredCommand>()
  /** pi has no unregister, so the slash_command tool registers once per process. */
  let toolRegistered = false
  /** The session_start approval decision, reused for per-invocation settings reads. */
  let projectApproved = false
  /** Tool set to put back once the run a restricted command drove has ended. */
  let pendingRestore: string[] | undefined
  /** `Bash(...)` scopes enforced while that run lasts; lifted with the restriction. */
  let pendingBashRules: string[] | undefined
  /** Read/Edit path scopes enforced the same way, per pi file tool. */
  let pendingPathRules: Partial<Record<PathRuleTool, string[]>> | undefined
  /** The session model to restore after a command's `model:` override drove its run,
   * captured once per turn so a second command restores the original session model. */
  const modelOverride = createTurnOverride<ModelLike>({
    // setModel can reject (e.g. auth resolution fails), and a floated rejection would
    // escape as unhandled; surface it as a no-op instead of leaving the session silently
    // on the command's override model.
    set: (model) => {
      void pi.setModel(model as Parameters<typeof pi.setModel>[0]).catch(() => {})
    },
  })
  /** The thinking level to restore after a command's `effort:` override drove its run,
   * captured once per turn the same way. */
  const effortOverride = createTurnOverride<string>({
    set: (level) => pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]),
  })

  // Claude's contract is "the grant clears when you send your next message", and
  // pi's turn_end fires after every assistant step: restoring there stripped a
  // multi-step command's tool and model scoping as soon as its first tool batch
  // came back. agent_end is not the end either: it fires once per agent loop, ahead
  // of an automatic retry, an auto-compaction-and-retry, or a Stop-hook continuation,
  // so restoring there lifts the scoping before that continued run executes.
  // agent_settled fires exactly once, after the run has fully settled and no such
  // continuation remains, which is the grant's true clearing point.
  pi.on('agent_settled', async () => {
    pendingBashRules = undefined
    pendingPathRules = undefined
    modelOverride.settle()
    effortOverride.settle()
    if (pendingRestore) {
      pi.setActiveTools(pendingRestore)
      pendingRestore = undefined
    }
  })

  // The active-tool set has no argument dimension, so a scoped grant hands the turn
  // the whole tool; the scope is enforced here instead, when the call arrives. Same
  // steering-not-sandbox caveat as plan mode's guard.
  pi.on('tool_call', async (event, ctx) => {
    if (pendingBashRules && event.toolName === 'bash') {
      const command = typeof event.input.command === 'string' ? event.input.command : ''
      if (matchesBashRules(command, pendingBashRules)) return
      return {
        block: true,
        reason: `allowed-tools: bash is scoped for this command.\nAllowed: ${pendingBashRules.join(', ')}\nCommand: ${command}`,
      }
    }
    const rules = pendingPathRules?.[event.toolName as PathRuleTool]
    if (!rules) return
    const input = event.input as Record<string, unknown>
    const filePath = typeof input.path === 'string' ? input.path : ''
    const anchors = { cwd: ctx.cwd, projectRoot: repoRoot(ctx.cwd) ?? ctx.cwd, home: os.homedir() }
    if (filePath && matchesPathRules(filePath, rules, anchors)) return
    return {
      block: true,
      reason: `allowed-tools: ${event.toolName} is scoped for this command.\nAllowed: ${rules.join(', ')}\nPath: ${filePath}`,
    }
  })

  /** Take the tool set to restore when this run ends, captured once per turn so a
   * second restricted command narrows against the original unrestricted set. */
  function captureRestorePoint(): string[] {
    const original = pendingRestore ?? pi.getActiveTools()
    pendingRestore = original
    return original
  }

  /** Apply a command's allowed-tools to the run it drives: intersect with the tools
   * pi actually has, keep the bash and path scopes for the tool_call guard, and let
   * agent_settled restore the previous set. */
  function applyAllowedTools(parsed: ParsedCommand, vars: Record<string, string | undefined>): void {
    const allowed = parsed.allowedTools
    if (!allowed) return
    // Only the first restriction in a turn sees the unrestricted set; a second
    // command must grant and restore against that original set, or its own tools
    // are intersected away by the first command's narrowing.
    const original = captureRestorePoint()
    const granted = allowed.filter((tool) => original.includes(tool))
    // `allowed-tools: []` says no tools, and is honored. A non-empty list that
    // intersects to nothing named only tools pi has none of: that restriction cannot
    // be expressed, and applying it as "no tools" is not what the command asked for.
    if (granted.length > 0 || allowed.length === 0) pi.setActiveTools(granted)
    // The latest restricted command speaks for the turn: a later unscoped grant
    // lifts an earlier command's scopes rather than stacking under them. Rules get
    // the same ${CLAUDE_*} substitution as the body, so a rule can name a bundled
    // script by its real path, as the skills docs show.
    pendingBashRules = granted.includes('bash') ? parsed.bashRules?.map((rule) => substituteVars(rule, vars)) : undefined
    pendingPathRules = parsed.pathRules ? scopedPathRules(parsed.pathRules, granted, vars) : undefined
  }

  /** Claude removes disallowed-tools from the pool while the command is active; with
   * both fields present the removal wins, as in subagent tool lists. */
  function applyDisallowedTools(parsed: ParsedCommand): void {
    const disallowed = parsed.disallowedTools
    if (!disallowed || disallowed.length === 0) return
    captureRestorePoint()
    pi.setActiveTools(pi.getActiveTools().filter((tool) => !disallowed.includes(tool)))
  }

  /** Claude's `model:` frontmatter overrides the model for this run only, then the
   * session model resumes; restore happens on agent_settled like the tool-set restore.
   * Applied before sendUserMessage so the run it drives happens on the new model. */
  async function applyModelOverride(parsed: ParsedCommand, varCtx: VarContext): Promise<void> {
    const target = resolveCommandModel(parsed.model, varCtx.modelRegistry?.getAvailable() ?? [])
    if (target && varCtx.model && target.id !== varCtx.model.id) {
      modelOverride.arm(varCtx.model)
      await pi.setModel(target as Parameters<typeof pi.setModel>[0])
    }
  }

  /** Claude's `effort:` frontmatter overrides the thinking level for this run only, then
   * the session level resumes; restore happens on agent_settled like the model restore.
   * Applied before sendUserMessage so the run it drives happens at the new level. Only the
   * first override in a turn records the restore target, so a second command restores to
   * the original session level rather than the first command's override (as the model override). */
  function applyEffortOverride(parsed: ParsedCommand, varCtx: VarContext): void {
    const target = parsed.effort
    if (target && varCtx.thinkingLevel && target !== varCtx.thinkingLevel) {
      effortOverride.arm(varCtx.thinkingLevel)
      pi.setThinkingLevel(target as Parameters<typeof pi.setThinkingLevel>[0])
    }
  }

  async function runCommand(parsed: ParsedCommand, args: string, ctx: ExtensionCommandContext, filePath: string, plugin?: CommandPlugin): Promise<void> {
    const varCtx = ctx as unknown as VarContext
    const vars = commandVars(ctx, filePath, plugin)

    let expanded: string
    try {
      expanded = await expandCommand(pi, parsed, args, ctx, filePath, plugin, { allowShell: !shellExecutionDisabled(ctx.cwd, os.homedir(), projectApproved) })
    } catch (error) {
      // A failed injected command aborts the invocation; the model never sees a
      // half-expanded body. The notify carries Claude's failure message format.
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      return
    }

    // allowed-tools restricts the run the command drives, and the previous set is
    // restored when that run ends. Restoring inline does not work: sendUserMessage is
    // fire-and-forget, so the restore would land before the agent ever read the tool
    // list, leaving the command running with everything enabled.
    // A command invoked while the agent is streaming must not narrow the in-flight run's
    // tools or switch its model (that would corrupt a run it does not own), and a bare
    // sendUserMessage throws mid-stream and would be silently dropped. Queue it as a
    // follow-up through pi's own queue, which is abort-aware and shown to the user; its
    // frontmatter scoping is not applied in that case, since it cannot land on a run that
    // has not started yet.
    if (!ctx.isIdle()) {
      pi.sendUserMessage(expanded, { deliverAs: 'followUp' })
      return
    }
    applyAllowedTools(parsed, vars)
    applyDisallowedTools(parsed)
    await applyModelOverride(parsed, varCtx)
    applyEffortOverride(parsed, varCtx)
    pi.sendUserMessage(expanded)
  }

  pi.on('session_start', async (_event, ctx) => {
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while a command's per-run scoping is still pending (its agent_settled
    // never came). Carrying that into the next session would restore an unrelated tool set,
    // bash/path scope, model, or effort onto it, so drop the pending state here. Drop only:
    // no setActiveTools/setModel/setThinkingLevel, since the new session owns its own state.
    pendingRestore = undefined
    pendingBashRules = undefined
    pendingPathRules = undefined
    modelOverride.reset()
    effortOverride.reset()
    const trusted = await isProjectApproved(ctx)
    projectApproved = trusted
    // A resume/fork/new session can switch projects in-process. pi cannot unregister a
    // command or re-describe the slash_command tool, so a name registered in an earlier
    // project keeps its user-path binding and the tool description stays frozen at the
    // first session's list; that is a pi limitation. What must not persist is the map
    // the model resolves against, so it is rebuilt from scratch here: a stale command
    // from a previous project resolves to "unknown" rather than being expanded.
    discovered.clear()
    // Plugins are user-installed and enabled by user settings; a checked-out repo
    // must not silently flip which code-bearing plugins run, so enablement is
    // user-scoped and never reads the project settings chain (see installedPlugins).
    const plugins = pluginCommands(installedPlugins(os.homedir()))
    const invocable: SlashCommandEntry[] = []
    for (const command of [...collectCommands(commandDirs(ctx.cwd, os.homedir(), trusted)), ...plugins]) {
      let parsed: ParsedCommand
      try {
        parsed = parseCommandFile(fs.readFileSync(command.filePath, 'utf-8'))
      } catch {
        continue // an unreadable command file must not take down session start
      }
      discovered.set(command.name, command)
      // A user-only command stays off the tool description; it is still in the
      // map so a model attempt gets the explicit refusal, not "unknown command".
      if (!parsed.disableModelInvocation) invocable.push({ name: command.name, description: parsed.description, argumentHint: parsed.argumentHint, whenToUse: parsed.whenToUse })
      // user-invocable:false is the inverse of disable-model-invocation: the command is
      // hidden from the user slash-command surface but stays in `discovered` and the tool
      // description above, so the model can still run it through the slash_command tool.
      if (!parsed.userInvocable) continue
      // pi has no unregister, so a command already registered this process keeps its
      // original file binding; re-registering would only add a numbered duplicate.
      if (registered.has(command.name)) continue
      registered.add(command.name)
      pi.registerCommand(command.name, {
        description: parsed.argumentHint ? `${parsed.description} ${parsed.argumentHint}` : parsed.description,
        handler: async (args, commandCtx) => {
          // Re-read on invocation so an edited command file takes effect without a reload.
          let current = parsed
          try {
            current = parseCommandFile(fs.readFileSync(command.filePath, 'utf-8'))
          } catch {
            // fall back to what was parsed at registration
          }
          await runCommand(current, args, commandCtx, command.filePath, command.plugin)
        },
      })
    }

    // Claude's SlashCommand tool, registered only when there is something for the
    // model to call: an empty tool would spend context saying "nothing available".
    if (toolRegistered || invocable.length === 0) return
    toolRegistered = true
    pi.registerTool({
      name: 'slash_command',
      label: 'SlashCommand',
      description: slashCommandToolDescription(invocable, slashCommandBudget((ctx as unknown as VarContext).model?.contextWindow)),
      parameters: Type.Object({ command: Type.String({ description: 'The command to run with args, e.g. "/deploy staging"' }) }),
      async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
        const line = params.command.trim().replace(/^\//, '')
        const space = line.search(/\s/)
        const name = space === -1 ? line : line.slice(0, space)
        const args = space === -1 ? '' : line.slice(space + 1).trim()
        // pi marks a tool result as an error only when execute() throws, so the
        // failure paths below throw rather than return.
        const command = discovered.get(name)
        if (!name || !command) throw new Error(`Unknown command: /${name || params.command}. Only the custom commands listed in the slash_command tool description can be run.`)
        // Live-edit parity with the user path: re-read on every invocation, so a
        // just-added disable-model-invocation takes effect immediately too.
        let current: ParsedCommand
        try {
          current = parseCommandFile(fs.readFileSync(command.filePath, 'utf-8'))
        } catch {
          throw new Error(`/${name}: the command file could not be read (${command.filePath}).`)
        }
        if (current.disableModelInvocation) {
          throw new Error(`/${name} is user-only (disable-model-invocation: true) and was not run. Do not reproduce this command's steps or try to achieve its effect another way; only the user can invoke it.`)
        }
        // Expansion only, never sendUserMessage (that would spawn a second turn):
        // the tool result is the channel, and frontmatter scoping stays user-path
        // territory (see the header).
        const expanded = await expandCommand(pi, current, args, execCtx, command.filePath, command.plugin, { allowShell: false })
        // Cap the tool result: a command body can inline an arbitrarily large @file, and
        // an uncapped tool result overflows the model's context (every other pi-code tool
        // routes its output through capForContext). The user-invoked path stays uncapped.
        return { content: [{ type: 'text' as const, text: capForContext(`Contents of /${name} (expanded):\n\n${expanded}`) }], details: {} }
      },
    })
  })
}
