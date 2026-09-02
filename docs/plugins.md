# Claude plugins

Loads installed marketplace plugins. Source: [`extensions/internal/plugins.ts`](../extensions/internal/plugins.ts).

- Reads the plugin cache at `~/.claude/plugins/cache`, active per `enabledPlugins` in user settings only: a checked-out repo cannot flip which code-bearing plugins run, so project settings never toggle them.
- Contributes commands as `/plugin:name`, agents, hooks, MCP servers (tools aliased `mcp__plugin_<plugin>_<server>__<tool>`), and output styles.
- Enablement follows Claude's precedence: a managed-settings `enabledPlugins` entry force-enables or blocks, then the user's `enabledPlugins` setting, then the manifest's `defaultEnabled` (default `true`: an installed plugin with no entry runs).
- Substitutes `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${user_config.KEY}` (from `pluginConfigs[id].options` in user settings).
- Skill directories contribute too, though pi's loader names them without the plugin prefix.
