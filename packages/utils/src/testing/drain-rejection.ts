/**
 * TEST USE ONLY.
 *
 * Eagerly attach a no-op catch handler to a Promise so its rejection
 * is observed synchronously (before any other microtask gets a chance
 * to run), preventing vitest's `unhandled-rejection` warning when the
 * test body awaits a different Promise that races with this one.
 *
 * Returns a Promise that resolves to:
 *  - the Promise's value if it resolves, or
 *  - the rejection reason if it rejects.
 *
 * Use at the **point of construction**, immediately after the underlying
 * call that returns the Promise — not later, after other awaits have
 * had a chance to interleave. That's what makes the drain "pre-": the
 * handler is attached in the same synchronous turn as the Promise's
 * birth, so the rejection is always observed.
 *
 * Typical shapes this replaces:
 *
 *   // Before: catch the reason explicitly
 *   const drained = handle.result.catch((e: unknown) => e);
 *
 *   // After:
 *   const drained = drainRejection(handle.result);
 *
 *   // Before: drain and discard
 *   await handle.result.catch(() => undefined);
 *
 *   // After:
 *   await drainRejection(handle.result);
 *
 * **Not for production code.** Production fire-and-forget sites
 * (`Effect.runPromise(...).catch(() => undefined)` in long-lived
 * harnesses, bus emit drains in transports) have intentionally
 * different semantics — they swallow the rejection on purpose and
 * never await it. Don't replace those with this helper; the name
 * signals test-only intent at the call site.
 *
 * @param p - any Promise whose rejection should be observed eagerly
 * @returns a Promise that resolves to the value or the rejection reason
 */
export function drainRejection<T>(p: Promise<T>): Promise<T | unknown> {
  return p.catch((reason: unknown) => reason);
}
