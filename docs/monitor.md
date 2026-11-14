# Monitor

Claude's Monitor tool as pi's `monitor` tool: it runs a command in the background and feeds each line it prints back to the model, so the model can react to log entries, file changes, or polled status while the conversation goes on. Source: [`extensions/monitor.ts`](../extensions/monitor.ts), sharing the background-shell registry in [`extensions/internal/background-shells.ts`](../extensions/internal/background-shells.ts) with [background Bash](background-bash.md).

- `monitor` takes a `command` and an optional `timeout_ms` deadline, starts the command, and returns at once with its ID (`m…`) and the file its output is written to.
- Lines the command prints reach the session as messages that start a turn, or steer the turn in progress.
- At the deadline the command is stopped and the model gets one notice, so it can start the watch again if it is still needed. When the command exits by itself, the model gets one notice with its exit code.
- `task_stop` stops a monitor by ID, as it stops a background Bash command. A stopped monitor sends nothing more.
- `/tasks` lists monitors with the background shell commands, labelled `monitor`.

## Aligned with Claude

- **Deadline**: 5 minutes by default, at most 30 minutes; a longer request is capped.
- **Stops with the session**: quitting pi stops every monitor, and so does a session switch (`/new`, `/resume`, `/fork`). `/reload` keeps them running, since the session continues.
- **Same rules as Bash**: a hook `if` filter written as `Bash(…)` also judges Monitor commands, and `Monitor(…)` judges them alone. Hook payloads name the tool `Monitor`.
- The command runs through pi's local bash operations with pi's `shellPath` and `shellCommandPrefix` settings.

## Batching

A command can print far faster than a model can read, and every message starts or steers a turn, so lines are batched rather than sent one by one:

- The first line opens a 1-second window; the lines that arrive in it go out together.
- One monitor sends at most one message every 5 seconds.
- A message carries at most 50 lines and 4,000 characters, and a line longer than 500 characters is cut. Lines past those caps are counted (`[N more lines not shown; full output: …]`) and stay in the output file.
- Blank lines are not delivered. Whatever is still queued when the command ends goes out with the end notice.

## Divergences

- **No WebSocket source**: Claude's `ws` input is not offered. A command that polls or streams (for example `websocat`, if installed) covers the same ground.
- **Refused without a UI or with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`**: in print and json modes and in subagents no later turn could receive an event, so the tool fails with an error saying so. Claude's 10-minute ceiling under `-p` therefore has no counterpart.
- **No permission prompt**: pi has no permission flow, so the command runs as `bash` would. `allowed-tools` scopes such as `Bash(git *)` do not narrow `monitor`.
- **Batching** is pi-code's own; Claude documents no batching or rate limit.
