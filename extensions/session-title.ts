/**
 * Session Auto-Title Extension
 *
 * Claude auto-names a new conversation from its first message; this does the same for
 * pi. After the first run of an unnamed session settles, it asks the current model for
 * a short title based on the first user message and applies it with setSessionName, which
 * names the session in the selector and refreshes the terminal window/tab title natively
 * (pi changelog); a separate ctx.ui.setTitle call would only duplicate that, so there is none.
 *
 * It runs in every mode, not just the TUI: naming a session is cheap and harmless, and a
 * headless run that persists its session still benefits from a readable name later. Titling
 * is best-effort throughout: a session that already has a name, a run with no user text (a
 * slash-command-only turn), a headless run with no model, or any provider error leaves the
 * session untitled and never throws.
 *
 * Cost: one model call per session at most. The guard is claimed before the completion so
 * repeated settles cannot each fire a call, and a failed attempt is not retried until a
 * new session resets the guard.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { completeText } from './internal/model-complete.js'
import { contentText } from './internal/values.js'

const TITLE_SYSTEM = 'You name a coding session from its first user message. Reply with a terse 3 to 6 word title in Title Case that captures the task. No quotes, no surrounding punctuation, no trailing period. Output the title only, nothing else.'
/** A title is a few words; a tight cap keeps the extra call cheap and stops a runaway reply. */
const TITLE_MAX_TOKENS = 24
/** The first message can be huge; only its opening is needed to name the session, and a
 * bounded prompt keeps the input cost of the extra call small. */
const MAX_PROMPT_CHARS = 1000

/** Text of the first user message in the branch, or empty when the run carried no user text
 * (for example a slash-command-only turn), in which case there is nothing to title from. */
export function firstUserText(ctx: ExtensionContext): string {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type === 'message' && entry.message.role === 'user') {
      return contentText(entry.message.content, ' ').trim()
    }
  }
  return ''
}

/** Wrapping quotes (straight, smart, and backtick) and trailing sentence punctuation that
 * cleanTitle peels, held as plain strings so the trims below can test membership by index
 * rather than with an anchored regex. */
const WRAPPING_QUOTES = '"\'`“”‘’'
const TRAILING_PUNCTUATION = '.,;:!?'

/** Strip runs of `chars` from both ends of `value` in linear time. The equivalent
 * /^[chars]+|[chars]+$/g backtracks super-linearly on a long run (S8786). */
function trimBothEnds(value: string, chars: string): string {
  let start = 0
  let end = value.length
  while (start < end && chars.includes(value[start])) start++
  while (end > start && chars.includes(value[end - 1])) end--
  return value.slice(start, end)
}

/** Strip a trailing run of `chars` from `value` in linear time. The equivalent
 * /[chars]+$/g backtracks super-linearly on a long trailing run (S8786). */
function trimTrailing(value: string, chars: string): string {
  let end = value.length
  while (end > 0 && chars.includes(value[end - 1])) end--
  return value.slice(0, end)
}

/** Trim the model's reply to a bare title: collapse whitespace, then peel wrapping quotes
 * and trailing punctuation until stable, so `"Fix The Parser."` and `Fix The Parser.` both
 * land on the plain phrase. */
export function cleanTitle(raw: string): string {
  let title = raw.trim().replace(/\s+/g, ' ')
  let prev: string
  do {
    prev = title
    title = trimTrailing(trimBothEnds(title, WRAPPING_QUOTES), TRAILING_PUNCTUATION).trim()
  } while (title !== prev)
  return title
}

export default function sessionTitleExtension(pi: ExtensionAPI) {
  // One title per session, reset when a new session takes over so a resumed or forked
  // session can still earn its own name.
  let titled = false
  // Bumped on every session_start. Captured before the model call so a title that resolves
  // after a /new (which resets state to a different session) is recognized as stale and
  // dropped, rather than renaming whoever holds the session slot now.
  let generation = 0

  pi.on('session_start', () => {
    titled = false
    generation++
  })

  pi.on('agent_settled', async (_event, ctx) => {
    // Claude: "Set to 1 to disable automatic terminal title updates based on conversation
    // context. In Agent SDK and claude -p sessions, this also skips the background
    // small/fast-model request that generates the session title." setSessionName is pi's
    // only title sink, so skipping the call here skips both effects at once.
    if (process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE === '1') return
    if (titled) return
    // Never clobber an existing name: a user-chosen or resumed name wins.
    if (pi.getSessionName?.()) return
    const model = ctx.model
    if (!model) return // headless with no model: nothing to name with, and the guard is left unspent
    const prompt = firstUserText(ctx)
    if (!prompt) return // no user text this run: leave the guard unspent for a later real message

    // Claim the single attempt before the await, so overlapping or repeated settles cannot
    // each fire a model call; a failed attempt below is not retried within this session.
    titled = true
    const startedGeneration = generation
    let title: string
    try {
      const { text } = await completeText(model, `First user message of a new coding session:\n\n${prompt.slice(0, MAX_PROMPT_CHARS)}`, {
        system: TITLE_SYSTEM,
        maxTokens: TITLE_MAX_TOKENS,
      })
      title = cleanTitle(text)
    } catch {
      return // no model, provider error: leave the session untitled (best-effort)
    }
    if (!title) return
    // A /new during the await moved us to a different session, or a name has since been set;
    // applying this title now would rename the wrong session, so drop it.
    if (generation !== startedGeneration || pi.getSessionName?.()) return
    // Post-await ctx getters throw once the session is disposed, and an escaping rejection
    // from this un-awaited settle can exit pi; apply the title best-effort.
    try {
      // pi.setSessionName refreshes the terminal/tab title natively (pi changelog), so a
      // separate ctx.ui.setTitle call would only duplicate that. The guard stays: a
      // disposed session throws from setSessionName post-await, and an escaping rejection
      // from this un-awaited settle can exit pi.
      pi.setSessionName(title)
    } catch {
      // disposed session or a setter failure: leave the session untitled.
    }
  })
}
