/**
 * `JournalProjectedStore` — the REFERENCE event-sourced {@link CollectionStore}:
 * a store that is a PROJECTION OF THE JOURNAL rather than an independent
 * mutable backing (data-layer plan §E13, Run B).
 *
 * ## The point it proves
 *
 * "Any store MAY be a projection of the journal, opt-in." The bundled defaults
 * ({@link MemoryCollection}) hold their own `Map` and mutate it on `put` /
 * `delete`. This store holds NOTHING. Every read folds the operation journal —
 * the append-only record the harness's `runOperation` already writes — into the
 * projected records on demand. There is one source of truth (the journal); the
 * collection view is derived.
 *
 * ## Reads
 *
 *   - {@link list} folds `ctx.journalReader.readByQuery(scopeQuery, "beginning")`
 *     — the READ slice of the journal ({@link StoreCtx.journalReader}, populated
 *     by `BaseHarness.storeCtx`) — through the injected `fold`. The Effect
 *     `Stream` is collected and crossed to a `Promise` at the store edge via
 *     `Effect.runPromise` (the ONLY place Effect touches this Promise-shaped
 *     store — the substrate discipline of {@link StoreCtx}).
 *   - {@link get} folds and picks one by `keyOf`.
 *
 * ## `asOf` — time travel (the upper bound)
 *
 * {@link StoreCtx.asOf} pins the fold's UPPER bound (see the field's spec doc).
 * `undefined` / `"latest"` fold the whole scoped history → the CURRENT state.
 * `{ offset: N }` folds only the first `N` scoped events → the state AS OF that
 * earlier cursor (time travel). `"beginning"` folds nothing → the empty
 * prehistory.
 *
 * The journal's `readByQuery(query, from)` treats `from` as a LOWER bound (a
 * start cursor) and exposes no upper-bound surface, and the events it yields
 * carry no absolute offset — so this reference store applies `asOf` as a
 * prefix bound over the SCOPED stream (the first `N` matched events), always
 * reading the lower bound from `"beginning"`. That is exact whenever the scope
 * query is no sparser than the offset space it bounds (the common single-scope
 * case); a durable, offset-indexed store (Postgres, …) would bound by the
 * journal's absolute offset instead. Reference vs production: this is a
 * reference — honest, minimal, and correct for the demonstrated semantics, not
 * an offset-indexed production projector.
 *
 * ## Writes
 *
 * An event-sourced store's writes ARE the journaled operations themselves — the
 * harness's `runOperation` appended the event that IS the mutation BEFORE this
 * store ever sees a call, and {@link StoreCtx.journalReader} is a READ-ONLY
 * slice (no `append`). So this store owns no write path: {@link put} and
 * {@link delete} are deliberate no-ops. Mutating an event-sourced collection
 * means appending an operation to the journal (through the harness), not calling
 * `store.put`. This is the honest minimal shape — a projection cannot forge the
 * log it projects.
 *
 * @see docs/proposals/v2/data-layer-plan.md §E13
 * @see StoreCtx — the Effect→Promise scope carrier + the event-sourcing seam
 * @verifiedBy packages-next/store/src/__tests__/journal-projected.spec.ts
 */

import { Chunk, Effect, Stream } from "effect";
import type {
  CollectionMutation,
  CollectionStore,
  EventQuery,
  ProtocolEvent,
  StoreCtx,
} from "@agentick/spec-next";

/**
 * The per-store parameterization for {@link JournalProjectedStore}. Everything
 * projection-specific lives here; the fold-the-journal mechanics are the
 * generic's.
 */
