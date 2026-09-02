# CLAUDE.md, @imports, and rules

Context files and path-scoped rules, beyond what pi loads natively. Sources: [`extensions/context-imports.ts`](../extensions/context-imports.ts), [`extensions/claude-rules.ts`](../extensions/claude-rules.ts).

## CLAUDE.md and imports

- Resolves `@path` imports pi's native loader skips (4-hop depth, budget-capped). An import in a project file that resolves outside the project is external: the first session in that project asks once, listing the files, and remembers the answer either way, as Claude does. This is what makes the worktree recipe (`@~/.claude/my-project-instructions.md` in a project `CLAUDE.md`) work. A headless run has nobody to ask, so it refuses. Only a file loaded at launch can raise the dialog: a `CLAUDE.md` below cwd is reached mid-turn, where asking is not an option, so its external imports load under an approval the launch-time files already obtained and are reported otherwise. Anything still refused, including every external import in a declined project, is listed under `## Imports not loaded (@)` rather than dropped silently; the list names the path the importing file wrote, never where a symlink pointed, and reports a target that does not exist the same as one that does, so it carries no information about the filesystem that the importing file did not already have. User-scope files (`~/.claude/CLAUDE.md`) import from the user config with no dialog, and a project's approval never widens what they may read.
- Loads a `CLAUDE.md` that sits beside an `AGENTS.md` pi chose instead (approval-gated, imports expanded). pi picks one context file per directory and prefers `AGENTS.md`; Claude reads `CLAUDE.md` and never `AGENTS.md`, so its recommended split, a `CLAUDE.md` opening with `@AGENTS.md` and adding Claude-specific instructions below, would otherwise lose the Claude half. The `@AGENTS.md` does not duplicate the body pi already injected.
- Loads the user `~/.claude/CLAUDE.md` and the project `.claude/CLAUDE.md` (approval-gated, deduped against the repo-root `CLAUDE.md`/`AGENTS.md` pi loads natively).
- Loads every `CLAUDE.local.md` from the repo root down to cwd (approval-gated, root first).
- Loads `CLAUDE.md` and `CLAUDE.local.md` from directories **below** cwd on demand, as Claude does: reading, editing or writing a file there appends each one between that file and cwd to the tool result, shallowest first, once per file per session (exclude-checked, `@imports` expanded, capped like any other tool output, and confined to the project so a symlinked file or directory cannot carry the read outside it). Fires `InstructionsLoaded` with `load_reason: nested_traversal`. A nested `CLAUDE.local.md` needs a recorded project approval rather than the "nothing here to gate" shortcut, since the approval walk only looks at or above cwd.
- Injects the managed `CLAUDE.md` (a per-OS file beside `managed-settings.json`) and the `claudeMd` string from `managed-settings.json` at the top of context; managed content is never excludable.
- Honors `claudeMdExcludes`: a glob/absolute-path skip list from user, approved-project, and managed settings, merged.
- Strips block-level HTML comments from CLAUDE.md, rule, and imported bodies (fenced-code comments preserved), so a commented-out `@import` does not expand.
- With `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set, loads `CLAUDE.md`/`.claude/CLAUDE.md`/`.claude/rules/*.md`/`CLAUDE.local.md` from each `--add-dir` directory (comma-separated for several, since pi's flag is single-value).

## Rules

- `~/.claude/rules` and `.claude/rules` (nearest at or above cwd).
- Unscoped rules are inlined in full; `paths:`-scoped rules are surfaced as pointers and auto-attached: the rule body is appended to a read/edit/write result when a matching file is touched, once per rule per session.
- Rule `paths` globs support bracket expressions (`[jt]`, ranges, `[!...]` negation); an unreadable `[` makes the pattern invalid (matching nothing) and `\[` matches a literal bracket, as Claude documents. Attach matching compares realpaths, so a symlinked checkout still matches.
- `claudeMdExcludes` covers rules files too: the docs' monorepo recipe of excluding another team's `.claude/rules/**` works, with globs matched against both the lexical and resolved path.
