/**
 * Claude Skills Extension
 *
 * Bridges Claude Code's skills into pi. On resources_discover it hands pi the
 * existing `.claude/skills` directories (user then project) as skill paths, so
 * pi discovers Claude Code skills the same way it loads its own `.pi/skills`.
 * pi implements the Agent Skills standard, so `SKILL.md` directories work
 * unchanged and register as `/skill:name`.
 *
 * Plugin skills are the exception. pi's loader names a skill by its directory and
 * always registers it under the fixed `/skill:` prefix, so handing a plugin's skills
 * directory over drops Claude's plugin prefix. Those skills are registered here as
 * `/plugin:name` commands instead, the way plugin commands already are.
 *
 * Claude documents that a command file and a skill "work the same way", so a
 * SKILL.md body carries the dynamic features command bodies do: `` !`cmd` ``
 * spans, `@file` references, `$ARGUMENTS`/positional substitution and
 * `${CLAUDE_*}` variables. pi's loader delivers the raw text, so this extension
 * intercepts `/skill:name` input for the skills it contributed and `/plugin:name`
 * for a plugin's, expands the body through the shared command pipeline, and hands pi
 * the already-expanded content in pi's own skill-block format (pi emits the input
 * event before its own expansion, and skips text that no longer starts with `/`).
 *
 * Docs: https://code.claude.com/docs/en/skills.md, https://agentskills.io
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { expandCommand, pluginCommands, shellExecutionDisabled, slashCommandBudget, slashCommandToolDescription } from './commands.ts'
import { runAgent } from './internal/agent-run.ts'
import { parseCommandFile } from './internal/command-file.ts'
import { claudeConfigDir } from './internal/config-dir.ts'
import { parseClaudeFrontmatter } from './internal/frontmatter.ts'
import { managedSettingsFile } from './internal/managed-settings.ts'
import { capForContext } from './internal/output-guard.ts'
import { installedPlugins, pluginComponentPath } from './internal/plugins.ts'
import { isProjectApprovedSilently } from './internal/project-approval.ts'
import { ancestorDirs } from './internal/project-root.ts'
import { sessionHasTurns, sessionMailbox } from './internal/session-mailbox.ts'
import { claudeSettingsChain, readSettingsChain } from './internal/settings-chain.ts'
import { SKILL_HOOKS_CHANNEL } from './internal/skill-hooks.ts'
import { errorMessage, isDirectory, isRecord } from './internal/values.ts'

/** The extra skill directories a manifest declares, as a list. A string is one entry,
 * a list is itself, anything else declares none. */
function declaredSkillDirs(declared: unknown): string[] {
  if (Array.isArray(declared)) return declared.map(String)
  return typeof declared === 'string' ? [declared] : []
}

/** Existing `.claude/skills` directories, user first then project. The project
 * directory is included only for approved projects: pi's loader surfaces every skill's
 * name and description to the model, so an untrusted repository would otherwise get
 * text into the prompt without the user ever agreeing to load its config. Plugin skills
 * are not here: pi's loader would name them without the plugin prefix, so they are
 * registered as `/plugin:name` commands instead (see pluginSkills). */
export function skillDirs(cwd: string, home: string, trusted: boolean): string[] {
  // Claude's precedence: enterprise (the skills directory beside the managed
  // settings file) overrides personal, and personal overrides project; discovery
  // here is first-match, so higher precedence goes first.
  // Claude: "Set to 1 to skip loading skills from the system-wide managed skills
  // directory. Useful for container or CI sessions that should not load
  // operator-provisioned skills." The enterprise dir beside managed-settings.json is
  // that directory here; personal and project skills are unaffected.
  const enterprise = process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS === '1' ? [] : [path.join(path.dirname(managedSettingsFile()), '.claude', 'skills')]
  const candidates = [...enterprise, path.join(claudeConfigDir(home), 'skills')]
  // Claude loads skills from every .claude/skills between cwd and the repository
  // root; the list goes nearest-first so findClaudeSkill's first match is the
  // closest definition (pi's loader receives the same order).
  if (trusted) candidates.push(...ancestorDirs(cwd, path.join('.claude', 'skills')))
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}

