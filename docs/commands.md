# Custom slash commands

Registers `.claude/commands/**/*.md` as slash commands with Claude's command contract. Source: [`extensions/commands.ts`](../extensions/commands.ts), [`extensions/internal/command-file.ts`](../extensions/internal/command-file.ts) for parsing, and [`extensions/internal/command-spans.ts`](../extensions/internal/command-spans.ts) for the `!` and `@` bodies.

## Naming and arguments

- Commands load from every project `.claude/commands` between the working directory and the repository root, then the personal `~/.claude/commands`, then the enterprise directory beside the managed settings file; per Claude, enterprise overrides personal and personal overrides project. A command is named by its file name alone (subdirectories only organize the files).
- `$ARGUMENTS` (the `ARGUMENTS:` append fires only when no placeholder received an argument), 0-based `$ARGUMENTS[N]`/`$N`, named `arguments:` frontmatter. The model-facing listing always keeps every command name; over budget only descriptions are shed.
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` in bodies and `allowed-tools` rules.

## Dynamic content

- `` !`cmd` `` and multi-line ```` ```! ```` bash spans: whitespace-bounded, merged stderr, 2-minute budget; a failure aborts the invocation with the documented exit-1 carveout.
- `@file` inlining.
- `disableSkillShellExecution` (managed and user always, project when trusted) replaces every `!` span with a policy-disabled placeholder.

## Frontmatter

- `allowed-tools` (space- or comma-separated, or a YAML list). Every specifier Claude documents for an allow rule is enforced at call time: `Bash(...)`, the `Read`/`Edit`/`Write` path scopes (gitignore anchors, Edit governs writes), `WebFetch(domain:host)` (case-insensitive, a leading `*.` matches any subdomain depth but not the apex, a `*` elsewhere never crosses a dot), `Agent(AgentName)`, which is checked against every agent a call names across single, `tasks` and `chain` modes, and `Skill(name)` / `Skill(name *)`. An unscoped entry for a tool is the wider grant and lifts its scoped siblings. `Agent` and the legacy `Task` are the same tool, as are `Skill` and the legacy `SlashCommand`.
  - Divergence: pi has no permission system, so this restricts the turn's tool set instead of pre-approving calls. Claude's `allowed-tools` only pre-approves and leaves every other tool callable.
  - Divergence: `Write(...)` path scopes are enforced; Claude accepts them, warns, and never consults them. Enforcing is the safe direction.
  - Claude's `Tool(param:value)` form is not supported, and neither is it applicable: the permissions reference confines parameter rules to deny and ask rules, and `allowed-tools` is an allow surface.
- `disallowed-tools`, `argument-hint`.
- `model`: switches the session model for the command's turn, restored after; `effort`: raises reasoning for the turn, restored after.
- Injected spans run through `/bin/sh`; on Windows through Git Bash, else PowerShell (a `shell: bash` skill fails before any command runs when Git Bash is missing, as Claude documents). `shell: powershell`: PowerShell when one is installed, else the bash path.
- `when_to_use` steers model invocation; `disable-model-invocation` opts a file out; `user-invocable: false` hides a command from the menu while still exposing it to the model.

## Model invocation

The model can run a command itself through the `slash_command` tool, which pi-code registers and reports as `SlashCommand`. Claude has since folded custom commands into skills and its tools reference no longer lists a SlashCommand tool, so `Skill` and `SlashCommand` both resolve to this tool in `allowed-tools`, and `Skill(name)` / `Skill(name *)` scopes are enforced at call time against the invocation. Only those two forms are interpreted; any other spelling matches nothing rather than widening the grant. Project commands are gated on approval.
