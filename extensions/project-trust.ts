/**
 * Project Trust Extension
 *
 * pi decides whether to prompt for trust from `hasTrustRequiringProjectResources`,
 * which looks only at entries under `cwd/.pi` and at `.agents/skills`. A repository
 * that ships only Claude Code shaped config, `.claude/` plus `.mcp.json`, matches
 * none of them, so pi trusts it without asking.
 *
 * That is exactly the shape pi-code exists to load, and the other extensions gate
 * their project input on `ctx.isProjectTrusted()`. Without this handler that flag is
 * true for a freshly cloned repo nobody was asked about, and a project `.mcp.json`
 * server command, project hooks and project agents all run.
 *
 * Only user/global and CLI extensions receive `project_trust`, so this works when
 * pi-code is installed with `pi install npm:pi-code`. A project-local install
 * (`pi install -l`) is not loaded until trust is already resolved.
 *
 * Docs: node_modules/@earendil-works/pi-coding-agent/docs/extensions.md (project_trust)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { type ExtensionAPI, getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent'

/** Project files pi-code acts on that pi's own trust check does not look for. */
const CLAUDE_SHAPED = [path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json'), path.join('.claude', 'agents'), path.join('.claude', 'hooks'), path.join('.claude', 'output-styles'), '.mcp.json', path.join('.pi', 'mcp.json'), path.join('.pi', 'agents')]

export function hasClaudeShapedConfig(cwd: string): boolean {
  return CLAUDE_SHAPED.some((entry) => fs.existsSync(path.join(cwd, entry)))
}

export type TrustDecision = { trusted: 'yes' | 'no' | 'undecided'; remember?: boolean }

interface TrustDeps {
  hasClaudeShaped: (cwd: string) => boolean
  piWouldAsk: (cwd: string) => boolean
  savedDecision: (cwd: string) => boolean | null
}

const defaultDeps: TrustDeps = {
  hasClaudeShaped: hasClaudeShapedConfig,
  piWouldAsk: hasTrustRequiringProjectResources,
  savedDecision: (cwd) => new ProjectTrustStore(getAgentDir()).get(cwd),
}

/**
 * Whether to take over the trust decision for this project.
 *
 * Returns `undecided` wherever pi already resolves things correctly, so a remembered
 * decision is never overridden and a headless run keeps whatever `defaultProjectTrust`
 * says rather than being forced closed.
 */
export async function decideTrust(cwd: string, hasUI: boolean, confirm: (title: string, body: string) => Promise<boolean>, deps: TrustDeps = defaultDeps): Promise<TrustDecision> {
  if (!deps.hasClaudeShaped(cwd)) return { trusted: 'undecided' }
  if (deps.piWouldAsk(cwd)) return { trusted: 'undecided' } // pi prompts on its own
  if (deps.savedDecision(cwd) !== null) return { trusted: 'undecided' } // apply the stored answer
  if (!hasUI) return { trusted: 'undecided' } // cannot ask; leave pi's default in charge

  const approved = await confirm('Trust this project?', `${cwd}\n\nIt ships Claude Code configuration that pi-code loads: MCP servers, hooks and agents can run commands from this repository.`)
  return { trusted: approved ? 'yes' : 'no', remember: true }
}

export default function projectTrustExtension(pi: ExtensionAPI) {
  pi.on('project_trust', async (event, ctx) => decideTrust(event.cwd, ctx.hasUI, (title, body) => ctx.ui.confirm(title, body)))
}
