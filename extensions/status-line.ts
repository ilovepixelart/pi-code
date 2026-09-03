/**
 * Status Line Extension
 *
 * Honors Claude Code's `statusLine` settings contract: a configured command runs
 * with the session JSON on stdin (model, workspace, cost, context_window, effort,
 * output_style, session ids) and its first stdout line becomes the footer segment,
 * padded per `padding`. It re-runs, debounced 300ms as Claude does, at session
 * start, after turns and each assistant message, after compaction, on plan-mode
 * changes (the permission-mode analogue, off the shared bus), when a rate-limit
 * window in the last payload reaches its resets_at time, when the statusLine
 * settings change mid-session (file watcher), and on the optional
 * `refreshInterval` timer (minimum 1s). A new trigger while the script is still
 * running cancels the in-flight run, as Claude does. A project-defined command is
 * arbitrary shell, so project settings count only once the project is already
 * approved, read without prompting.
 * Claude's `disableAllHooks` setting turns the configured command off too, and
 * the built-in segment stands in.
 *
 * Without a configured statusLine, the built-in segment shows turn state plus
 * running session cost: a total seeded from the branch's per-message usage at
 * session start, accumulated per message_end, and reseeded when compaction or
 * /tree navigation reshapes the branch, so it stays correct across navigation
 * and forks without re-walking the branch on every render. The built-in segment is also
 * the fallback while a configured command produces no output. Multi-line output
 * is truncated to its first line: the segment is one footer row in pi.
 *
 * Docs: https://code.claude.com/docs/en/statusline.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { hookFiles, readDisableAllHooks, runHookCommand } from './hooks/index.js'
import { claudeEffortLevel } from './internal/effort.js'
import { readManagedSettings } from './internal/managed-settings.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from './internal/plan-mode-state.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { repoRoot } from './internal/project-root.js'
import { readSettingsChain } from './internal/settings-chain.js'
import { watchSettingsFiles } from './internal/settings-watch.js'
import { readActiveStyleName, settingsFiles } from './output-styles.js'

const COMMAND_TIMEOUT_MS = 5_000
const DEBOUNCE_MS = 300

/** Claude sends its CLI version; pi-code's own version is the honest analogue. */
const PACKAGE_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8')).version ?? '')
  } catch {
    return ''
  }
})()

interface UsageEntry {
  type: string
  message?: { usage?: { cost?: { total?: number } } }
}

/** Full branch walk: used only to (re)seed the running total, at session start
 * and on the events that reshape the branch. Renders read the total instead. */
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

interface RateLimitWindow {
  used_percentage: number
  /** Unix epoch seconds when the window resets, per Claude's documented field. */
  resets_at?: number
}
interface RateLimitSnapshot {
  five_hour?: RateLimitWindow
  seven_day?: RateLimitWindow
}

/** Lowercase every header name (HTTP names are case-insensitive) and drop null
 * values, so a single lookup shape works regardless of how the provider cased
 * them. ProviderHeaders values are string | null. */
function normalizeHeaders(raw: Record<string, string | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') out[key.toLowerCase()] = value
  }
  return out
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** One rate-limit window from the `anthropic-ratelimit-<prefix>-*` header family,
 * taking a direct `-utilization` percentage when present, else computing it from
 * `-limit` and `-remaining`. resets_at comes from `-reset` when the header is set.
 * Header names vary, so only what is present is read and a bare number is enough. */
function readRateLimitWindow(headers: Record<string, string>, prefix: string): RateLimitWindow | undefined {
  const base = `anthropic-ratelimit-${prefix}`
  let usedPercentage = toNumber(headers[`${base}-utilization`])
  if (usedPercentage === undefined) {
    const limit = toNumber(headers[`${base}-limit`])
    const remaining = toNumber(headers[`${base}-remaining`])
    if (limit !== undefined && limit > 0 && remaining !== undefined) {
      usedPercentage = ((limit - remaining) / limit) * 100
    }
  }
  if (usedPercentage === undefined) return undefined
  // A provider can report a utilization above 100 (or a remaining above the limit, making
  // the computed value negative); clamp so the payload never carries a nonsense percentage.
  const window: RateLimitWindow = { used_percentage: Math.max(0, Math.min(100, usedPercentage)) }
  const resetsAt = headers[`${base}-reset`] ?? headers[`${base}-resets-at`]
  if (resetsAt) {
    // Claude documents resets_at as Unix epoch seconds; the header carries an ISO
    // timestamp (or, from some providers, a bare epoch number already).
    const epoch = /^\d+$/.test(resetsAt.trim()) ? Number(resetsAt.trim()) : Math.floor(Date.parse(resetsAt) / 1000)
    if (Number.isFinite(epoch)) window.resets_at = epoch
  }
  return window
}

