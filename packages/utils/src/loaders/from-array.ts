/**
 * `sourceFromArray` — wraps an in-memory array as a `Loader<T>`.
 *
 * The trivial source. Useful for static records (initial seed,
 * test fixtures) and as the terminus of a `mapLoader` chain over
 * literal data.
 */

import type { Loader } from "./loader.js";

export function sourceFromArray<T>(items: readonly T[]): Loader<T> {
  return {
    load: () => Promise.resolve(items),
  };
}
