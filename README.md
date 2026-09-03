# pi-code

[![npm](https://img.shields.io/npm/v/pi-code)](https://www.npmjs.com/package/pi-code)
[![npm](https://img.shields.io/npm/dt/pi-code)](https://www.npmjs.com/package/pi-code)
[![GitHub](https://img.shields.io/github/license/ilovepixelart/pi-code)](https://github.com/ilovepixelart/pi-code/blob/main/LICENSE)
\
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=coverage)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
\
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=ilovepixelart_pi-code&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=ilovepixelart_pi-code)

Claude Code experience for the [pi](https://pi.dev) coding agent, in one package. Point pi at a project that already has a `.claude/` directory and it reads your existing config: rules, commands, skills, hooks, output styles, MCP servers, and agents. It also adds the Claude Code features pi lacks: a todo overlay, checkpoints, memory, web search, subagents, and goals.

What a repository ships is treated as untrusted until you approve it: project MCP servers, hooks, agents, rules, output styles, commands and skills load only once you say yes. A headless run (`pi -p`) cannot ask, so an undecided project loads none of them there, which is stricter than Claude, where a headless run uses them without showing the dialog.

![pi-code demo](demos/hero.gif)

## Requirements

pi `>=0.79.1` (0.84.x recommended) and Node `>=22.19` for current pi.

## Install

```bash
pi install npm:pi-code       # from npm
pi install -l npm:pi-code    # project-local instead, writes .pi/settings.json
```

Other sources:

```bash
pi install git:github.com/ilovepixelart/pi-code
pi install ./pi-code         # local checkout, then /reload after edits
```

One `pi install` and everything below loads on the next start. `pi list` shows what is installed, `pi config` toggles individual resources, and `pi update pi-code` upgrades it. Each feature is an extension under [`extensions/`](extensions).

## What it does

Each topic links to its own doc with the full contract and any divergences from Claude Code.

- **[Hooks](docs/hooks.md)** — your `.claude/settings.json` hooks on every lifecycle event, with Claude's tool vocabulary, decision fields, and background hooks.
- **[MCP servers](docs/mcp.md)** — every Claude config scope, all four transports, OAuth, managed policy, timeouts, prompts, and resources.
- **[Custom slash commands](docs/commands.md)** — `.claude/commands` with arguments, bash spans, `@file` inlining, frontmatter, and model invocation.
- **[Skills](docs/skills.md)** — `.claude/skills` discovery plus the same dynamic content commands get.
- **[Subagents](docs/subagents.md)** — built-in and custom agents, background runs, per-agent memory, worktree isolation.
- **[CLAUDE.md, @imports, and rules](docs/claude-md.md)** — the context files and path-scoped rules pi does not load natively.
- **[Settings `env`](docs/settings-env.md)** — env blocks from every settings scope, exported with Claude's precedence.
- **[Output styles](docs/output-styles.md)** — replace semantics, bundled built-ins, `/output-style`.
- **[Persistent memory](docs/memory.md)** — a per-repository store with a session-injected index.
- **[Statusline](docs/statusline.md)** — your Claude `statusLine` command with the documented stdin JSON.
- **[WebSearch / WebFetch](docs/web.md)** — key-free search and SSRF-guarded fetch.
- **[Claude plugins](docs/plugins.md)** — installed marketplace plugins: commands, agents, hooks, MCP servers, styles, skills.
- **[Goal](docs/goal.md)**: `/goal <condition>` keeps the session working until a separate model check confirms the condition holds, with status, clear, block cap, background-work deferral, and resume.
- **[Session extras](docs/session-extras.md)** — project trust, plan mode, todos, checkpoints/rewind, AskUserQuestion, notifications, think keywords, session titles, `/context`, `/init`.

Slash commands: `/init`, `/context`, `/goal`, `/memory`, `/todos`, `/rewind`, `/tasks`, `/agents`, `/plan`, `/mcp`, `/hooks`, and `/output-style`, alongside your own `/dir:name` commands, `/skill:name` skills, `/plugin:name` plugin commands, and each connected server's `/mcp__server__prompt` prompts.

pi has no general permission system, so most of what Claude routes through a permission prompt maps to hard behavior here: `allowed-tools` restricts the turn's tool set instead of pre-approving calls, and a hook that times out on PreToolUse or UserPromptSubmit fails closed. A hook's `permissionDecision: "ask"` is the exception: it shows a confirm dialog and lets the call through when you approve (a headless run has no dialog, so it blocks). Where a Claude restriction cannot be expressed at all (an argument-scoped grant in an agent's `tools:`), the definition is rejected rather than widened.

Trust is the other place pi-code is deliberately stricter. Claude states that "a `claude -p` run never shows the trust dialog" and loads the project's hooks, MCP servers, agents, commands, skills and rules anyway. pi-code refuses instead: with no stored decision and no UI to ask, a headless run in a project you have not already trusted loads none of them. A repository would otherwise get to run its own hooks and MCP servers in any CI job that checks it out, with nobody present to decline.

`CLAUDE.md` itself needs no extension: pi loads `CLAUDE.md` / `AGENTS.md` context files natively (global + walking cwd to root). `context-imports.ts` only adds the `@import` resolution pi's loader lacks, appending the imported files without re-injecting the base. Setting `CLAUDE_CONFIG_DIR` relocates the entire home config scope (settings, commands, agents, skills, plugins, output styles, memory, and the user `CLAUDE.md`); a project's own `.claude/` is a separate scope and is unaffected.

[`extensions/internal/`](extensions/internal) holds the shared modules pi's loader must not treat as extensions (each file's header says what it owns); only `internal/` keeps them out of pi's extension scan.

Vendored bases (`question`, `notify`, `status-line`) come from pi's MIT example extensions (see [LICENSE](LICENSE)).

## Development

```bash
npm install
npm run check           # biome + strict tsc + knip + vitest with coverage floors, the whole gate
scripts/e2e-smoke.sh    # headless deterministic smoke: wire payload against a dead-port model, no real model (also runs in CI)
scripts/e2e.sh          # quick smoke of the real pi TUI via tmux (needs a working model)
scripts/e2e-full.sh     # every README feature end to end, model turns included (5-15 min)
scripts/record-demos.sh # re-records demos/*.tape with vhs at low thinking
```

Extensions live in `extensions/`, tests in `tests/`. Install a local checkout with `pi install ./pi-code`, then `/reload` after edits. Development needs Node `>=22.19`.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test and review conventions, and the release process, and the [Code of Conduct](CODE_OF_CONDUCT.md) for community expectations. Report security issues privately as described in [SECURITY.md](SECURITY.md). Release notes are on the [Releases page](https://github.com/ilovepixelart/pi-code/releases).

## License

[MIT](LICENSE).