interface FoundSkill {
  filePath: string
  baseDir: string
}

/** The skill a directory entry holds, named as pi's loader names it (frontmatter
 * `name`, else the directory name); undefined without a readable SKILL.md. */
function skillAt(root: string, dirName: string): { name: string; filePath: string } | undefined {
  const filePath = path.join(root, dirName, 'SKILL.md')
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
  let name = dirName
  try {
    const declared = parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter.name
    if (typeof declared === 'string' && declared.trim()) name = declared.trim()
  } catch {
    // Malformed frontmatter: pi's loader falls back to the directory name too.
  }
  return { name, filePath }
}

export interface PluginSkill {
  /** Claude's plugin skill name, `plugin:skill`. */
  name: string
  filePath: string
  plugin: { root: string; dataDir: string; userConfig?: Record<string, string> }
}

/** The skill directories one plugin contributes: the manifest's `skills` entries plus the
 * default `skills/`. Claude scans both, so a declaration adds to the default rather than
 * replacing it. A path that resolves outside the plugin root is already dropped. */
function pluginSkillDirs(plugin: ReturnType<typeof installedPlugins>[number]): string[] {
  const extra = declaredSkillDirs(plugin.manifest.skills)
  return [...extra, 'skills'].map((entry) => pluginComponentPath(plugin, String(entry))).filter((entry): entry is string => entry !== undefined && isDirectory(entry))
}

/** The skills one directory holds, named `plugin:skill`. */
function skillsIn(dir: string, pluginName: string, pluginInfo: PluginSkill['plugin']): PluginSkill[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: PluginSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const skill = skillAt(dir, entry.name)
    if (skill) found.push({ name: skill.name.startsWith(`${pluginName}:`) ? skill.name : `${pluginName}:${skill.name}`, filePath: skill.filePath, plugin: pluginInfo })
  }
  return found
}

/** The skills an enabled plugin ships, named `plugin:skill` as Claude registers them.
 * Registered as commands rather than handed to pi's loader, which can only name a skill
 * by its directory and always under the fixed `/skill:` prefix. The manifest may point
 * `skills` somewhere else; the default `skills/` is always scanned alongside it. */
export function pluginSkills(home: string): PluginSkill[] {
  // NOT SUPPORTED: Claude's single-skill layout, "a plugin that ships exactly one skill
  // can place SKILL.md directly at the plugin root". The scan looks for
  // <dir>/<name>/SKILL.md; the plugin root would also pull in hooks/, agents/ and
  // commands/ as if they were skills.
  const plugins = installedPlugins(home)
  const commandNames = new Set(pluginCommands(plugins).map((command) => command.name))
  const found = plugins.flatMap((plugin) => {
    const pluginInfo = { root: plugin.root, dataDir: plugin.dataDir, ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}) }
    return pluginSkillDirs(plugin).flatMap((dir) => skillsIn(dir, plugin.name, pluginInfo))
  })
  // Two plugins can declare the same name. The listing, the command, and the tool must all
  // resolve that name to one file; the first one found wins and the rest are reported.
  const byName = new Map<string, PluginSkill>()
  for (const skill of found) {
    // Commands retain their established name even if the skills extension loads first.
    if (commandNames.has(skill.name)) {
      console.warn(`pi-code-skills: /${skill.name} is a plugin command; ignoring ${skill.filePath}`)
      continue
    }
    const existing = byName.get(skill.name)
    if (existing) {
      console.warn(`pi-code-skills: /${skill.name} from ${skill.filePath} is hidden by ${existing.filePath}`)
      continue
    }
    byName.set(skill.name, skill)
  }
  return [...byName.values()]
}

/** A Claude-contributed skill by the name pi's loader gives it. One directory
 * level, the standard layout. */
function findClaudeSkill(name: string, roots: string[]): FoundSkill | undefined {
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // A link counts: pi's loader follows it, and skillAt already turns a link that
      // leads to no SKILL.md (dangling, or to a plain file) into undefined.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skill = skillAt(root, entry.name)
      if (skill?.name === name) return { filePath: skill.filePath, baseDir: path.dirname(skill.filePath) }
    }
  }
  return undefined
}

