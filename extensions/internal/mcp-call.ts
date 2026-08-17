/**
 * A one-function seam letting the hooks extension invoke a tool on a server the
 * mcp extension has connected, without the two extensions importing each other.
 *
 * The mcp extension registers a caller once its clients exist; anything that needs
 * to call an MCP tool (today: Claude's `type: "mcp_tool"` hooks) goes through
 * callMcpTool. It is the direct-call analogue of the MCP_TOOLS_CHANNEL alias bus.
 */

export interface McpToolResult {
  text: string
  isError: boolean
}

export type McpToolCaller = (server: string, tool: string, input: Record<string, unknown>) => Promise<McpToolResult>

let caller: McpToolCaller | undefined

/** The mcp extension registers its caller here; pass undefined to clear it. */
export function setMcpToolCaller(fn: McpToolCaller | undefined): void {
  caller = fn
}

/** Invoke a tool on a connected MCP server. Throws when no server is connected. */
export function callMcpTool(server: string, tool: string, input: Record<string, unknown>): Promise<McpToolResult> {
  if (!caller) return Promise.reject(new Error(`no MCP server connected to serve ${server}/${tool}`))
  return caller(server, tool, input)
}
