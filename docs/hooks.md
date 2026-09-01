# Hooks

Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events. Source: [`extensions/hooks/`](../extensions/hooks) (the module header in `index.ts` is the authoritative contract).

## Events

- **PreToolUse**: blocks tools, rewrites input via `updatedInput`, injects `additionalContext` beside the eventual tool result.
- **PostToolUse**: feedback and `additionalContext` land next to the tool result; `updatedToolOutput`/`updatedMCPToolOutput` replace what the model sees (schema-checked for built-ins, unvalidated for MCP).
- **PostToolUseFailure**: notify-only (the tool already failed); the hook's stderr is shown to the model.
- **SessionStart**: context injection before the first prompt.
- **UserPromptSubmit**: blocks the prompt or injects context ahead of it.
- **Stop**: a block (or `additionalContext`) feeds back as a new turn, with `stop_hook_active` as the loop guard and a consecutive-block cap of 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; `0` disables the cap). Does not run when the turn ended on a user interrupt, as Claude documents.
- **SubagentStart / SubagentStop**: notify-only (a child has already exited by SubagentStop).
- **PreCompact / PostCompact / SessionEnd / Notification** (`idle_prompt`, the one type pi can source): notify-only.
- **InstructionsLoaded**: observational; fires per loaded context file at session start, plus `path_glob_match` on a scoped-rule attach and `include` per resolved `@import`, deduped per session. `nested_traversal`/`compact` reasons never fire (pi does not lazily load nested CLAUDE.md or reload after compaction).

## Hook types

- `type: "command"` (default): runs via `sh -c` with the event JSON on stdin, or exec form (`command` as an argv array, no shell); executes with `CLAUDECODE=1` and `CLAUDE_PROJECT_DIR` set.
- `type: "http"`: POSTs the payload; a 2xx JSON body renders the decision, everything else is non-blocking per Claude's contract. Targets are gated by `allowedHttpHookUrls` (union of managed and settings scopes; unset allows all, `[]` blocks every http hook).
- `type: "prompt"`: evaluates in-process against the session model.
- `type: "mcp_tool"`: calls a connected server's tool.
- `type: "agent"` (experimental): spawns a read-only Read/Grep/Glob subagent that returns the JSON decision.
- For all non-command types: a missing model/server/runner is non-blocking; only a PreToolUse timeout fails closed.

## Payloads and decisions

- Payloads use Claude's vocabulary for pi's built-ins: `Bash`/`Edit`/`Write`/`Read`/`Grep`/`Glob` names, the documented input shapes with absolute `file_path`, and the documented Bash/Write response shapes; `updatedInput` is translated back to pi's shape (an incomplete rewrite keeps the original input).
- Every payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`; tool events add `tool_use_id`.
- Claude matcher semantics, including `mcp__server__tool` names; Stop and UserPromptSubmit ignore a stray matcher.
- The `if` permission-rule filter (`"Bash(git *)"`, `"Edit(*.ts)"`) runs on tool events only; a hook carrying it never runs elsewhere.
- `permissionDecision: "ask"` prompts via a confirm dialog (blocks when headless); `"defer"` blocks the call, since pi cannot resume a deferred one.
- Exit-2 blocking messages prefer the JSON reason over stderr.
- A user-typed `!`/`!!` bash line runs PreToolUse (there is no PostToolUse for it).

## Background hooks

`async`/`asyncRewake` command hooks run in the background on every event: never blocking, no decision, no timeout enforced on `async` while `asyncRewake` keeps its own. An asyncRewake exit 2 wakes the model with the hook's stderr as a new turn; other completions deliver `systemMessage`/`additionalContext` to the model on the next turn; hooks still running at session end are killed.

## Divergences from Claude Code

- A timed-out PreToolUse/UserPromptSubmit hook fails closed at a 60s default (Claude: 600s for PreToolUse, 30s for UserPromptSubmit, both non-blocking), since pi has no permission prompt to fall back on. Prompt hooks default to Claude's 30s and agent hooks to 60s; SessionEnd hooks share Claude's 1.5-second budget, raised by a declared per-hook `timeout` up to 60 seconds, so a slow hook cannot stall session exit.
- Prompt hooks honor the `model` override (resolved against the models this user can run) and append the input JSON to the prompt when `$ARGUMENTS` is absent, as documented.
- `disableAllHooks` in any scope turns the system off; `/hooks` prints the resolved configuration.
