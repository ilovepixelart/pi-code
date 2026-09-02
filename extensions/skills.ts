/**
 * Claude Skills Extension
 *
 * Bridges Claude Code's skills into pi. On resources_discover it hands pi the
 * existing `.claude/skills` directories (user then project) as skill paths, so
 * pi discovers Claude Code skills the same way it loads its own `.pi/skills`.
 * pi implements the Agent Skills standard, so `SKILL.md` directories work
 * unchanged and register as `/skill:name`.
 *
 * Claude documents that a command file and a skill "work the same way", so a
 * SKILL.md body carries the dynamic features command bodies do: `` !`cmd` ``
 * spans, `@file` references, `$ARGUMENTS`/positional substitution and
 * `${CLAUDE_*}` variables. pi's loader delivers the raw text, so this extension
 * intercepts `/skill:name` input for the skills it contributed, expands the body
 * through the shared command pipeline, and hands pi the already-expanded content
 * in pi's own skill-block format (pi emits the input event before its own
 * expansion, and skips text that no longer starts with `/`).
 *
 * Docs: https://code.claude.com/docs/en/skills.md, https://agentskills.io
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type ExtensionAPI, type ExtensionContext, parseFrontmatter } from '@earendil-works/pi-coding-agent'

import { expandCommand, shellExecutionDisabled } from './commands.js'
import { runAgent } from './internal/agent-run.js'
import { parseCommandFile } from './internal/command-file.js'
import { claudeConfigDir } from './internal/config-dir.js'
import { managedSettingsFile } from './internal/managed-settings.js'
import { installedPlugins, pluginComponentPath } from './internal/plugins.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { ancestorDirs } from './internal/project-root.js'
import { claudeSettingsChain } from './internal/settings-chain.js'
import { SKILL_HOOKS_CHANNEL } from './internal/skill-hooks.js'

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Existing `.claude/skills` directories, user first then project. The project
 * directory is included only for approved projects: pi's loader surfaces every skill's
 * name and description to the model, so an untrusted repository would otherwise get
 * text into the prompt without the user ever agreeing to load its config. */
export function skillDirs(cwd: string, home: string, trusted: boolean): string[] {
  // Claude's precedence: enterprise (the skills directory beside the managed
  // settings file) overrides personal, and personal overrides project; discovery
  // here is first-match, so higher precedence goes first.
  const candidates = [path.join(path.dirname(managedSettingsFile()), '.claude', 'skills'), path.join(claudeConfigDir(home), 'skills')]
  // Enabled plugins contribute their skills directories. pi's loader names a
  // skill by its directory, so a plugin skill registers without Claude's
  // /plugin: prefix; a rename-free approximation, disclosed in the README.
  for (const plugin of installedPlugins(home)) {
    const declared = plugin.manifest.skills
    const dirs = Array.isArray(declared) ? declared : [typeof declared === 'string' ? declared : 'skills']
    candidates.push(...dirs.map((dir) => pluginComponentPath(plugin, String(dir))).filter((dir): dir is string => dir !== undefined))
  }
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
    const declared = parseFrontmatter<Record<string, unknown>>(content).frontmatter.name
    if (typeof declared === 'string' && declared.trim()) name = declared.trim()
  } catch {
    // Malformed frontmatter: pi's loader falls back to the directory name too.
  }
  return { name, filePath }
}

/** A Claude-contributed skill by the name pi's loader gives it. One directory
 * level, the standard layout. */
export function findClaudeSkill(name: string, roots: string[]): FoundSkill | undefined {
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skill = skillAt(root, entry.name)
      if (skill?.name === name) return { filePath: skill.filePath, baseDir: path.dirname(skill.filePath) }
    }
  }
  return undefined
}

