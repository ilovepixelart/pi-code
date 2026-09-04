/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 *
 * Honors Claude Code's `preferredNotifChannel` (user settings): `terminal_bell`
 * rings the bell, `notifications_disabled` stays silent, `iterm2_with_bell` does
 * both, anything else sends the desktop notification. Like Claude, a notification
 * fires only when you "appear to be away": pi exposes no terminal-focus signal, so
 * a turn is treated as away when it ran at least AWAY_AFTER_MS, or when no prompt
 * was submitted since session start.
 */

import { execFile } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { claudeConfigDir } from './internal/config-dir.js'
import { readSettingsFile } from './internal/settings-chain.js'

/** How a finished turn is announced, from Claude's `preferredNotifChannel`. */
export type NotifChannel = 'desktop' | 'bell' | 'both' | 'off'

/** Map Claude's `preferredNotifChannel` to what we emit. Unknown or unset means the
 * default desktop notification; `iterm2_with_bell` both notifies and rings. */
export function resolveNotifChannel(setting: unknown): NotifChannel {
  switch (typeof setting === 'string' ? setting : '') {
    case 'notifications_disabled':
      return 'off'
    case 'terminal_bell':
      return 'bell'
    case 'iterm2_with_bell':
      return 'both'
    default:
      return 'desktop'
  }
}

/** How long a turn must run before its end is worth a notification. Claude only
 * notifies when you "appear to be away"; pi exposes no terminal-focus signal, so a
 * turn that ran at least this long is the best available proxy for having stepped
 * away. A turn with no recorded start (none since session start) always notifies. */
export const AWAY_AFTER_MS = 30_000

export function isAway(lastInputAt: number | undefined, now: number, thresholdMs: number): boolean {
  if (lastInputAt === undefined) return true
  return now - lastInputAt >= thresholdMs
}

/** The `preferredNotifChannel` from the user's settings. This is a personal terminal
 * preference, so only user scope is read; a checked-out repo does not get to silence
 * or change your notifications. */
function readPreferredNotifChannel(home: string): unknown {
  return readSettingsFile(path.join(claudeConfigDir(home), 'settings.json'))?.preferredNotifChannel
}

function windowsToastScript(title: string, body: string): string {
  const type = 'Windows.UI.Notifications'
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`
  const template = `[${type}.ToastTemplateType]::ToastText01`
  const toast = `[${type}.ToastNotification]::new($xml)`
  return [`${mgr} > $null`, `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`, `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`, `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`].join('; ')
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`)
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`)
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`)
}

function notifyWindows(title: string, body: string): void {
  // Resolve powershell from a fixed system path rather than through PATH, and let the callback
  // capture a spawn failure instead of an unhandled 'error' event crashing the host.
  const root = process.env.SystemRoot ?? String.raw`C:\Windows`
  const powershell = String.raw`${root}\System32\WindowsPowerShell\v1.0\powershell.exe`
  execFile(powershell, ['-NoProfile', '-Command', windowsToastScript(title, body)], () => {})
}

function notifyDesktop(title: string, body: string): void {
  if (process.env.WT_SESSION) {
    notifyWindows(title, body)
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body)
  } else {
    notifyOSC777(title, body)
  }
}

export default function notifyExtension(pi: ExtensionAPI) {
  let channel: NotifChannel = 'desktop'
  // When the user last submitted a prompt, so a turn's duration can stand in for
  // Claude's "appear to be away" check. Undefined until the first prompt this session.
  let lastInputAt: number | undefined

  pi.on('session_start', async (_event, _ctx) => {
    channel = resolveNotifChannel(readPreferredNotifChannel(os.homedir()))
    lastInputAt = undefined
  })

  pi.on('input', async () => {
    lastInputAt = Date.now()
  })

  // Fires on agent_end rather than agent_settled deliberately: agent_settled is only
  // emitted after every agent_end handler returns, and a peer extension (plan mode)
  // blocks its agent_end handler on a UI dialog, which would starve this notification
  // exactly when the user has stepped away. agent_end can fire slightly early before a
  // rare automatic retry or compaction, which is a better failure than never notifying.
  pi.on('agent_end', async () => {
    if (channel === 'off') return
    // Piped or headless stdout (pi -p, CI) must not receive raw escape bytes.
    if (!process.stdout.isTTY) return
    if (!isAway(lastInputAt, Date.now(), AWAY_AFTER_MS)) return
    if (channel === 'bell') {
      process.stdout.write('\x07')
      return
    }
    notifyDesktop('Pi', 'Ready for input')
    if (channel === 'both') process.stdout.write('\x07')
  })
}
