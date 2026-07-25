/**
 * Bounded-concurrency map. Runs `fn` against each item with at most
 * `concurrency` in flight at once; preserves input order in the
 * returned array. Each result lands in `results[i]` regardless of
 * completion order.
 *
 *   concurrency = 1   sequential (waits for each result before next)
 *   concurrency = ∞   equivalent to `Promise.all(items.map(fn))`
 *
 * If `fn` rejects for any item, the whole call rejects with the
 * first error — in-flight work still completes (no cancellation
 * primitive here; pass an AbortSignal through your `fn` if you need
 * cancellation). The rejection is the FIRST observed, not necessarily
 * the LEFTMOST index — adopters who need leftmost should sort their
 * input or wrap with their own error-collection layer.
 *
 * Empty input → `[]`. `concurrency <= 0` is clamped to 1.
 */
export async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const inFlight: Array<Promise<void>> = [];

  const start = (i: number): Promise<void> =>
    fn(items[i]!, i).then((r) => {
      results[i] = r;
    });

  while (nextIndex < items.length && inFlight.length < limit) {
    const i = nextIndex++;
    const p = start(i);
    inFlight.push(p);
    // Self-pruning: when this promise settles, remove it from
    // `inFlight` so the loop below can detect open slots. The
    // trailing `.catch(noop)` is critical — `.finally(...)` returns
    // a NEW promise that re-raises if `p` rejected; without a tail
    // handler we'd get a phantom unhandled-rejection log even though
    // `p` itself is observed by the await/race below.
    p.finally(() => {
      const idx = inFlight.indexOf(p);
      if (idx !== -1) inFlight.splice(idx, 1);
    }).catch(() => undefined);
  }

  while (nextIndex < items.length) {
    // Wait for ANY in-flight to settle, then queue the next item.
    await Promise.race(inFlight);
    if (inFlight.length < limit && nextIndex < items.length) {
      const i = nextIndex++;
      const p = start(i);
      inFlight.push(p);
      void p.finally(() => {
        const idx = inFlight.indexOf(p);
        if (idx !== -1) inFlight.splice(idx, 1);
      });
    }
  }

  // Drain remaining in-flight.
  await Promise.all(inFlight);
  return results;
}
