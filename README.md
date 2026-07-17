# pi-code-checkpoint

Git checkpoint and rewind of agent edits

Vendored from the `@earendil-works/pi-coding-agent` v0.74.2 example extensions (MIT), maintained here for full control.

## Features

- `git stash create` checkpoint at the start of each user prompt (tracked files only)
- Checkpoints persisted in the session file: they survive restarts, resumes, and forks
- `/rewind`: pick a checkpoint, then restore "Code and conversation", "Conversation only", or "Code only" (Claude Code style)
- `/fork` offers to restore code at the fork point

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-checkpoint
```
