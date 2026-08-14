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
| context-imports | `CLAUDE.local.md` body and its `@imports`, injected into the system prompt |
| commands | project `.claude/commands` bodies (they run shell via `` !`cmd` `` and inline files via `@path`) |
| skills | project `.claude/skills` paths (pi's loader surfaces every skill name and description to the model) |

That gate is only as good as the trust decision behind it. pi decides whether to ask by looking for entries under `cwd/.pi` and for `.agents/skills`; a repository shipping only `.claude/` and `.mcp.json` matches neither, so `resolveProjectTrusted` returns `true` for it without prompting and without a stored decision. Extensions therefore see `isProjectTrusted()` as true for a repository nobody was asked about. `project-approval` asks for those projects at the point the project config is consumed, and remembers the answer; it defers when pi genuinely prompted, and refuses when there is no UI to ask with.

`context-imports` confines `@path` imports with `realpath`. A file under the user's own config may import from `~/.claude` and `~/.pi`; a project file may import only from the working directory. Without that split a cloned repository's `CLAUDE.md` could read `~/.claude/.credentials.json`, global settings, and other projects' transcripts into the system prompt.

`web_fetch` refuses loopback, RFC1918, link-local, CGNAT, benchmark (198.18/15), protocol-assignment (192.0.0/24), multicast, reserved (240/4) and broadcast addresses, and the IPv6 equivalents including IPv4-mapped, NAT64, unique-local, link-local, site-local and multicast. It fails closed when a host resolves to no address, refuses a redirect that leaves `http(s)`, and caps the response body before parsing. The host is resolved once and the connection is pinned to that validated address (via a `node:http`/`node:https` `lookup`, with SNI and the `Host` header kept as the real hostname), so a rebinding record cannot answer public to the check and private to the connection.

## Known limitations

These are not addressed yet. None is a trust-model bypass on macOS/Linux, which are the primary supported platforms.

- **Plan mode's bash allowlist is model steering, not a sandbox.** It splits a command on the shell separators outside quotes, validates each subcommand independently, refuses command and process substitution, and excludes commands carrying execution, write or exfiltration primitives. The split is a quote-aware scan rather than a shell parse, so an exotic quoting form may be split wrongly; it fails closed on unbalanced quotes. It cannot constrain an allowlisted interpreter that reads or writes files itself, and pi-code has no OS-level isolation to fall back on. Treat it as narrowing the blast radius of a wrong turn, not as containing a determined one.
- **Windows.** `hooks` runs commands through `sh`; if `sh` is absent it fails open (the tool is allowed rather than blocked). The `subagent` fallback spawn also assumes `pi` is not a `.cmd` shim. Use on Windows is untested.
- **The hook timeout binds the process tree, but only on POSIX.** The shell is spawned detached as its own process-group leader, the timeout SIGKILLs the whole group, and the run resolves from the timer rather than from `close`, so a grandchild of a compound hook (`a; b`, a pipeline, a multi-line script) can neither outlive the timeout nor stall the awaiting tool call by holding the stdio pipes. A timed-out `PreToolUse` hook fails closed: it blocks the tool rather than being reported as the clean exit its SIGKILLed shell would otherwise look like. Two residuals: `detached` also means a running hook outlives pi if pi exits first, and the group kill is POSIX-only, so on Windows the timeout still reaches the direct child alone.
- **hook output is capped at 1MB per stream.** A hook exceeding that has its output truncated, which can make a decision payload unparseable and therefore non-blocking, the same as any malformed hook output.
- **`allowed-tools` is enforced per tool, not per argument, and never leaves a turn with nothing.** Claude scopes a grant to arguments, so `Bash(git add:*)` pre-approves exactly those commands. pi's active-tool list has no argument dimension, so the scope is dropped and the base tool is granted for the turn: a command declaring `Bash(git add:*)` can run any bash command, and pi has no per-call approval in front of bash to narrow that. A name no pi tool answers to (`NotebookEdit`, say) would intersect the grant to nothing, so the turn runs unrestricted rather than with no tools at all: a restriction that cannot be expressed is not applied. An explicitly empty `allowed-tools: []` is a restriction the author wrote rather than one that failed to map, and is honored as no tools. Read `allowed-tools` as naming which tools a command may reach, not which arguments it may pass them, and the same holds for an agent's `tools:`.
- **skills and commands are trust-gated; pi's own skill loader still reads the files.** Project `.claude/skills` and `.claude/commands` are handed to the loader only once the project is approved, so an unapproved repository contributes neither command bodies nor skill descriptions to the model. Within an approved project, pi's loader decides what a skill may do: its `allowed-tools` frontmatter is inert there, which is upstream behavior rather than something this package can enforce.
- **Checkpoints copy the working tree into `~/.pi/agent/checkpoints`, retained for 30 days.** Each session gets a bare shadow repo holding full snapshots of the tracked and non-ignored-untracked files at every turn. `.gitignore` is honored, so the usual `.env` case is excluded, but any non-ignored secret or large asset is copied under the home directory and outlives the session. Repos untouched for longer than 30 days are removed at session start (the live session's repo is always kept); delete anything sensitive sooner by hand.
- **web body cap is a mitigation, not a bound of zero.** `web_fetch` caps the raw response at 200 KB before the HTML regexes run. A hostile page near that cap can still block the event loop for a few seconds; benign pages (which close their tags) are unaffected.
- **Agent discovery is bounded by the project root** (`.git` or `package.json`); a project with neither marker is searched only in the working directory, so an agent planted in an ancestor is not offered. The consent prompt names the directory each requested agent was loaded from, and collapses whitespace in the agent name so a crafted name cannot forge a second provenance line.
- **Imports are bounded, but the bound is a budget rather than a policy.** Alongside the `@path` depth cap and cycle detection, one budget (50 files, 256 KB) is shared by every context file of a run: imports stop once it is spent, the body that outruns it is truncated with a marker, and the number of skipped imports is stated in the prompt. Which files fill that budget is still the context file's choice, so a hostile `CLAUDE.md` can crowd out the imports a user wanted with 50 of its own.
