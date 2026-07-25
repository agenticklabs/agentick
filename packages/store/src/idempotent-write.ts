/**
 * `IdempotentCollectionStore` — a decorator that dedups retried writes on
 * {@link StoreCtx.opId} (E16, Run B).
 *
 * ## The point it demonstrates
 *
 * `ctx.opId` is the operation's identity — the SAME op retried (a redelivered
 * inbox message, a client resend, a crash-recovery replay) carries the SAME
 * `opId`. A durable / derived store that must apply an effect EXACTLY ONCE keys
 * on it: the first write for an `opId` passes through; a second write for the
 * same `opId` short-circuits. `opId` is the natural idempotency key because the
 * substrate already stamps it (the journal dedups its own envelopes on
 * `(opId, phase)` the same way — see `MemoryJournal.appendSync`).
 *
 * ## Scope — a focused demonstration, not a sweep
 *
 * The bundled in-memory defaults ({@link MemoryCollection}) do NOT dedup: they
 * are in-process, single-writer, last-write-wins — a repeated in-process `put`
 * is harmless (it re-sets the same cell). Idempotency earns its keep at the
 * DURABLE / cross-process edge, where a retry is a genuine second delivery. This
 * decorator is where a store that needs it opts in; it is deliberately small.
 *
 * A write whose `ctx.opId` is `undefined` (outside any op scope) is NEVER
 * deduped — there is no key to dedup on, and such writes are direct host calls
 * the caller is responsible for. Dedup is keyed by `opId` alone (one op = one
 * effect, E16); a single op that both puts and deletes is out of scope for this
 * reference (document it, don't over-engineer it).
 *
 * @see docs/proposals/v2/data-layer-plan.md §E16
 * @see StoreCtx.opId
 * @verifiedBy packages/store/src/__tests__/idempotent-write.spec.ts
 */

import type { CollectionMutation, CollectionStore, StoreCtx } from "@agentick/spec";

export class IdempotentCollectionStore<T, Q, PruneArg = never> implements CollectionStore<
  T,
  Q,
  PruneArg
> {
  readonly backend: string;
  private readonly inner: CollectionStore<T, Q, PruneArg>;
  /** `opId`s whose write has already been applied. In-memory — bounded by process life. */
  private readonly applied = new Set<string>();

  // Present only when the inner store prunes — mirrors MemoryCollection's
  // `typeof`-honest capability detection so a prune-less inner stays prune-less.
  prune?: (arg: PruneArg, ctx: StoreCtx) => Promise<void>;

  constructor(inner: CollectionStore<T, Q, PruneArg>) {
    this.inner = inner;
    this.backend = `${inner.backend}+idempotent`;
    if (inner.prune !== undefined) {
      const innerPrune = inner.prune.bind(inner);
      this.prune = (arg, ctx) => innerPrune(arg, ctx);
    }
  }

  put(item: T, ctx: StoreCtx): Promise<void> {
    if (this.seen(ctx.opId)) return Promise.resolve();
    return this.inner.put(item, ctx);
  }

  delete(key: string, ctx: StoreCtx): Promise<void | boolean> {
    if (this.seen(ctx.opId)) return Promise.resolve(false);
    return this.inner.delete(key, ctx);
  }

  // Reads never dedup.
  get(key: string, ctx: StoreCtx): Promise<T | undefined> {
    return this.inner.get(key, ctx);
  }

  list(query: Q | undefined, ctx: StoreCtx): Promise<readonly T[]> {
    return this.inner.list(query, ctx);
  }

  // ── Store seam. `query` is a read (never dedups) → straight to the inner
  // store; `mutate` routes through this decorator's own `put`/`delete` so the
  // seam write dedups on `ctx.opId` exactly as the sugar does.
  query(q: Q | undefined, ctx: StoreCtx): Promise<readonly T[]> {
    return this.inner.query(q, ctx);
  }

  mutate(m: CollectionMutation<T>, ctx: StoreCtx): Promise<void> {
    return "put" in m ? this.put(m.put, ctx) : this.delete(m.delete, ctx).then(() => undefined);
  }

  /**
   * `true` when this `opId` was already applied (short-circuit the retry).
   * Records the `opId` on first sight. An absent `opId` is never deduped.
   */
  private seen(opId: string | undefined): boolean {
    if (opId === undefined) return false;
    if (this.applied.has(opId)) return true;
    this.applied.add(opId);
    return false;
  }
}

/** Wrap a {@link CollectionStore} so retried writes dedup on `ctx.opId`. */
export function idempotentWrite<T, Q, PruneArg = never>(
  inner: CollectionStore<T, Q, PruneArg>,
): CollectionStore<T, Q, PruneArg> {
  return new IdempotentCollectionStore(inner);
}
