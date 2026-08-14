/**
 * Claude Commands Extension
 *
 * Registers Claude Code's custom slash commands with pi directly, rather than
 * handing `.claude/commands` to pi's prompt-template loader. Owning registration
 * is what makes the rest of Claude's command contract reachable: namespaced
 * subdirectories (`frontend/build.md` is `/frontend:build`), `$ARGUMENTS` and
 * positional substitution, `` !`cmd` `` bash output, `@file` inlining, and the
 * `allowed-tools` and `argument-hint` frontmatter. `model` and
 * `disable-model-invocation` are parsed but not applied yet: pi has seams for both
 * (`pi.setModel`, and commands are user-invoked anyway), so they are a gap rather
 * than an impossibility.
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

import { type DiscoveredCommand, discoverCommandFiles, expandDynamicContent, type ParsedCommand, parseCommandFile, substituteArgs } from './internal/command-file.js'
import { isProjectApproved } from './internal/project-approval.js'

/** Wall-clock budget for one `` !`cmd` `` span; a hung command must not wedge a turn. */
const BASH_TIMEOUT_MS = 30_000

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Existing `.claude/commands` directories, user first then project. The project
 * directory is included only for approved projects. */
export function commandDirs(cwd: string, home: string, trusted: boolean): string[] {
  const candidates = [path.join(home, '.claude', 'commands')]
  if (trusted) candidates.push(path.join(cwd, '.claude', 'commands'))
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

export default function commandsExtension(pi: ExtensionAPI) {
  const registered = new Set<string>()
  /** Tool set to put back once the turn a restricted command drove has ended. */
  let pendingRestore: string[] | undefined

  pi.on('turn_end', async () => {
    if (!pendingRestore) return
    pi.setActiveTools(pendingRestore)
    pendingRestore = undefined
  })

  async function runCommand(parsed: ParsedCommand, args: string, ctx: ExtensionCommandContext): Promise<void> {
    const withArgs = substituteArgs(parsed.body, args)
    const expanded = await expandDynamicContent(withArgs, ctx.cwd, async (shell) => {
      // Hooks get CLAUDE_PROJECT_DIR, and a command's bash span is the same kind of
      // project-scoped script. pi.exec takes no env, so it is exported in the script.
      const projectDir = ctx.cwd.replaceAll("'", String.raw`'\''`)
      const script = `export CLAUDE_PROJECT_DIR='${projectDir}'; ${shell}`
      const result = await pi.exec('/bin/sh', ['-c', script], { cwd: ctx.cwd, timeout: BASH_TIMEOUT_MS })
      return { stdout: result.stdout, stderr: result.stderr, code: result.code }
    })

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
    }
    pi.sendUserMessage(expanded)
  }

  pi.on('session_start', async (_event, ctx) => {
    const trusted = await isProjectApproved(ctx)
    for (const command of collectCommands(commandDirs(ctx.cwd, os.homedir(), trusted))) {
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
          await runCommand(current, args, commandCtx)
        },
      })
    }
  })
}