export default function skillsExtension(pi: ExtensionAPI) {
  pi.on('resources_discover', async (_event, ctx) => {
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
  for (const file of claudeSettingsChain(cwd, os.homedir(), trusted)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(file, 'utf-8')).skillOverrides
      if (overrides !== null && typeof overrides === 'object' && typeof overrides[name] === 'string') value = overrides[name]
    } catch {
      // missing or invalid file: skip
    }
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

/** Claude's context: fork run: the expanded skill content becomes the prompt that
 * drives a subagent, without the conversation history. Divergence: Claude
 * backgrounds the fork by default; pi-code waits for the result in the invoking
 * turn (Claude's background: false behavior, which is also what Claude itself
 * does in -p and SDK runs). */
async function runForkedSkill(name: string, filePath: string, expanded: string, agentName: string | undefined): Promise<{ action: 'transform'; text: string }> {
  try {
    const output = await runAgent({ prompt: expanded, fullTools: true, ...(agentName ? { agent: agentName } : {}) })
    return { action: 'transform', text: `<skill name="${name}" location="${filePath}">\nThe skill ran in a forked subagent (no conversation history shared). Its result:\n\n${output}\n</skill>` }
  } catch (error) {
    return { action: 'transform', text: `<skill name="${name}">\nThe forked subagent run failed: ${error instanceof Error ? error.message : String(error)}\n</skill>` }
  }
}

/** A `/skill:name args` invocation into its expanded skill block, or undefined to
 * pass the input through to pi untouched. The expanded body is wrapped in pi's
 * skill-block format so downstream behavior (the baseDir note for relative
 * references) matches an untouched invocation. */
async function expandSkillInvocation(pi: ExtensionAPI, rawText: string, ctx: ExtensionContext): Promise<{ action: 'transform'; text: string } | { action: 'handled' } | undefined> {
  const text = rawText.trimStart()
  if (!text.startsWith('/skill:')) return
  const space = text.indexOf(' ')
  const name = (space === -1 ? text.slice(7) : text.slice(7, space)).trim()
  const args = space === -1 ? '' : text.slice(space + 1).trim()
  if (!name) return
  const trusted = isProjectApprovedSilently(ctx)
  const found = findClaudeSkill(name, skillDirs(ctx.cwd, os.homedir(), trusted))
  if (!found) return
  const refused = refusedByOverride(name, ctx, trusted)
  if (refused) return refused
  let parsed: ReturnType<typeof parseCommandFile>
  let content: string
  try {
    content = fs.readFileSync(found.filePath, 'utf-8')
    parsed = parseCommandFile(content)
  } catch {
    // Unreadable, or malformed frontmatter: pass through to pi's plain expansion
    // (the loader registered the skill and delivers the raw body), rather than
    // failing the invocation over the dynamic features it cannot have.
    return
  }
  // Claude registers hooks a skill's frontmatter declares when the skill is
  // invoked, for the rest of the session; the hooks extension owns running them,
  // so the declaration is announced over the shared bus.
  const frontmatter = parseFrontmatter<Record<string, unknown>>(content).frontmatter
  const declaredHooks = frontmatter.hooks
  if (declaredHooks !== null && typeof declaredHooks === 'object' && !Array.isArray(declaredHooks)) {
    pi.events?.emit(SKILL_HOOKS_CHANNEL, { skillName: name, hooks: declaredHooks })
  }
  const expanded = await expandCommand(pi, parsed, args, { cwd: ctx.cwd }, found.filePath, undefined, { allowShell: !shellExecutionDisabled(ctx.cwd, os.homedir(), trusted) })
  if (typeof frontmatter.context === 'string' && frontmatter.context.trim().toLowerCase() === 'fork') {
    return runForkedSkill(name, found.filePath, expanded, typeof frontmatter.agent === 'string' ? frontmatter.agent.trim() : undefined)
  }
  return { action: 'transform', text: `<skill name="${name}" location="${found.filePath}">\nReferences are relative to ${found.baseDir}.\n\n${expanded}\n</skill>` }
}
