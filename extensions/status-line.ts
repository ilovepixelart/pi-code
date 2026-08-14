/**
 * Status Line Extension
 *
 * Honors Claude Code's `statusLine` settings contract: a configured command runs
 * with the session JSON on stdin (model, workspace, cost, context_window, effort,
 * output_style, session ids) and its first stdout line becomes the footer segment,
 * padded per `padding`. It re-runs, debounced 300ms as Claude does, at session
 * start, after turns, after compaction, on plan-mode changes (the permission-mode
 * analogue, off the shared bus), and on the optional `refreshInterval` timer
 * (minimum 1s). A project-defined command is arbitrary shell, so project settings
 * count only once the project is already approved, read without prompting.
 *
 * Without a configured statusLine, the built-in segment shows turn state plus
 * running session cost, summed from per-message usage on the current branch so it
 * stays correct across /tree navigation and forks. The built-in segment is also
 * the fallback while a configured command produces no output. Multi-line output
 * is truncated to its first line: the segment is one footer row in pi.
 *
 * Docs: https://code.claude.com/docs/en/statusline.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { hookFiles, runHookCommand } from './hooks.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from './internal/plan-mode-state.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { readActiveStyleName, settingsFiles } from './output-styles.js'

const COMMAND_TIMEOUT_MS = 5_000
const DEBOUNCE_MS = 300

interface UsageEntry {
  type: string
  message?: { usage?: { cost?: { total?: number } } }
}

function sessionCost(ctx: ExtensionContext): number {
  let total = 0
  for (const entry of ctx.sessionManager.getBranch() as UsageEntry[]) {
    total += entry.message?.usage?.cost?.total ?? 0
  }
  return total
}

function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`
}

export interface StatusLineConfig {
  command: string
  padding: number
  refreshInterval: number | undefined
}

/** The `statusLine` recorded in settings, last file winning. Claude's shape is
 * `{type: "command", command, padding?, refreshInterval?}`; entries without a
 * command string are ignored, and refreshInterval has a documented minimum of 1. */
export function readStatusLineConfig(files: string[]): StatusLineConfig | undefined {
  let found: StatusLineConfig | undefined
  for (const file of files) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const entry = settings.statusLine
      if (!entry || typeof entry.command !== 'string') continue
      if (entry.type !== undefined && entry.type !== 'command') continue
      found = {
        command: entry.command,
        padding: typeof entry.padding === 'number' && entry.padding > 0 ? entry.padding : 0,
        refreshInterval: typeof entry.refreshInterval === 'number' && entry.refreshInterval >= 1 ? entry.refreshInterval : undefined,
      }
    } catch {
      // missing or invalid file: skip
    }
  }
  return found
}

