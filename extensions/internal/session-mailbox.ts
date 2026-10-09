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
 * A delivery is told whether it may start a turn. pi 1.1.0 sends a turn that an extension
 * starts before the session's first prompt with no system prompt, and every later request
 * in that session goes without one too (measured with a bare extension, no pi-code). Until
 * the session has had a turn, a delivery is recorded for the next prompt instead.
 *
 * State lives in a shared slot, so the mailbox survives /reload re-evaluating this module
 * and reaches across the module graphs pi loads each extension entry through.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { sharedSlot } from './shared-slot.ts'

/** Delivers on `pi`; `startsTurn` is false until the current session has had a turn. */
export type Delivery = (pi: ExtensionAPI, startsTurn: boolean) => void

interface Box {
  current: ExtensionAPI | undefined
  /** Whether the current session has had a turn, so a delivery may start one. */
  prompted: boolean
  pending: Delivery[]
}

/** Whether a session already holds messages: a resumed or forked one has had turns. */
export function sessionHasTurns(ctx: { sessionManager: { getBranch: () => Array<{ type: string }> } }): boolean {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === 'message')
}

export interface SessionMailbox {
  /** The session's instance takes delivery; anything held meanwhile is delivered now. */
  attach: (pi: ExtensionAPI, prompted: boolean) => void
  /** The current session has started a turn; later deliveries may start their own. */
  markPrompted: (pi: ExtensionAPI) => void
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
    const created: Box = { current: undefined, prompted: false, pending: [] }
    slot.set(created)
    return created
  }
  return {
    attach(pi, prompted) {
      const state = box()
      state.current = pi
      state.prompted = prompted
      for (const delivery of state.pending.splice(0)) {
        try {
          delivery(pi, prompted)
        } catch {
          // One failing delivery must not keep the rest from the session.
        }
      }
    },
    markPrompted(pi) {
      const state = box()
      if (state.current === pi) state.prompted = true
    },
    detach(pi) {
      const state = box()
      if (state.current === pi) state.current = undefined
    },
    deliver(delivery) {
      const state = box()
      if (state.current) delivery(state.current, state.prompted)
      else state.pending.push(delivery)
    },
  }
}
