/**
 * Which file a tool call touched.
 *
 * pi's read, edit and write tools accept `file_path` as an alias for `path`, so every
 * reader of a file tool's target must accept both, and a handler reading only `path`
 * does nothing for a model that used the alias. This is the one reader (claude-rules,
 * context-imports and the command path-scope guard all go through it).
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
