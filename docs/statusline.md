# Statusline

Runs a configured Claude `statusLine` command. Source: [`extensions/status-line.ts`](../extensions/status-line.ts).

- The stdin JSON follows Claude's contract: `version`, `hook_event_name`, `session_name`, a `cost` block with wall and API durations and lines added/removed, a `context_window` token breakdown, `exceeds_200k_tokens`, `workspace.added_dirs` (always empty: pi has no /add-dir), `effort` in Claude's vocabulary (pi's `minimal` maps to `low`, `off` omits it), and `rate_limits` carrying the `five_hour`/`seven_day` utilization with `resets_at` as Unix epoch seconds; an expired window is dropped rather than left stale. `fast_mode`, `prompt_cache`, and `spend_limit` have no pi source and stay absent.
- Scripts run with `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, and `COLUMNS`/`LINES` set to the terminal dimensions.
- `padding` and `refreshInterval` are honored, with a 300ms debounce.
- Without a configured command, a built-in statusline shows turn state and session cost.
