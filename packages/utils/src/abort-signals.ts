/**
 * `mergeAbortSignals` — combine several `AbortSignal`s into one that
 * aborts the instant ANY input aborts, propagating the first abort's
 * `reason`.
 *
 * The canonical home for the abort-signal merge the framework threads
 * through its cancellation edges. Previously duplicated privately inside
 * `@agentick/loop-executor`; lifted here so the loop executor, the
 * session harness (app-signal cascade), and any future consumer share
 * one implementation.
 *
 * Semantics:
 *   - No live inputs → `undefined` (nothing to abort on).
 *   - Exactly one live input → returned as-is (no wrapper, no listener).
 *   - An already-aborted input short-circuits: it is returned directly so
 *     callers can branch on `.aborted` without waiting a microtask.
 *   - Otherwise a fresh linked signal fires on the first source abort and
 *     copies that source's `reason`.
 *
 * `undefined` inputs are ignored, so callers can pass optional signals
 * (`mergeAbortSignals(appSignal, sendInput.signal)`) without pre-filtering.
 */
export function mergeAbortSignals(
  ...signals: ReadonlyArray<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  // If any source is already aborted, hand it back directly — the caller
  // sees `.aborted === true` synchronously (matches the prior loop-executor
  // fast path) and no listeners leak.
  const already = present.find((s) => s.aborted);
  if (already !== undefined) return already;
  const ctrl = new AbortController();
  for (const source of present) {
    source.addEventListener(
      "abort",
      () => {
        ctrl.abort(source.reason);
      },
      { once: true },
    );
  }
  return ctrl.signal;
}
