/**
 * pi-ai's StringEnum typed for TypeBox. From pi 1.5 its published types return a pi-schema
 * Schema, whose value TypeBox's Static reads as unknown. The emitted schema is unchanged.
 */

import { StringEnum } from '@earendil-works/pi-ai'
import { type TUnsafe, Type } from 'typebox'

export function stringEnum<const T extends readonly string[]>(values: T, options?: { description?: string }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>(StringEnum(values, options))
}
