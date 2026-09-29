# Deliver context memory through the prompt options

## Problem and outcome

`context-imports` adds Claude's memory files by rewriting the rendered system prompt. From pi 0.86 the prompt is built from structured options, so that rewrite misses its anchor (the user `CLAUDE.md` lands in a second `<project_context>` block after the project's), and a provider that rebuilds the prompt from the options (`pi-claude-bridge`) receives none of what the extension adds or removes.

Outcome: on pi 0.86 and later the extension edits `systemPromptOptions`, so the rendered prompt and a rebuilding provider carry the same memory, in Claude's order. pi before 0.86 keeps the appended text it gets today.

## Observed baseline

One fixture with every memory source, captured from the request each target sent. Claude Code 2.1.284, pi 0.87.1, pi 0.85.1, `pi-claude-bridge` 0.9.0. A number is the position in the request. The rule rows were measured with rule files delivered as context files.

| Source | Claude Code | pi 0.87.1 | Bridge | pi 0.85.1 |
|---|---|---|---|---|
| User `CLAUDE.md` | 1 | 3 | missing | 1 |
| Its import | 2 | 8 | missing | 7 |
| Project `CLAUDE.md` | 3 | 1 | 1 | 2 |
| Its import | 4 | 6 | missing | 6 |
| HTML comment in it | stripped | stripped | **delivered** | stripped |
| `.claude/CLAUDE.md` | 5 | 4 | missing | 4 |
| Project rule | 6 | 2 | 3 | 3 |
| Its import | 7 | 7 | missing | missing |
| `CLAUDE.local.md` | 8 | 5 | 4, loaded by Claude Code itself | 5 |
| `<project_context>` blocks | none | **2** | 1 | 1 |
| File named in `claudeMdExcludes` | dropped | dropped | **delivered** | dropped |
| Project `CLAUDE.md` with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | dropped | dropped | **delivered** | not run |

On the bridge, `InstructionsLoaded` fires for the user `CLAUDE.md`, `.claude/CLAUDE.md` and every import although none of them reached the model.

## Acceptance clauses

"Re-rendering runtime" means `event.systemPrompt` changes when `systemPromptOptions` is edited (pi 0.86 and later, prompt not forced).

