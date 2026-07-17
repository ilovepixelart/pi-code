# pi-code-todo

Live todo list overlay tracking task progress

Vendored from the `@earendil-works/pi-coding-agent` v0.74.2 example extensions (MIT), maintained here for full control.

## Features

- `todo` tool for the agent: add, start, complete, delete, clear, list
- Status machine per todo: pending -> in_progress -> completed, with optional activeForm label shown while in_progress
- Persistent overlay above the editor: live status glyphs, capped at 12 lines dropping completed first, "+N more" tail, auto-hides when empty
- `/todos` command for users to view the list
- Branch-safe state stored in tool result details, replayed on session start, branch switch, and compaction

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-todo
```
