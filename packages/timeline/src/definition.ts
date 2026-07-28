/**
 * `defineTimeline` / `defineTimelineStore` — the timeline's NAMESPACE DEFINITION
 * (ADR 93, the proving instance).
 *
 * A store-bearing namespace is configured by a **definition**: the durability
 * port (`store`), the genesis seam (`hydrate`), that namespace's shaping verbs
 * (`compact`, `writePolicy`), and the `hooks:` / `guards:` bags. One definition
 * object is consumed by BOTH `createApp({ timeline })` and `withTimeline(...)`,
 * and is what a namespace file default-exports.
 *
 * ## The definition IS the options
 *
 * `defineTimeline` is **identity + brand** — it returns its argument, stamped.
 * The value is portability, not construction: a grammar file default-exports
 * one, a test imports the production definition and overrides a slot, and the
 * brand lets a slot tell a definition from a live harness instance. Nothing is
 * constructed and no hydrator runs: **definitions are INERT until install**
 * (ADR 93 §Composition ruling). Construction is PER-SESSION at install; genesis
 * runs at session-open with that session's reality.
 *
 * ## The genesis seam
 *
 * `hydrate(ctx)` returns the namespace's initial entries. Its `ctx` is the
 * session's derived {@link OperationCtx} — so `sessionId`, `principal`, `log`,
 * `run` are simply THERE — plus one boundary facet: `ctx.store`, the
 * definition's own store, typed by inference from the `store` slot.
 *
 * **Genesis output is SEED, never re-appended.** The entries a hydrator returns
 * are already durable (or are deliberately ephemeral); writing them back would
 * duplicate the log on every resume. This is the #1 adopter footgun, and the
 * conformance suite asserts it.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @see ./hydrators.ts — the named hydrators (`hydrateFromStore`, `hydrateTail`)
 * @verifiedBy packages/timeline/src/__tests__/definition.spec.ts
 */

import type {
  ContentBlock,
  LogHistoryOptions,
  LogMutation,
  LogQuery,
  OperationCtx,
  SeqTagged,
  StoreCtx,
  TimelineEntry,
  TimelineStore,
} from "@agentick/spec";
import type { NamespaceGuards, NamespaceHooks } from "@agentick/runtime";

/**
 * The brand `defineTimeline` stamps. Symbol-keyed so it never collides with an
 * adopter property and stays out of `JSON.stringify` / spread-visible shape —
 * the definition remains a plain data bag for every other purpose.
 */
const TIMELINE_DEFINITION: unique symbol = Symbol("agentick.timelineDefinition");

// ============================================================================
// The genesis seam
// ============================================================================

/**
 * The ctx a {@link TimelineHydrator} receives: the session's derived
 * {@link OperationCtx} (identity + causality + `log`/`trace`/`metrics`/`run`)
 * plus the definition's own store as a typed facet.
 *
 * `TStore` flows from the definition's `store` slot, so a hydrator written
 * against `defineTimeline({ store: myPostgresStore, hydrate: (ctx) => … })`
 * sees `ctx.store` typed as the Postgres adapter — including any verbs that
 * adapter adds beyond the port.
 */
export interface TimelineHydrateCtx<
  TStore extends TimelineStore = TimelineStore,
> extends OperationCtx {
  /** The definition's store — the durability port, as a boundary facet. */
  readonly store: TStore;
}

/**
 * The genesis seam (ADR 93): produce the namespace's initial entries at
 * session-open. Runs on CREATE and RESUME, never on FORK / SPAWN-inherit (a
 * fork inherits the parent's image; re-running genesis would duplicate or
 * diverge it). Runs after identity stamping, before first render, before the
 * write pump — and a rejection FAILS session creation (no half-genesis session).
 *
 * The returned entries are a SEED: they are never appended back to the store.
 */
export type TimelineHydrator<TStore extends TimelineStore = TimelineStore> = (
  ctx: TimelineHydrateCtx<TStore>,
) => Promise<readonly TimelineEntry[]>;

// ============================================================================
// The shaping seam
// ============================================================================

/**
 * The ctx a {@link TimelineCompactor} receives: the compact op's derived
 * {@link OperationCtx} plus the advisory `instructions` the ADR-51 signal form
 * may carry (a bare `timeline:compact` verb over the inbox/wire). The compactor
 * is authoritative to honor or ignore them.
 */
