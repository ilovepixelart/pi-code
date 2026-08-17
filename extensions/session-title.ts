/**
 * Session Auto-Title Extension
 *
 * Claude auto-names a new conversation from its first message; this does the same for
 * pi. After the first run of an unnamed session settles, it asks the current model for
 * a short title based on the first user message and applies it two ways: setSessionName
 * (the name shown in the session selector) and the terminal window/tab title.
 *
 * It runs in every mode, not just the TUI: naming a session is cheap and harmless, and a
 * headless run that persists its session still benefits from a readable name later. The
 * window-title update is the only terminal-specific part, so it is optional-called rather
 * than gated on hasUI. Titling is best-effort throughout: a session that already has a
 * name, a run with no user text (a slash-command-only turn), a headless run with no model,
 * or any provider error leaves the session untitled and never throws.
 *
 * Cost: one model call per session at most. The guard is claimed before the completion so
 * repeated settles cannot each fire a call, and a failed attempt is not retried until a
 * new session resets the guard.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { completeText } from './internal/model-complete.js'

const TITLE_SYSTEM = 'You name a coding session from its first user message. Reply with a terse 3 to 6 word title in Title Case that captures the task. No quotes, no surrounding punctuation, no trailing period. Output the title only, nothing else.'
/** A title is a few words; a tight cap keeps the extra call cheap and stops a runaway reply. */
const TITLE_MAX_TOKENS = 24
/** The first message can be huge; only its opening is needed to name the session, and a
 * bounded prompt keeps the input cost of the extra call small. */
const MAX_PROMPT_CHARS = 1000

/** Join the text of a message's content, mirroring git-checkpoint's extraction: content is
 * either a plain string or an array of parts, of which only text parts carry a title's worth. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
}

/** Text of the first user message in the branch, or empty when the run carried no user text
 * (for example a slash-command-only turn), in which case there is nothing to title from. */
export function firstUserText(ctx: ExtensionContext): string {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type === 'message' && entry.message.role === 'user') {
      return extractText(entry.message.content).trim()
    }
  }
  return ''
}

/** Trim the model's reply to a bare title: collapse whitespace, then peel wrapping quotes
 * and trailing punctuation until stable, so `"Fix The Parser."` and `Fix The Parser.` both
 * land on the plain phrase. */
export function cleanTitle(raw: string): string {
  let title = raw.trim().replace(/\s+/g, ' ')
  let prev: string
  do {
    prev = title
    title = title
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
      .replace(/[.,;:!?]+$/g, '')
      .trim()
  } while (title !== prev)
  return title
}

export default function sessionTitleExtension(pi: ExtensionAPI) {
  // One title per session, reset when a new session takes over so a resumed or forked
  // session can still earn its own name.
  let titled = false

  pi.on('session_start', () => {
    titled = false
  })

  pi.on('agent_settled', async (_event, ctx) => {
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
    pi.setSessionName(title)
    ctx.ui.setTitle?.(title)
  })
}
