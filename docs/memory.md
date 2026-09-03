# Persistent memory

Per-repository memories with a session-injected index. Source: [`extensions/memory.ts`](../extensions/memory.ts).

- Memories live under `~/.pi/agent/memory`, keyed on the repository root, so subdirectory sessions and every worktree of one repository share a store (as Claude does; this is pi's own store, separate from Claude's).
- The index is injected each session within Claude's 200-line/25KB bound; YAML frontmatter and block HTML comments are stripped before it counts or loads.
- A save landing near the index read limit reminds Claude to shorten it; over the limit the write still succeeds and an error tells Claude to rewrite the index, per Claude's contract. A memory written with frontmatter gets a `modified:` ISO timestamp; the tool asks for Claude's documented `type` vocabulary (user/feedback/project/reference).
- Honors `autoMemoryEnabled` (settings) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (env) to turn it off, and `autoMemoryDirectory` (absolute or `~/`) to relocate the store; managed policy settings win over the file chain.
- `/memory` prints the store, index, and every documented memory-file location (user and project CLAUDE.md, CLAUDE.local.md, the `.claude/CLAUDE.md` alternate), including files that do not exist yet.