/** The snapshot with expired windows dropped, so a window whose reset time has
 * passed never lingers in the payload; undefined when nothing remains. */
function liveRateLimits(snapshot: RateLimitSnapshot): RateLimitSnapshot | undefined {
  const nowSeconds = Date.now() / 1000
  const keep = (window?: RateLimitWindow): RateLimitWindow | undefined => (window && (window.resets_at === undefined || window.resets_at > nowSeconds) ? window : undefined)
  const fiveHour = keep(snapshot.five_hour)
  const sevenDay = keep(snapshot.seven_day)
  if (!fiveHour && !sevenDay) return undefined
  return { ...(fiveHour ? { five_hour: fiveHour } : {}), ...(sevenDay ? { seven_day: sevenDay } : {}) }
}

/** The five-hour and seven-day utilization windows Claude's statusline reports,
 * from the unified rate-limit response headers. Undefined when neither is present
 * so a response without them never clobbers an earlier snapshot. */
function parseRateLimits(headers: Record<string, string>): RateLimitSnapshot | undefined {
  const fiveHour = readRateLimitWindow(headers, 'unified-5h')
  const sevenDay = readRateLimitWindow(headers, 'unified-7d')
  if (!fiveHour && !sevenDay) return undefined
  const snapshot: RateLimitSnapshot = {}
  if (fiveHour) snapshot.five_hour = fiveHour
  if (sevenDay) snapshot.seven_day = sevenDay
  return snapshot
}

export interface StatusLineConfig {
  command: string
  padding: number
  refreshInterval: number | undefined
}

/** One settings `statusLine` entry parsed into a config, or undefined when it is
 * not Claude's `{type: "command", command, padding?, refreshInterval?}` shape;
 * refreshInterval has a documented minimum of 1. */
function parseStatusLineEntry(entry: unknown): StatusLineConfig | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as { type?: unknown; command?: unknown; padding?: unknown; refreshInterval?: unknown }
  if (typeof record.command !== 'string') return undefined
  if (record.type !== undefined && record.type !== 'command') return undefined
  return {
    command: record.command,
    padding: typeof record.padding === 'number' && record.padding > 0 ? record.padding : 0,
    refreshInterval: typeof record.refreshInterval === 'number' && record.refreshInterval >= 1 ? record.refreshInterval : undefined,
  }
}

/** The `statusLine` recorded in settings, last file winning; a managed policy
 * entry wins over every file, and allowManagedHooksOnly narrows the setting to
 * managed settings entirely, as Claude documents. */
export function readStatusLineConfig(files: string[], managed: Record<string, unknown> = readManagedSettings()): StatusLineConfig | undefined {
  const managedConfig = parseStatusLineEntry(managed.statusLine)
  if (managedConfig) return managedConfig
  if (managed.allowManagedHooksOnly === true) return undefined
  let found: StatusLineConfig | undefined
  for (const settings of readSettingsChain(files)) found = parseStatusLineEntry(settings.statusLine) ?? found
  return found
}