/** A plugin skill the user can type, registered once per process: pi cannot unregister a
 * command, so a later session keeps the first binding. pi runs the handler instead of the
 * input pipeline, so the handler expands the body itself and sends that. */
function registerPluginSkillCommand(pi: ExtensionAPI, skill: PluginSkill, parsed: ReturnType<typeof parseCommandFile>, registered: Set<string>): void {
  if (registered.has(skill.name)) return
  if (pi.getCommands?.().some((command) => command.name === skill.name)) {
    console.warn(`pi-code-skills: /${skill.name} is already registered; leaving that command in place`)
    registered.add(skill.name)
    return
  }
  registered.add(skill.name)
  pi.registerCommand(skill.name, {
    description: parsed.argumentHint ? `${parsed.description} ${parsed.argumentHint}` : parsed.description,
    handler: async (args, commandCtx) => {
      const outcome = await expandSkillInvocation(pi, `/${skill.name}${args.trim() ? ` ${args}` : ''}`, commandCtx)
      if (!outcome || outcome.action === 'handled') return
      pi.sendUserMessage(outcome.text, commandCtx.isIdle() ? {} : { deliverAs: 'followUp' })
    },
  })
}

/** The model-facing listing of the plugin skills invocable right now. */
function pluginSkillToolDescription(invocable: Map<string, { description: string; argumentHint?: string }>, contextWindow: number | undefined): string {
  return slashCommandToolDescription(
    [...invocable].map(([name, skill]) => ({ name, description: skill.description, argumentHint: skill.argumentHint })),
    slashCommandBudget(contextWindow),
  ).replace('Execute a custom slash command', 'Run a skill shipped by an enabled Claude Code plugin. Its name includes the plugin')
}

/** The model-facing tool for plugin skills, registered once. prepareLoadout refreshes the
 * description from the session's current listing; one marked disable-model-invocation or
 * turned off by skillOverrides stays off that listing. */
function registerPluginSkillTool(pi: ExtensionAPI, contextWindow: number | undefined, invocable: Map<string, { description: string; argumentHint?: string }>): void {
  pi.registerTool({
    name: 'plugin_skill',
    label: 'PluginSkill',
    description: pluginSkillToolDescription(invocable, contextWindow),
    parameters: Type.Object({ command: Type.String({ description: 'The plugin skill to run with args, e.g. "/pm-workflow:hustle the change"' }) }),
    prepareLoadout: () => ({ descriptions: { plugin_skill: pluginSkillToolDescription(invocable, contextWindow) } }),
    async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
      const invocation = params.command.trim().replace(/^\//, '')
      const name = invocation.split(/\s/, 1)[0]
      if (!invocable.has(name)) throw new Error(`Unknown plugin skill: /${name || params.command}. It is not available in this session.`)
      // Both entry points use current settings, hooks and fork behavior. A model call
      // never runs injected shell and returns fork results through this tool.
      const outcome = await expandSkillInvocation(pi, `/${invocation}`, execCtx, { allowShell: false, inlineFork: true, modelInvocation: true })
      if (!outcome || outcome.action === 'handled') throw new Error(`/${name} was not run.`)
      return { content: [{ type: 'text' as const, text: capForContext(outcome.text) }], details: {} }
    },
  })
}

/** Rebuild the session's plugin-skill listing and register the commands the user can type.
 * A skill skillOverrides sets to "off" is absent from both. */
function registerSessionPluginSkills(pi: ExtensionAPI, ctx: ExtensionContext, registered: Set<string>, invocable: Map<string, { description: string; argumentHint?: string }>): void {
  invocable.clear()
  const trusted = isProjectApprovedSilently(ctx)
  for (const skill of pluginSkills(os.homedir())) {
    const override = skillOverrideFor(skill.name, ctx.cwd, trusted)
    if (override === 'off') continue
    let parsed: ReturnType<typeof parseCommandFile>
    try {
      parsed = parseCommandFile(fs.readFileSync(skill.filePath, 'utf-8'))
    } catch (error) {
      console.warn(`pi-code-skills: ignoring ${skill.filePath}: ${errorMessage(error)}`)
      continue
    }
    if (!parsed.disableModelInvocation && override !== 'user-invocable-only') invocable.set(skill.name, { description: override === 'name-only' ? '' : parsed.description, ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}) })
    if (parsed.userInvocable) registerPluginSkillCommand(pi, skill, parsed, registered)
  }
}

