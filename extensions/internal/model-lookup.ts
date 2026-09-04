/**
 * A model named by an override (a prompt hook's `model`, /goal's evaluator model),
 * resolved against the models this user can run: exact id first, then a substring
 * of the id or display name. The session model stands in when nothing matches or no
 * override was given, so a misspelled override degrades to the default rather than
 * silently disabling the feature.
 */

export interface ModelLookupContext<M> {
  model: M | undefined
  modelRegistry?: { getAvailable?: () => ReadonlyArray<{ id: string; name?: string }> }
}

/** The one fuzzy model rule every surface shares (goal, prompt hooks, commands,
 * subagent aliases): an exact id (case-insensitive) first, then a substring of the
 * id or the display name. Three private copies had diverged, so `model: opus` could
 * resolve differently per surface. */
export function findModel<M extends { id: string; name?: string }>(needle: string, available: ReadonlyArray<M>): M | undefined {
  const wanted = needle.toLowerCase()
  return available.find((model) => model.id.toLowerCase() === wanted) ?? available.find((model) => model.id.toLowerCase().includes(wanted) || model.name?.toLowerCase().includes(wanted))
}

export function resolveModelOverride<M>(ctx: ModelLookupContext<M>, override: string | undefined): M | undefined {
  if (!override) return ctx.model
  const available = ctx.modelRegistry?.getAvailable?.() ?? []
  return (findModel(override, available) as M | undefined) ?? ctx.model
}
