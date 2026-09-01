# Persistent memory

Per-repository memories with a session-injected index. Source: [`extensions/memory.ts`](../extensions/memory.ts).

- Memories live under `~/.pi/agent/memory`, keyed on the repository root, so subdirectory sessions share one store (as Claude does; this is pi's own store, separate from Claude's).
- The index is injected each session within Claude's 200-line/25KB bound; YAML frontmatter and block HTML comments are stripped before it counts or loads.
- A save that would overflow the index reports why; a memory written with frontmatter gets a `modified:` ISO timestamp.
- Honors `autoMemoryEnabled` (settings) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (env) to turn it off, and `autoMemoryDirectory` (absolute or `~/`) to relocate the store.
- `/memory` prints the store and index locations.
