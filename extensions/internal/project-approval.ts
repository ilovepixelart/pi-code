/**
 * Project Approval
 *
 * `ctx.isProjectTrusted()` is not sufficient on its own. pi decides whether to ask for
 * trust in `hasTrustRequiringProjectResources`, which looks only under `cwd/.pi` and for
 * `.agents/skills`. A repository shipping just `.claude/` and `.mcp.json` matches neither,
 * so `resolveProjectTrusted` short-circuits to `true` before it ever emits `project_trust`:
 *
 *     if (!hasTrustRequiringProjectResources(cwd)) return true
 *     if (extensionsResult) { ...emitProjectTrustEvent... }
 *
 * A `project_trust` handler therefore cannot cover this case; the event only fires for
 * projects pi was already going to prompt about. The decision has to be made where the
 * project config is consumed instead, which is what this module does.
 *
 * Answers are stored in pi's own trust store, so approving here also satisfies pi if the
 * project later grows `.pi` resources, and a decision recorded on a parent directory applies.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent'

/** Project files pi-code acts on that pi's own trust check does not look for. */
const CLAUDE_SHAPED = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  path.join('.claude', 'agents'),
  path.join('.claude', 'hooks'),
  path.join('.claude', 'output-styles'),
  path.join('.claude', 'rules'),
  'CLAUDE.local.md',
  '.mcp.json',
  path.join('.pi', 'mcp.json'),
  path.join('.pi', 'agents'),
]

export function hasClaudeShapedConfig(cwd: string): boolean {
  return CLAUDE_SHAPED.some((entry) => fs.existsSync(path.join(cwd, entry)))
}

export interface ApprovalContext {
  cwd: string
  hasUI: boolean
  isProjectTrusted?: () => boolean
  ui: { confirm: (title: string, body: string) => Promise<boolean> }
}

export interface ApprovalDeps {
  hasClaudeShaped: (cwd: string) => boolean
  piWouldAsk: (cwd: string) => boolean
  savedDecision: (cwd: string) => boolean | null
  remember: (cwd: string, trusted: boolean) => void
}

const defaultDeps: ApprovalDeps = {
  hasClaudeShaped: hasClaudeShapedConfig,
  piWouldAsk: hasTrustRequiringProjectResources,
  savedDecision: (cwd) => new ProjectTrustStore(getAgentDir()).get(cwd),
  remember: (cwd, trusted) => new ProjectTrustStore(getAgentDir()).set(cwd, trusted),
}

const APPROVAL_BODY = 'It ships Claude Code configuration that pi-code loads. MCP servers, hooks and agents can run commands from this repository.'

/**
 * Whether project-controlled config may be acted on.
 *
 * Refuses without a UI rather than deferring: pi reached this point without consulting
 * `defaultProjectTrust` at all, so there is no user preference to fall back on. A run
 * that cannot ask has not been approved.
 */
/** The same decision as isProjectApproved, but never prompts: an undecided project
 * reads as unapproved. For surfaces that only display project config, like the
 * subagent roster, where a mid-turn dialog would be wrong. */
export function isProjectApprovedSilently(ctx: Pick<ApprovalContext, 'cwd' | 'isProjectTrusted'>, deps: ApprovalDeps = defaultDeps): boolean {
  if (ctx.isProjectTrusted?.() !== true) return false
  if (!deps.hasClaudeShaped(ctx.cwd)) return true
  if (deps.piWouldAsk(ctx.cwd)) return true
  return deps.savedDecision(ctx.cwd) === true
}

export async function isProjectApproved(ctx: ApprovalContext, deps: ApprovalDeps = defaultDeps): Promise<boolean> {
  if (ctx.isProjectTrusted?.() !== true) return false // pi already declined, or never trusted
  if (!deps.hasClaudeShaped(ctx.cwd)) return true // nothing here pi's own check would miss
  if (deps.piWouldAsk(ctx.cwd)) return true // pi genuinely prompted for this project

  const stored = deps.savedDecision(ctx.cwd)
  if (stored !== null) return stored
  if (!ctx.hasUI) return false

  const approved = await ctx.ui.confirm('Trust this project?', `${ctx.cwd}\n\n${APPROVAL_BODY}`)
  deps.remember(ctx.cwd, approved)
  return approved
}
