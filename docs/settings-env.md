# Settings `env`

Exports `env` blocks from settings into the session. Source: [`extensions/env-settings.ts`](../extensions/env-settings.ts).

- Reads `managed-settings.json`, `~/.claude/settings.json`, and the project `.claude/settings.json`/`settings.local.json`, per-key `managed > user > project`.
- The project scope is approval-gated (a repo's env can redirect providers).
- A shell `export` outranks user and project values, but a managed key overrides even that.
- A key an approved project set is unset once a later session no longer defines it.