export interface TimelineCompactCtx extends OperationCtx {
  /** Advisory instructions from the signal form, when the caller supplied any. */
  readonly instructions?: string | readonly ContentBlock[];
}

/**
 * The definition's `compact` sugar (ADR 93) — the namespace's shaping verb in
 * the uniform `(subject, ctx)` grammar. `entries` is the fold INPUT (the durable
 * log); the return is the new projection. The durable log is never rewritten.
 *
 * This is sugar over {@link import("@agentick/spec").CompactStrategy}: the slot
 * accepts either form (ADR 42's dichotomy — a function is the declarative
 * shorthand, a `CompactStrategy` is the configured value `fromHandler(...)` /
 * an adopter factory produces). The function form implies
 * `source: "persisted"`, matching `fromHandler`'s default.
 */
export type TimelineCompactor = (
  entries: readonly TimelineEntry[],
  ctx: TimelineCompactCtx,
) => Promise<readonly TimelineEntry[]> | readonly TimelineEntry[];

// ============================================================================
// The definition
// ============================================================================

/**
 * The timeline's namespace definition — the CLOSED surface (ADR 93
 * §"Definition surface — complete and closed"): the store, the genesis seam,
 * this namespace's shaping seams, and the two interceptor bags. Nothing else
 * belongs here; wire-exposure grants live at the gateway, telemetry is a trunk
 * field, channels are the bus.
 *
 * This same type is what `withTimeline(...)` and `createApp({ timeline })`
 * accept inline — `defineTimeline` adds identity + the brand, not a new shape.
 */
export interface TimelineDefinition<TStore extends TimelineStore = TimelineStore> {
  /**
   * Durable backing for the log — the durability/query port (ADR 49). Defaults
   * to a bundled `MemoryTimelineStore` (`:memory:`, lost on exit). Inject a
   * durable adapter (`@agentick/timeline-fs`, `-postgres`) or build one inline
   * with {@link defineTimelineStore}.
   */
  readonly store?: TStore;
  /**
   * The genesis seam. Defaults to `hydrateFromStore()` when a `store` is
   * configured (ADR 49 open-or-rehydrate, preserved exactly); no genesis runs
   * when neither a store nor a hydrator is present.
   *
   * Declared as a METHOD signature, not a function-typed property, and
   * deliberately so (ADR 93 landmine 6). `TStore` appears here in a PARAMETER
   * position, so a property declaration would make `TimelineDefinition`
   * invariant under `strictFunctionTypes` — and then
   * `defineTimeline({ store: myPostgresStore, hydrate })` would not fit a slot
   * typed at the PORT (`TimelineDefinition<TimelineStore>`), which is every
   * slot. Method params are checked bivariantly, which is the correct trade
   * here: the store a definition names and the store its hydrator receives are
   * the same object by construction.
   */
  hydrate?(ctx: TimelineHydrateCtx<TStore>): Promise<readonly TimelineEntry[]>;
  /**
   * Construction-bound default compaction (ADR 51 signal form). With this set,
   * `timeline.compact()` — the no-arg form, the one that can cross the
   * inbox/wire as a bare verb — runs it. An explicit `compact(strategy)`
   * call-site argument overrides it (inner-scope-wins, in-process only).
   */
  readonly compact?: TimelineCompactor | import("@agentick/spec").CompactStrategy;
  /** `"behind"` (default; write-behind pump + flush barrier) | `"through"`. */
  readonly writePolicy?: "behind" | "through";
  /**
   * Emit a turn-boundary record at each execution end (ADR 53). Default true;
   * set false to keep boundary rows out of the store.
   */
  readonly turnBoundaries?: boolean;
  /**
   * Namespace-local command hooks (ADR 93) — DROP-LAYER keys
   * (`onBeforeAppend`, not `onBeforeTimelineAppend`). Pure colocation sugar:
   * each entry desugars to the same op-scoped `transform` interceptor the
   * app-level discriminated bag produces. App-level hooks wrap these (broader
   * scope outermost).
   */
  readonly hooks?: NamespaceHooks<"timeline">;
  /**
   * Namespace-local guards (ADR 93) — DROP-LAYER keys (`{ append }`, not
   * `{ timelineAppend }`). A distinct KIND from hooks: the verdict seam
   * (`proceed` / `veto` / `replace` / `defer`), floated OUTERMOST of every
   * transform. App-level guards outrank these — governance before local policy.
   */
  readonly guards?: NamespaceGuards<"timeline">;
}

