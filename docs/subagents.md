# Subagents / Task

Claude-style subagents with parallel, chain, and background modes. Source: [`extensions/subagent/`](../extensions/subagent) (see also its [README](../extensions/subagent/README.md)).

- Built-in Explore/Plan/general-purpose agents, plus `~/.claude/agents`, `~/.pi/agent/agents`, and project `.claude/agents`/`.pi/agents` (scanned recursively into subfolders), merged once the project is trusted; project wins a name clash. Every `.claude/agents` between the working directory and the repository root is scanned, the definition closest to the working directory winning a same-name clash, as Claude documents.
- Frontmatter: `tools`/`disallowedTools`, `model` (sonnet/opus/haiku/fable tier aliases or a concrete id), `effort`, `skills` preload, `permissionMode: plan`, `maxTurns`, `memory`, `isolation: worktree`.
- `memory` (`user`/`project`/`local`) gives the child its own persistent store under `.claude/agent-memory[-local]`, injected with Read/Write/Edit enabled, gated on auto memory; the parent conversation's memory is never loaded into a subagent, matching Claude.
- `isolation: worktree` runs the child in a temporary git worktree branched from the repository's default branch; the worktree is removed when the agent made no changes and reported in the output when kept; a run that cannot get its worktree fails rather than touching the real checkout. Divergence: pi sets the child's working directory but does not police per-command escapes.
- Parallel and chain modes (pi extensions), one nesting level; background runs with cancel and resume. `/tasks` lists runs, `/agents` lists the discovered roster.
