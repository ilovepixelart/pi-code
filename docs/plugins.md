# Claude plugins

Loads installed marketplace plugins. Source: [`extensions/internal/plugins.ts`](../extensions/internal/plugins.ts).

- Reads the plugin cache at `~/.claude/plugins/cache`, active per `enabledPlugins` in user settings only: a checked-out repo cannot flip which code-bearing plugins run, so project settings never toggle them.
- Contributes commands as `/plugin:name`, agents, hooks, MCP servers (tools aliased `mcp__plugin_<plugin>_<server>__<tool>`), and output styles.
- Enablement follows Claude's precedence: a managed-settings `enabledPlugins` entry force-enables or blocks, then the user's `enabledPlugins` setting, then the manifest's `defaultEnabled` (default `true`: an installed plugin with no entry runs).
- Substitutes `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${user_config.KEY}` (from `pluginConfigs[id].options` in user settings). Fields that reach a shell reject `${user_config.KEY}`, as Claude does: a shell-form hook command carrying one is dropped, and an MCP `headersHelper` carrying one skips its server.
- Skill directories contribute too, though pi's loader names them without the plugin prefix.
- Skills: the plugin's `skills/` directory is always scanned, and any directory the manifest's `skills` names is loaded alongside it rather than replacing it. Claude's single-skill layout (`SKILL.md` at the plugin root) is not supported: pi's loader owns the directory layout and looks for `<dir>/<name>/SKILL.md`.
