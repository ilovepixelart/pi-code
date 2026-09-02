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

export function resolveModelOverride<M>(ctx: ModelLookupContext<M>, override: string | undefined): M | undefined {
  if (!override) return ctx.model
  const available = ctx.modelRegistry?.getAvailable?.() ?? []
  const needle = override.toLowerCase()
  const match = available.find((model) => model.id.toLowerCase() === needle) ?? available.find((model) => model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle))
  return (match as M | undefined) ?? ctx.model
}
