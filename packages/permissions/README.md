# pi-code-permissions

Claude Code style permission system for pi's bash, write, and edit tools.

- Wildcard rules with `allow` / `ask` / `deny` actions, evaluated last-match-wins
- Config: global `~/.pi/agent/permissions.json`, project `.pi/permissions.json` (project wins)
- Chained bash commands are split into units; the most restrictive verdict wins
- Wrappers (`sudo`, `sh -c`, `eval`, `env`, `xargs`) can never ride an allow rule
- Built-in dangerous-command floor (rm -rf, git reset --hard, dd, ...) always at least asks
- Prompt options: once / allow pattern for session / always allow (persisted to project config) / block
- Fail closed: gate errors block, and `ask` blocks in non-interactive mode
- `/permissions` shows the active rule set

Started from the pi v0.74.2 `permission-gate` example; rule engine modeled on `@gotgenes/pi-permission-system`, trimmed to a single dependency-free file.

## Config format

```json
{
  "bash": {
    "npm test *": "allow",
    "git push *": "ask",
    "curl *": "deny"
  },
  "write": { "/etc/*": "deny" }
}
```

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-permissions
```
