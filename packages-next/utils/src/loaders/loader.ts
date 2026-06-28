/**
 * `Loader<T>` — minimal contract for "produce a collection of T".
 *
 * Loaders are deliberately tiny: `load()` resolves with the full record
 * batch. Sources that stream (huge directories, paginated URLs) can
 * still implement `load()` by awaiting their internal iteration —
 * streaming is a v2 concern, not part of the primitive.
 *
 * Loaders compose:
 *  - {@link mergeLoaders} concatenates the outputs of N loaders
 *  - {@link mapLoader} transforms each record (raw bytes → typed record)
 *
 * Each harness package builds its own public `fromX` surface ON TOP OF
 * these primitives. The set of sources that's sound for a record type
 * depends on whether the record carries unserializable code (functions,
 * class instances) — that constraint is harness-specific, so `utils-next`
 * intentionally does not ship a unified `from*` API.
 */

export interface Loader<T> {
  readonly load: () => Promise<readonly T[]>;
}

/**
 * Concatenate the outputs of multiple loaders into one. Loaders execute
 * concurrently; ordering follows the input array (NOT load-completion
 * order). Throws if any underlying `load()` rejects — there is no
 * partial-success semantic. Wrap individual loaders if you need
 * per-source error isolation.
 */
export function mergeLoaders<T>(...loaders: readonly Loader<T>[]): Loader<T> {
  return {
    load: async () => {
      const batches = await Promise.all(loaders.map((l) => l.load()));
      return batches.flat();
    },
  };
}

/**
 * Transform every record yielded by a loader. The mapper runs lazily
 * (only when `load()` is called) and can be async. Use for the
 * raw-bytes → typed-record stage of a pipeline.
 *
 * The mapper may yield `null` / `undefined` to discard a record (e.g.,
 * skipping files that fail to parse) — the resulting loader collapses
 * those out.
 */
export function mapLoader<A, B>(
  loader: Loader<A>,
  fn: (input: A, index: number) => B | null | undefined | Promise<B | null | undefined>,
): Loader<B> {
  return {
    load: async () => {
      const inputs = await loader.load();
      const mapped = await Promise.all(inputs.map((input, i) => fn(input, i)));
      return mapped.filter((v) => v != null) as readonly B[];
    },
  };
}
