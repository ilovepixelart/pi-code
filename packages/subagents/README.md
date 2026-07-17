# pi-code-subagents

Task-tool style subagents with parallel execution and chained workflows.

Vendored from the `@earendil-works/pi-coding-agent` v0.74.2 `subagent` example (MIT), maintained here for full control. Local changes:

- Agent discovery also reads `~/.claude/agents/*.md` (Claude Code compat), with tool names normalized (`Glob` -> `find`, lowercased); `~/.pi/agent/agents` wins on name conflicts
- Workflow prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`) exposed via the package manifest
- Sample agents (scout, planner, reviewer, worker) install to `~/.pi/agent/agents` with model pins stripped so they inherit the session model

See `extensions/subagent/README.md` for full usage.

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-subagents
```
