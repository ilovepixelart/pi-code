import { sharedSlot } from './shared-slot.ts'

/** Discovery runs on every roster build, session start, input and tool call, and a
 * rejected file is rejected again each time. Each distinct warning is emitted once per
 * process so it informs without flooding the terminal. The set lives in a shared slot
 * because pi loads a fresh module instance for every session and /reload. */
const warnedSlot = sharedSlot<Set<string>>('warned-once')
export function warnOnce(message: string, emit: (message: string) => void = console.warn): void {
  let warned = warnedSlot.get()
  if (!warned) {
    warned = new Set()
    warnedSlot.set(warned)
  }
  if (warned.has(message)) return
  warned.add(message)
  emit(message)
}
