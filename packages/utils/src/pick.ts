import { type OmitUndefined } from "./omit-undefined.js";

/**
 * `pick` — copy the named keys, dropping any whose value is `undefined`.
 *
 * The pass-through half of {@link omitUndefined}: where that takes an object
 * you built, this takes the object you were handed and the keys to forward,
 * so the spread-pattern tax reads as one line:
 *
 *   ...pick(input, ["connectionId", "clientId"])
 *
 * Same semantics as `omitUndefined` — only literal `undefined` is dropped,
 * shallow, never mutates, fresh object. A key absent from `obj` is absent
 * from the result.
 */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): OmitUndefined<Pick<T, K>> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined) result[key as string] = value;
  }
  return result as OmitUndefined<Pick<T, K>>;
}
