// Stdio MCP server for scripts/e2e-smoke.sh: one `echo` tool. Built on the SDK's
// low-level Server so it needs nothing beyond the package's own dependency.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'smoke', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `ECHO:${request.params.arguments?.text ?? ''}` }],
}))
await server.connect(new StdioServerTransport())
