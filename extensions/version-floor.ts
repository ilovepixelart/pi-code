/**
 * pi Version Floor Extension
 *
 * Warns when the running pi is older than the floor in internal/pi-floor.ts. On such a pi
 * pi-code loads without an error and parts of it silently do nothing; this turns that
 * silence into one warning on the first session start.
 */

import { type ExtensionAPI, VERSION } from '@earendil-works/pi-coding-agent'

import { floorNotice } from './internal/pi-floor.ts'
import { sharedSlot } from './internal/shared-slot.ts'

// pi loads a fresh instance of this extension for every session (/new, /resume, /fork,
// /reload), so a flag in the closure would warn again in each one. pi cannot change
// version mid-run, so one notice per process says everything a repeat would.
const warned = sharedSlot<boolean>('version-floor.warned')

export function registerFloorCheck(pi: ExtensionAPI, version: string): void {
  pi.on('session_start', (_event, ctx) => {
    const notice = floorNotice(version)
    if (warned.get() || notice === undefined) return
    warned.set(true)
    ctx.ui.notify(notice, 'warning')
  })
}

export default function versionFloorExtension(pi: ExtensionAPI) {
  registerFloorCheck(pi, VERSION)
}
