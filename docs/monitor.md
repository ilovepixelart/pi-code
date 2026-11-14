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

## Events and flood protection

pi-code batches and rate-limits Monitor events as Claude Code 2.1.325 does, with the same numbers. They are the constants at the top of [`extensions/monitor.ts`](../extensions/monitor.ts).

- **Batching**: the first stdout line opens a 200 ms window, and the lines that arrive in it form one event, sent as one message. Lines are trimmed, and blank lines are not events.
- **Size**: a line is cut at 500 characters and an event at 3,000; a cut is marked `...(truncated)`.
- **Allowance**: a monitor may send 10 events at once and one more every 2 seconds.
- **Suppression**: an event that is due while the allowance is spent is not delivered. The next event that is delivered follows a message of its own, `[N events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]`.
- **Auto-stop**: a monitor suppressed for more than 30 seconds without a break is stopped, with one notice: `[Monitor stopped: too much output (N events suppressed over Ns). Restart with a more selective source.]`. A break is 6 seconds without an event, or the allowance being whole again.
- **Last event**: what is queued when the command ends, or reaches its deadline, is one more event under the same allowance. It goes out with the end notice, or not at all if the allowance is spent.

A monitor is also stopped, with one notice, once its stdout and stderr together pass 5 GB, the output cap of a background Bash command.

What still differs from Claude Code in how an event reaches the model:

| | Claude Code | pi-code |
| --- | --- | --- |
| Notice punctuation | a dash after "suppressed" and after "Monitor stopped" | a colon |
| Tool named in the suppression notice | `TaskStop` | `task_stop` |
| Framing of an event | a task notification with the summary `Monitor event: "<description>"` and the event in an `<event>` element | a message that starts `Monitor <id> ("<description>") output:`, the event on the following lines |
| End of the command | a task notification, `Monitor "<description>" stream ended` | `Monitor <id> ("<description>") ended: the command exited with code N. Full output: <file>` |

## Divergences

- **No WebSocket source**: Claude's `ws` input is not offered. A command that polls or streams (for example `websocat`, if installed) covers the same ground.
- **Refused without a UI**: in print and json modes and in subagents no later turn could receive an event, so the tool fails with an error saying so. Claude's 10-minute ceiling under `-p` therefore has no counterpart.
- **No permission prompt**: pi has no permission flow, so outside an `allowed-tools` scope the command runs as `bash` would.
