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
import { type ExtensionAPI, parseFrontmatter } from '@earendil-works/pi-coding-agent'

import { expandCommand, shellExecutionDisabled } from './commands.js'
import { parseCommandFile } from './internal/command-file.js'
import { claudeConfigDir } from './internal/config-dir.js'
import { installedPlugins } from './internal/plugins.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { findNearestDir } from './internal/project-root.js'

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Existing `.claude/skills` directories, user first then project. */
/** Existing `.claude/skills` directories, user first then project. The project
 * directory is included only for approved projects: pi's loader surfaces every skill's
 * name and description to the model, so an untrusted repository would otherwise get
 * text into the prompt without the user ever agreeing to load its config. */
export function skillDirs(cwd: string, home: string, trusted: boolean): string[] {
  const candidates = [path.join(claudeConfigDir(home), 'skills')]
  // Enabled plugins contribute their skills directories. pi's loader names a
  // skill by its directory, so a plugin skill registers without Claude's
  // /plugin: prefix; a rename-free approximation, disclosed in the README.
  for (const plugin of installedPlugins(home)) {
    const declared = plugin.manifest.skills
    const dirs = Array.isArray(declared) ? declared : [typeof declared === 'string' ? declared : 'skills']
    candidates.push(...dirs.map((dir) => path.resolve(plugin.root, String(dir))))
  }
  if (trusted) candidates.push(findNearestDir(cwd, path.join('.claude', 'skills')) ?? path.join(cwd, '.claude', 'skills'))
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

/** A Claude-contributed skill by the name pi's loader gives it (frontmatter
 * `name`, else the directory name). One directory level, the standard layout. */
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
      const filePath = path.join(root, entry.name, 'SKILL.md')
      let content: string
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }
      let skillName = entry.name
      try {
        const declared = parseFrontmatter<Record<string, unknown>>(content).frontmatter.name
        if (typeof declared === 'string' && declared.trim()) skillName = declared.trim()
      } catch {
        // Malformed frontmatter: pi's loader falls back to the directory name too.
      }
      if (skillName === name) return { filePath, baseDir: path.dirname(filePath) }
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
  // `.pi/skills` (or an unknown name) pass through to pi's plain expansion. The
  // expanded body is wrapped in pi's skill-block format so downstream behavior
  // (baseDir note for relative references) matches an untouched invocation.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return
    const text = event.text.trimStart()
    if (!text.startsWith('/skill:')) return
    const space = text.indexOf(' ')
    const name = (space === -1 ? text.slice(7) : text.slice(7, space)).trim()
    const args = space === -1 ? '' : text.slice(space + 1).trim()
    if (!name) return
    const trusted = isProjectApprovedSilently(ctx)
    const found = findClaudeSkill(name, skillDirs(ctx.cwd, os.homedir(), trusted))
    if (!found) return
    let content: string
    let parsed: ReturnType<typeof parseCommandFile>
    try {
      content = fs.readFileSync(found.filePath, 'utf-8')
      parsed = parseCommandFile(content)
    } catch {
      // Unreadable, or malformed frontmatter: pass through to pi's plain expansion
      // (the loader registered the skill and delivers the raw body), rather than
      // failing the invocation over the dynamic features it cannot have.
      return
    }
    const expanded = await expandCommand(pi, parsed, args, { cwd: ctx.cwd }, found.filePath, undefined, { allowShell: !shellExecutionDisabled(ctx.cwd, os.homedir(), trusted) })
    const block = `<skill name="${name}" location="${found.filePath}">\nReferences are relative to ${found.baseDir}.\n\n${expanded}\n</skill>`
    return { action: 'transform', text: block }
  })
}
