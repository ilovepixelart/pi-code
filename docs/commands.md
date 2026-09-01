# Custom slash commands

Registers `.claude/commands/**/*.md` as slash commands with Claude's command contract. Source: [`extensions/commands.ts`](../extensions/commands.ts) and [`extensions/internal/command-file.ts`](../extensions/internal/command-file.ts).

## Naming and arguments

- Subdirectory commands register as `/dir:name` (`frontend/build.md` is `/frontend:build`); current Claude docs name a command by file name alone, so the qualified form is a pi-code divergence.
- `$ARGUMENTS` (with the `ARGUMENTS:` append when unused), 0-based `$ARGUMENTS[N]`/`$N`, named `arguments:` frontmatter.
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` in bodies and `allowed-tools` rules.

## Dynamic content

- `` !`cmd` `` and multi-line ```` ```! ```` bash spans: whitespace-bounded, merged stderr, 2-minute budget; a failure aborts the invocation with the documented exit-1 carveout.
- `@file` inlining.
- `disableSkillShellExecution` (managed and user always, project when trusted) replaces every `!` span with a policy-disabled placeholder.

## Frontmatter

- `allowed-tools` (space- or comma-separated, or a YAML list) with `Bash(...)` and `Read`/`Edit`/`Write` path scopes enforced at call time (gitignore anchors, Edit governs writes). Divergence: pi has no permission system, so this restricts the turn's tool set instead of pre-approving calls.
- `disallowed-tools`, `argument-hint`.
- `model`: switches the session model for the command's turn, restored after; `effort`: raises reasoning for the turn, restored after.
- `shell: powershell`: injected spans run through PowerShell when a `pwsh` binary is present, else `/bin/sh`.
- `when_to_use` steers model invocation; `disable-model-invocation` opts a file out; `user-invocable: false` hides a command from the menu while still exposing it to the model.

## Model invocation

The model can run a command itself through the `SlashCommand` tool (Claude's `SlashCommand` in `allowed-tools`). Project commands are gated on approval.