export default function skillsExtension(pi: ExtensionAPI) {
  const registeredPluginSkills = new Set<string>()
  let pluginSkillToolRegistered = false
  const invocablePluginSkills = new Map<string, { description: string; argumentHint?: string }>()

  pi.on('session_start', (_event, ctx) => {
    forkResults.attach(pi, sessionHasTurns(ctx))
    registerSessionPluginSkills(pi, ctx, registeredPluginSkills, invocablePluginSkills)
    if (!pluginSkillToolRegistered && invocablePluginSkills.size > 0) {
      pluginSkillToolRegistered = true
      registerPluginSkillTool(pi, (ctx as { model?: { contextWindow?: number } }).model?.contextWindow, invocablePluginSkills)
    }
  })
  pi.on('agent_start', () => forkResults.markPrompted(pi))
  pi.on('session_shutdown', () => forkResults.detach(pi))

  pi.on('resources_discover', (_event, ctx) => {
    // resources_discover fires after session_start, so the approval is already
    // resolved; reading it silently keeps a second trust dialog off the screen.
    const skillPaths = skillDirs(ctx.cwd, os.homedir(), isProjectApprovedSilently(ctx))
    return skillPaths.length > 0 ? { skillPaths } : undefined
  })

  // The dynamic-content shim: only for skills this extension contributed; pi's own
  // `.pi/skills` (or an unknown name) pass through to pi's plain expansion.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return
    return expandSkillInvocation(pi, event.text, ctx)
  })
}

/** Claude's `skillOverrides` value for one skill from the settings chain, later
 * files winning: "off" hides the skill entirely, "name-only" trims its listing
 * (a pi-loader surface, noted in docs). */
function skillOverrideFor(name: string, cwd: string, trusted: boolean): string | undefined {
  let value: string | undefined
  for (const settings of readSettingsChain(claudeSettingsChain(cwd, os.homedir(), trusted))) {
    const overrides = settings.skillOverrides
    if (!isRecord(overrides)) continue
    const bareName = name.slice(name.indexOf(':') + 1)
    const state = overrides[name] ?? overrides[bareName]
    if (typeof state === 'string') value = state
  }
  return value
}

/** Claude's skillOverrides "off": the skill is hidden and does not run; the
 * invocation is swallowed with a notice. Undefined lets the invocation proceed. */
function refusedByOverride(name: string, ctx: ExtensionContext, trusted: boolean): { action: 'handled' } | undefined {
  if (skillOverrideFor(name, ctx.cwd, trusted) !== 'off') return undefined
  if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" is turned off by skillOverrides in settings.`, 'info')
  return { action: 'handled' }
}

/** Forked skills still running in the background, by name. */
const runningForks = new Set<string>()

/** Whether a context: fork skill holds the invoking turn for its result. Claude: "The
 * forked subagent runs in the background: you keep working while it runs, and its result
 * arrives in your conversation when it completes. Set background: false in the frontmatter
 * to instead wait for the result in the turn that invoked the skill." It also waits in
 * non-interactive mode, when CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is 1, and "when you
 * invoke a forked skill while an earlier invocation of the same skill is still running". */
function forkWaits(name: string, frontmatter: Record<string, unknown>, ctx: ExtensionContext): boolean {
  if (String(frontmatter.background).trim().toLowerCase() === 'false') return true
  return !ctx.hasUI || process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1' || runningForks.has(name)
}

/** Where a forked skill's result goes: the session current when it completes, which after
 * a /new, /resume, /fork or /reload is not the one whose pi started it. */
const forkResults = sessionMailbox('skill-fork-results')

/** Start a forked skill in the background and hand its result to the conversation when it
 * completes. The promise has no awaiter, so the catch keeps a delivery that throws from
 * surfacing as an unhandled rejection, which exits pi. */
