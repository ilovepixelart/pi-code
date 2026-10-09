/**
 * Delivery for background work that can outlive the session that started it.
 *
 * pi runs a fresh extension instance per session and invalidates the old one on /new,
 * /resume, /fork and /reload: every call on its `pi` throws from then on. A background
 * subagent run or forked skill finishing after that would have nowhere to report, so its
 * result goes through a mailbox instead: the instance attached at session_start receives
 * it, and one finishing while no session is attached waits for the next session_start.
 * Each delivery runs exactly once, on whichever `pi` is current when it runs.
 *
 * State lives in a shared slot, so the mailbox survives /reload re-evaluating this module
 * and reaches across the module graphs pi loads each extension entry through.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { sharedSlot } from './shared-slot.ts'

export type Delivery = (pi: ExtensionAPI) => void

interface Box {
  current: ExtensionAPI | undefined
  pending: Delivery[]
}

export interface SessionMailbox {
  /** The session's instance takes delivery; anything held meanwhile is delivered now. */
  attach: (pi: ExtensionAPI) => void
  /** The instance's session is ending; later deliveries wait for the next attach. */
  detach: (pi: ExtensionAPI) => void
  /** Run now on the current instance, or hold until one attaches. */
  deliver: (delivery: Delivery) => void
}

export function sessionMailbox(name: string): SessionMailbox {
  const slot = sharedSlot<Box>(`session-mailbox.${name}`)
  const box = (): Box => {
    const existing = slot.get()
    if (existing) return existing
    const created: Box = { current: undefined, pending: [] }
    slot.set(created)
    return created
  }
  return {
    attach(pi) {
      const state = box()
      state.current = pi
      for (const delivery of state.pending.splice(0)) {
        try {
          delivery(pi)
        } catch {
          // One failing delivery must not keep the rest from the session.
        }
      }
    },
    detach(pi) {
      const state = box()
      if (state.current === pi) state.current = undefined
    },
    deliver(delivery) {
      const state = box()
      if (state.current) delivery(state.current)
      else state.pending.push(delivery)
    },
  }
}
