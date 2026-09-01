# MCP servers

Connects Claude Code's MCP configuration and registers each server's tools in pi. Source: [`extensions/mcp/`](../extensions/mcp).

## Configuration scopes

- User: `~/.claude.json` (including the per-project `projects[cwd].mcpServers` local scope) and `~/.pi/agent/mcp.json`.
- Project: `.mcp.json` and `.pi/mcp.json`, loaded once the project is approved; `enabledMcpjsonServers`/`disabledMcpjsonServers`/`enableAllProjectMcpServers` honored, with consent keys counted only from non-repo settings.
- Managed: a `managed-mcp.json` beside `managed-settings.json` takes exclusive control — only its servers load, every other scope and the approval flow suppressed; an empty file disables MCP.

## Policy

Managed `allowedMcpServers`/`deniedMcpServers` entries are typed and matched per Claude's contract: `serverUrl` (with `*` wildcards anywhere, case-insensitive host and trailing-dot fold, case-sensitive path, a no-path pattern matches any path), `serverCommand` (exact argv), and `serverName` (allowlist names limited to letters/numbers/hyphens/underscores; the name fallback counts only when no typed entries exist for the server's transport). Both lists merge from the trust-gated settings chain; `allowManagedMcpServersOnly` keeps the allowlist managed-only; the deny side matches raw and expanded forms so expansion drift can only widen a deny. An empty allow array is a lockdown; deny wins.

## Transports and auth

- stdio, HTTP (streamable with SSE fallback), SSE, and WebSocket by `type`. WebSocket is url-only: any `headers`/`bearerToken`/`headersHelper` on a ws server is ignored with a warning (the SDK transport carries no headers; Claude documents header auth for ws, so authenticated ws servers cannot be used yet).
- `${VAR}` / `${VAR:-default}` expansion in values.
- A `headersHelper` command's stdout JSON merges into the transport headers (http/sse).
- Bearer tokens, or OAuth for remote servers: browser login on 401 after a confirm, CSRF-guarded loopback callback, tokens under `~/.pi/agent/mcp-oauth`, silent refresh later.

## Budgets

Connect and per-call budgets honor `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` over a 4-hour wall default, plus a 5-minute idle timeout that a progress notification resets (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `0` disables).

## Surface

A connected server's prompts register as `/mcp__server__prompt` commands; resources are reachable through the `list_mcp_resources`/`read_mcp_resource` tools; tools refresh on `list_changed`. `/mcp` shows status.
