# Skills

Bridges `.claude/skills` into pi's skill discovery. Source: [`extensions/skills.ts`](../extensions/skills.ts).

- Project skills are gated on approval and load from every `.claude/skills` between the working directory and the repository root (nearest first); pi's loader reads `name`, `description`, and `disable-model-invocation` (`allowed-tools` is inert in pi's loader, a documented gap).
- Invoking `/skill:name` expands the body through the shared command pipeline, as Claude documents that commands and skills "work the same way": `` !`cmd` `` spans, `@file` references, `$ARGUMENTS`/positional substitution, and `${CLAUDE_*}` variables, with the same shell-execution gate commands use.
- A skill with malformed frontmatter degrades to pi's plain expansion (raw body) instead of failing the invocation.
- Plugin skill directories contribute too, though pi's loader names them without the plugin prefix.
