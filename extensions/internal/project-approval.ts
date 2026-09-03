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

import { ROOT_MARKERS } from './project-root.js'

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

/** Claude-shaped config anywhere between `cwd` and the repository root.
 *
 * The walk matters: agent discovery already searches upward, so starting pi in a
 * subdirectory of a repository whose `.claude/agents` sits at the root found those
 * agents while a cwd-only check reported nothing to gate, and the short-circuit
 * approved the project without ever asking. The bound is the repository root and the home
 * directory, because `~/.claude` is the user's own configuration: a directory under
 * home that is in no repository would otherwise walk up into it and report the user's
 * own settings as a project waiting to be approved. */
export function hasClaudeShapedConfig(cwd: string, home: string = os.homedir()): boolean {
  let currentDir = cwd
  while (true) {
    // The home check comes first: at home itself the .claude found is the user's own.
    if (currentDir === home) return false
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

/**
 * Shown once when the pi runtime predates project-trust support. pi >= 0.79.1 hands
 * extensions a `ctx.isProjectTrusted` callback; older runtimes omit it, and the trust
 * guard below then reads every project as untrusted, so trust prompts, project hooks, MCP,
 * commands, skills and rules all fail closed with nothing said. A live run on such a pi
 * produced no error anywhere; this turns that silence into one line.
 */
const RUNTIME_TOO_OLD = 'pi-code requires pi >= 0.79.1 for project configuration; project-scoped .claude config stays disabled on this pi version'

/**
 * Whether the runtime lacks the `isProjectTrusted` capability, warning once when it does.
 *
 * The notice fires at most once per process and the guard is never reset: a pi binary
 * cannot change version mid-run, so a single notice carries all the information a session
 * can, and repeating it on every gated surface would be noise. Both the prompting and the
 * silent callers report it. A missing runtime capability is not an approval question, so
 * surfacing it from the silent variant is correct rather than a stray dialog. `ctx.ui` may
 * be absent on a headless run, so the notify is fully optional-chained. Callers still fail
 * closed on a true return, exactly as before.
 */
let warnedRuntimeTooOld = false

function runtimeLacksProjectTrust(ctx: { isProjectTrusted?: () => boolean; ui?: { notify?: (message: string, type?: 'info' | 'warning' | 'error') => void } }): boolean {
  if (typeof ctx.isProjectTrusted === 'function') return false
  if (!warnedRuntimeTooOld) {
    warnedRuntimeTooOld = true
    ctx.ui?.notify?.(RUNTIME_TOO_OLD, 'warning')
  }
  return true
}

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
export function isProjectApprovedSilently(ctx: Pick<ApprovalContext, 'cwd' | 'isProjectTrusted'> & { ui?: ApprovalContext['ui'] }, deps: ApprovalDeps = defaultDeps): boolean {
  if (runtimeLacksProjectTrust(ctx)) return false // pi predates project-trust support
  if (ctx.isProjectTrusted?.() !== true) return false
  if (!deps.hasClaudeShaped(ctx.cwd)) return true
  if (deps.piWouldAsk(ctx.cwd)) return true
  return deps.savedDecision(ctx.cwd) === true
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

export async function isProjectApproved(ctx: ApprovalContext, deps: ApprovalDeps = defaultDeps): Promise<boolean> {
  if (runtimeLacksProjectTrust(ctx)) return false // pi predates project-trust support
  if (ctx.isProjectTrusted?.() !== true) return false // pi declined trust for this project
  if (!deps.hasClaudeShaped(ctx.cwd)) return true // nothing here pi's own check would miss
  if (deps.piWouldAsk(ctx.cwd)) return true // pi genuinely prompted for this project

  const stored = deps.savedDecision(ctx.cwd)
  if (stored !== null) return stored
  if (!ctx.hasUI) return false

  const approved = await ctx.ui.confirm('Trust this project?', `${ctx.cwd}\n\n${APPROVAL_BODY}`)
  deps.remember(ctx.cwd, approved)
  return approved
}