export interface JournalProjectedConfig<T, Q> {
  /** Self-identifying backend label. Defaults to `"journal-projected"`. */
  readonly backend?: string;
  /**
   * Build the {@link EventQuery} that scopes the journal read to THIS store's
   * events — the projection's selector over the shared log (by `name` prefix,
   * `surface`, `scope`, `tagsAny`, …). Receives the `list` query and the ctx so
   * a store can scope by `ctx.sessionId` / `ctx.principal` when it wants.
   */
  readonly scopeQuery: (query: Q | undefined, ctx: StoreCtx) => EventQuery;
  /**
   * Fold the matched events — in journal append order, already bounded by
   * `asOf` — into the projected records. This is the store's entire
   * interpretation of its event history (last-write-wins, accumulate, tombstone,
   * …); the store stays ignorant of it.
   */
  readonly fold: (events: readonly ProtocolEvent[]) => readonly T[];
  /** Primary-key accessor — used by {@link get} to pick one folded record. */
  readonly keyOf: (item: T) => string;
}

export class JournalProjectedStore<T, Q, PruneArg = never> implements CollectionStore<
  T,
  Q,
  PruneArg
> {
  readonly backend: string;
  private readonly config: JournalProjectedConfig<T, Q>;

  constructor(config: JournalProjectedConfig<T, Q>) {
    this.config = config;
    this.backend = config.backend ?? "journal-projected";
  }

  /**
   * Fold the scoped journal history (bounded by `ctx.asOf`) into records.
   * Throws if `ctx.journalReader` is absent — an event-sourced store is
   * meaningless without the log it projects.
   */
  async list(query: Q | undefined, ctx: StoreCtx): Promise<readonly T[]> {
    const reader = ctx.journalReader;
    if (reader === undefined) {
      throw new Error(
        "JournalProjectedStore requires ctx.journalReader (the READ slice of the operation journal); none was threaded. An event-sourced store cannot project without its log.",
      );
    }
    const scoped = reader.readByQuery(this.config.scopeQuery(query, ctx), "beginning");
    // Effect → Promise crossing: collect the Stream, then bound by asOf. This is
    // the sole place Effect touches this Promise-shaped store (StoreCtx §).
    const chunk = await Effect.runPromise(Stream.runCollect(scoped));
    const events = boundByAsOf(Chunk.toReadonlyArray(chunk), ctx.asOf);
    return this.config.fold(events);
  }

  /** Fold-then-pick — reads one record from the projection. */
  async get(key: string, ctx: StoreCtx): Promise<T | undefined> {
    const all = await this.list(undefined, ctx);
    return all.find((item) => this.config.keyOf(item) === key);
  }

  /**
   * No-op. An event-sourced store's writes are the journaled operations
   * themselves — the harness's `runOperation` already appended the event that
   * IS this mutation, and the journal slice this store projects is read-only.
   * See the class doc.
   */
  put(_item: T, _ctx: StoreCtx): Promise<void> {
    return Promise.resolve();
  }

  /** No-op — same reason as {@link put}. Reports `false` (nothing removed here). */
  delete(_key: string, _ctx: StoreCtx): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ── Store seam. `query` IS the fold (delegates to {@link list}); `mutate` is
  // a no-op, exactly like {@link put}/{@link delete} — an event-sourced store's
  // writes are the journaled operations themselves, not seam calls.
  query(query: Q | undefined, ctx: StoreCtx): Promise<readonly T[]> {
    return this.list(query, ctx);
  }

  mutate(_m: CollectionMutation<T>, _ctx: StoreCtx): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Apply {@link StoreCtx.asOf} as the fold's UPPER bound over the scoped stream.
 *
 *   - `undefined` / `"latest"` → the whole history (current state).
 *   - `{ offset: N }`          → the first `N` events (state as of that cursor).
 *   - `"beginning"`            → nothing (the empty prehistory).
 */
function boundByAsOf(
  events: readonly ProtocolEvent[],
  asOf: StoreCtx["asOf"],
): readonly ProtocolEvent[] {
  if (asOf === undefined || asOf === "latest") return events;
  if (asOf === "beginning") return [];
  return events.slice(0, Math.max(0, asOf.offset));
}
