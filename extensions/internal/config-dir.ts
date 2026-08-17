/**
 * CLAUDE_CONFIG_DIR: Claude Code's override for the home configuration directory.
 *
 * Claude relocates the entire ~/.claude configuration tree (settings.json, commands,
 * agents, skills, plugins, output-styles, CLAUDE.md) when CLAUDE_CONFIG_DIR is set,
 * so a user can keep that config outside their home directory. This resolves the
 * home-scope config root for every consumer; a project's own `.claude/` directory is
 * a separate scope and is never affected. A leading `~` expands against `home`, and
 * the result is resolved to an absolute path so a relative value cannot depend on the
 * reader's working directory.
 */

import * as path from 'node:path'

/** The home-scope Claude config directory: CLAUDE_CONFIG_DIR (expanded, absolute)
 * when set to a non-empty value, otherwise `<home>/.claude`. */
export function claudeConfigDir(home: string): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  if (override && override.trim().length > 0) {
    const expanded = override.startsWith('~') ? path.join(home, override.slice(1)) : override
    return path.resolve(expanded)
  }
  return path.join(home, '.claude')
}
