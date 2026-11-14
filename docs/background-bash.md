# Background Bash

Claude's background commands on pi's `bash` tool. Source: [`extensions/background-bash.ts`](../extensions/background-bash.ts), with the shared registry in [`extensions/internal/background-shells.ts`](../extensions/internal/background-shells.ts).

- `run_in_background: true` starts a command as a background task and returns at once with its ID and the file its output is written to.
- A foreground command that reaches its timeout is moved to the background instead of stopped, unless it starts with `sleep`. The result says so: `Command did not complete within its 120s timeout and was moved to the background (ID: …)`.
- When a background command finishes, a message reaches the session with its exit status and output file, and starts a turn, so an idle session wakes up to handle it. During a turn the message is steered in before the next model call. The model reads the output with the `read` tool.
- The override replaces pi's `bash` only where the session has it: a session whose tool selection leaves `bash` out (the `defaultTools` setting, `--no-builtin-tools`, `--tools -bash`, or a `bash` turned off before `/reload`) stays without it, and `task_stop` is taken out of such a session when it starts.
- `task_stop` (Claude's `TaskStop`, with its aliases `KillShell` and `KillBash`) stops a running command by `task_id`, or by the deprecated `shell_id`. A stopped command sends no completion message.
- `/tasks` lists background shell commands after background subagent runs, the last 20 finished ones included. A finished command dropped from that list loses its output file.
- The footer shows how many background commands are running (`⏵ 2 background shells`), and clears when none are. A foreground command is not counted until it moves to the background.

## Aligned with Claude

- **Timeouts**: `BASH_DEFAULT_TIMEOUT_MS` (two minutes) applies when the model passes no timeout; a requested timeout is capped at the larger of that and `BASH_MAX_TIMEOUT_MS` (ten minutes). An unset, blank, zero, negative or non-numeric value keeps the default.
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`** turns background commands off: the tool has no `run_in_background` parameter, a call that passes it anyway fails, and a command still running at its timeout is stopped. The default timeout still applies.
- **A command outlives a session switch**: across `/new`, `/resume`, `/fork` and `/reload` it keeps running. In a session that has not had a turn yet, its completion message is recorded for the next prompt instead of starting one, as background subagent results are.
- **Quitting pi stops every background command** and removes their output files.
- **Output cap**: a background command whose output file passes 5 GB is stopped, and its completion message says so.
- The output, truncation, renderer and exit-code reporting are pi's own: the built-in bash tool still runs each command, through its operations seam, with pi's `shellPath` and `shellCommandPrefix` settings. A background command's output goes to its output file only; the copy pi keeps of a foreground command's truncated output is removed if the command then moves to the background.

## Divergences

- **The timeout is in seconds**, as pi's bash tool takes it, where Claude's is in milliseconds.
- **A session without a UI** (print and json modes, subagents) has background commands off, exactly as with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: it ends with its last turn, so no later turn could receive a completion message. Claude runs background commands under `-p`, with a time limit.
- **No time limit on background commands**, as in an interactive Claude session. Claude's limits for unattended sessions (30 minutes by default, 10 minutes for a `-p` run whose prompt is passed as text) do not apply, since unattended runs do not background here.
- **No Ctrl+B** to move a running command to the background.
- **A completion message goes to whichever session is current** when the command finishes, or to the next session start when none is: after `/new`, that is not the session that started the command.
- **Stopping is a kill with no grace period**: `task_stop`, the output cap and quit send `SIGKILL` to the command's process group (`taskkill /F /T` on Windows), with no `SIGTERM` first.
- **A process that leaves the process group** (`setsid`) survives `task_stop` and quit. Claude stops these.
- **`/tasks` lists background commands but cannot stop one**; only `task_stop` does.
