/**
 * Claude's `--settings` and `--setting-sources` CLI flags (docs/specs/settings-flags.md).
 *
 * This extension owns the two flags: pi answers `getFlag` only for the extension that
 * registered a flag, so the values are resolved here and shared with every consumer of
 * the settings chain through internal/cli-settings. pi parses flag values after every
 * extension has loaded, so the reader resolves lazily and re-resolves when the raw
 * values change; a read at load time sees no flags, as documented in the spec.
 *
 * A refused value is reported the way Claude does ("Settings file not found: ...",
 * "Invalid setting source: ...") and the session ends: Claude exits 1 rather than run
 * with settings the caller did not ask for. Interactively that is pi's own shutdown;
 * headless, where pi binds no shutdown handler (pi dist/modes/print-mode), the process
 * exits 1 itself.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type CliSettings, resolveCliSettings, setCliSettingsReader } from './internal/cli-settings.js'

export default function settingsFlagsExtension(pi: ExtensionAPI) {
  // Optional-called so the extension still wires under stub hosts without flags.
  pi.registerFlag?.('settings', {
    description: 'Claude settings: a JSON file or inline JSON applied above user, project and local settings for this session',
    type: 'string',
  })
  pi.registerFlag?.('setting-sources', {
    description: 'Claude settings sources to load, comma-separated: user, project, local',
    type: 'string',
  })

  let resolved: CliSettings | undefined
  let resolvedFor: string | undefined
  const rawFlags = (): { settings?: unknown; settingSources?: unknown } => {
    // After a session replacement this instance's pi is stale and every call throws;
    // the last answer stands until the fresh instance registers its own reader.
    try {
      return { settings: pi.getFlag?.('settings'), settingSources: pi.getFlag?.('setting-sources') }
    } catch {
      return {}
    }
  }
  const read = (): CliSettings => {
    const flags = rawFlags()
    const key = JSON.stringify([flags.settings, flags.settingSources])
    if (resolved === undefined || resolvedFor !== key) {
      resolved = resolveCliSettings(flags, process.cwd())
      resolvedFor = key
    }
    return resolved
  }
  setCliSettingsReader(read)

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    const { errors } = read()
    if (errors.length === 0) return
    for (const error of errors) {
      console.error(`pi-code: ${error}`)
      ctx.ui.notify(error, 'error')
    }
    if (ctx.hasUI) ctx.shutdown()
    else process.exit(1)
  })
}
