/**
 * Claude Commands Extension
 *
 * Bridges Claude Code's custom slash commands into pi. On resources_discover
 * it hands pi the existing `.claude/commands` directories (user then project)
 * as prompt-template paths, so `/name` invokes `.claude/commands/name.md` the
 * same way pi loads its own `.pi/prompts`. pi's `$ARGUMENTS` / `$1` / `${1:-x}`
 * substitution overlaps Claude Code's, so most command files work unchanged.
 *
 * Not bridged (pi's prompt engine ignores them): `!` bash execution, `@` file
 * refs, `allowed-tools`/`model` frontmatter, and namespaced subdirectories
 * (discovery is non-recursive).
 *
 * Docs: https://code.claude.com/docs/en/slash-commands.md
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

/** Existing `.claude/commands` directories, user first then project. */
export function commandDirs(cwd: string, home: string): string[] {
  const candidates = [path.join(home, '.claude', 'commands'), path.join(cwd, '.claude', 'commands')]
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}

export default function commandsExtension(pi: ExtensionAPI) {
  pi.on('resources_discover', async (_event, ctx) => {
    const promptPaths = commandDirs(ctx.cwd, os.homedir())
    return promptPaths.length > 0 ? { promptPaths } : undefined
  })
}