export default function statusLine(pi: ExtensionAPI) {
  let turnCount = 0
  let config: StatusLineConfig | undefined
  let sessionCtx: ExtensionContext | undefined
  let commandLine: string | undefined
  let permissionMode = 'default'
  let projectApproved = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let rerunQueued = false

  function segmentText(ctx: ExtensionContext, symbol: string): string {
    const theme = ctx.ui.theme
    const cost = sessionCost(ctx)
    const costText = cost > 0 ? theme.fg('muted', ` ${formatCost(cost)}`) : ''
    const turnText = turnCount > 0 ? theme.fg('dim', ` turn ${turnCount}`) : theme.fg('dim', ' ready')
    return symbol + turnText + costText
  }

  function show(ctx: ExtensionContext, builtIn: string): void {
    ctx.ui.setStatus('pi-code-status', commandLine ?? builtIn)
  }

  /** The stdin payload per Claude's documented statusline contract. */
  function buildPayload(ctx: ExtensionContext): Record<string, unknown> {
    const usage = ctx.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null }
    const model = ctx.model as { id?: string; name?: string } | undefined
    // Same gate as the config read above: an unapproved project's style is not applied,
    // so reporting it here would describe a style the session is not using.
    const styleName = readActiveStyleName(settingsFiles(ctx.cwd, os.homedir(), projectApproved))
    const payload: Record<string, unknown> = {
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      workspace: { current_dir: ctx.cwd, project_dir: ctx.cwd },
      // Both fields, per Claude's documented contract: published statusline scripts
      // read .model.display_name and render the literal "null" when it is missing.
      model: { id: model?.id ?? '', display_name: model?.name ?? model?.id ?? '' },
      cost: { total_cost_usd: sessionCost(ctx) },
      context_window: { context_window_size: usage.contextWindow, used_percentage: usage.percent, total_input_tokens: usage.tokens },
      permission_mode: permissionMode,
    }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) payload.transcript_path = transcript
    if (ctx.thinkingLevel) payload.effort = { level: ctx.thinkingLevel }
    if (styleName) payload.output_style = { name: styleName }
    return payload
  }

  async function runCommand(ctx: ExtensionContext): Promise<void> {
    if (!config) return
    if (running) {
      rerunQueued = true
      return
    }
    running = true
    try {
      // Everything below can touch ctx after an await, and every ctx getter throws
      // once the session is disposed. This promise is started from a timer with no
      // awaiter, so an escaping rejection becomes an uncaughtException and exits pi.
      const result = await runHookCommand(config.command, buildPayload(ctx), COMMAND_TIMEOUT_MS)
      const first = result.stdout.split('\n')[0].trimEnd()
      const pad = ' '.repeat(config.padding)
      commandLine = first ? `${pad}${first}${pad}` : undefined
      show(ctx, segmentText(ctx, ctx.ui.theme.fg('dim', '○')))
    } catch {
      // A replaced or reloaded session invalidates ctx while the command is in
      // flight; there is nothing left to update, and the next session starts fresh.
    } finally {
      running = false
      if (rerunQueued) {
        rerunQueued = false
        void runCommand(ctx)
      }
    }
  }

  /** Claude debounces statusline updates at 300ms so rapid triggers batch. */
  function scheduleRefresh(): void {
    if (!config || !sessionCtx) return
    const ctx = sessionCtx
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void runCommand(ctx)
    }, DEBOUNCE_MS)
  }

  pi.events.on(PLAN_MODE_CHANNEL, (data) => {
    if (!isPlanModeState(data)) return
    permissionMode = data.active ? 'plan' : 'default'
    scheduleRefresh()
  })

  pi.on('session_start', async (_event, ctx) => {
    // One instance serves every session, so a fresh session must not inherit state.
    turnCount = 0
    commandLine = undefined
    sessionCtx = ctx
    clearInterval(refreshTimer)
    // Reading config must never open a trust dialog: several extensions resolve
    // approval at session start, and a second prompt stacks over the first and eats
    // the keys meant for it. An undecided project simply skips project settings.
    const trusted = isProjectApprovedSilently(ctx)
    projectApproved = trusted
    config = readStatusLineConfig(hookFiles(ctx.cwd, os.homedir(), trusted))
    if (config?.refreshInterval) {
      refreshTimer = setInterval(() => scheduleRefresh(), config.refreshInterval * 1000)
    }
    show(ctx, segmentText(ctx, ctx.ui.theme.fg('dim', '○')))
    scheduleRefresh()
  })

  pi.on('turn_start', async (_event, ctx) => {
    turnCount++
    const theme = ctx.ui.theme
    show(ctx, theme.fg('accent', '●') + theme.fg('dim', ` turn ${turnCount}...`))
  })

  pi.on('turn_end', async (_event, ctx) => {
    show(ctx, segmentText(ctx, ctx.ui.theme.fg('success', '✓')))
    scheduleRefresh()
  })

  pi.on('agent_end', async (_event, ctx) => {
    show(ctx, segmentText(ctx, ctx.ui.theme.fg('success', '✓')))
    scheduleRefresh()
  })

  pi.on('session_compact', async (_event, _ctx) => {
    scheduleRefresh()
  })

  pi.on('session_shutdown', async () => {
    clearInterval(refreshTimer)
    clearTimeout(debounceTimer)
  })
}
