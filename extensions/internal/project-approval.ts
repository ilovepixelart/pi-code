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
import * as os from 'node:os'
import * as path from 'node:path'
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent'

import { claudeConfigDir } from './config-dir.ts'
import { ROOT_MARKERS } from './project-root.ts'
import { localSettingsFile } from './settings-chain.ts'

/** Project files pi-code acts on that pi's own trust check does not look for. */
const CLAUDE_SHAPED = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  path.join('.claude', 'agents'),
  path.join('.claude', 'hooks'),
  path.join('.claude', 'output-styles'),
  path.join('.claude', 'rules'),
  path.join('.claude', 'skills'),
  path.join('.claude', 'commands'),
  // Injected into the prompt verbatim, and context-imports treats it as approval-gated.
  path.join('.claude', 'CLAUDE.md'),
  'CLAUDE.local.md',
  '.mcp.json',
  path.join('.pi', 'mcp.json'),
  path.join('.pi', 'agents'),
]

/** The folders whose `.claude` is the user's own configuration: the home directory, and
 * the directory whose `.claude` subdirectory is CLAUDE_CONFIG_DIR. The latter only while
 * its settings.local.json stays beside that config: inside a repository whose root takes
 * the local settings instead, Claude holds it like any other folder. One comparison
 * covers both: a CLAUDE_CONFIG_DIR not named `.claude` never holds the file either. */
function configurationHomes(home: string): string[] {
  const configDir = claudeConfigDir(home)
  const configHome = path.dirname(configDir)
  if (localSettingsFile(configHome, home) !== path.join(configDir, 'settings.local.json')) return [home]
  return [home, configHome]
}

/** Claude-shaped config anywhere between `cwd` and the repository root.
 *
 * The walk matters: agent discovery already searches upward, so starting pi in a
 * subdirectory of a repository whose `.claude/agents` sits at the root found those
 * agents while a cwd-only check reported nothing to gate, and the short-circuit
 * approved the project without ever asking. The bound is the repository root and the
 * configuration homes, because `~/.claude` is the user's own configuration: a directory under
 * home that is in no repository would otherwise walk up into it and report the user's
 * own settings as a project waiting to be approved. */
export function hasClaudeShapedConfig(cwd: string, home: string = os.homedir()): boolean {
  // settings.local.json is read from the main checkout, which a worktree's .git file
  // names and which is a sibling of cwd, never on the walk below. An archive can carry
  // both ends of that pointer, so the file the chain will read is checked where it is.
  // At a configuration home the file is the user's own, as the walk also holds.
  const homes = configurationHomes(home)
  const relocated = localSettingsFile(cwd, home)
  if (!homes.includes(path.dirname(path.dirname(relocated))) && fs.existsSync(relocated)) return true
  let currentDir = cwd
  while (true) {
    // The home check comes first: at a configuration home the .claude found is the user's own.
    if (homes.includes(currentDir)) return false
    if (CLAUDE_SHAPED.some((entry) => fs.existsSync(path.join(currentDir, entry)))) return true
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(currentDir, marker)))) return false
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return false
    currentDir = parentDir
  }
}

export interface ApprovalContext {
  cwd: string
  hasUI: boolean
  isProjectTrusted?: () => boolean
  ui: { confirm: (title: string, body: string) => Promise<boolean>; notify?: (message: string, type?: 'info' | 'warning' | 'error') => void }
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

/** The same decision as isProjectApproved, but never prompts: an undecided project
 * reads as unapproved. For surfaces that only display project config, like the
 * subagent roster, where a mid-turn dialog would be wrong. */
export function isProjectApprovedSilently(ctx: Pick<ApprovalContext, 'cwd' | 'isProjectTrusted'> & { ui?: ApprovalContext['ui'] }, deps: ApprovalDeps = defaultDeps): boolean {
  // A pi without isProjectTrusted (before 0.79.1, below PI_FLOOR) reads as untrusted.
  if (ctx.isProjectTrusted?.() !== true) return false
  if (!deps.hasClaudeShaped(ctx.cwd)) return true
  if (deps.piWouldAsk(ctx.cwd)) return true
  return deps.savedDecision(ctx.cwd) === true
}

/**
 * A re-check of the approval decision for code that outlives session_start, such as a
 * settings watcher's reload. The answer given at session_start cannot be reused: a
 * repository with nothing Claude-shaped reads as approved without a question, so config
 * that appears later (a branch checkout, an unpacked archive) would inherit an answer
 * nobody gave. ctx is read once, here: the returned function holds values only, because
 * a poll outlives the session and every getter of a replaced session's ctx throws. It
 * never prompts, so a project that turned Claude-shaped mid-session stays out until the
 * next session asks.
 */
export function approvalRecheck(ctx: Pick<ApprovalContext, 'cwd' | 'isProjectTrusted'>, deps: ApprovalDeps = defaultDeps): () => boolean {
  const cwd = ctx.cwd
  const piTrusted = ctx.isProjectTrusted?.() === true
  return () => isProjectApprovedSilently({ cwd, isProjectTrusted: () => piTrusted }, deps)
}

/**
 * The approval decision for a file that is itself the thing to gate.
 *
 * The silent check short-circuits to approved when the repository holds no
 * Claude-shaped config, meaning there is nothing here pi-code would act on. That is
 * wrong for a file the CLAUDE_SHAPED walk cannot see: the walk only looks at or above
 * cwd, so a CLAUDE.local.md in a subdirectory would come in through the one door the
 * gate does not cover. Forcing the shaped answer makes such a file need a real
 * decision, never the shortcut.
 */
export function isGatedFileApproved(ctx: Pick<ApprovalContext, 'cwd' | 'isProjectTrusted'> & { ui?: ApprovalContext['ui'] }, deps: ApprovalDeps = defaultDeps): boolean {
  return isProjectApprovedSilently(ctx, { ...deps, hasClaudeShaped: () => true })
}

/**
 * Whether project-controlled config may be acted on.
 *
 * Refuses without a UI rather than deferring: pi reached this point without consulting
 * `defaultProjectTrust` at all, so there is no user preference to fall back on. A run
 * that cannot ask has not been approved.
 */
export async function isProjectApproved(ctx: ApprovalContext, deps: ApprovalDeps = defaultDeps): Promise<boolean> {
  if (ctx.isProjectTrusted?.() !== true) return false // pi declined trust, or predates it (below PI_FLOOR)
  if (!deps.hasClaudeShaped(ctx.cwd)) return true // nothing here pi's own check would miss
  if (deps.piWouldAsk(ctx.cwd)) return true // pi genuinely prompted for this project

  const stored = deps.savedDecision(ctx.cwd)
  if (stored !== null) return stored
  if (!ctx.hasUI) return false

  const approved = await ctx.ui.confirm('Trust this project?', `${ctx.cwd}\n\n${APPROVAL_BODY}`)
  deps.remember(ctx.cwd, approved)
  return approved
}