| ID | Behaviour | Check |
|---|---|---|
| CTX-001 | On a re-rendering runtime the user `CLAUDE.md` is a context file entry ahead of every file pi loaded, and the prompt holds one `<project_context>` block | Unit: `places the user CLAUDE.md ahead of pi's context files`. E2E: pi 0.87.1 payload |
| CTX-002 | `.claude/CLAUDE.md`, a `CLAUDE.md` beside an `AGENTS.md` pi chose, and each `CLAUDE.local.md` are context file entries. Entries follow Claude's order: managed, user, then each directory from the repository root down to cwd, and within a directory the memory file pi loaded, the `CLAUDE.md` beside an `AGENTS.md`, `.claude/CLAUDE.md`, rule files, `CLAUDE.local.md` | Unit: `orders the context files by directory, local memory last at each level`. E2E: two directory levels against the Claude Code capture |
| CTX-003 | Each file resolved through `@path` is a context file entry under its own path, directly after the entry that imports it. Depth, budget and cycle handling are unchanged | Unit: `places an imported file after the file that imports it` |
| CTX-004 | Every entry's content in the options is comment-stripped | Unit: `strips block comments from the context files in the options` |
| CTX-005 | A file matching `claudeMdExcludes`, and every file under `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, is removed from the options together with its imports | Unit: `removes an excluded file from the options`, `removes every file when memory is disabled` |
| CTX-006 | The managed `CLAUDE.md` file and the managed `claudeMd` key are the first entries and are never removed | Unit: `places managed memory first and keeps it under an exclude` |
| CTX-007 | The refused-imports list and the budget notice are not files: they join `appendSystemPrompt` | Unit: `appends the refused imports to the appended instructions` |
| CTX-008 | On a re-rendering runtime the handler returns nothing, so it does not force the prompt | Unit: asserted in CTX-001 to CTX-007 |
| CTX-009 | On pi before 0.86 the prompt text is byte-identical to today's and the options are left as found | Characterization tests pinned before any change. E2E: pi 0.85.1 payload, `scripts/e2e-smoke.sh` |
| CTX-010 | When an earlier handler forced the prompt on pi 0.86 and later, the entries stay in the options, and the forced text gets the memory inside its one `<project_context>` block | Unit: `keeps the memory in the options when the prompt was forced`, `puts the user CLAUDE.md into the one <project_context> of a forced prompt` |
| CTX-011 | `InstructionsLoaded` payloads are unchanged, one per delivered file, none for a file that was not delivered | Unit: existing event tests pass unchanged on both runtimes |
| CTX-012 | A project file's import outside the project loads only after approval, a headless run refuses it, and refused files are listed | Unit: existing `external-imports` tests pass unchanged, plus one on a re-rendering runtime |
| CTX-013 | `--add-dir` memory files are context file entries after the project's | Unit: `adds additional directory memory as context files` |
| CTX-014 | Through `pi-claude-bridge`, Claude Code receives the same memory set as pi 0.87.1 sends a plain provider | E2E: bridge payload against the baseline fixture |

## Micro-tasks

| # | Task | Clauses | Files | Test strategy |
|---|---|---|---|---|
| 1 | Pin today's fallback text | CTX-009 | `tests/context-imports.test.ts` | Characterization, proven by mutation |
| 2 | Detect the runtime, add the user `CLAUDE.md` entry, return nothing | CTX-001, CTX-008 | `extensions/context-imports.ts`, test | Red on entry order and block count |
| 3 | Strip comments and remove excluded files in the options | CTX-004, CTX-005 | same | Red per behaviour |
| 4 | Alternate, sibling and local memory as entries | CTX-002 | same | Red on entries and order |
| 5 | Imports as entries after their importer | CTX-003, CTX-012 | same, `tests/external-imports.test.ts` | Red on placement, approval tests unchanged |
| 6 | Managed memory entries | CTX-006 | same | Red on order and exclude |
| 7 | Notices as appended instructions | CTX-007 | same | Red on `appendSystemPrompt` |
| 8 | `--add-dir` entries | CTX-013 | same | Red on entries |
| 9 | Forced prompt on pi 0.86 and later | CTX-010 | same | Red on options after a forced prompt |
| 10 | Events on both runtimes | CTX-011 | tests only | Existing tests, both event shapes |
| 11 | End to end and docs | CTX-014 | `docs/claude-md.md`, `scripts/e2e-smoke.sh` | Payload capture on pi 0.85.1, pi 0.87.1 and the bridge |

## Out of scope

- Text other extensions append to the prompt (`memory`, `output-styles`, `subagent`, `plan-mode`, `hooks`, `git-checkpoint`). A rebuilding provider drops it too.
- Rules and `.claude/CLAUDE.md` from every directory between the repository root and cwd (today: the nearest only), and rules below cwd. Claude Code loads all of them.
- Values other than `1` for the `CLAUDE_CODE_DISABLE_*` variables.
- Running the test suite against pi 0.87.

## Risks

- **Double delivery on the bridge.** Under the bridge Claude Code itself loads `CLAUDE.local.md` and `AGENTS.md`: the bridge excludes only `**/CLAUDE.md` and rules. Once `CLAUDE.local.md` is an entry, the bridge carries it twice until the bridge excludes it.
- **Runs without `before_agent_start`.** A run an extension starts while the agent is idle (a goal kickoff after a user prompt) fires no `before_agent_start`. Measured on pi 0.87.1: with the memory written into the prompt text, that run carried the project `CLAUDE.md` only and lost the user `CLAUDE.md`, the rules and `.claude/CLAUDE.md`. With the memory in the options it carries all four, in one `<project_context>` block and with no added system message. Text other extensions append is still absent from such a run.
- **Import confinement.** Delivery changes, the roots an importer may read must not. CTX-012 guards it.

## Decisions

Each follows the [Claude Code memory documentation](https://code.claude.com/docs/en/memory) and was checked against Claude Code 2.1.284.

| Decision | Documented as |
|---|---|
| An imported file is its own entry, directly after the file that imports it | "Imported files are expanded and loaded into context at launch alongside the CLAUDE.md that references them" |
| `CLAUDE.local.md` is an entry like any other, last in its directory | "It loads alongside `CLAUDE.md` and is treated the same way", "Within each directory, `CLAUDE.local.md` is appended after `CLAUDE.md`" |
| Directories are ordered from the repository root down to cwd | "content is ordered from the filesystem root down to your working directory" |
| Managed memory, then user memory, then the project's | The load order table: managed policy, user, project, local |
| Managed memory is never excluded | "Managed policy CLAUDE.md files cannot be excluded" |
| `CLAUDE.local.md` is delivered on the bridge too, where Claude Code also loads it itself | It is part of the memory set. The duplicate comes from the bridge's exclude list |

pi-code stays bounded at the repository root for the files it adds, where Claude Code walks to the filesystem root: files above the repository are outside what the project approval covers.