function startForkedSkill(ctx: ExtensionContext, fork: { name: string; filePath: string; expanded: string; agentName: string | undefined }): { action: 'handled' } {
  runningForks.add(fork.name)
  ctx.ui.notify(`Skill ${fork.name} is running in a forked subagent in the background; its result arrives here when it completes.`, 'info')
  void runForkedSkill(fork.name, fork.filePath, fork.expanded, fork.agentName)
    .then((result) => forkResults.deliver((current, startsTurn) => current.sendMessage({ customType: 'skill-fork', content: result.text, display: true }, { triggerTurn: startsTurn })))
    .catch(() => {})
    .finally(() => runningForks.delete(fork.name))
  return { action: 'handled' }
}

/** Claude's context: fork run: the expanded skill content becomes the prompt that
 * drives a subagent, without the conversation history. Never rejects: a failed run
 * is reported in the returned block. */
async function runForkedSkill(name: string, filePath: string, expanded: string, agentName: string | undefined): Promise<{ action: 'transform'; text: string }> {
  try {
    const output = await runAgent({ prompt: expanded, fullTools: true, ...(agentName ? { agent: agentName } : {}) })
    return { action: 'transform', text: `<skill name="${name}" location="${filePath}">\nThe skill ran in a forked subagent (no conversation history shared). Its result:\n\n${output}\n</skill>` }
  } catch (error) {
    return { action: 'transform', text: `<skill name="${name}">\nThe forked subagent run failed: ${errorMessage(error)}\n</skill>` }
  }
}

/** Whether pi resolved this skill name to another file: pi loads its own skill directories
 * ahead of the ones this extension adds and the first name wins, so its listing then
 * shows that skill, and the invocation is left to pi's own expansion of it. */
function shadowedByPi(pi: ExtensionAPI, name: string, filePath: string): boolean {
  const loaded = pi.getCommands?.().find((command) => command.source === 'skill' && command.name === `skill:${name}`)
  if (loaded === undefined) return false
  const real = (target: string): string => {
    try {
      return fs.realpathSync(target)
    } catch {
      return path.resolve(target)
    }
  }
  return real(loaded.sourceInfo.path) !== real(filePath)
}

/** The prefix a slash input addresses, or undefined when it addresses no skill. `/skill:`
 * is pi's own skill prefix; anything else namespaced (`/plugin:skill`) is a plugin skill. */
function invocationMarker(text: string): string | undefined {
  if (text.startsWith('/skill:')) return '/skill:'
  const head = text.slice(1).split(' ')[0]
  return text.startsWith('/') && head.includes(':') ? '/' : undefined
}

function parseSkillInvocation(rawText: string): { name: string; args: string } | undefined {
  const text = rawText.trimStart()
  const marker = invocationMarker(text)
  if (marker === undefined) return undefined
  const space = text.indexOf(' ')
  const name = (space === -1 ? text.slice(marker.length) : text.slice(marker.length, space)).trim()
  if (!name || (marker !== '/skill:' && !name.includes(':'))) return undefined
  return { name, args: space === -1 ? '' : text.slice(space + 1).trim() }
}

/** The skill file and its parsed frontmatter, or a throw when the file cannot be read. */
function readSkill(filePath: string): { parsed: ReturnType<typeof parseCommandFile>; content: string } {
  const content = fs.readFileSync(filePath, 'utf-8')
  return { content, parsed: parseCommandFile(content) }
}

/** Resolve a plugin skill, or a personal/project skill contributed to pi's loader. */
function resolveInvokedSkill(name: string, ctx: ExtensionContext, trusted: boolean): { filePath: string; baseDir: string; plugin?: PluginSkill['plugin'] } | undefined {
  const pluginSkill = name.includes(':') ? pluginSkills(os.homedir()).find((skill) => skill.name === name) : undefined
  if (pluginSkill) return { filePath: pluginSkill.filePath, baseDir: path.dirname(pluginSkill.filePath), plugin: pluginSkill.plugin }
  return findClaudeSkill(name, skillDirs(ctx.cwd, os.homedir(), trusted))
}

