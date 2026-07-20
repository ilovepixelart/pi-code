# pi-code

[![npm](https://img.shields.io/npm/v/pi-code)](https://www.npmjs.com/package/pi-code)
[![npm](https://img.shields.io/npm/dt/pi-code)](https://www.npmjs.com/package/pi-code)
[![GitHub](https://img.shields.io/github/license/ilovepixelart/pi-code)](https://github.com/ilovepixelart/pi-code/blob/main/LICENSE)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=coverage)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)

Claude Code experience for the [pi](https://pi.dev) coding agent, in one package. Point pi at a project that already has a `.claude/` directory and it reads your existing config: rules, commands, skills, hooks, output styles, MCP servers, and agents. It also adds the Claude Code features pi lacks: a todo overlay, checkpoints, memory, web search, and subagents.

![pi-code demo](demos/hero.gif)

## Install

```bash
pi install pi-code                       # from npm (when published)
pi install git:github.com/ilovepixelart/pi-code
pi install ~/Documents/pi-code           # local path, then /reload after edits
```

One `pi install`, everything below loads. Each feature is an extension under [`extensions/`](extensions).

## What it does

| Feature | Reads / provides | Extension |
|---|---|---|
| Global + project rules | `~/.claude/rules`, `.claude/rules` (+ `paths:` frontmatter scoping) | `claude-rules.ts` |
| Custom slash commands | `.claude/commands/*.md` → pi prompt templates | `commands.ts` |
| Skills | `.claude/skills` → pi skill discovery | `skills.ts` |
| Hooks | `.claude/settings.json` hooks on pi lifecycle events | `hooks.ts` |
| Output styles | `.claude/output-styles` + active `outputStyle`, `/output-style` switcher | `output-styles.ts` |
| CLAUDE.md `@imports` | resolves `@path` imports pi's native loader skips | `context-imports.ts` |
| MCP servers | `.mcp.json`, `~/.claude.json`, `.pi/mcp.json`; stdio + HTTP | `mcp.ts` |
| Subagents / Task | `~/.claude/agents` + project `.claude/agents`, background runs | `subagent/` |
| Plan mode | `plan_mode_complete` tool, exact tool snapshot/restore | `plan-mode/` |
| Todo list | persistent overlay, status machine, compaction-safe | `todo.ts` |
| Checkpoints / rewind | shadow-repo snapshots, hard-reset restore | `git-checkpoint.ts` |
| Persistent memory | per-project memories, index injected each session | `memory.ts` |
| WebSearch / WebFetch | key-free DuckDuckGo search, SSRF-guarded fetch | `web.ts` |
| AskUserQuestion | vendored example | `question.ts` |
| Statusline | turn state + session cost | `status-line.ts` |
| Notifications | vendored example | `notify.ts` |

`CLAUDE.md` itself needs no extension: pi loads `CLAUDE.md` / `AGENTS.md` context files natively (global + walking cwd to root). `context-imports.ts` only adds the `@import` resolution pi's loader lacks, appending the imported files without re-injecting the base.

Vendored bases (`question`, `notify`, `status-line`) come from pi's MIT example extensions (see [LICENSE](LICENSE)). Personal config lives in [dot-pi](https://github.com/ilovepixelart/dot-pi) (`~/.pi/agent`).

## Development

```bash
npm install
npm run check           # biome + strict tsc + vitest, the whole gate
scripts/e2e.sh          # drives the real pi TUI via tmux (needs a working model)
scripts/record-demos.sh # re-records demos/*.tape with vhs at low thinking
```

Extensions live in `extensions/`, tests in `tests/`. Install locally with `pi install ~/Documents/pi-code`, then `/reload` after edits.
