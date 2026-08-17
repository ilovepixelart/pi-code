/**
 * Init Extension
 *
 * Claude Code's /init: analyze the codebase and produce a project context file
 * with build commands, test instructions, and the conventions it discovers; when
 * a context file already exists, suggest improvements instead of overwriting it.
 * The handler does no analysis itself. Claude drives /init through the main agent
 * with tools, and pi's equivalent is pi.sendUserMessage: the handler detects what
 * exists on disk (existing context file, cursor rules, copilot instructions),
 * builds one curated prompt, and sends it; the agent then explores the codebase
 * and writes the file with full tool access. A fresh file is AGENTS.md, the name
 * pi prefers over CLAUDE.md.
 *
 * Docs: https://code.claude.com/docs/en/memory.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { repoRoot } from './internal/project-root.js'

/** Context files pi recognizes, in its lookup order; the first hit wins. */
export const CONTEXT_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

function statOf(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target)
  } catch {
    return undefined
  }
}

/** The name of the first context-file candidate present at the project root. */
export function findExistingContextFile(root: string): string | undefined {
  return CONTEXT_FILE_CANDIDATES.find((name) => statOf(path.join(root, name))?.isFile())
}

export interface InitPromptOptions {
  /** Name of the context file already at the project root, when one exists. */
  existingContextFile?: string
  /** Whether .cursor/rules/ or .cursorrules exists at the project root. */
  cursorRules?: boolean
  /** Whether .github/copilot-instructions.md exists at the project root. */
  copilotRules?: boolean
}

/** The prompt /init sends to the main agent. Pure so tests can pin its contract. */
export function buildInitPrompt(opts: InitPromptOptions = {}): string {
  const parts: string[] = [
    [
      'Please analyze this codebase and distill what a coding agent needs to work in it effectively:',
      '- Build, lint, and test commands, including how to run a single test.',
      '- Code conventions: formatting, imports, naming, types, error handling.',
      '- Architecture notes: the big-picture structure that takes reading several files to see.',
      '- Project layout: the important directories and entry points.',
    ].join('\n'),
  ]
  if (opts.cursorRules) parts.push('Cursor rules exist in this repository (.cursor/rules/ or .cursorrules). Read them and fold the parts that still apply into the context file.')
  if (opts.copilotRules) parts.push('Copilot instructions exist at .github/copilot-instructions.md. Read them and fold the parts that still apply into the context file.')
  if (opts.existingContextFile) {
    parts.push(`A context file already exists at the project root: ${opts.existingContextFile}. Read it, then propose improvements based on what you found and apply the ones that clearly help. Do not overwrite the file wholesale; keep its structure and voice and make targeted edits.`)
  } else {
    parts.push('Write the result to AGENTS.md at the project root. Create the file yourself. pi prefers AGENTS.md over CLAUDE.md as its context file, and Claude Code can read it too via an @AGENTS.md import from CLAUDE.md or a symlink.')
  }
  parts.push('Keep the file concise and high-signal, under roughly 200 lines. Skip generic advice and anything obvious from a glance at the code.')
  return parts.join('\n\n')
}

export default function initExtension(pi: ExtensionAPI) {
  pi.registerCommand('init', {
    description: 'Analyze the codebase and create or improve the project context file (AGENTS.md)',
    handler: async (_args, ctx) => {
      const root = repoRoot(ctx.cwd) ?? ctx.cwd
      const existing = findExistingContextFile(root)
      const cursorRules = statOf(path.join(root, '.cursor', 'rules'))?.isDirectory() === true || statOf(path.join(root, '.cursorrules'))?.isFile() === true
      const copilotRules = statOf(path.join(root, '.github', 'copilot-instructions.md'))?.isFile() === true
      // A bare send throws (and is silently swallowed) while the agent is
      // streaming, so mid-stream invocations queue as a follow-up turn.
      pi.sendUserMessage(buildInitPrompt({ ...(existing !== undefined ? { existingContextFile: existing } : {}), cursorRules, copilotRules }), ctx.isIdle() ? {} : { deliverAs: 'followUp' })
    },
  })
}