export default function statusLine(pi: ExtensionAPI) {
  let turnCount = 0
  let config: StatusLineConfig | undefined
  let sessionCtx: ExtensionContext | undefined
  let commandLine: string | undefined
  let permissionMode = 'default'
  let sessionStartMs = Date.now()
  // Running session cost; seeded and reseeded by sessionCost(), see below.
  let costTotal = 0
  // The output-style settings chain and active style name, resolved once at
  // session start: the chain's upward walk and per-file reads are too costly for
  // every refresh tick. /output-style persists a choice straight to settings with
  // no bus event, and the new style applies from the next turn anyway, so the
  // cached name is re-read lazily at most once per turn (styleDirty, turn_start).
  let styleFiles: string[] = []
  let styleName: string | undefined
  let styleDirty = false
  // Lines changed, counted from successful edit/write inputs: newText and content
  // lines add, oldText lines remove. An approximation of Claude's counters, which
  // is honest for the tools pi has; bash-side changes are invisible to both.
  let linesAdded = 0
  let linesRemoved = 0
  // API timing and the last message's token usage, from provider/message events:
  // the fields ctx.getContextUsage() does not expose (output/cache tokens, API time).
  let apiDurationMs = 0
  let requestStartMs: number | undefined
  let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined
  // The most recent rate-limit snapshot parsed from provider response headers, and
  // a once-per-session guard so a 429 warns the user only the first time it lands.
  let rateLimits: RateLimitSnapshot | undefined
  let rateLimitWarned = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  /** Kills the script currently in flight; Claude cancels it on a new trigger. */
  let killInflight: (() => void) | undefined
  /** Stops the settings watcher of the previous session. */
  let disposeSettingsWatch: () => void = () => {}
  let running = false
  let rerunQueued = false

  function segmentText(ctx: ExtensionContext, symbol: string): string {
    const theme = ctx.ui.theme
    const costText = costTotal > 0 ? theme.fg('muted', ` ${formatCost(costTotal)}`) : ''
    const turnText = turnCount > 0 ? theme.fg('dim', ` turn ${turnCount}`) : theme.fg('dim', ' ready')
    return symbol + turnText + costText
  }

  function show(ctx: ExtensionContext, builtIn: string): void {
    ctx.ui.setStatus('pi-code-status', commandLine ?? builtIn)
  }

  /** Whether cwd sits in a git worktree: `.git` is a file pointing at the main
   * checkout there, and a directory in an ordinary clone. */
  function isGitWorktree(cwd: string): boolean {
    const root = repoRoot(cwd)
    if (root === undefined) return false
    try {
      return fs.statSync(path.join(root, '.git')).isFile()
    } catch {
      return false
    }
  }

  /** The --add-dir directories, the flag pi-code registers for Claude's additional
   * working directories. Empty when none were given, which is the documented shape. */
  function addedDirs(): string[] {
    const raw = String(pi.getFlag?.('add-dir') ?? '')
    return raw
      .split(',')
      .map((dir) => dir.trim())
      .filter(Boolean)
  }

  /** The stdin payload per Claude's documented statusline contract. */
  function buildPayload(ctx: ExtensionContext): Record<string, unknown> {
    const usage = ctx.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null }
    const model = ctx.model as { id?: string; name?: string } | undefined
    // Refresh the cached style name only when a turn boundary may have changed it.
    if (styleDirty) {
      styleName = readActiveStyleName(styleFiles)
      styleDirty = false
    }
    const payload: Record<string, unknown> = {
      hook_event_name: 'Status',
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      version: PACKAGE_VERSION,
      // project_dir is the repository, not the directory the session started in: a
      // script labelling the project showed whichever subdirectory it was launched
      // from. git_worktree reports the .git file a worktree carries in place of a
      // directory. added_dirs comes from the --add-dir flag pi-code registers.
      workspace: {
        current_dir: ctx.cwd,
        project_dir: repoRoot(ctx.cwd) ?? ctx.cwd,
        git_worktree: isGitWorktree(ctx.cwd),
        added_dirs: addedDirs(),
      },
      // Both fields, per Claude's documented contract: published statusline scripts
      // read .model.display_name and render the literal "null" when it is missing.
      model: { id: model?.id ?? '', display_name: model?.name ?? model?.id ?? '' },
      cost: {
        total_cost_usd: costTotal,
        total_duration_ms: Date.now() - sessionStartMs,
        total_api_duration_ms: apiDurationMs,
        total_lines_added: linesAdded,
        total_lines_removed: linesRemoved,
      },
      context_window: {
        context_window_size: usage.contextWindow,
        used_percentage: usage.percent,
        remaining_percentage: usage.percent === null ? null : 100 - usage.percent,
        total_input_tokens: usage.tokens,
        // The per-component breakdown from the last message's usage, which
        // ctx.getContextUsage() (input-side estimate only) cannot provide.
        // Present before the first response too, as Claude sends them: a script
        // reading current_usage gets null rather than undefined.
        total_output_tokens: lastUsage?.output ?? 0,
        current_usage: lastUsage
          ? {
              input_tokens: lastUsage.input,
              output_tokens: lastUsage.output,
              cache_read_input_tokens: lastUsage.cacheRead,
              cache_creation_input_tokens: lastUsage.cacheWrite,
            }
          : null,
      },
      // The true combined total when a message usage is known, else the input-side estimate.
      exceeds_200k_tokens: (lastUsage?.totalTokens ?? usage.tokens ?? 0) > 200_000,
      permission_mode: permissionMode,
    }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) payload.transcript_path = transcript
    const sessionName = ctx.sessionManager.getSessionName?.()
    if (sessionName) payload.session_name = sessionName
    if (ctx.thinkingLevel) {
      // Thinking disabled says the rest, so off carries no effort field of its own.
      payload.thinking = { enabled: ctx.thinkingLevel !== 'off' }
      const effort = claudeEffortLevel(ctx.thinkingLevel)
      if (effort) payload.effort = { level: effort }
    }
    if (styleName) payload.output_style = { name: styleName }
    // The current utilization of the account's rate-limit windows, when the
    // provider reported them; omitted until a response has carried them, and an
    // expired window is dropped rather than left stale.
    if (rateLimits) {
      const live = liveRateLimits(rateLimits)
      if (live) payload.rate_limits = live
    }
    return payload
  }

  async function runCommand(ctx: ExtensionContext): Promise<void> {
    if (!config) return
    if (running) {
      // Claude cancels the in-flight script when a new update triggers; the
      // rerun below then runs the fresh one.
      killInflight?.()
      rerunQueued = true
      return
    }
    running = true
    try {
      // Everything below can touch ctx after an await, and every ctx getter throws
      // once the session is disposed. This promise is started from a timer with no
      // awaiter, so an escaping rejection becomes an uncaughtException and exits pi.
      const result = await runHookCommand(config.command, buildPayload(ctx), COMMAND_TIMEOUT_MS, undefined, undefined, (kill) => {
        killInflight = kill
      })
      // Claude: "Your script can output multiple lines to create a richer display."
      // pi has one row for every extension status and replaces newlines with spaces
      // before rendering it (footer.js sanitizeStatusText), so the rows are joined
      // here rather than dropped; taking only the first silently lost the rest.
      const rows = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
      const pad = ' '.repeat(config.padding)
      commandLine = rows ? `${pad}${rows}${pad}` : undefined
      show(ctx, segmentText(ctx, ctx.ui.theme.fg('dim', '○')))
    } catch {
      // A replaced or reloaded session invalidates ctx while the command is in
      // flight; there is nothing left to update, and the next session starts fresh.
    } finally {
      killInflight = undefined
      running = false
      if (rerunQueued) {
        rerunQueued = false
        void runCommand(ctx)
      }
    }
  }

  /** Claude re-runs the script when a rate-limit window in the last data reaches
   * its resets_at time, so an expired segment clears without another event. */
  function scheduleExpiryRefresh(snapshot: RateLimitSnapshot): void {
    clearTimeout(expiryTimer)
    const resets = [snapshot.five_hour?.resets_at, snapshot.seven_day?.resets_at].filter((value): value is number => typeof value === 'number')
    if (resets.length === 0) return
    const delayMs = Math.min(...resets) * 1000 - Date.now()
    if (delayMs <= 0) return
    expiryTimer = setTimeout(() => scheduleRefresh(), delayMs)
    expiryTimer.unref?.()
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

  // Counted here rather than in buildPayload so the numbers accumulate across the
  // session the way Claude's counters do.
  pi.on('tool_result', async (event) => {
    if (event.isError) return
    const input = event.input as Record<string, unknown>
    const lines = (text: unknown): number => (typeof text === 'string' && text.length > 0 ? text.split('\n').length : 0)
    if (event.toolName === 'write') linesAdded += lines(input.content)
    if (event.toolName === 'edit' && Array.isArray(input.edits)) {
      for (const edit of input.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
        linesAdded += lines(edit.newText)
        linesRemoved += lines(edit.oldText)
      }
    }
  })

  // API round-trip timing: the window between the request and its response, summed
  // across the session. ctx exposes no API-duration getter, so it is measured here.
  pi.on('before_provider_request', async () => {
    requestStartMs = Date.now()
  })
  pi.on('after_provider_response', async (event, ctx) => {
    if (requestStartMs !== undefined) apiDurationMs += Date.now() - requestStartMs
    requestStartMs = undefined
    // Rate-limit windows and 429 handling ride on the same response event. Header
    // names and presence vary, so parse only what is there and never throw.
    const headers = normalizeHeaders(event.headers)
    const snapshot = parseRateLimits(headers)
    if (snapshot) {
      rateLimits = snapshot
      scheduleExpiryRefresh(snapshot)
    }
    if (event.status === 429 && !rateLimitWarned) {
      rateLimitWarned = true
      const retryAfter = headers['retry-after']
      const detail = retryAfter ? `; retry after ${retryAfter}s` : ''
      try {
        ctx.ui.notify(`Provider rate limit reached (429)${detail}`, 'warning')
      } catch {
        // The session may be gone by the time a late response lands; nothing to warn.
      }
    }
  })
  // The last message's token usage, for the breakdown getContextUsage() omits,
  // and the running cost total, so renders never re-walk the branch.
  pi.on('message_end', async (event) => {
    const usage = (event as { message?: { usage?: NonNullable<typeof lastUsage> & { cost?: { total?: number } } } }).message?.usage
    if (!usage) return
    lastUsage = usage
    costTotal += usage.cost?.total ?? 0
    // Claude re-runs the status line after each assistant message.
    scheduleRefresh()
  })

  pi.on('session_start', async (_event, ctx) => {
    // One instance serves every session, so a fresh session must not inherit state.
    turnCount = 0
    commandLine = undefined
    sessionCtx = ctx
    sessionStartMs = Date.now()
    linesAdded = 0
    linesRemoved = 0
    apiDurationMs = 0
    requestStartMs = undefined
    lastUsage = undefined
    rateLimits = undefined
    rateLimitWarned = false
    clearInterval(refreshTimer)
    // Seed the running cost from the branch: a resumed or forked session starts
    // with history, and message_end only accumulates from here on.
    costTotal = sessionCost(ctx)
    // Reading config must never open a trust dialog: several extensions resolve
    // approval at session start, and a second prompt stacks over the first and eats
    // the keys meant for it. An undecided project simply skips project settings.
    const trusted = isProjectApprovedSilently(ctx)
    // Same gate for the style chain: an unapproved project's style is not applied,
    // so reporting it in the payload would describe a style the session is not using.
    styleFiles = settingsFiles(ctx.cwd, os.homedir(), trusted)
    styleName = readActiveStyleName(styleFiles)
    styleDirty = false
    const files = hookFiles(ctx.cwd, os.homedir(), trusted)
    // Claude's disableAllHooks also turns off the custom statusLine command; the
    // built-in segment still renders as the fallback.
    config = readDisableAllHooks(files) ? undefined : readStatusLineConfig(files)
    // Re-armed rather than armed once: a refreshInterval added or changed mid-session
    // had no effect until the next session, though Claude applies a settings change as
    // soon as the file is saved.
    const armRefresh = (): void => {
      clearInterval(refreshTimer)
      refreshTimer = config?.refreshInterval ? setInterval(() => scheduleRefresh(), config.refreshInterval * 1000) : undefined
    }
    armRefresh()
    // Claude re-runs the script when the statusLine settings change mid-session; a
    // command change re-resolves and re-runs.
    disposeSettingsWatch()
    disposeSettingsWatch = watchSettingsFiles(files, () => {
      const previousCommand = config?.command
      config = readDisableAllHooks(files) ? undefined : readStatusLineConfig(files)
      armRefresh()
      // The debounce batches rapid triggers, but a command the user just edited has
      // nothing to batch with: run it now so the result of the edit is immediate.
      if (config?.command !== previousCommand) void runCommand(ctx)
      else scheduleRefresh()
    })
    show(ctx, segmentText(ctx, ctx.ui.theme.fg('dim', '○')))
    scheduleRefresh()
  })

  pi.on('turn_start', async (_event, ctx) => {
    turnCount++
    // A /output-style between turns lands in settings silently; its style applies
    // from this turn, so this is the moment the cached name can go stale.
    styleDirty = true
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

  // The model and effort segments of the payload go stale between turns; a switch
  // fires these events, so refresh at once instead of waiting for the next tick.
  pi.on('model_select', async () => {
    scheduleRefresh()
  })
  pi.on('thinking_level_select', async () => {
    scheduleRefresh()
  })

  pi.on('session_compact', async (_event, ctx) => {
    // Compaction replaces the branch entries; reseed the total from what remains.
    costTotal = sessionCost(ctx)
    scheduleRefresh()
  })

  pi.on('session_tree', async (_event, ctx) => {
    // Tree navigation swaps the branch wholesale with no message_end events.
    costTotal = sessionCost(ctx)
  })

  pi.on('session_shutdown', async () => {
    clearInterval(refreshTimer)
    clearTimeout(debounceTimer)
  })
}
