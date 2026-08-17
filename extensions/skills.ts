/**
 * Claude Skills Extension
 *
 * Bridges Claude Code's skills into pi. On resources_discover it hands pi the
 * existing `.claude/skills` directories (user then project) as skill paths, so
 * pi discovers Claude Code skills the same way it loads its own `.pi/skills`.
 * pi implements the Agent Skills standard, so `SKILL.md` directories work
 * unchanged and register as `/skill:name`.
 *
 * Docs: https://code.claude.com/docs/en/skills.md, https://agentskills.io
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

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
  const candidates = [path.join(home, '.claude', 'skills')]
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

export default function skillsExtension(pi: ExtensionAPI) {
  pi.on('resources_discover', async (_event, ctx) => {
    // resources_discover fires after session_start, so the approval is already
    // resolved; reading it silently keeps a second trust dialog off the screen.
    const skillPaths = skillDirs(ctx.cwd, os.homedir(), isProjectApprovedSilently(ctx))
    return skillPaths.length > 0 ? { skillPaths } : undefined
  })
}
