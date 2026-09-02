# Goal

Claude Code's `/goal`: a completion condition the session keeps working toward without a prompt per step. Source: [`extensions/goal.ts`](../extensions/goal.ts) (the module header is the authoritative contract); the evaluator prompt, verdict parser, and status text live in [`extensions/internal/goal-evaluator.ts`](../extensions/internal/goal-evaluator.ts).

## Commands

- `/goal <condition>`: sets the goal (replacing an active one), prints `Goal set:`, and starts a turn at once with Claude's kickoff directive, so the condition itself is the task. The condition is capped at 4,000 characters.
- `/goal`: status. Active: the condition, turns evaluated (`not yet evaluated` before the first verdict), elapsed time, token spend since the goal was set, and the evaluator's last reason. After the goal is achieved: the achieved condition with its duration, turns, and spend. Otherwise `No goal set`.
- `/goal clear` (also `stop`, `off`, `reset`, `none`, `cancel`, any case): removes the goal and records `Goal cleared:` in the transcript, or says `No goal set`. `/new` drops it with the session.

A `◎ goal <elapsed>` status appears in the footer while a goal is active.

Headless, `pi -p "/goal <condition>"` runs the loop to completion in one invocation: the command holds the process open until the goal resolves or pauses. Use `--mode json` to watch each turn and verdict as they happen; the default text output prints nothing until the run ends.

## How evaluation works

After every turn, the goal extension sends the branch transcript and the condition to the evaluator with Claude's stop-condition instructions, and acts on its JSON verdict:

- **Not yet met**: the reason and the condition are fed back as a `[goal]` transcript line that starts the next turn.
- **Met**: the goal clears and `Goal achieved (duration · turns · tokens)` lands in the transcript with the evaluator's evidence.
- **Impossible**: the goal clears and `Goal could not be achieved` lands in the transcript with the reason.

The evaluator runs in-process on the session model (`ANTHROPIC_DEFAULT_HAIKU_MODEL` picks another model this user can run, matched on id or name). It reads the transcript trimmed from the head to half its context window and cannot run tools, so write conditions the session's own output can prove (`npm test exits 0`, `git status is clean`), with the check named. Its tokens count toward the goal's spend shown by `/goal`.

Guards, each mirroring Claude's documented behavior:

- **Block cap**: the Stop hooks' consecutive-block cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8, `0` disables) also bounds a goal. That many not-met verdicts in a row on turns that ran no tool pause the loop with a warning; the goal stays set and evaluation resumes after the next user prompt. A tool-using turn or a user prompt resets the count.
- **Background work**: a turn that ends while a subagent is still running is not evaluated; the next turn that ends with none running is. A check-in turn is injected once the wait reaches `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` (30 by default, `0` turns check-ins off), listing the running subagents and asking the model to check on them; later check-ins wait twice as long each, up to four times the first interval, and at most three are started while idle between user prompts (a check-in that comes due mid-turn is delivered when that turn ends).
- **Interrupts and errors**: a turn the user interrupted or that failed on an error is not evaluated. Once the run settles, an error you have to fix clears the goal with `Goal cleared after an unrecoverable error (<kind>)`: authentication, exhausted credits, a context overflow, or an unavailable model. Rate limits, overloads, and network errors leave the goal set.
- **Evaluator failures**: no model, a provider error, a timeout (30 seconds), or an unreadable verdict end the turn with a warning and leave the goal set.

## Persistence

The active goal is written to the session as a custom entry and restored on `--continue`, `/resume`, and `/reload` with the turn count, timer, and token baseline reset. An achieved, failed, or cleared goal is not restored.

## Availability

As in Claude, `/goal` rides the hooks system: it refuses, saying why, when hooks are restricted (`disableAllHooks` in managed policy or any honored settings file, or `allowManagedHooksOnly`) or the project is not trusted.

## Divergences from Claude Code

- pi has no small fast model tier, so the evaluator defaults to the session model rather than Haiku; `ANTHROPIC_DEFAULT_HAIKU_MODEL` selects among the models this user can run instead of naming an arbitrary id.
- pi's only background work is subagents, so deferral and check-ins track those; there is no background shell.
- The goal loop runs beside the hooks extension's Stop path rather than inside it: a settings `Stop` hook and a goal both evaluate at turn end, and when both continue, the second continuation is delivered into the first's turn. The goal does not set `stop_hook_active` on Stop hook payloads.
- The transcript view shows the evaluator's verdict and reason as a `[goal]` line; there is no Ctrl+O detail toggle.
- Claude pins the evaluator's reply with a JSON schema; pi's one-off completion cannot, so the instruction asks for JSON only and a reply that opens with a bare `yes` or `no` (how small local models tend to answer) is read as that verdict with the reply as its reason. Anything else is an evaluator error.
