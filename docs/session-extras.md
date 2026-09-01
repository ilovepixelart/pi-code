# Session extras

The smaller conveniences, each its own extension.

- **Project trust** ([`extensions/internal/project-approval.ts`](../extensions/internal/project-approval.ts)): prompts before loading project config (MCP servers, hooks, agents, rules, output styles, commands, skills) that pi would otherwise trust silently.
- **Plan mode** ([`extensions/plan-mode/`](../extensions/plan-mode)): `plan_mode_complete` tool, tool snapshot/restore that survives `/reload`.
- **Todo list** ([`extensions/todo.ts`](../extensions/todo.ts)): persistent overlay, status machine, compaction-safe.
- **Checkpoints / rewind** ([`extensions/git-checkpoint.ts`](../extensions/git-checkpoint.ts)): shadow-repo snapshots; restore overwrites checkpointed files and keeps files created later; 100 per session, repos pruned after 30 days.
- **AskUserQuestion** ([`extensions/question.ts`](../extensions/question.ts)): 1-4 questions per call (asked in sequence), each with `header` and 2-4 options, single- or `multiSelect`, plus free-text.
- **Notifications** ([`extensions/notify.ts`](../extensions/notify.ts)): terminal notification when a turn ends (OSC 777 / Kitty OSC 99 / Windows toast); honors `preferredNotifChannel` (`terminal_bell`, `notifications_disabled`, `iterm2_with_bell`, else desktop) from user settings; fires only when you appear to be away, approximated by turn duration since pi exposes no terminal-focus signal.
- **Think keywords** ([`extensions/thinking.ts`](../extensions/thinking.ts)): raises reasoning for one turn (`ultrathink` to the max, `think hard`/`think harder` to high, bare `think` to medium); only ever raises, matched on word boundaries, restored once the turn settles.
- **Session title** ([`extensions/session-title.ts`](../extensions/session-title.ts)): names a new session from its first message with a single model call; never overwrites an existing name, best-effort, at most once per session.
- **`/context`** ([`extensions/context-usage.ts`](../extensions/context-usage.ts)): reports used/window/free/percent of the model's context window, reading pi's live usage so it reflects a compaction.
- **`/init`** ([`extensions/init.ts`](../extensions/init.ts)): generates a project context file; detects an existing `AGENTS.md`/`CLAUDE.md` (proposes improvements) or creates `AGENTS.md`, ingesting `.cursor/rules`, `.cursorrules`, and `.github/copilot-instructions.md` when present; drives the main agent with full tools so it analyzes the codebase and writes the file itself.
