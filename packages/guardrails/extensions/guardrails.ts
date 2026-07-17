/**
 * Guardrails Extension
 *
 * Mechanically enforces personal git rules on every bash tool call:
 * - git push --force is blocked; --force-with-lease is allowed on feature branches.
 * - Commit messages with AI attribution (Co-Authored-By: Claude, "Generated with", robot emoji) are blocked.
 * - Blanket staging (git add -A / --all / .) requires confirmation.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const FORCE_PUSH = /\bgit\s+push\b(?=.*(\s--force\b|\s-f\b))/s
const FORCE_WITH_LEASE = /--force-with-lease/
const AI_ATTRIBUTION = /Co-Authored-By:.*Claude|Generated with.*Claude|🤖/i
const BLANKET_ADD = /\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/
const GIT_COMMIT = /\bgit\s+commit\b/

export default function guardrailsExtension(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined

    const command = event.input.command as string

    if (FORCE_PUSH.test(command) && !FORCE_WITH_LEASE.test(command)) {
      return {
        block: true,
        reason: 'Force-push is blocked. Use --force-with-lease on your own feature branch, or hand the command to the user.',
      }
    }

    if (GIT_COMMIT.test(command) && AI_ATTRIBUTION.test(command)) {
      return {
        block: true,
        reason: 'AI attribution in commit messages is not allowed. Commit without Co-Authored-By/Generated-with trailers.',
      }
    }

    if (BLANKET_ADD.test(command)) {
      if (!ctx.hasUI) {
        return { block: true, reason: 'Blanket git add blocked in non-interactive mode. Stage explicitly by path.' }
      }

      const choice = await ctx.ui.select(`⚠️ Blanket staging:\n\n  ${command}\n\nStage everything?`, ['Yes', 'No'])

      if (choice !== 'Yes') {
        return { block: true, reason: 'Blocked by user. Stage explicitly by path.' }
      }
    }

    return undefined
  })
}
