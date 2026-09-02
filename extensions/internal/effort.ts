/**
 * pi's thinking levels translated to Claude's effort vocabulary, which is
 * `low | medium | high | xhigh | max`. pi adds two levels outside it: `minimal`, which
 * reads as Claude's lowest, and `off`, which has no effort at all. Every surface that
 * exposes the level to a script or a hook goes through here, so `off` and `minimal`
 * never leak into a payload or an environment variable that promises Claude's set.
 */

/** The Claude effort level for a pi thinking level, or undefined when thinking is off. */
export function claudeEffortLevel(thinkingLevel: string | undefined): string | undefined {
  if (!thinkingLevel || thinkingLevel === 'off') return undefined
  return thinkingLevel === 'minimal' ? 'low' : thinkingLevel
}
