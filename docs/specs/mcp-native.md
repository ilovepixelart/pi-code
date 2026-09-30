# Hand MCP servers to pi's native MCP

## Problem and outcome

pi 0.99 ships a built-in MCP extension that is `replaceable`: an extension registering `/mcp` at load drops it, and pi warns about that on every start. pi-code registers `/mcp`, so every pi 0.99 user sees the `builtin:mcp` warning, pi's `mcp.json` servers are read by pi-code with pi-code's semantics (`timeout` in ms, no `enabled`, no `!command`), and pi's `pi mcp login` tokens are never used.

Outcome: on pi 0.99 and later with the built-in active, pi-code keeps reading Claude's MCP configuration and applying its approval and scope rules, and hands the servers to pi through `pi.registerMcpServer()`. pi connects them and owns `/mcp`, its own `mcp.json` files and OAuth. Servers pi cannot take stay on pi-code's client. Everything else is unchanged.

## Observed baseline (pi 0.99.1 source)

- The built-in registers only the `/mcp` command during load; `mcp__*`, `list_mcp_resources` and `read_mcp_resource` are registered on connect (`dist/extensions/mcp/index.js`).
- It reads registered servers on `session_start` and connects later registrations on `mcp_servers_change`. A registration no extension handles `mcp_servers_change` for is reported as an extension error (`core/extensions/runner.js`, `reportUnhandledMcpServers`).
- `McpServerConfig` takes stdio (`command`, `args`, `env`, `cwd`) or streamable HTTP (`url`, `headers`, `oauth`), plus `exposure`, `toolExposure`, `enabled`, `timeout` in seconds (resets on progress, default 60). SSE is rejected; there is no WebSocket and no header helper. Names match `[A-Za-z0-9_-]+`.
- Tool names are `mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_-]` folded to `_`: Claude's own naming.
- `pi.getCommands()` carries each command's source, so a running built-in `/mcp` is observable after load.

## Acceptance clauses

"Native mode" means `pi.registerMcpServer` exists and no MCP policy is configured (MCPN-001).

