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

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Existing `.claude/skills` directories, user first then project. */
export function skillDirs(cwd: string, home: string): string[] {
  const candidates = [path.join(home, '.claude', 'skills'), path.join(cwd, '.claude', 'skills')]
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}

export default function skillsExtension(pi: ExtensionAPI) {
  pi.on('resources_discover', async (_event, ctx) => {
    const skillPaths = skillDirs(ctx.cwd, os.homedir())
    return skillPaths.length > 0 ? { skillPaths } : undefined
  })
}
