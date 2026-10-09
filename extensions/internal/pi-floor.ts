/**
 * The oldest pi that pi-code supports, and the check against the running pi.
 *
 * 0.80.5 is the first published pi with `agent_settled` (0.80.4 added it but was never
 * published). Several extensions rely on it unconditionally, and on an older pi it never
 * fires, so the work it gates never happens with nothing said. Registering a handler for
 * an event that never fires cannot be feature-detected, and pi installs packages with peer
 * resolution disabled, so no peerDependencies range enforces this either: the version pi
 * reports is the only thing to check.
 */
export const PI_FLOOR = '0.80.5'

const parse = (version: string): number[] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** The warning for a pi older than PI_FLOOR, or undefined when it is not. pi reports
 * "0.0.0" when it cannot read its own package.json; that, like any version without a
 * leading x.y.z, is unknown rather than old, and stays silent. */
export function floorNotice(version: string): string | undefined {
  const running = parse(version)
  if (!running || running.every((part) => part === 0)) return undefined
  const floor = parse(PI_FLOOR) as number[]
  const index = running.findIndex((part, i) => part !== floor[i])
  if (index === -1 || running[index] > floor[index]) return undefined
  return `pi-code requires pi >= ${PI_FLOOR}; this is pi ${version}. agent_settled never fires on it, so command tool restrictions, ultrathink escalation and the ready notification are never lifted or sent`
}
