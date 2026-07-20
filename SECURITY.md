# Security

pi-code bridges a project's `.claude/` configuration into pi. That configuration can come from an untrusted cloned repository, so extensions that read project-controlled input act on it only once pi has marked the project trusted (`ctx.isProjectTrusted()`). User-scoped config (`~/.claude`, `~/.pi`) is the user's own and always loaded.

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/ilovepixelart/pi-code/security/advisories/new). Please do not open a public issue for a security report.

## Trust model

An untrusted project can ship any `.claude/` content. These extensions read that project input only for a trusted project:

| Extension | Project input gated behind trust |
|---|---|
| mcp | `.mcp.json` / `.pi/mcp.json` servers (a server `command` runs on connect) |
| hooks | project `settings.json` hooks (arbitrary shell on tool calls) |
| subagent | project `.claude/agents` / `.pi/agents` (their own system prompt and tools) |
| output-styles | project style body, injected verbatim into the system prompt |
| rules | project rule filenames and `paths:` frontmatter, surfaced in the system prompt |
| context-imports | `@path` imports, confined via `realpath` to cwd, `~/.claude`, and `~/.pi` |

`web_fetch` refuses loopback, RFC1918, link-local, CGNAT, and the IPv6 equivalents (including IPv4-mapped and NAT64 forms), and caps the response body before parsing.

## Known limitations

These are not addressed yet. None is a trust-model bypass on macOS/Linux, which are the primary supported platforms.

- **Windows.** `hooks` runs commands through `sh`; if `sh` is absent it fails open (the tool is allowed rather than blocked). The `subagent` fallback spawn also assumes `pi` is not a `.cmd` shim. Use on Windows is untested.
- **hooks timeout is fail-open.** A `PreToolUse` hook that hangs past its timeout lets the tool through instead of blocking it.
- **DNS-rebinding TOCTOU (`web`).** The SSRF guard validates the resolved address, then `fetch` resolves the host again independently; the validated IP is not pinned for the connection. A rebinding server with a zero-TTL record can pass the check and then be reached at a private address.
- **skills / commands are not trust-gated.** Their path handling is safe (fixed `.claude/skills` and `.claude/commands` paths, no filename or content reaches a command), but the directories are handed to pi's loader without a trust check. The residual risk is pi's loader surfacing untrusted skill descriptions or command bodies to the model.
- **web body cap is a mitigation, not a bound of zero.** `web_fetch` caps the raw response at 200 KB before the HTML regexes run. A hostile page near that cap can still block the event loop for a few seconds; benign pages (which close their tags) are unaffected.
