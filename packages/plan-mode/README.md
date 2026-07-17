# pi-code-plan-mode

Read-only plan mode with reviewable plans, Claude Code style: `/plan` or Ctrl+Alt+P toggles, bash restricted to a read-only allowlist, plan steps extracted with execution progress tracking, approve/refine/execute menu.

Vendored from the `@earendil-works/pi-coding-agent` v0.74.2 `plan-mode` example (MIT), maintained here for full control. Local changes:

- Active tools are snapshotted on enter and restored exactly on exit (the example hardcoded a 4-tool list, silently dropping grep/find/ls and all extension tools)
- Clarifying questions go through our `question` tool (the example referenced a `questionnaire` tool we do not ship)

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-plan-mode
```
