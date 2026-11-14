# Monitor

Claude's Monitor tool as pi's `monitor` tool: it runs a command in the background and feeds each line the command prints on stdout back to the model, so the model can react to log entries, file changes, or polled status while the conversation goes on. Source: [`extensions/monitor.ts`](../extensions/monitor.ts), sharing the background-shell registry in [`extensions/internal/background-shells.ts`](../extensions/internal/background-shells.ts) with [background Bash](background-bash.md).

- `monitor` takes a `description`, a `command` and an optional `timeout_ms` deadline, starts the command, and returns at once with its ID (`m…`) and the file its output is written to.
- Stdout lines reach the session as messages that start a turn, or steer the turn in progress. Each message names the monitor by its ID and description.
- At the deadline the command is stopped and the model gets one notice, so it can start the watch again if it is still needed. When the command exits by itself, the model gets one notice with its exit code.
- `task_stop` stops a monitor by ID, as it stops a background Bash command. A stopped monitor sends nothing more.
- `/tasks` lists monitors with the background shell commands, labelled `monitor`, with their description and command.

## Aligned with Claude

- **Parameters**: `description` and `command` are required. `timeout_ms` defaults to 300000 (5 minutes), is refused under 1000, and is capped at 1800000 (30 minutes).
- **Stdout only**: only stdout lines are events. Stderr is written to the output file and never starts a message.
- **Not covered by `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`**: the variable turns off background Bash, not Monitor.
- **Stops with the session**: quitting pi stops every monitor, and so does a session switch (`/new`, `/resume`, `/fork`). `/reload` keeps them running, since the session continues.
- **Same rules as Bash**: a hook `if` filter written as `Bash(…)` also judges Monitor commands, and `Monitor(…)` judges them alone. In `allowed-tools`, `Monitor(…)` and `Bash(…)` scopes both apply to monitor commands (see [commands](commands.md)). Hook payloads name the tool `Monitor`.
- The command runs in the shell and environment of the `bash` tool: pi's `shellPath` and `shellCommandPrefix` settings and the `PI_*` session variables.

## Batching and flood protection

Claude batches and rate-limits Monitor events, and so does pi-code, with different numbers. In pi every message starts a turn or steers the one in progress, so pi-code sends fewer, larger messages and stops a noisy monitor sooner. The Claude column is the behaviour of Claude Code 2.1.325; its tool prompt documents the 200 ms batching and that "monitors that produce too many events are automatically stopped".

| | Claude Code | pi-code |
| --- | --- | --- |
| Batch window | stdout lines within 200 ms form one notification | the first line opens a 1-second window; the lines that arrive in it go out together |
| Rate | 10 notifications at once, one more every 2 seconds; a notification past that is suppressed and reported later as a count | at most one message every 5 seconds, lines arriving meanwhile wait for the next one; 10 messages at once, one more every 30 seconds |
| Auto-stop | after 30 seconds of continuous suppression | when a message is due and the allowance is spent, or when one message would leave out more than 1,000 lines |
| Size | a line is cut at 500 characters, a notification at 3,000 | a line is cut at 500 characters; a message carries at most 50 lines and 4,000 characters |

- Lines past the size caps are counted (`[N more lines not shown; full output: …]`) and stay in the output file. Once a message has left one line out, it leaves out every later line too.
- A monitor stopped for flooding sends one notice saying that it produced too many events and needs a tighter filter. The delivery that tripped the limit is not sent.
- A monitor is also stopped, with one notice, once its stdout and stderr together pass 5 GB, the output cap of a background Bash command.
- Blank lines are not delivered. Whatever is still queued when the command ends, or reaches its deadline, goes out with the end notice.

The pi-code numbers are the constants at the top of [`extensions/monitor.ts`](../extensions/monitor.ts).

## Divergences

- **No WebSocket source**: Claude's `ws` input is not offered. A command that polls or streams (for example `websocat`, if installed) covers the same ground.
- **Refused without a UI**: in print and json modes and in subagents no later turn could receive an event, so the tool fails with an error saying so. Claude's 10-minute ceiling under `-p` therefore has no counterpart.
- **No permission prompt**: pi has no permission flow, so outside an `allowed-tools` scope the command runs as `bash` would.
- **Batching, rate and stop thresholds** differ from Claude's as the table above shows, and pi-code has no suppression phase: it stops the monitor instead of dropping events and reporting a count.