/** A {@link TimelineDefinition} carrying the {@link defineTimeline} brand. */
export type BrandedTimelineDefinition<TStore extends TimelineStore = TimelineStore> =
  TimelineDefinition<TStore> & { readonly [TIMELINE_DEFINITION]: true };

/**
 * Name a timeline definition (ADR 93). Identity + brand — it returns `options`
 * with the definition brand stamped; nothing is constructed, no store is
 * opened, no hydrator runs.
 *
 * ```ts
 * export default defineTimeline({
 *   store: postgresTimelineStore({ executor: pool }),
 *   hydrate: hydrateTail(200),
 *   compact: async (entries, ctx) => summarize(entries, ctx),
 *   guards: { append: (input) => (input.entries.length > 500 ? { kind: "veto" } : undefined) },
 * });
 * ```
 */
export function defineTimeline<TStore extends TimelineStore = TimelineStore>(
  options: TimelineDefinition<TStore> = {},
): BrandedTimelineDefinition<TStore> {
  return Object.defineProperty(options, TIMELINE_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedTimelineDefinition<TStore>;
}

/**
 * Does `value` carry the {@link defineTimeline} brand? Note that an INLINE bag
 * (`withTimeline({ store })`) is a perfectly valid definition and is NOT
 * branded — so slots discriminate a definition from a LIVE HARNESS with
 * {@link isTimelineHarnessInstance}, and use this only when the brand itself is
 * the question (introspection, tooling).
 */
export function isTimelineDefinition(value: unknown): value is BrandedTimelineDefinition {
  return typeof value === "object" && value !== null && TIMELINE_DEFINITION in value;
}

/**
 * The ADR-42 dichotomy discriminator for the `timeline` slot: is this a LIVE
 * harness instance (the BYO / single-session escape hatch, whose lifecycle the
 * adopter owns) rather than a definition? Structural, so any conforming
 * implementation passes — a definition is pure data and has none of these.
 */
export function isTimelineHarnessInstance(
  value: unknown,
): value is import("@agentick/spec").TimelineHarnessProtocol {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.append === "function" && typeof v.read === "function" && "ready" in v;
}

// ============================================================================
// defineTimelineStore — the port's typed inline constructor
// ============================================================================

/**
 * The verbs {@link defineTimelineStore} takes: the LOG archetype's required
 * four plus its two optionals. The `Store` seam (`query` / `mutate`) is
 * DERIVED — it is sugar over these, so an inline store never writes it twice.
 *
 * `history` is optional in the port but strongly recommended: it is what a
 * bounded hydrator (`hydrateTail`), history paging, and the client's
 * scroll-back read all use. Without it they degrade to a full `read`.
 */
export interface TimelineStoreVerbs {
  /** Self-identifying backend label, for observability. Defaults to `"inline"`. */
  readonly backend?: string;
  /**
   * Append entries in order; return the `seq` assigned to each, in input order.
   * The only write — the log is otherwise append-only. Reject with any error on
   * failure; the harness wraps it into `TimelineWriteFailed`.
   */
  append(
    logKey: string,
    entries: readonly TimelineEntry[],
    ctx: StoreCtx,
  ): Promise<readonly number[]>;
  /** Full ordered read — the fold input for hydration. `[]` for an unknown log. */
  read(logKey: string, ctx: StoreCtx): Promise<readonly TimelineEntry[]>;
  /** Enumerate the log keys holding entries (the enumerate-is-foundational verb). */
  keys(ctx: StoreCtx): Promise<readonly string[]>;
  /** End a log. Idempotent; `true` when entries were removed. */
  delete(logKey: string, ctx: StoreCtx): Promise<boolean>;
  /**
   * OPTIONAL cursored read — the {@link LogHistoryOptions} window, seq-tagged,
   * ASCENDING, at most `limit` taken from the anchor end (`fromSeq` present ⇒
   * the first `limit`; absent ⇒ the last).
   */
  history?(
    logKey: string,
    options: LogHistoryOptions | undefined,
    ctx: StoreCtx,
  ): Promise<readonly SeqTagged<TimelineEntry>[]>;
  /** OPTIONAL destructive retention — drop entries with absolute `seq < before.seq`. */
  prune?(logKey: string, before: { seq: number }, ctx: StoreCtx): Promise<number>;
}

/**
 * Build a {@link TimelineStore} from its verbs (ADR 93) — the port's typed
 * inline constructor, for an adopter whose durability is a few lines against an
 * existing table and who does not want a class or a package.
 *
 * The `Store` seam is derived: `query` projects a log window (delegating to
 * `history` when the adapter has it), `mutate` appends. The result satisfies the
 * SAME port a published adapter does, so it passes
 * `runTimelineStoreConformance` unchanged — run it: the `seq` contract
 * (strictly increasing, never reused, stable across `prune`) is not checkable by
 * types.
 *
 * ```ts
 * const store = defineTimelineStore({
 *   backend: "pg",
 *   append: async (key, entries) => insertReturningSeq(key, entries),
 *   read: (key) => selectEntries(key),
 *   keys: () => selectDistinctKeys(),
 *   delete: (key) => deleteLog(key),
 *   history: (key, o) => selectEntryWindow(key, o),
 * });
 * ```
 */
export function defineTimelineStore(verbs: TimelineStoreVerbs): TimelineStore {
  const backend = verbs.backend ?? "inline";
  const store: TimelineStore = {
    backend,
    append: (logKey, entries, ctx) => verbs.append(logKey, entries, ctx),
    read: (logKey, ctx) => verbs.read(logKey, ctx),
    keys: (ctx) => verbs.keys(ctx),
    delete: (logKey, ctx) => verbs.delete(logKey, ctx),
    // The seam READ — a projection of a log window shaped by a `LogQuery`. An
    // `undefined` query identifies no log, so it projects nothing (a
    // partitioned log has no "return all").
    query: async (q: LogQuery | undefined, ctx: StoreCtx): Promise<readonly TimelineEntry[]> => {
      if (q === undefined) return [];
      const { logKey, ...window } = q;
      if (verbs.history !== undefined) {
        const tagged = await verbs.history(logKey, window, ctx);
        return tagged.map((t) => t.entry);
      }
      // Degradation without the optional cursored read: an unbounded projection
      // (whole log, or a `limit`-anchored end of it) is still answerable from
      // `read`, but `fromSeq`/`toSeq` are SEQ cursors and seqs are
      // store-assigned — position is not a legal substitute (a `prune` breaks
      // the correspondence). Fail loudly rather than silently returning the
      // wrong window.
      if (window.fromSeq !== undefined || window.toSeq !== undefined) {
        throw new Error(
          `TimelineStore "${backend}" does not implement the optional cursored read ` +
            "(history), so a `fromSeq`/`toSeq` query cannot be answered. Implement " +
            "`history` (see runTimelineStoreConformance) or query without seq bounds.",
        );
      }
      const entries = await verbs.read(logKey, ctx);
      // The anchor rule with no bounds: `limit` takes the log's LAST n.
      return window.limit !== undefined
        ? entries.slice(Math.max(entries.length - window.limit, 0))
        : entries;
    },
    // The seam WRITE — the single append mutation; the assigned seqs are
    // discarded to satisfy the `Promise<void>` seam.
    mutate: async (m: LogMutation<TimelineEntry>, ctx: StoreCtx): Promise<void> => {
      await verbs.append(m.append.logKey, m.append.entries, ctx);
    },
  };
  // Optional verbs are ABSENT when not supplied, never `undefined`-valued —
  // consumers feature-detect with `store.history === undefined`.
  if (verbs.history !== undefined) {
    (store as { history?: TimelineStore["history"] }).history = (logKey, options, ctx) =>
      verbs.history!(logKey, options, ctx);
  }
  if (verbs.prune !== undefined) {
    (store as { prune?: TimelineStore["prune"] }).prune = (logKey, before, ctx) =>
      verbs.prune!(logKey, before, ctx);
  }
  return store;
}