type ExpansionOptions = { allowShell?: boolean; inlineFork?: boolean; modelInvocation?: boolean }
type ExpansionResult = { action: 'transform'; text: string } | { action: 'handled' } | undefined

/** Validate the current file rather than the metadata captured at session start. */
function checkModelInvocation(name: string, override: string | undefined, parsed: ReturnType<typeof parseCommandFile>): void {
  if (override === 'off' || override === 'user-invocable-only') throw new Error(`/${name} is disabled for model invocation by skillOverrides and was not run.`)
  if (parsed.disableModelInvocation) throw new Error(`/${name} is user-only (disable-model-invocation: true) and was not run. Only the user can invoke it.`)
}

async function expandSkillInvocation(pi: ExtensionAPI, rawText: string, ctx: ExtensionContext, options?: ExpansionOptions): Promise<ExpansionResult> {
  const invocation = parseSkillInvocation(rawText)
  if (!invocation) return
  const { name, args } = invocation
  const trusted = isProjectApprovedSilently(ctx)
  const found = resolveInvokedSkill(name, ctx, trusted)
  if (!found || shadowedByPi(pi, name, found.filePath)) return
  const override = skillOverrideFor(name, ctx.cwd, trusted)
  if (!options?.modelInvocation) {
    const refused = refusedByOverride(name, ctx, trusted)
    if (refused) return refused
  }
  let parsed: ReturnType<typeof parseCommandFile>
  let content: string
  try {
    ;({ parsed, content } = readSkill(found.filePath))
  } catch {
    // Unreadable, or malformed frontmatter: pass through to pi's plain expansion
    // (the loader registered the skill and delivers the raw body), rather than
    // failing the invocation over the dynamic features it cannot have.
    return
  }
  if (options?.modelInvocation) checkModelInvocation(name, override, parsed)
  return expandSkillBody(pi, ctx, { name, args, found, parsed, content }, options)
}

async function expandSkillBody(pi: ExtensionAPI, ctx: ExtensionContext, skill: { name: string; args: string; found: FoundSkill & { plugin?: PluginSkill['plugin'] }; parsed: ReturnType<typeof parseCommandFile>; content: string }, options?: ExpansionOptions): Promise<ExpansionResult> {
  const { name, args, found, parsed, content } = skill
  const trusted = isProjectApprovedSilently(ctx)
  // Claude registers hooks a skill's frontmatter declares when the skill is
  // invoked, for the rest of the session; the hooks extension owns running them,
  // so the declaration is announced over the shared bus.
  const frontmatter = parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter
  const declaredHooks = frontmatter.hooks
  if (declaredHooks !== null && typeof declaredHooks === 'object' && !Array.isArray(declaredHooks)) {
    pi.events?.emit(SKILL_HOOKS_CHANNEL, { skillName: name, hooks: declaredHooks })
  }
  let expanded: string
  try {
    expanded = await expandCommand(pi, parsed, args, { cwd: ctx.cwd }, found.filePath, found.plugin, {
      allowShell: options?.allowShell ?? !shellExecutionDisabled(ctx.cwd, os.homedir(), trusted),
    })
  } catch (error) {
    // A failed injected command aborts the invocation, as it does for a command: pi logs a
    // throwing input handler and continues with the raw text, which would send the body
    // unexpanded. The notify carries the failure message.
    ctx.ui.notify(errorMessage(error), 'error')
    return { action: 'handled' }
  }
  if (typeof frontmatter.context === 'string' && frontmatter.context.trim().toLowerCase() === 'fork') {
    const agentName = typeof frontmatter.agent === 'string' ? frontmatter.agent.trim() : undefined
    if (options?.inlineFork || forkWaits(name, frontmatter, ctx)) return runForkedSkill(name, found.filePath, expanded, agentName)
    return startForkedSkill(ctx, { name, filePath: found.filePath, expanded, agentName })
  }
  return { action: 'transform', text: `<skill name="${name}" location="${found.filePath}">\nReferences are relative to ${found.baseDir}.\n\n${expanded}\n</skill>` }
}
