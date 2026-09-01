# MCP servers

Connects Claude Code's MCP configuration and registers each server's tools in pi. Source: [`extensions/mcp/`](../extensions/mcp).

## Configuration scopes

- User: `~/.claude.json` (including the per-project `projects[cwd].mcpServers` local scope) and `~/.pi/agent/mcp.json`. The per-project `disabledMcpServers` toggle list mutes a user or plugin server without removing it.
- Project: `.mcp.json` and `.pi/mcp.json`, loaded once the project is approved; `enabledMcpjsonServers`/`disabledMcpjsonServers`/`enableAllProjectMcpServers` honored, with consent keys counted only from non-repo settings. Precedence on a name clash is local over project over user.
- Managed: a `managed-mcp.json` beside `managed-settings.json` takes exclusive control — only its servers load, every other scope and the approval flow suppressed; an empty file disables MCP.

## Policy

Managed `allowedMcpServers`/`deniedMcpServers` entries are typed and matched per Claude's contract: `serverUrl` (with `*` wildcards anywhere, case-insensitive host and trailing-dot fold, case-sensitive path, a no-path pattern matches any path), `serverCommand` (exact argv), and `serverName` (allowlist names limited to letters/numbers/hyphens/underscores; the name fallback counts only when no typed entries exist for the server's transport). Both lists merge from the trust-gated settings chain; `allowManagedMcpServersOnly` keeps the allowlist managed-only; the deny side matches raw and expanded forms so expansion drift can only widen a deny. An empty allow array is a lockdown; deny wins.

## Transports and auth

- stdio, HTTP (streamable with SSE fallback), SSE, and WebSocket by `type`. WebSocket is url-only: any `headers`/`bearerToken`/`headersHelper` on a ws server is ignored with a warning (the SDK transport carries no headers; Claude documents header auth for ws, so authenticated ws servers cannot be used yet).
- `${VAR}` / `${VAR:-default}` expansion in values.
- Stdio servers get `CLAUDE_PROJECT_DIR` (and `CLAUDE_PLUGIN_ROOT` for a plugin's server) in their environment; every client answers `roots/list` with the session's launch directory.
- A `headersHelper` command's stdout JSON merges into the transport headers (http/sse). The helper runs with `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL` set (credential-expanded url parts shown as `REDACTED`); a project- or plugin-supplied helper runs without credential-named variables (`TOKEN`/`SECRET`/`PASSWORD`/`KEY`/`AUTH`).
- Bearer tokens, or OAuth for remote servers: browser login on 401/403 after a confirm, CSRF-guarded loopback callback, tokens under `~/.pi/agent/mcp-oauth`, silent refresh later. A configured `Authorization` header (static, bearer, or helper-supplied) is the server's authentication: auth failures report as failed connections with no OAuth fallback.

## Budgets

Connect and per-call budgets honor `MCP_TIMEOUT` (30s default) and `MCP_TOOL_TIMEOUT` (4-hour wall default), plus an idle timeout that a progress notification resets: 5 minutes for remote transports, 30 minutes for stdio (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` overrides, `0` disables). A per-server `timeout` of at least 1000 sets the wall budget and floors the idle window; lower values are ignored. Numeric env values accept `2e3` and `64_000` spellings.

## Surface

A connected server's prompts register as `/mcp__server__prompt` commands; resources are reachable through the `list_mcp_resources`/`read_mcp_resource` tools; tools refresh on `list_changed`. `/mcp` shows status.
