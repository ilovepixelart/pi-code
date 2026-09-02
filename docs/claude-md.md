# CLAUDE.md, @imports, and rules

Context files and path-scoped rules, beyond what pi loads natively. Sources: [`extensions/context-imports.ts`](../extensions/context-imports.ts), [`extensions/claude-rules.ts`](../extensions/claude-rules.ts).

## CLAUDE.md and imports

- Resolves `@path` imports pi's native loader skips (4-hop depth, budget-capped). An import that resolves outside the working directory is refused rather than approved through a dialog, and is currently dropped without a word.
- Loads a `CLAUDE.md` that sits beside an `AGENTS.md` pi chose instead (approval-gated, imports expanded). pi picks one context file per directory and prefers `AGENTS.md`; Claude reads `CLAUDE.md` and never `AGENTS.md`, so its recommended split, a `CLAUDE.md` opening with `@AGENTS.md` and adding Claude-specific instructions below, would otherwise lose the Claude half. The `@AGENTS.md` does not duplicate the body pi already injected.
- Loads the user `~/.claude/CLAUDE.md` and the project `.claude/CLAUDE.md` (approval-gated, deduped against the repo-root `CLAUDE.md`/`AGENTS.md` pi loads natively).
- Loads every `CLAUDE.local.md` from the repo root down to cwd (approval-gated, root first).
- Injects the managed `CLAUDE.md` (a per-OS file beside `managed-settings.json`) and the `claudeMd` string from `managed-settings.json` at the top of context; managed content is never excludable.
- Honors `claudeMdExcludes`: a glob/absolute-path skip list from user, approved-project, and managed settings, merged.
- Strips block-level HTML comments from CLAUDE.md, rule, and imported bodies (fenced-code comments preserved), so a commented-out `@import` does not expand.
- With `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set, loads `CLAUDE.md`/`.claude/CLAUDE.md`/`.claude/rules/*.md`/`CLAUDE.local.md` from each `--add-dir` directory (comma-separated for several, since pi's flag is single-value).

## Rules

- `~/.claude/rules` and `.claude/rules` (nearest at or above cwd).
- Unscoped rules are inlined in full; `paths:`-scoped rules are surfaced as pointers and auto-attached: the rule body is appended to a read/edit/write result when a matching file is touched, once per rule per session.
- Rule `paths` globs support bracket expressions (`[jt]`, ranges, `[!...]` negation); an unreadable `[` makes the pattern invalid (matching nothing) and `\[` matches a literal bracket, as Claude documents. Attach matching compares realpaths, so a symlinked checkout still matches.
- `claudeMdExcludes` covers rules files too: the docs' monorepo recipe of excluding another team's `.claude/rules/**` works, with globs matched against both the lexical and resolved path.
