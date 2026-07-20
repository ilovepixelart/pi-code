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

That gate is only as good as the trust decision behind it. pi decides whether to ask by looking for entries under `cwd/.pi` and for `.agents/skills`; a repository shipping only `.claude/` and `.mcp.json` matches neither, so `resolveProjectTrusted` returns `true` for it without prompting and without a stored decision. Extensions therefore see `isProjectTrusted()` as true for a repository nobody was asked about. `project-approval` asks for those projects at the point the project config is consumed, and remembers the answer; it defers when pi genuinely prompted, and refuses when there is no UI to ask with.

`context-imports` confines `@path` imports with `realpath`. A file under the user's own config may import from `~/.claude` and `~/.pi`; a project file may import only from the working directory. Without that split a cloned repository's `CLAUDE.md` could read `~/.claude/.credentials.json`, global settings, and other projects' transcripts into the system prompt.

`web_fetch` refuses loopback, RFC1918, link-local, CGNAT, benchmark (198.18/15), protocol-assignment (192.0.0/24), multicast, reserved (240/4) and broadcast addresses, and the IPv6 equivalents including IPv4-mapped, NAT64, unique-local, link-local, site-local and multicast. It fails closed when a host resolves to no address, refuses a redirect that leaves `http(s)`, and caps the response body before parsing.

## Known limitations

These are not addressed yet. None is a trust-model bypass on macOS/Linux, which are the primary supported platforms.

- **Plan mode's bash allowlist is model steering, not a sandbox.** It splits a command on the shell separators outside quotes, validates each subcommand independently, refuses command and process substitution, and excludes commands carrying execution, write or exfiltration primitives. The split is a quote-aware scan rather than a shell parse, so an exotic quoting form may be split wrongly; it fails closed on unbalanced quotes. It cannot constrain an allowlisted interpreter that reads or writes files itself, and pi-code has no OS-level isolation to fall back on. Treat it as narrowing the blast radius of a wrong turn, not as containing a determined one.
- **Windows.** `hooks` runs commands through `sh`; if `sh` is absent it fails open (the tool is allowed rather than blocked). The `subagent` fallback spawn also assumes `pi` is not a `.cmd` shim. Use on Windows is untested.
- **hooks timeout is not enforced for compound commands.** Only a single-command hook is exec'd directly by `sh` and killed on timeout. A compound hook (`a; b`, a pipeline, a multi-line script) leaves grandchildren holding the stdio pipes, so the run resolves only when the child finishes naturally: the tool call stalls for that full duration and is then allowed through. A hook that tried to block with `exit 2` is reported as exit 0.
- **hook stdout is not capped.** A hook emitting hundreds of megabytes is buffered whole.
- **DNS-rebinding TOCTOU (`web`).** The SSRF guard validates the resolved address, then `fetch` resolves the host again independently; the validated IP is not pinned for the connection. A rebinding server with a zero-TTL record can pass the check and then be reached at a private address.
- **skills / commands are not trust-gated.** Their path handling is safe (fixed `.claude/skills` and `.claude/commands` paths, no filename or content reaches a command), but the directories are handed to pi's loader without a trust check. The residual risk is pi's loader surfacing untrusted skill descriptions or command bodies to the model.
- **web body cap is a mitigation, not a bound of zero.** `web_fetch` caps the raw response at 200 KB before the HTML regexes run. A hostile page near that cap can still block the event loop for a few seconds; benign pages (which close their tags) are unaffected.
- **Agent discovery walks above the project root.** `.claude/agents` and `.pi/agents` are searched from the working directory up to the filesystem root, so an agent planted in a world-writable ancestor such as `/tmp` is offered as a project agent. The consent prompt also reports `(unknown)` as the source unless the agents came from `.pi/agents`.
- **Imports are unbounded in count and size.** The `@path` depth cap and cycle detection hold, but a context file may pull in an unlimited number of files from the working directory.
