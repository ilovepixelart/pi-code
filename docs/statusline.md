# Statusline

Runs a configured Claude `statusLine` command. Source: [`extensions/status-line.ts`](../extensions/status-line.ts).

- The stdin JSON follows Claude's contract: `version`, `hook_event_name`, `session_name`, a `cost` block with wall and API durations and lines added/removed, a `context_window` token breakdown, `exceeds_200k_tokens`, and `rate_limits` carrying the `five_hour`/`seven_day` utilization and reset from the provider's rate-limit headers.
- `padding` and `refreshInterval` are honored, with a 300ms debounce.
- Without a configured command, a built-in statusline shows turn state and session cost.
