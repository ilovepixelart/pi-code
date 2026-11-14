/**
 * Background shell commands: Bash commands Claude runs with `run_in_background`, or
 * moves to the background when a foreground command reaches its timeout (tools-reference,
 * "Background commands"). The bash extension starts and settles them; the subagent
 * extension's /tasks lists them next to background agent runs, since Claude's /tasks
 * shows "running shells and subagents" together.
 *
 * The registry lives in a shared slot: pi evaluates this module once per extension
 * entry and again on /reload, and a registry that died with one instance would leave a
 * still-running command unlisted, unstoppable, and alive past pi's exit.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { sharedSlot } from './shared-slot.ts'

export type ShellState = 'running' | 'completed' | 'failed' | 'killed'

export interface BackgroundShell {
  id: string
  command: string
  /** Every byte the command wrote to stdout and stderr, for the model to read. */
  outputFile: string
  state: ShellState
  exitCode?: number
  /** Ends the command's process tree; cleared once the command settles. */
  stop?: () => void
  /** Monotonic finish order, so eviction drops the earliest-finished commands. */
  finishedAt?: number
  /** False while a bash command is still in the foreground: it is registered from the
   * start so its output reaches the file, but it is not a background task until it moves,
   * so /tasks and the footer leave it out. */
  background: boolean
}

/** Finished commands kept for /tasks; older ones are evicted (their output files stay
 * on disk until pi quits, since a notification already pointed the model at them). */
export const MAX_FINISHED_SHELLS = 20

/** Characters of a command shown in a listing or notification. */
const COMMAND_PREVIEW_CHARS = 80

interface Registry {
  shells: Map<string, BackgroundShell>
  finishSequence: number
  /** Private per-process directory holding the output files, created on first use. */
  outputDir?: string
}

const slot = sharedSlot<Registry>('background-shells')
/** Called whenever the set of background commands changes, so the footer can follow it.
 * Shared like the registry: the instance of the current session registers it. */
const listenerSlot = sharedSlot<() => void>('background-shells.listener')

export function setShellsListener(listener: (() => void) | undefined): void {
  listenerSlot.set(listener)
}

function changed(): void {
  try {
    listenerSlot.get()?.()
  } catch {
    // A listener from a replaced session throws; the next session_start registers anew.
  }
}
const registry = (): Registry => {
  const existing = slot.get()
  if (existing) return existing
  const created: Registry = { shells: new Map(), finishSequence: 0 }
  slot.set(created)
  return created
}

/** A fresh private directory per process: a fixed name under a shared /tmp could be
 * created in advance by another user, who would then read every command's output. */
export function shellOutputDir(): string {
  const state = registry()
  if (state.outputDir && fs.existsSync(state.outputDir)) return state.outputDir
  state.outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-bash-'))
  return state.outputDir
}

export function registerShell(shell: Pick<BackgroundShell, 'id' | 'command' | 'outputFile' | 'stop'> & { background?: boolean }): BackgroundShell {
  const record: BackgroundShell = { ...shell, state: 'running', background: shell.background ?? true }
  registry().shells.set(record.id, record)
  if (record.background) changed()
  return record
}

/** A foreground command has moved to the background. */
export function markBackground(shell: BackgroundShell): void {
  shell.background = true
  changed()
}

/** Record how a command ended. A command stopped on request stays `killed`: its
 * non-zero exit is the stop, not a failure. */
export function settleShell(shell: BackgroundShell, exitCode: number | undefined): void {
  const state = registry()
  shell.stop = undefined
  if (shell.state === 'running') shell.state = exitCode === 0 ? 'completed' : 'failed'
  shell.exitCode = exitCode
  shell.finishedAt = ++state.finishSequence
  const finished = [...state.shells.values()].filter((entry) => entry.state !== 'running')
  finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  for (const stale of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_SHELLS))) state.shells.delete(stale.id)
  if (shell.background) changed()
}

/** Drop a command that finished in the foreground: it never became a background task. */
export function forgetShell(shell: BackgroundShell): void {
  registry().shells.delete(shell.id)
  fs.rmSync(shell.outputFile, { force: true })
}

export function stopShell(id: string): 'stopped' | 'not-running' | 'unknown' {
  const shell = registry().shells.get(id.trim())
  if (!shell) return 'unknown'
  if (shell.state !== 'running' || !shell.stop) return 'not-running'
  const stop = shell.stop
  shell.state = 'killed'
  shell.stop = undefined
  stop()
  if (shell.background) changed()
  return 'stopped'
}

/** Stop every running command and remove the output directory. Called when pi quits:
 * a detached command would otherwise outlive pi with nobody left to read its output. */
export function stopAllShells(): number {
  const state = registry()
  let count = 0
  for (const id of Array.from(state.shells.keys())) {
    if (stopShell(id) === 'stopped') count++
  }
  if (state.outputDir) fs.rmSync(state.outputDir, { recursive: true, force: true })
  state.outputDir = undefined
  return count
}

/** Background commands, live and finished; a command still in the foreground is not one. */
export function allShells(): BackgroundShell[] {
  return [...registry().shells.values()].filter((shell) => shell.background)
}

export function runningShells(): number {
  return allShells().filter((shell) => shell.state === 'running').length
}

/** The footer status: how many background commands are running, or undefined for none. */
export function shellsFooterText(running: number): string | undefined {
  if (running === 0) return undefined
  return `⏵ ${running} background shell${running === 1 ? '' : 's'}`
}

/** Test seam: the registry is process state, so tests reset it between cases. */
export function resetShells(): void {
  const state = registry()
  for (const id of Array.from(state.shells.keys())) stopShell(id)
  state.shells.clear()
  state.finishSequence = 0
  if (state.outputDir) fs.rmSync(state.outputDir, { recursive: true, force: true })
  state.outputDir = undefined
}

export function commandPreview(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > COMMAND_PREVIEW_CHARS ? `${chars.slice(0, COMMAND_PREVIEW_CHARS - 1).join('')}…` : flat
}

function stateLabel(shell: Pick<BackgroundShell, 'state' | 'exitCode'>): string {
  if (shell.state === 'running') return 'running'
  if (shell.state === 'killed') return 'stopped'
  return `${shell.state} (exit code ${shell.exitCode ?? '?'})`
}

/** The /tasks section for shells; empty when there are none, so /tasks can omit it. */
export function shellsStatusText(shells: ReadonlyArray<BackgroundShell>): string {
  if (shells.length === 0) return ''
  return shells.map((shell) => `${shell.id} shell: ${stateLabel(shell)} - ${commandPreview(shell.command)}\n  output: ${shell.outputFile}`).join('\n')
}

/** What the model is told when a background command finishes. */
export function shellCompletionText(shell: Pick<BackgroundShell, 'id' | 'command' | 'state' | 'exitCode' | 'outputFile'>): string {
  const how = shell.state === 'completed' ? 'completed (exit code 0)' : shell.state === 'killed' ? 'was stopped' : `failed (exit code ${shell.exitCode ?? '?'})`
  return `Background command ${shell.id} ("${commandPreview(shell.command)}") ${how}. Output: ${shell.outputFile}`
}
