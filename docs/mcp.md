# MCP servers

Connects Claude Code's MCP configuration and registers each server's tools in pi. Source: [`extensions/mcp/`](../extensions/mcp).

## Configuration scopes

- User: `~/.claude.json` (including the per-project `projects[cwd].mcpServers` local scope) and `mcp.json` in pi's agent directory (`~/.pi/agent`, relocated by `PI_CODING_AGENT_DIR`). The per-project `disabledMcpServers` toggle list mutes a user or plugin server without removing it.
- Project: `.mcp.json` and `.pi/mcp.json`, loaded once the project is approved; `enabledMcpjsonServers`/`disabledMcpjsonServers`/`enableAllProjectMcpServers` honored, with consent keys counted only from non-repo settings. Precedence on a name clash is local over project over user.
- Plugin stdio servers get Claude's three path variables in their environment: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (the data directory is created when the path is handed over, which is Claude's "created on first reference").
- **Divergence:** `CLAUDE_CODE_MCP_ALLOWLIST_ENV` has no effect here. pi-code always passes the SDK's baseline environment to a stdio server, with no opt-out.
- A stdio server also gets `CLAUDE_CODE_SESSION_ID`, captured once at connect time ("an MCP server subprocess retains the ID it was spawned with") rather than re-read per call.
- `MCP_OAUTH_CALLBACK_PORT` is a fallback default for any server naming no per-server `oauth.callbackPort`. Claude documents it as "an alternative to `--callback-port` when adding an MCP server with pre-configured credentials"; pi-code has no `mcp add` command, so the fallback applies more broadly.
- Managed: a `managed-mcp.json` beside `managed-settings.json` takes exclusive control — only its servers load, every other scope and the approval flow suppressed; an empty file disables MCP.

## Policy

Managed `allowedMcpServers`/`deniedMcpServers` entries are typed and matched per Claude's contract: `serverUrl` (with `*` wildcards anywhere, case-insensitive host and trailing-dot fold, case-sensitive path, a no-path pattern matches any path), `serverCommand` (exact argv), and `serverName` (allowlist names limited to letters/numbers/hyphens/underscores; the name fallback counts only when no typed entries exist for the server's transport). Both lists merge from the trust-gated settings chain; `allowManagedMcpServersOnly` keeps the allowlist managed-only; the deny side matches raw and expanded forms so expansion drift can only widen a deny. An empty allow array is a lockdown; deny wins.

## Transports and auth

- stdio, HTTP (streamable with SSE fallback), SSE, and WebSocket by `type`. WebSocket is url-only: any `headers`/`bearerToken`/`headersHelper` on a ws server is ignored with a warning (the SDK transport carries no headers; Claude documents header auth for ws, so authenticated ws servers cannot be used yet).
- `${VAR}` / `${VAR:-default}` expansion in values; `:-` follows shell semantics deliberately (substitutes when unset OR empty), a pinned reading of the doc's "if set" summary.
- Stdio servers get `CLAUDE_PROJECT_DIR` (and `CLAUDE_PLUGIN_ROOT` for a plugin's server) in their environment; every client answers `roots/list` with the session's launch directory.
- A `headersHelper` command's stdout JSON merges into the transport headers (http/sse). The helper runs with `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL` set (credential-expanded url parts shown as `REDACTED`); a project- or plugin-supplied helper runs without credential-named variables (`TOKEN`/`SECRET`/`PASSWORD`/`KEY`/`AUTH`).
- Bearer tokens, or OAuth for remote servers: browser login on 401/403 after a confirm, CSRF-guarded loopback callback, tokens under `~/.pi/agent/mcp-oauth`, silent refresh later. A configured `Authorization` header (static, bearer, or helper-supplied) is the server's authentication: auth failures report as failed connections with no OAuth fallback.
- The per-server `oauth` object: `clientId` (secret via `MCP_CLIENT_SECRET`) replaces dynamic registration, `callbackPort` fixes the loopback port, `scopes` pins the requested scopes. `authServerMetadataUrl` is accepted but warned as unsupported (the MCP SDK has no discovery override).
- Lifecycle: a transient first-connect failure of a remote server (5xx, refused, timeout) retries up to three times; a remote server that drops mid-session reconnects with exponential backoff (five attempts, 1s doubling); stdio servers are not auto-reconnected. A tool call rejected with 401/403 reconnects once (re-running the `headersHelper`, refreshing OAuth tokens) and retries once.

## Budgets

Connect and per-call budgets honor `MCP_TIMEOUT` (30s default) and `MCP_TOOL_TIMEOUT` (4-hour wall default here, where Claude leaves it at about 28 hours: a wall that long is indistinguishable from none in an interactive session), plus an idle timeout that a progress notification resets: 5 minutes for remote transports, 30 minutes for stdio (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` overrides, `0` disables). A per-server `timeout` of at least 1000 sets the wall budget and floors the idle window; lower values are ignored. Numeric env values accept `2e3` and `64_000` spellings.

Startup connects are non-blocking, as Claude documents ("servers connect in the background and their tools become available as they finish"): an interactive session's `session_start` waits up to `MCP_CONNECT_TIMEOUT_MS` (5s default) for the connect batch, then proceeds regardless, so one slow or unreachable server no longer costs the whole session its own `MCP_TIMEOUT` × retries. Still-connecting servers keep going in the background and register their tools as they finish, with a second startup summary once they do. A headless (no-UI) session still waits for every server before proceeding, matching Claude's stated exception for `-p` runs, which have no later turn to react to a tool that arrives after the fact. **Not implemented:** `alwaysLoad`-style forced waiting for specific servers, and the `ToolSearch`/`WaitForMcpServers` mechanism that lets the model itself wait on a tool that has not registered yet; a call to such a tool today simply finds no tool by that name, the same as before it connected.

## Surface

A connected server's prompts register as `/mcp__server__prompt` commands; resources are reachable through the `list_mcp_resources`/`read_mcp_resource` tools and via `@server:uri` mentions in a prompt, which fetch and inline the resource (mentions naming an unconnected server stay literal); tools refresh on `list_changed`. `/mcp` shows status.
