/**
 * Whether a project may load `@imports` that resolve outside it.
 *
 * Claude Code asks once per project, listing the external files, and remembers the
 * answer: "The first time Claude Code encounters external imports in a project, it
 * shows an approval dialog listing the files. If you decline, the imports stay
 * disabled and the dialog doesn't appear again."
 *
 * The answer lives beside pi's own trust store rather than in the repository, so a
 * clone cannot ship its own approval, and it is keyed on the project root so every
 * subdirectory session and worktree of one repository shares the decision.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getAgentDir } from '@earendil-works/pi-coding-agent'

import { atomicWriteFile } from './atomic-write.js'
import { isRecord } from './values.js'

/** The store file. A seam: the tests point it at a temp directory. */
export function externalImportStorePath(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, 'pi-code-external-imports.json')
}

function readStore(storePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    // No store yet, or one a hand-edit left unparseable: no decision recorded.
    return {}
  }
}

/** The recorded answer for `root`, or null when the project has never been asked.
 * Only a boolean counts: anything else in the file reads as unasked, so a corrupt
 * entry re-asks rather than silently allowing or silently refusing forever. */
export function externalImportDecision(root: string, storePath: string = externalImportStorePath()): boolean | null {
  const value = readStore(storePath)[root]
  return typeof value === 'boolean' ? value : null
}

/** Record the answer for `root`, keeping every other project's. */
export function rememberExternalImportDecision(root: string, allowed: boolean, storePath: string = externalImportStorePath()): void {
  const store = readStore(storePath)
  store[root] = allowed
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    atomicWriteFile(storePath, `${JSON.stringify(store, null, 2)}\n`)
  } catch {
    // An unwritable agent directory costs the memory of the answer, not the session:
    // the next start asks again, which is the safe direction.
  }
}
