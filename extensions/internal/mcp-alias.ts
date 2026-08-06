/**
 * Channel and payload for the MCP tool-name registry the mcp extension publishes on
 * pi's shared extension event bus. Claude Code names MCP tools `mcp__<server>__<tool>`
 * (original names, dashes preserved); pi-code registers them as `<server>_<tool>` with
 * dashes folded to underscores. Hook matchers written for Claude need the mapping, and
 * pi loads every extension without a shared module cache, so cross-extension state must
 * ride the bus rather than a module singleton.
 */

export const MCP_TOOLS_CHANNEL = 'pi-code:mcp-tools'

export interface McpToolAlias {
  /** Tool name as registered in pi, e.g. `github_create_issue`. */
  pi: string
  /** Claude Code's name for the same tool, e.g. `mcp__github__create_issue`. */
  claude: string
}

export function isMcpToolAliases(data: unknown): data is McpToolAlias[] {
  return Array.isArray(data) && data.every((entry) => typeof (entry as McpToolAlias)?.pi === 'string' && typeof (entry as McpToolAlias)?.claude === 'string')
}
