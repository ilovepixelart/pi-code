/**
 * A process-wide slot for a function one extension registers and another calls.
 *
 * pi loads every extension entry through its own module graph, so a module-level `let`
 * in a file two extensions import is a separate variable in each: the setter and the
 * caller never meet, and the seam reads as "nothing registered" for the life of the
 * process. `globalThis` is the one object the graphs share, and a registered symbol
 * resolves to the same key from every copy of this module. pi's event bus carries the
 * cross-extension data (see mcp-alias); a slot is for a call that returns a result.
 *
 * Each session replacement loads fresh extension instances, which register again and
 * replace the previous instance's function.
 */
export function sharedSlot<T>(name: string): { get: () => T | undefined; set: (value: T | undefined) => void } {
  const key = Symbol.for(`pi-code.${name}`)
  const holder = globalThis as Record<symbol, unknown>
  return {
    get: () => holder[key] as T | undefined,
    set: (value) => {
      holder[key] = value
    },
  }
}
