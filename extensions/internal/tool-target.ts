/**
 * Which file a tool call touched.
 *
 * Two extensions attach instruction files when a file tool touches a path they cover
 * (claude-rules for a path-scoped rule, context-imports for a nested CLAUDE.md), and
 * both got the same detail wrong: pi's edit and write tools accept `file_path` as an
 * alias for `path`, so a handler reading only `path` did nothing for a model that used
 * the alias. One reader, one place to be wrong.
 */

/** The tools that name a file pi-code acts on. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write'])

/** The path a file tool call named, or undefined for any other tool, an errored call,
 * or a call that named none. The path is as the tool gave it: callers resolve it
 * against their own cwd. */
export function fileToolTarget(event: { toolName: string; input?: unknown; isError?: boolean }): string | undefined {
  if (event.isError === true) return undefined
  if (!FILE_TOOLS.has(event.toolName)) return undefined
  const input = event.input as { path?: unknown; file_path?: unknown } | undefined
  const target = typeof input?.path === 'string' ? input.path : input?.file_path
  return typeof target === 'string' && target.length > 0 ? target : undefined
}
