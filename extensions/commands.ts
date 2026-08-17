/**
 * Claude Commands Extension
 *
 * Registers Claude Code's custom slash commands with pi directly, rather than
 * handing `.claude/commands` to pi's prompt-template loader. Owning registration
 * is what makes the rest of Claude's command contract reachable: namespaced
 * subdirectories (`frontend/build.md` is `/frontend:build`), `$ARGUMENTS` and
 * positional substitution, `` !`cmd` `` bash output, `@file` inlining, and the
 * `allowed-tools`, `argument-hint` and `model` frontmatter (`model` switches the
 * session model for the command's turn via `pi.setModel`, restored on turn_end).
 * `shell: powershell` runs a command's injected spans through PowerShell when a
 * pwsh binary is installed, falling back to /bin/sh so the command still works
 * without one. `disable-model-invocation` is parsed but not applied yet.
 *
 * A project command body is repository-controlled text that can now run shell
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

import { matchesBashRules } from './internal/bash-rules.js'
import { type DiscoveredCommand, discoverCommandFiles, expandDynamicContent, type ParsedCommand, parseCommandFile, resolvePowershellBinary, spanExec, substituteArgsDetailed, substituteVars } from './internal/command-file.js'
import { matchesPathRules } from './internal/path-rules.js'
import { type InstalledPlugin, installedPlugins } from './internal/plugins.js'
import { isProjectApproved } from './internal/project-approval.js'
import { findNearestDir, repoRoot } from './internal/project-root.js'

type PathRuleTool = 'read' | 'edit' | 'write'

/** Just enough of pi's Model to match and restore; getAvailable returns these. */
interface ModelLike {
  id: string
  name?: string
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

/** Existing `.claude/commands` directories, user first then project. The project
 * directory is the nearest at or above cwd (bounded at the repository root, matching
 * the approval walk) and is included only for approved projects. */
export function commandDirs(cwd: string, home: string, trusted: boolean): string[] {
  const candidates = [path.join(home, '.claude', 'commands')]
  if (trusted) candidates.push(findNearestDir(cwd, path.join('.claude', 'commands')) ?? path.join(cwd, '.claude', 'commands'))
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
export function pluginCommands(plugins: InstalledPlugin[]): DiscoveredCommand[] {
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

export default function commandsExtension(pi: ExtensionAPI) {
  const registered = new Set<string>()
  /** Tool set to put back once the turn a restricted command drove has ended. */
  let pendingRestore: string[] | undefined
  /** `Bash(...)` scopes enforced while that turn runs; lifted with the restriction. */
  let pendingBashRules: string[] | undefined
  /** Read/Edit path scopes enforced the same way, per pi file tool. */
  let pendingPathRules: Partial<Record<PathRuleTool, string[]>> | undefined
  /** The session model to restore after a command's `model:` override drove its turn. */
  let pendingModelRestore: ModelLike | undefined

  pi.on('turn_end', async () => {
    pendingBashRules = undefined
    pendingPathRules = undefined
    if (pendingModelRestore) {
      void pi.setModel(pendingModelRestore as Parameters<typeof pi.setModel>[0])
      pendingModelRestore = undefined
    }
    if (!pendingRestore) return
    pi.setActiveTools(pendingRestore)
    pendingRestore = undefined
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

  async function runCommand(parsed: ParsedCommand, args: string, ctx: ExtensionCommandContext, filePath: string, plugin?: { root: string; dataDir: string; userConfig?: Record<string, string> }): Promise<void> {
    const varCtx = ctx as unknown as VarContext
    const projectRoot = repoRoot(ctx.cwd) ?? ctx.cwd
    const vars: Record<string, string | undefined> = {
      CLAUDE_SESSION_ID: varCtx.sessionManager?.getSessionId?.(),
      CLAUDE_EFFORT: varCtx.thinkingLevel,
      CLAUDE_SKILL_DIR: path.dirname(filePath),
      CLAUDE_PROJECT_DIR: projectRoot,
      CLAUDE_PLUGIN_ROOT: plugin?.root,
      CLAUDE_PLUGIN_DATA: plugin?.dataDir,
    }
    const { text: withArgs, consumed } = substituteArgsDetailed(parsed.body, args, parsed.argumentNames ?? [])
    // `${user_config.KEY}` is a plugin-command variable only; leave it literal in an
    // ordinary command so a body that happens to contain the syntax is not stripped.
    const substituted = substituteVars(withArgs, vars)
    const withVars = plugin ? substituted.replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, key: string) => plugin.userConfig?.[key] ?? '') : substituted

    let expanded: string
    try {
      expanded = await expandDynamicContent(withVars, ctx.cwd, async (script) => {
        // Hooks get CLAUDE_PROJECT_DIR, and a command's shell span is the same kind of
        // project-scoped script. pi.exec takes no env, so it is set in the script.
        // stderr merges into stdout, as the Bash tool runs these for Claude. The
        // resolver is passed by its imported binding so tests can stub the lookup.
        const run = spanExec(parsed.shell, projectRoot, script, resolvePowershellBinary)
        const result = await pi.exec(run.command, run.args, { cwd: ctx.cwd, timeout: BASH_TIMEOUT_MS })
        // pwsh cannot merge a native command's stderr in-script (spanExec sets
        // mergeStreams), so it is appended here; the sh script merges via 2>&1.
        const stdout = run.mergeStreams ? result.stdout + result.stderr : result.stdout
        return { stdout, stderr: result.stderr, code: result.code }
      })
    } catch (error) {
      // A failed injected command aborts the invocation; the model never sees a
      // half-expanded body. The notify carries Claude's failure message format.
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      return
    }

    // Claude appends the raw arguments when the command never read them, so what
    // the user typed still reaches the model.
    if (args.trim().length > 0 && !consumed) expanded += `\n\nARGUMENTS: ${args.trim()}`

    // allowed-tools restricts the turn the command drives, and the previous set is
    // restored when that turn ends. Restoring inline does not work: sendUserMessage is
    // fire-and-forget, so the restore would land before the agent ever read the tool
    // list, leaving the command running with everything enabled.
    if (parsed.allowedTools) {
      // Only the first restriction in a turn sees the unrestricted set; a second
      // command must grant and restore against that original set, or its own tools
      // are intersected away by the first command's narrowing.
      const original = pendingRestore ?? pi.getActiveTools()
      pendingRestore = original
      const granted = parsed.allowedTools.filter((tool) => original.includes(tool))
      // `allowed-tools: []` says no tools, and is honored. A non-empty list that
      // intersects to nothing named only tools pi has none of: that restriction cannot
      // be expressed, and applying it as "no tools" is not what the command asked for.
      if (granted.length > 0 || parsed.allowedTools.length === 0) pi.setActiveTools(granted)
      // The latest restricted command speaks for the turn: a later unscoped grant
      // lifts an earlier command's scopes rather than stacking under them. Rules get
      // the same ${CLAUDE_*} substitution as the body, so a rule can name a bundled
      // script by its real path, as the skills docs show.
      pendingBashRules = granted.includes('bash') ? parsed.bashRules?.map((rule) => substituteVars(rule, vars)) : undefined
      pendingPathRules = undefined
      if (parsed.pathRules) {
        pendingPathRules = {}
        for (const [tool, rules] of Object.entries(parsed.pathRules)) {
          if (granted.includes(tool)) pendingPathRules[tool as PathRuleTool] = rules.map((rule) => substitutePathRule(rule, vars))
        }
      }
    }
    // Claude removes disallowed-tools from the pool while the skill is active;
    // with both fields present the removal wins, as in subagent tool lists.
    if (parsed.disallowedTools && parsed.disallowedTools.length > 0) {
      const original = pendingRestore ?? pi.getActiveTools()
      pendingRestore = original
      const disallowed = parsed.disallowedTools
      pi.setActiveTools(pi.getActiveTools().filter((tool) => !disallowed.includes(tool)))
    }
    // Claude's `model:` frontmatter overrides the model for this turn only, then the
    // session model resumes; restore happens on turn_end like the tool-set restore.
    // Applied before sendUserMessage so the turn it drives runs on the new model.
    const target = resolveCommandModel(parsed.model, varCtx.modelRegistry?.getAvailable() ?? [])
    if (target && varCtx.model && target.id !== varCtx.model.id) {
      pendingModelRestore = pendingModelRestore ?? varCtx.model
      await pi.setModel(target as Parameters<typeof pi.setModel>[0])
    }
    pi.sendUserMessage(expanded)
  }

  pi.on('session_start', async (_event, ctx) => {
    const trusted = await isProjectApproved(ctx)
    // Plugins are user-installed and enabled by user settings; a checked-out repo
    // must not silently flip which code-bearing plugins run, so enablement is
    // user-scoped and never reads the project settings chain (see installedPlugins).
    const plugins = pluginCommands(installedPlugins(os.homedir()))
    for (const command of [...collectCommands(commandDirs(ctx.cwd, os.homedir(), trusted)), ...plugins]) {
      // pi has no unregister, so a command already registered this process keeps its
      // original file binding; re-registering would only add a numbered duplicate.
      if (registered.has(command.name)) continue
      let parsed: ParsedCommand
      try {
        parsed = parseCommandFile(fs.readFileSync(command.filePath, 'utf-8'))
      } catch {
        continue // an unreadable command file must not take down session start
      }
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
  })
}
