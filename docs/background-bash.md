# Background Bash

Claude's background commands on pi's `bash` tool. Source: [`extensions/background-bash.ts`](../extensions/background-bash.ts), with the shared registry in [`extensions/internal/background-shells.ts`](../extensions/internal/background-shells.ts).

- `run_in_background: true` starts a command as a background task and returns at once with its ID and the file its output is written to.
- A foreground command that reaches its timeout is moved to the background instead of stopped, unless it starts with `sleep`. The result says so: `Command did not complete within its 120s timeout and was moved to the background (ID: …)`.
- When a background command finishes, a message reaches the session with its exit status and output file, and starts a turn. The model reads the output with the `read` tool.
- `task_stop` (Claude's `TaskStop`, formerly `KillShell`) stops a running command by ID. A stopped command sends no completion message.
- `/tasks` lists background shell commands after background subagent runs.

## Aligned with Claude

- **Timeouts**: `BASH_DEFAULT_TIMEOUT_MS` (two minutes) applies when the model passes no timeout; a requested timeout is capped at the larger of that and `BASH_MAX_TIMEOUT_MS` (ten minutes). An unset, blank, zero, negative or non-numeric value keeps the default.
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`** turns background commands off.
- **A command outlives a session switch**: across `/new`, `/resume`, `/fork` and `/reload` it keeps running and its completion message goes to the session current when it finishes, or to the next session start when none is. In a session that has not had a turn yet, the message is recorded for the next prompt instead of starting one, as background subagent results are.
- **Quitting pi stops every background command** and removes their output files.
- The output, truncation, renderer and exit-code reporting are pi's own: the built-in bash tool still runs each command, through its operations seam, with pi's `shellPath` and `shellCommandPrefix` settings.

## Divergences

- **The timeout is in seconds**, as pi's bash tool takes it, where Claude's is in milliseconds.
- **With background commands off, or in a session without a UI** (print and json modes, subagents), the tool runs as pi's bash does: no default timeout, and a requested timeout stops the command. Claude stops a command at its timeout there; pi has no default timeout to keep. A session without a UI ends with its last turn, so no later turn could receive a completion message.
- **No time limit on background commands**, as in an interactive Claude session. Claude's unattended limits (30 minutes by default under `-p`) do not apply, since unattended runs do not background here.
- **No Ctrl+B** to move a running command to the background.
- **No output cap**: Claude kills a command whose output passes 5 GB.
