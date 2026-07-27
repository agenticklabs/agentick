/**
 * Named hydrators — the timeline's genesis-seam library (ADR 93).
 *
 * A hydrator is a plain function of the derived ctx returning the entries the
 * session opens with. These are the two the framework names; anything with the
 * {@link TimelineHydrator} shape works, which is the point: an event-sourced
 * timeline is a hydrator folding `ctx.journalReader`, a tiered catalog is a
 * hydrator reading `ctx.principal`. Genesis became something an adopter WRITES
 * rather than something the framework promises.
 *
 * **The seed law.** What a hydrator returns is a SEED — it is never appended
 * back to the store. `hydrateFromStore` reads what is already durable;
 * `hydrateTail` reads a window of it; a synthetic hydrator produces entries the
 * adopter deliberately keeps ephemeral. Writing genesis back would duplicate the
 * log on every resume (the #1 footgun — conformance-cased).
 *
 * Lives at the package root (not a `/hydrators` subpath) because a hydrator is
 * part of the definition surface, not an optional extras bag:
 * `defineTimeline({ hydrate: hydrateTail(200) })` is the common case.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @verifiedBy packages/timeline/src/__tests__/hydrators.spec.ts
 */

import type { SeqTagged, StoreCtx, TimelineEntry, TimelineStore } from "@agentick/spec";
import type { TimelineHydrator } from "./definition.js";

/**
 * Paging window {@link hydrateTail} reads the log with. The tail size and the
 * transfer window are DIFFERENT concerns: a `hydrateTail(3)` over a 100k-entry
 * log should not make 33k round-trips. The window floors at this value so the
 * seek cost stays sane while memory stays bounded (window + n, never the log).
 */
const TAIL_PAGE_FLOOR = 256;

/**
 * The DEFAULT hydrator when a `store` is configured (ADR 93) — the full ordered
 * read of the session's durable log. This is ADR 49 open-or-rehydrate, preserved
 * exactly: the durable log is the authority, and a session opened with an id
 * that already has entries resumes on them before first render.
 *
 * Memory cost is the whole log. That is the right DEFAULT (correctness first,
 * and it is what every existing session already does) — not a mandate.
 * {@link hydrateTail} is one line away.
 */
export function hydrateFromStore<
  TStore extends TimelineStore = TimelineStore,
>(): TimelineHydrator<TStore> {
  return (ctx) => ctx.store.read(ctx.sessionId ?? "", ctx);
}

/**
 * Open on the LAST `n` entries of the durable log — the bounded-memory hydrator.
 *
 * Uses the store's optional cursored read (`history`) with a `limit`, so the
 * whole log never materializes: the walk transfers one bounded page at a time
 * and keeps a rolling tail of `n`. Peak memory is `page + n`, independent of log
 * length. `read` is never called.
 *
 * **Degradation.** A store that does NOT implement `history` (it is optional in
 * the port) falls back to a full {@link TimelineStore.read} and takes the tail
 * in memory. The RESULT is identical; the bounded-memory PROPERTY is not. If you
 * chose `hydrateTail` for the memory bound, implement `history` on your adapter
 * — `runTimelineStoreConformance` covers it, and `MemoryTimelineStore` (via
 * `MemoryLog`) already has it. The fallback logs at `debug` so the lost bound is
 * visible rather than silent.
 *
 * **Seek cost.** The LOG port is forward-cursored by design (`fromSeq` + `limit`
 * — an opaque, gap-tolerant `seq` space has no expressible "last n"), so
 * locating the tail is a forward walk: `ceil(N / page)` round-trips. An adapter
 * that can do better in one query should ship its own hydrator — one line,
 * `(ctx) => lastN(ctx.sessionId, n)` — which is exactly why genesis is a
 * function seam and not a config enum.
 *
 * **Semantics.** A tail opens the session on a SUFFIX of the log with no summary
 * of what precedes it — compaction is a projection concern, not a genesis one.
 * Pair it with a `compact` that says "earlier history omitted", or use it where
 * the tail genuinely is the conversation.
 *
 * @param n Maximum entries to open with. `n <= 0` opens empty.
 */
export function hydrateTail<TStore extends TimelineStore = TimelineStore>(
  n: number,
): TimelineHydrator<TStore> {
  return async (ctx) => {
    if (n <= 0) return [];
    const logKey = ctx.sessionId ?? "";
    const store = ctx.store;
    if (store.history === undefined) {
      ctx.log.debug({
        msg: "hydrateTail: store implements no cursored read (history); falling back to a full read — the memory bound does not hold",
        backend: store.backend,
        tail: n,
      });
      const all = await store.read(logKey, ctx);
      return all.length > n ? all.slice(all.length - n) : all;
    }
    return tailWindow(store.history.bind(store), logKey, n, ctx);
  };
}

/**
 * Read the last `n` entries using ONLY the port's forward-cursored `history`.
 *
 * Pages forward from the log's start, keeping a rolling buffer of the last `n`
 * seq-tagged entries. Terminates on the first EMPTY page — deliberately not on
 * a short page, so a store that under-fills a window mid-log (legal: the port
 * says "at most `limit`") is never truncated. Peak memory is `page + n`.
 */
async function tailWindow(
  history: NonNullable<TimelineStore["history"]>,
  logKey: string,
  n: number,
  ctx: StoreCtx,
): Promise<readonly TimelineEntry[]> {
  const page = Math.max(n, TAIL_PAGE_FLOOR);
  let buffer: SeqTagged<TimelineEntry>[] = [];
  let fromSeq = 0;
  for (;;) {
    const window = await history(logKey, { fromSeq, limit: page }, ctx);
    if (window.length === 0) break;
    // Keep only the rolling tail — the bound that makes this hydrator bounded.
    buffer =
      buffer.length === 0 && window.length <= n ? [...window] : [...buffer, ...window].slice(-n);
    // `seq` is strictly increasing and never reused, so `last + 1` is a safe
    // next cursor whether or not the space is contiguous.
    fromSeq = window[window.length - 1]!.seq + 1;
  }
  return buffer.map((t) => t.entry);
}
