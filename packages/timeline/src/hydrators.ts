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

import type { TimelineStore } from "@agentick/spec";
import type { TimelineHydrator } from "./definition.js";
import { projectLog } from "./project.js";

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
 * **Seek cost is ONE round-trip.** "The last `n`" is expressible at the port
 * (`{ limit: n }` with no lower bound — the anchor rule), so this is a single
 * `history` call whose window IS the tail; the adapter does the reverse slice
 * (`ORDER BY seq DESC LIMIT n`). No forward walk, no `ceil(N / page)`.
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
    // The tail read: a `limit` with NO lower bound anchors the window at the
    // log's end, so the store hands back exactly the last `n`, ascending.
    const window = await store.history(logKey, { limit: n }, ctx);
    return window.map((t) => t.entry);
  };
}

/**
 * Genesis as the fold: read the durable log, substitute every compaction event
 * at the range it covers, and open the session on the result.
 *
 * This is the hydrator the event-sourced framing implies — resume needs no
 * cursor and no side table, because a compaction event carries the range it
 * stands in for. A session that reopens on this sees exactly what it saw before
 * the process died.
 */
export function hydrateProjected<
  TStore extends TimelineStore = TimelineStore,
>(): TimelineHydrator<TStore> {
  return async (ctx) => projectLog(await ctx.store.read(ctx.sessionId ?? "", ctx));
}
