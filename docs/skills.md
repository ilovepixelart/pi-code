# Skills

Bridges `.claude/skills` into pi's skill discovery. Source: [`extensions/skills.ts`](../extensions/skills.ts).

- Skills load in Claude's precedence order: the enterprise directory beside the managed settings file, then personal `~/.claude/skills`, then (approval-gated) every project `.claude/skills` between the working directory and the repository root. `CLAUDE_CODE_DISABLE_POLICY_SKILLS` drops the enterprise directory from the scan; personal and project skills are unaffected.
- pi's loader reads `name`, `description`, and `disable-model-invocation`. Loader-side gaps, documented rather than hidden: other frontmatter fields (including `yes`/`on`/`1` boolean spellings) and the first-paragraph description fallback are pi-loader territory; a description-less skill may be dropped from the listing.
- `context: fork` runs the skill in a subagent via the agent seam: the expanded content becomes the subagent's prompt (no conversation history), `agent:` picks a discovered agent type. Divergence: pi-code waits for the result in the invoking turn (Claude's `background: false` behavior, and what Claude itself does in `-p`/SDK runs) instead of backgrounding by default.
- `skillOverrides`: a skill set to `"off"` refuses `/skill:name` with a notice; `"name-only"` listing visibility is pi-loader territory (noted gap).
- Invoking `/skill:name` expands the body through the shared command pipeline, as Claude documents that commands and skills "work the same way": `` !`cmd` `` spans, `@file` references, `$ARGUMENTS`/positional substitution, and `${CLAUDE_*}` variables, with the same shell-execution gate commands use.
- A skill with malformed frontmatter degrades to pi's plain expansion (raw body) instead of failing the invocation.
- Plugin skill directories contribute too, though pi's loader names them without the plugin prefix.
- Injected-span divergences: a span that exceeds the 2-minute timeout is killed and aborts the invocation (pi has no auto-background Bash set); the exit-1 carveout uses Claude's per-shell sets (bash keeps `find`/`diff`; PowerShell keeps `grep`/`git diff` but not `find`/`diff`). Stacked multi-skill messages (`/a` then `/b` in one message) expand only the first, and `@file` references outside the working directory stay literal (a deliberate hardening).
