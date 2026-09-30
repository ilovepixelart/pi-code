# Claude's `--settings` and `--setting-sources` flags

## Problem and outcome

Every consumer of Claude settings in pi-code resolves the same chain: the user `settings.json`, then the project's `.claude/settings.json` and `settings.local.json` once the project is approved. A caller that generates settings for one invocation has to place the file where that chain discovers it, and concurrent invocations in one repository then read each other's file: the chain reads the project file from cwd, and the watchers reload it on any change ([issue #307](https://github.com/ilovepixelart/pi-code/issues/307)).

Outcome: `pi --settings <file-or-json>` applies one more settings level for that session, and `pi --setting-sources user,project,local` chooses which file sources load, both with Claude Code's names, precedence and validation. Without either flag nothing changes.

## Observed baseline

Claude Code 2.1.285, measured from the CLI, and the [CLI reference](https://code.claude.com/docs/en/cli-reference) and [settings](https://code.claude.com/docs/en/settings) pages.

| Input | Claude Code |
|---|---|
| `--settings ./file.json` | Level 2 of the precedence: above local, project and user, below managed. A key set here wins; an omitted key keeps its file value; lists merge as at every level |
| `--settings '{"model":"x"}'` | Same, from the inline object |
| `--settings '{bad json'` | Treated as a path: `Error: Settings file not found: <cwd>/{bad json`, exit 1 |
| `--settings /missing.json` | `Error: Settings file not found: /missing.json`, exit 1 |
| `--settings <directory>` | `Error: Cannot use settings file (EISDIR: illegal operation on a directory, read): <path>`, exit 1 |
| File over 2 MiB | Refused: "The file must be a regular file no larger than 2 MiB" |
| Mid-session edit of the `--settings` file | Not reloaded: the reload covers user, project, local and managed settings |
| `--setting-sources user,project` | Only those file sources load |
| `--setting-sources ""` | Accepted; the SDK documents `[]` as loading no user, project or local settings |
| `--setting-sources bogus` | `Error processing --setting-sources: Invalid setting source: bogus. Valid options are: user, project, local`, exit 1 |
| Either flag | Managed settings still apply in full |

## Acceptance clauses

| ID | Behaviour | Check |
|---|---|---|
| SET-001 | `--settings <path>` is read at startup and its keys apply above the user, project and local files and below managed settings, in every consumer of the chain | Unit: `reads the --settings copy last, so it wins over local, project and user`; env, hooks and MCP policy tests |
| SET-002 | `--settings <inline JSON object>` behaves as SET-001 | Unit: `accepts an inline JSON object` |
| SET-003 | A value that does not parse as a JSON object is a path, resolved against the working directory | Unit: `treats a value that is not JSON as a path`, `resolves a relative path against cwd` |
| SET-004 | A missing file, a path that is not a regular file, a file over 2 MiB, invalid JSON or a non-object is refused with Claude's wording; no settings file loads, the error is reported, and the session ends: pi's shutdown in a terminal, exit status 1 in print and rpc mode | Unit: the refusal tests in `tests/cli-settings.test.ts`; the refusal tests in `tests/settings-flags.test.ts` |
| SET-005 | The value is a snapshot that a session replacement reuses: a later edit or removal of the file is not applied | Unit: `is a snapshot`, `a fresh instance with the same flags reuses the copy` |
| SET-006 | The value carries user-scope trust: it applies without project approval, its `env` keys are not sanitized, and its MCP consent keys count | Unit: `reads the --settings copy without project approval`; env and MCP policy tests |
| SET-007 | A subagent child receives the snapshot and the source list, so it reads the same settings | Unit: subagent spawn argument tests |
| SET-008 | `--setting-sources` keeps only the named file sources; an empty list keeps none; an unknown name is refused with Claude's wording, no settings file loads, and the session ends as in SET-004 | Unit: `parseSettingSources` tests, the chain filter tests |
| SET-009 | Neither flag changes managed settings | Unit: env precedence test |
| SET-010 | Without either flag the chain and every consumer behave as before | Existing tests pass unchanged |
| SET-011 | Keys read only from the user file (`askUserQuestionTimeout`, `preferredNotifChannel`, `cleanupPeriodDays`, `enabledPlugins`) read the `--settings` value too and honour the `user` source filter | Unit: `userSettingsFiles` tests |

Known limit: the MCP allow/deny policy pi-code computes while pi loads its extensions, before pi has parsed any flag, does not see `--settings`; the per-session policy does.

## Micro-tasks

| # | Task | Clauses | Files |
|---|---|---|---|
| 1 | Resolver: parse, validate, snapshot, forward | SET-002, SET-003, SET-004, SET-005, SET-008 | `extensions/internal/cli-settings.ts` |
| 2 | Chain: scoped sources, the flag level, the source filter | SET-001, SET-006, SET-008, SET-010 | `extensions/internal/settings-chain.ts` |
| 3 | Positional consumers read by scope | SET-006, SET-009 | `extensions/env-settings.ts`, `extensions/mcp/policy.ts` |
| 4 | User-only readers | SET-011 | `extensions/question.ts`, `extensions/notify.ts`, `extensions/git-checkpoint.ts`, `extensions/internal/plugins.ts` |
| 5 | Child forwarding | SET-007 | `extensions/subagent/run.ts`, `extensions/subagent/modes.ts` |
| 6 | The extension: register, resolve, report, shut down | SET-004, SET-008 | `extensions/settings-flags.ts` |
| 7 | Docs | | `docs/settings-env.md`, `docs/hooks.md`, `README.md` |
