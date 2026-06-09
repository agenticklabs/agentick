/**
 * Shared substrate-slot resolver for harnesses using ADR 31's
 * instance | factory pattern.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §The slot pattern
 */

/**
 * Resolve an `instance | factory | undefined` slot to a concrete
 * instance. Factory discrimination is `typeof slot === "function"` —
 * substrate primitives are object-shaped, so any function is a factory.
 *
 * The `parent` argument is passed explicitly so the resolver makes the
 * parent-child relationship visible at the call site, rather than
 * implicitly via `this`.
 *
 * **Sync-only contract.** Construction phases on harnesses that pass
 * substrate through `super()` need synchronous resolution; calling
 * `super(...)` can't await an async factory. Factories that return a
 * Promise throw with a helpful error pointing adopters at instances
 * or at session-level slots (where async resolution is supported
 * once createSession itself is async).
 */
export function resolveSyncSubstrateSlot<R, P, F extends (parent: P) => unknown>(
  slot: R | F | undefined,
  parent: P,
  defaultFn: () => R,
  slotName: string,
): R {
  if (slot === undefined) return defaultFn();
  if (typeof slot === "function") {
    const result = (slot as F)(parent);
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new Error(
        `'${slotName}' factory returned a Promise — substrate factories ` +
          `at this slot must be synchronous. Use a pre-constructed ` +
          `instance, or move async construction to a slot that supports ` +
          `async resolution.`,
      );
    }
    return result as R;
  }
  return slot;
}
