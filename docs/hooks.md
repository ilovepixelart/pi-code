# Hooks

Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events. Source: [`extensions/hooks/`](../extensions/hooks) (the module header in `index.ts` is the authoritative contract).

Hook locations: settings files, managed policy settings, plugins, skill frontmatter (registered at invocation for the rest of the session, with `once` removing a hook after its first successful run), and agent frontmatter (passed to the subagent child via env, running only while it runs, with `Stop` converted to `SubagentStop`).

## Events

- **PreToolUse**: blocks tools, rewrites input via `updatedInput`, injects `additionalContext` beside the eventual tool result.
- **PostToolUse**: feedback and `additionalContext` land next to the tool result; `updatedToolOutput`/`updatedMCPToolOutput` replace what the model sees (schema-checked for built-ins, unvalidated for MCP).
- **PostToolUseFailure**: notify-only (the tool already failed); the hook's stderr is shown to the model.
- **SessionStart**: context injection before the first prompt.
- **UserPromptSubmit**: blocks the prompt or injects context ahead of it.
- **Stop**: a block (or `additionalContext`) feeds back as a new turn, with `stop_hook_active` as the loop guard and a consecutive-block cap of 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; `0` disables the cap). Does not run when the turn ended on a user interrupt, as Claude documents.
- **SubagentStart / SubagentStop**: SubagentStart runs pre-spawn so its `additionalContext` reaches the child before its first prompt (it cannot block the spawn); SubagentStop is notify-only (the child has already exited) and carries `last_assistant_message`.
- **PreCompact / PostCompact / SessionEnd / Notification** (`idle_prompt`, the one type pi can source): notify-only. `idle_prompt` fires when the turn ended about 60 seconds ago and the user hasn't typed since, per Claude's timing; input or the next turn cancels it. After compaction, **SessionStart** also fires with source `compact`.
- **PostModelSwitch**: fires after the session's model changes, matched against the new model id; stdout/`additionalContext` reaches the model on the next turn. `requested_model` is `null` (pi does not carry the requested alias) and the cost-estimate fields are absent rather than fabricated. PreModelSwitch stays unbridged: pi's `model_select` event has no veto seam, and a blocking hook whose decision is silently ignored would be worse than an absent event. MessageDisplay is likewise unbridged (pi has no display-replacement seam).
- **InstructionsLoaded**: observational; fires per loaded context file at session start, plus `path_glob_match` on a scoped-rule attach and `include` per resolved `@import`, deduped per session. `nested_traversal`/`compact` reasons never fire (pi does not lazily load nested CLAUDE.md or reload after compaction).

## Hook types

- `type: "command"` (default): runs via `sh -c` with the event JSON on stdin, or exec form (`command` as an argv array, no shell); executes with `CLAUDECODE=1` and `CLAUDE_PROJECT_DIR` set.
- `type: "http"`: POSTs the payload; a 2xx JSON body renders the decision, everything else is non-blocking per Claude's contract. Targets are gated by `allowedHttpHookUrls` (union of managed and settings scopes; unset allows all, `[]` blocks every http hook).
- `type: "prompt"`: evaluates in-process against the session model.
- `type: "mcp_tool"`: calls a connected server's tool. String values in `input` support `${path}` substitution from the hook's JSON input (`${tool_input.file_path}`); without `input` the tool is called with no arguments.
- `type: "agent"` (experimental): spawns a read-only Read/Grep/Glob subagent that returns the JSON decision.
- For all non-command types: a missing model/server/runner is non-blocking; only a PreToolUse timeout fails closed.

## Payloads and decisions

- Payloads use Claude's vocabulary for pi's built-ins: `Bash`/`Edit`/`Write`/`Read`/`Grep`/`Glob` names, the documented input shapes with absolute `file_path`, and the documented Bash/Write response shapes; `updatedInput` is translated back to pi's shape (an incomplete rewrite keeps the original input).
- Every payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`; tool events add `tool_use_id` and PostToolUse/PostToolUseFailure add `duration_ms` (excluding PreToolUse hook and confirm time). PreCompact carries `custom_instructions`, PostCompact `compact_summary`.
- Stdout follows Claude's shape rule: only output that starts with `{` and ends with `}` is read as JSON; arrays, quoted strings, and numbers are plain text, multi-line independent JSON objects with no output field are plain text, and malformed `{..}`-shaped output surfaces a `hook error` notice instead of becoming context.
- UserPromptSubmit honors `suppressOriginalPrompt` when context is present (the context replaces the prompt).
- Claude matcher semantics, including `mcp__server__tool` names; Stop and UserPromptSubmit ignore a stray matcher.
- Identical handlers collapse across settings files only; a plugin's copy of the same handler stays separate, and http handlers differing only in headers are distinct.
- The `if` permission-rule filter (`"Bash(git *)"`, `"Edit(*.ts)"`) runs on tool events only; a hook carrying it never runs elsewhere.
- `permissionDecision: "ask"` prompts via a confirm dialog (blocks when headless); `"defer"` blocks the call, since pi cannot resume a deferred one.
- Exit-2 blocking messages prefer the JSON reason over stderr.
- A user-typed `!`/`!!` bash line runs PreToolUse (there is no PostToolUse for it).

## Background hooks

`async`/`asyncRewake` command hooks run in the background on every event: never blocking, no decision, no timeout enforced on `async` while `asyncRewake` keeps its own. An asyncRewake exit 2 wakes the model with the hook's stderr as a new turn; other completions deliver `systemMessage`/`additionalContext` to the model on the next turn; hooks still running at session end are killed.

## Unbridged events and fields

pi has no seam for these; a hook relying on them silently not working would be worse than a documented absence:

- Events: PreModelSwitch (no veto seam on `model_select`), MessageDisplay (no display-replacement seam), UserPromptExpansion, PermissionRequest/PermissionDenied (pi has no permission system), Setup, FileChanged, ConfigChange, CwdChanged, DirectoryAdded, StopFailure, Elicitation events, and Notification types other than `idle_prompt`.
- Fields: `prompt_id` and Stop's `background_tasks`/`session_crons` (no pi task registry), SessionStart's `initialUserMessage`/`watchPaths`/`sessionTitle` and UserPromptSubmit's `sessionTitle` (no session-rename or file-watch seam), and PostModelSwitch's cost-estimate fields (absent rather than fabricated).

## Divergences from Claude Code

- A timed-out PreToolUse/UserPromptSubmit hook fails closed at a 60s default (Claude: 600s for PreToolUse, 30s for UserPromptSubmit, both non-blocking), since pi has no permission prompt to fall back on. Prompt hooks default to Claude's 30s and agent hooks to 60s; SessionEnd hooks share Claude's 1.5-second budget, raised by a declared per-hook `timeout` up to 60 seconds, so a slow hook cannot stall session exit.
- Prompt hooks honor the `model` override (resolved against the models this user can run) and append the input JSON to the prompt when `$ARGUMENTS` is absent, as documented.
- `disableAllHooks` is tiered per Claude: the managed level turns everything off; a settings-file value disables non-managed hooks while managed policy hooks keep running. `/hooks` prints the resolved configuration.
