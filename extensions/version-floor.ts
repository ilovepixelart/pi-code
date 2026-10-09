/**
 * pi Version Floor Extension
 *
 * Warns when the running pi is older than the floor in internal/pi-floor.ts. On such a pi
 * pi-code loads without an error and parts of it silently do nothing; this turns that
 * silence into one warning on the first session start.
 */

import { type ExtensionAPI, VERSION } from '@earendil-works/pi-coding-agent'

import { floorNotice } from './internal/pi-floor.ts'

export function registerFloorCheck(pi: ExtensionAPI, version: string): void {
  // pi cannot change version mid-run, so one notice says everything a repeat would.
  let warned = false
  pi.on('session_start', (_event, ctx) => {
    const notice = floorNotice(version)
    if (warned || notice === undefined) return
    warned = true
    ctx.ui.notify(notice, 'warning')
  })
}

export default function versionFloorExtension(pi: ExtensionAPI) {
  registerFloorCheck(pi, VERSION)
}
