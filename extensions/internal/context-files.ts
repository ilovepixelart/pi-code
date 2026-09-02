/**
 * The context-file names pi looks for, in its own lookup order.
 *
 * Mirrors pi's resource loader: it takes the first of these that exists in a
 * directory and ignores the rest, so a repository holding both AGENTS.md and
 * CLAUDE.md loads only the first. Anything reasoning about what pi loaded, or about
 * what it passed over, has to use the same list in the same order.
 */

/** pi's per-directory candidates, first hit wins. */
export const CONTEXT_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

/** The candidates pi prefers over CLAUDE.md in the same directory. */
export const AGENTS_FILE_NAMES: ReadonlySet<string> = new Set(['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD'])
