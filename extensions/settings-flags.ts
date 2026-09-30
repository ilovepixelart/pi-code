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
 * with settings the caller did not ask for. In a terminal session that is pi's own
 * shutdown, which restores the terminal. Elsewhere the process exits 1 itself: print
 * mode binds no shutdown handler (pi dist/modes/print-mode), and rpc mode only marks
 * the session to end after the first turn settles (pi dist/modes/rpc-mode).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type CliSettings, resolveCliSettingsOnce, setCliSettingsReader } from './internal/cli-settings.js'

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

  let last: CliSettings | undefined
  const read = (): CliSettings => {
    let flags: { settings?: unknown; settingSources?: unknown }
    try {
      flags = { settings: pi.getFlag?.('settings'), settingSources: pi.getFlag?.('setting-sources') }
    } catch {
      // After a session replacement this instance's pi is stale and every call throws;
      // the last answer stands until the fresh instance registers its own reader.
      return last ?? resolveCliSettingsOnce({}, process.cwd())
    }
    last = resolveCliSettingsOnce(flags, process.cwd())
    return last
  }
  setCliSettingsReader(read)

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    const { errors } = read()
    if (errors.length === 0) return
    for (const error of errors) ctx.ui.notify(error, 'error')
    // The session ends once the report has flushed: piped stderr is asynchronous on
    // some platforms, and an exit right after the write can lose the message.
    const terminal = ctx.hasUI && process.stdout.isTTY === true
    const end = terminal ? () => ctx.shutdown() : () => process.exit(1)
    const report = errors.map((error) => `pi-code: ${error}`).join('\n')
    process.stderr.write(`${report}\n`, end)
  })
}