| ID | Behaviour | Check |
|---|---|---|
| MCPN-001 | Native mode is chosen at load when `pi.registerMcpServer` exists and neither `managed-mcp.json` nor `allowedMcpServers`/`deniedMcpServers` in an honored scope is present. Otherwise pi-code runs exactly as today | Unit: `chooses native mode only when the API exists and no policy is set` |
| MCPN-002 | In native mode pi-code registers no `/mcp` command and no `list_mcp_resources` or `read_mcp_resource` tool, and pi 0.99.1 starts without the `builtin:mcp` warning | Unit: registered names in native mode. E2E: pi 0.99.1 stderr |
| MCPN-003 | A user, local, approved project or plugin server with a stdio or streamable HTTP transport, no `headersHelper` and a valid name is registered with `exposure: "direct"`: `${VAR}` and `${VAR:-default}` expanded by pi-code, every `env` and header value escaped so pi runs and expands nothing in it (`$` as `$$`, a leading `!` as `$!`), Claude's `CLAUDECODE` and `CLAUDE_*` variables in a stdio server's env, `bearerToken`/`bearerTokenEnv` as an `Authorization` header, `oauth` mapped to pi's fields, and a timeout in seconds: the idle budget pi-code applies today (floored by a per-server `timeout` of at least 1000 ms), or the wall budget when idle is disabled | Unit: `translates a server config for pi` per field. E2E: a stdio fixture's tool reaches the pi 0.99.1 request as `mcp__fixture__echo` |
| MCPN-004 | A plugin server registers as `plugin_<plugin>_<server>`, so its tools are `mcp__plugin_<plugin>_<server>__<tool>` | Unit: plugin name mapping |
| MCPN-005 | A server with an `sse`, `ws` or `websocket` type, a `headersHelper`, or a name outside `[A-Za-z0-9_-]` connects on pi-code's client as today and is listed in the startup notice | Unit: `keeps servers pi cannot connect on pi-code's client` |
| MCPN-006 | In native mode pi-code does not read `~/.pi/agent/mcp.json` or `.pi/mcp.json` | Unit: config paths in native mode |
| MCPN-007 | Project approval, `disabledMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` and `enableAllProjectMcpServers` decide what is registered, as they decide what connects today; a headless run in an undecided project registers no project server | Unit: existing approval tests pass in both modes |
| MCPN-008 | The roster on `MCP_TOOLS_CHANNEL` includes pi's `mcp__*` tools, so hook matchers and subagent `mcp__<server>` patterns cover natively connected servers | Unit: roster from `getAllTools()`. E2E: a `PreToolUse` hook on `mcp__fixture__echo` fires |
| MCPN-009 | When pi's `/mcp` is not among `pi.getCommands()` at `session_start` (disabled with `-builtin:mcp`, or replaced), pi-code registers nothing with pi and connects every server on its own client, so no registration is reported as unhandled | E2E: pi 0.99.1 with `-builtin:mcp`, fixture tool in the request, no extension error |
| MCPN-010 | On pi before 0.99 behaviour is unchanged | Existing suite. E2E: pi 0.85.1 fixture run |
| MCPN-011 | `docs/mcp.md` and the README describe native mode, what moves to pi, and what does not apply there | Review |

## Micro-tasks

| # | Task | Clauses | Files | Test strategy |
|---|---|---|---|---|
| 1 | Pure translation from pi-code's `ServerConfig` to pi's config, or a reason it cannot be translated | MCPN-003, MCPN-004, MCPN-005 | `extensions/mcp/native.ts`, `tests/mcp-native.test.ts` | Specified values per field, red first |
| 2 | Mode selection | MCPN-001 | `extensions/mcp/native.ts`, `extensions/mcp/index.ts` | Red on each condition |
| 3 | Native registration path in `session_start`, pi's files skipped, no `/mcp` or resource tools | MCPN-002, MCPN-006, MCPN-007 | `extensions/mcp/index.ts`, `extensions/mcp/config.ts` | Red on registered names and paths; approval tests in both modes |
| 4 | Roster from pi's tools | MCPN-008 | `extensions/mcp/index.ts` | Red on the published roster |
| 5 | Fallback when the built-in is not running | MCPN-009 | `extensions/mcp/index.ts` | Red with a fake `getCommands` |
| 6 | End to end on pi 0.99.1 (native, `-builtin:mcp`) and 0.85.1 | MCPN-002, 003, 008, 009, 010 | `scripts/e2e-smoke.sh`, a stdio fixture | Payload and stderr capture, run against `main` for contrast |
| 7 | Docs | MCPN-011 | `docs/mcp.md`, `README.md` | Grep for `/mcp`, `mcp.json`, tool naming |

## What native mode gives up, per natively connected server

- Server prompts as `/mcp__server__prompt` commands and `@server:uri` mentions (pi has neither).
- pi-code's `/mcp` view; pi's `/mcp` replaces it.
- The stdio environment allowlist: pi starts a stdio server with the full parent environment plus its `env`, as Claude Code does by default.
- `mcp_tool` hooks: pi exposes `executeTool()` only inside a tool's `execute()`, so a hook cannot call a tool pi connected.
- `MCP_TIMEOUT`, `MCP_CONNECT_TIMEOUT_MS` and the reconnect schedule: pi's own apply.
- Stored OAuth tokens under `~/.pi/agent/mcp-oauth`: pi keeps its own, so an OAuth server needs one sign-in through pi.
- Tool names change from `<server>_<tool>` to `mcp__<server>__<tool>`. Hooks and subagent patterns written with Claude's names keep matching (MCPN-008); anything naming pi-code's old form does not.

## Out of scope

- Reading pi's `exposure`, `toolExposure`, `enabled` and `!command` in pi-code's own client (legacy mode keeps pi-code's semantics for those files, which older pi users depend on).
- Migrating stored OAuth tokens to pi's store.
- A setting to force legacy mode on pi 0.99.

## Risks

- A policy configured after a session started does not switch modes until the next load.
- pi's `mcp.json` servers are outside Claude's allow and deny lists in native mode; MCPN-001 keeps policy users on legacy mode for that reason.
- Idle budget mapping: pi resets its timeout on progress like pi-code's idle timer, but has no separate wall ceiling.

## Decisions

- Every server pi can connect goes native, including servers that offer prompts or resources; the losses above are accepted.
- Native mode is the default on pi 0.99 and later, shipped as a minor release with the changes listed first.
