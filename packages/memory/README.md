# pi-code-memory

Claude Code style persistent memory, per project.

- Memories are markdown files under `~/.pi/agent/memory/<project-slug>/`
- `MEMORY.md` index (one line per memory) is injected into the system prompt each session
- `memory` tool: `save` (name + description + content), `read`, `delete`, `list`
- The agent is instructed to save durable facts, preferences, and corrections that code and git history do not record

Hand-written.

## Install

```bash
pi install ~/Documents/pi-code/packages/memory
```
