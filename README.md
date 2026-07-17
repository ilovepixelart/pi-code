# pi-code

Claude Code experience for the [pi](https://pi.dev) coding agent: one plugin per feature, one monorepo.

![pi-code demo](demos/hero.gif)

| Claude Code | Package | Status |
|---|---|---|
| Plan mode | [packages/plan-mode](packages/plan-mode) | adapted: plan_mode_complete tool, exact tool snapshot/restore |
| Task tool / subagents | [packages/subagents](packages/subagents) | adapted: background runs with completion notify, ~/.claude/agents discovery, workflow prompts |
| Permission prompts | [packages/permissions](packages/permissions) | rewritten: wildcard allow/ask/deny rules, session/persisted allows |
| Todo list | [packages/todo](packages/todo) | rewritten: persistent overlay, status machine, compaction-safe |
| MCP servers | [packages/mcp](packages/mcp) | hand-written: mcp.json config, stdio + HTTP transports |
| Persistent memory | [packages/memory](packages/memory) | hand-written: per-project memories, index injected each session |
| WebSearch / WebFetch | [packages/web](packages/web) | hand-written: key-free DuckDuckGo search, SSRF-guarded fetch |
| Checkpoints / rewind | [packages/checkpoint](packages/checkpoint) | rewritten: shadow-repo snapshots, hard-reset restore, untracked files included |
| AskUserQuestion | [packages/question](packages/question) | vendored example |
| Statusline | [packages/statusline](packages/statusline) | rewritten: turn state + session cost |
| Notifications | [packages/notify](packages/notify) | vendored example |
| Global + project rules | [packages/rules](packages/rules) | adapted: inlines ~/.claude/rules globally |
| Git guardrails | [packages/guardrails](packages/guardrails) | hand-written |

Vendored bases come from pi's MIT example extensions (see each package's LICENSE). Personal config lives in [dot-pi](https://github.com/ilovepixelart/dot-pi) (`~/.pi/agent`).

## Development

```bash
npm install
npm run check          # biome + strict tsc + vitest, the whole gate
scripts/e2e.sh         # drives the real pi TUI via tmux (needs a working model)
scripts/record-demos.sh # re-records demos/*.tape with vhs at low thinking
```

Install a package into pi by local path (`pi install ~/Documents/pi-code/packages/todo`), then `/reload` after edits. npm workspaces publish each package independently when the time comes.

## Going public later

Move `packages/rules` and `packages/guardrails` (personal, config-like) to dot-pi first; everything else is flip-ready (LICENSE, CI, tests in place).
