# pi-code-mcp

MCP (Model Context Protocol) adapter for pi: connects configured MCP servers and registers their tools so the agent can call them like native tools.

- Config: `~/.pi/agent/mcp.json` (global) and `.pi/mcp.json` (project), stdio and HTTP transports
- `/mcp` command shows connected servers and their tools
- Startup notification with server/tool counts; failures skip with a warning instead of blocking the session
- Hand-written; design informed by the `pi-mcp-adapter` community package

Config example:

```json
{
  "mcpServers": {
    "sonarqube": { "command": "npx", "args": ["-y", "sonarqube-mcp-server"], "env": { "SONAR_TOKEN": "${SONAR_TOKEN}" } },
    "remote": { "url": "https://example.com/mcp", "bearerTokenEnv": "REMOTE_TOKEN" }
  }
}
```

## Install

Local path install from the monorepo:

```bash
pi install ~/Documents/pi-code/packages/mcp
```
