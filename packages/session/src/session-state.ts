/**
 * `SessionRuntime` — the current session's **live, synchronous** runtime state,
 * owned by a `SessionHarness`.
 *
 * This is the **projection** half of the session's (projection, store) pair —
 * NOT a store (do not confuse with the durable `SessionStore`, which is the
 * app-singleton `CollectionStore<SessionRecord>` holding every session's
 * record). `SessionRuntime` is the sync working copy of THIS session's
 * `SessionRecord`: it holds the record's mutable subset (`status`,
 * `currentExecutionId`, `executionCount`, `usage`) plus non-persisted live
 * extras (`currentTick`, the metadata-change listeners).
 *
 * ## Store-backed via a single-key {@link View} (convergence run 3)
 *
 * The projection machine is no longer hand-rolled. The durable-mirror fields
 * PLUS the captured identity (`createdAt`, `appId`,
 * `parentSessionId`) and the app-owned descriptive slots (`title`,
 * `description`, `metadata`) live IN ONE cached `SessionRecord`, held by a
 * `View.collection` keyed by session id — a SINGLE cache entry. This proves the
 * generic {@link View} primitive covers the single-record cell with no
 * refinement: the three things this class used to hand-roll —
 *
 *   1. a synchronous read cache (per-tick `status`/`usage` reads cannot await),
 *   2. the write-through to the durable `SessionStore` (formerly the harness's
 *      `syncSessionRecord` → `void store.put(...)`), and
 *   3. the metadata-change notifier (formerly a bare `Notifier`),
 *
 * — all collapse into the view. Accessors read `view.getSync(id)?.<field>`;
 * mutations are a read-modify-write of the whole record. This is the augmented
 * single-record projection archetype — the session-scoped sibling of tasks'
 * `live` — expressed with the shared primitive instead of bespoke machinery.
 *
 * The cached record is the SOLE home of every durable field: nothing this class
 * writes is also mirrored in a sibling instance field, so no write-through can
 * project a stale shadow over what the store already holds.
 *
 * ## Construction seeds; {@link SessionRuntime.hydrate} adopts, then persists lazily
 *
 * Construction is synchronous, so it only SEEDS the cache (fresh record: idle,
 * count 0, zero usage). `hydrate()` — the session's genesis step (ADR 93), run
 * before first render — first reads the persisted record and ADOPTS it. A
 * RESUME (a record already exists) re-writes it; a genuinely NEW session
 * persists nothing at genesis — the harness's `session:persist` COMMAND is
 * what performs the first durable `put` ({@link persistRecord} is its body).
 * Lazy-by-default is what keeps a "new chat" that never sends off the durable
 * "list my sessions" registry (no blank "Untitled" rows). Deferring the write
 * to `hydrate` is also what makes resume correct: an eager construction write
 * would overwrite a live session's durable record with a blank one before
 * anything read it back.
 *
 * **Create early, persist late — and persist is a COMMAND.** A session EXISTS
 * the moment it is constructed — palette, prompts, completions, subscriptions
 * all real — but it becomes DURABLE only when something earns the record:
 * adopting one at hydrate, or the harness dispatching `session:persist` (at
 * the first `running` transition — execution is the intent moment — or at
 * genesis for an `eager` create). Until then every "persisting" write below
 * stays cache-only (`durable` gates `commit`), and teardown — evict,
 * shutdown, close — writes nothing: a session nobody ever spoke to leaves no
 * trace. Because the earn moment is an operation, it is journaled, hookable
 * (`onBeforeSessionPersist` is the ephemeral-by-policy veto), and its
 * terminal event is the wire-visible "this conversation now exists".
 *
 * **Persist/notify parity (the View migration was parity-only):**
 *   - `setStatus` / `setMeta` PERSIST (`view.write` → cache + store.put +
 *     notify) — once the record is EARNED (see above). `setStatus` is the
 *     metadata-change notify trigger, exactly as the old `notify()` was;
 *     `setMeta` persists directly (as it did).
 *   - `setCurrentExecutionId` / `bumpExecutionCount` / `addTickAccounting` are
 *     CACHE-ONLY (`view.seedSync` — no store write, no notify). They ride the
 *     next `setStatus` into the store, preserving the old behavior where only a
 *     status transition re-wrote the durable record. (Usage therefore persists
 *     at the execution-boundary status change, not eagerly per tick — this is
 *     the E11 "upsert-on-transition" design, preserved, not a bug to fix here.)
 *
 * ## Optional `SessionStore` — no durable mirror where there wasn't one
 *
 * When no durable `SessionStore` is injected (ephemeral / standalone sessions),
 * the view is constructed over {@link NULL_STORE} — a Store whose `mutate` is a
 * no-op. The sync cache is then the record's only home (in-memory, ephemeral)
 * and every write-through falls into the void, exactly reproducing the previous
 * "persist nothing" behavior — with ONE code path (the cache still serves reads
 * uniformly), no store-present / store-absent branch.
 *
 * Synchronous on purpose: the runtime reads `status`/`currentTick`/`usage` per
 * tick, and the substrate's FiberRef scope flows through the harness's
 * `runOperation` wrap around this mutable cell. The timeline lives in the
 * `TimelineHarness` (ADR 26 Step 5a) — its two-tier log+projection surface
 * doesn't fit this synchronous metadata cell.
 *
 * TODO(store-phase-N): `currentTick` is **execution-local** (resets per
 * execution — session → execution → tick), so it does not belong in session
 * state at all; its clean home is execution-scoped state (ADR 77 execution
 * spine). It lives here today only for lack of an execution-state holder, and
 * is correctly excluded from the durable `SessionRecord`.
 */

import type {
  CollectionMutation,
  Cost,
  CostRollup,
  ExecutionTarget,
  ModelKey,
  ModelUsage,
  SessionRecord,
  SessionRunOutcome,
  SessionStatus,
  SessionStore,
  SessionStoreQuery,
  Store,
  StoreCtx,
  UsageStats,
} from "@agentick/spec";
import { foldUsageRollup } from "@agentick/spec";
import { View } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";

/**
 * The zero-value usage accumulator seeded into a fresh session's record —
 * every field explicit so the running sums start defined. `byModel` and
 * `cost` have no zero value and are simply ABSENT until the first tick folds
 * in — a zero-valued cost would claim "this session cost nothing".
 */
const ZERO_USAGE: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * The no-op {@link Store} the view falls back to when no durable
 * {@link SessionStore} was injected. `mutate` discards, `query` returns empty:
 * the view's sync cache is the record's only home (ephemeral), and write-through
 * is a no-op — preserving the pre-View "no durable mirror" behavior without a
 * store-present / store-absent code split.
 */
const NULL_STORE: Store<SessionRecord, SessionStoreQuery, CollectionMutation<SessionRecord>> = {
  backend: "none",
  query: async () => [],
  mutate: async () => {},
};

/**
 * Construction slots for a {@link SessionRuntime}. The identity fields
 * (`createdAt` captured internally; `appId` / `parentSessionId`
 * passed) and the app-owned descriptive slots (`title` / `description` /
 * `metadata`) are folded into the cached `SessionRecord` alongside the runtime
 * accounting. `store` is the durable registry (or `undefined` → {@link
 * NULL_STORE}); `storeCtx` is the harness's scope carrier, threaded on every
 * write across the Effect→Promise boundary.
 */
export interface SessionRuntimeInit {
  readonly id: string;
  /** Durable session registry (E11). `undefined` ⇒ no durable mirror. */
  readonly store: SessionStore | undefined;
  /** The owning harness's {@link StoreCtx} carrier, evaluated per write. */
  readonly storeCtx: () => StoreCtx;
  readonly appId?: string;
  readonly parentSessionId?: string;
  /** Owning principal (ADR 48) — construction-bound; folded into every record write. */
  readonly principal?: string;
  /** Session is INTERNAL (backlog F) — the durable top rung; folded into the record. */
  readonly internal?: boolean;
  /**
   * Called after a persisting write that CHANGED the status — the transition
   * seam the harness publishes `session:channel:status` from. A write that
   * leaves the value alone still persists (parity) but is not a transition and
   * does not call this. `outcome` rides only the transition that ends a run.
   */
  readonly onStatusTransition?: (status: SessionStatus, outcome?: SessionRunOutcome) => void;
  /** Spawn lineage (SP5) — ancestor session ids, root-first. Folded into the record. */
  readonly spawnPath?: readonly string[];
  /** Origin edge (EX1) — the parent EXECUTION that spawned this session. Folded in. */
  readonly originExecutionId?: string;
  /** Origin edge (EX1) — the parent TOOL CALL that asked for the spawn. Folded in. */
  readonly originCallId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The mutable slice of a {@link SessionRecord}. Presence semantics, not value
 * semantics: a key ABSENT from the patch preserves the cached value, a key
 * PRESENT replaces it — including with `undefined`, which clears the field.
 * Clearing has to be expressible: restoring an unpriced snapshot must drop a
 * stale `cost`, and ending an execution must drop `currentExecutionId`.
 */
type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | "status"
    | "executionCount"
    | "usage"
    | "byModel"
    | "cost"
    | "currentExecutionId"
    | "interruptedExecutionId"
    | "resumeAttempts"
    | "title"
    | "description"
    | "metadata"
  >
>;

export class SessionRuntime {
  readonly id: string;

  /** The durable registry, for the {@link hydrate} read-back. */
  private readonly store: SessionStore | undefined;
  private readonly storeCtx: () => StoreCtx;

  private readonly onStatusTransition:
    | ((status: SessionStatus, outcome?: SessionRunOutcome) => void)
    | undefined;

  /**
   * The single-key projection of this session's `SessionRecord`. One cache
   * entry, keyed by session id; write-through to the durable `SessionStore`
   * (or {@link NULL_STORE}); the view's own keyed notifier is the metadata
   * notify seam. See the file header for the persist/notify contract.
   */
  private readonly view: View<
    SessionRecord,
    SessionRecord,
    SessionStoreQuery,
    CollectionMutation<SessionRecord>
  >;

  /**
   * Execution-local tick counter — TRANSIENT (never enters `SessionRecord`;
   * see the file TODO). Held as a plain scalar, untouched by the view.
   */
  private _currentTick = 0;
  /**
   * Live-only (never persisted): is the in-flight execution INTERNAL (backlog F)?
   * Set at execution start to `record.internal || send.internal`, read at append
   * to stamp each produced entry `internal`, cleared at execution end — the
   * execution rung of the stamp spine (see internal-visibility.md). The SESSION
   * rung is the durable `record.internal`; this is its per-execution fold.
   */
  private _currentExecutionInternal = false;

  /** The record {@link hydrate} adopted, until {@link takeAdoptedRecord} claims it. */
  private adopted: SessionRecord | undefined;

  constructor(init: SessionRuntimeInit) {
    this.id = init.id;
    this.store = init.store;
    this.storeCtx = init.storeCtx;
    this.onStatusTransition = init.onStatusTransition;

    const store: Store<
      SessionRecord,
      SessionStoreQuery,
      CollectionMutation<SessionRecord>
    > = init.store ?? NULL_STORE;
    this.view = View.collection(store, (record) => record.id);

    const now = Date.now();
    this.view.seedSync(
      omitUndefined({
        id: this.id,
        createdAt: now,
        updatedAt: now,
        status: "idle",
        executionCount: 0,
        usage: { ...ZERO_USAGE },
        parentSessionId: init.parentSessionId,
        principal: init.principal,
        internal: init.internal,
        spawnPath: init.spawnPath,
        originExecutionId: init.originExecutionId,
        originCallId: init.originCallId,
        appId: init.appId,
        title: init.title,
        description: init.description,
        metadata: init.metadata,
      }) as SessionRecord,
    );
  }

  /**
   * GENESIS (ADR 93) — adopt a persisted record on RESUME; otherwise seed the
   * cache only (the `session:persist` command performs the first write).
   *
   * A `createSession` with an id the durable registry already holds is a
   * RESUME, and the record it holds is the session's real history: when it was
   * created, how many executions it has run, what it has spent, and the
   * app-owned `title` / `description` / `metadata` an app-side titler wrote.
   * All of it is adopted; only the fields that describe THIS process win over
   * it — the construction-bound identity (a caller-supplied lineage slot, an
   * explicitly re-supplied title) and the live lifecycle fields, since a
   * freshly opened harness is `idle` and the execution the previous process
   * died mid-way through is not running here.
   *
   * The read lands here rather than in the constructor so that a resume reads
   * before it writes. A NEW session (nothing persisted) writes nothing until
   * the harness dispatches `session:persist`.
   */
  /**
   * Durability barrier over the record's write-behind — awaits every in-flight
   * store put (the view's flush) and surfaces a latched failure. The resume
   * path's ordering guarantee: a caller about to write the record DIRECTLY
   * (the interruption mark) must drain the fire-and-forget hydrate write-back
   * first, or an async store can complete it late and clobber the direct write
   * (execution-resume.md §3.1 — F1).
   */
  flushRecord(): Promise<void> {
    return this.view.flush();
  }

  /**
   * Completion clears the interruption (execution-resume.md §3.3) — keyed to
   * the SETTLING execution, so a fresh turn ending never erases a DIFFERENT
   * (dropped) interruption's history, and only the resumed execution reaching
   * its own end resolves it. Cache-only; the settle's `setStatus`
   * write-through persists the one record carrying the clear — the same
   * pattern as the execution-start delta.
   */
  clearInterruption(executionId: string): void {
    if (this.record().interruptedExecutionId !== executionId) return;
    this.commit(
      { interruptedExecutionId: undefined, resumeAttempts: undefined },
      {
        persist: false,
      },
    );
  }

  /**
   * The persisted record this session ADOPTED at genesis — `undefined` for a
   * fresh one — read back exactly once. It is the only place a crashed
   * `running` + `currentExecutionId` survives (the {@link hydrate} merge below
   * overwrites both), and consuming it is what keeps the app's interruption
   * reconcile firing once per interruption rather than once per open.
   */
  takeAdoptedRecord(): SessionRecord | undefined {
    const adopted = this.adopted;
    this.adopted = undefined;
    return adopted;
  }

  /**
   * Whether this session has EARNED a durable record — by adopting one at
   * hydrate, or by the harness's `session:persist` command (dispatched at the
   * first `running` transition, or at genesis for an `eager` create). Until
   * then every `persist: true` commit stays cache-only: persistence is a
   * COMMAND, not a side-effect of creation — and not of teardown either. A
   * session that never ran a turn dies recordless on evict, shutdown, and
   * close alike, which is what lets a host create a live session for a
   * brand-new chat (palette, prompts, completions all real) and leave no row
   * behind if the user never says anything.
   */
  private durable = false;

  /** Adoption/persistence state a dispatch site guards on before minting an op. */
  isDurable(): boolean {
    return this.durable;
  }

  /**
   * The body of the `session:persist` command: flip the latch and perform the
   * durable write of the record as it stands. Returns what was written — the
   * op's terminal event carries it, which is what lets a connected list insert
   * the row from the payload instead of racing the store with a read-back.
   * Idempotent in effect (a second write upserts the same record); ONCE-ness
   * is the dispatch sites' guard, not this body's.
   */
  persistRecord(): SessionRecord {
    this.durable = true;
    this.commit({}, { persist: true });
    return this.record();
  }

  async hydrate(): Promise<void> {
    const persisted = await this.store?.get(this.id, this.storeCtx());
    if (persisted !== undefined) {
      this.durable = true;
      this.adopted = persisted;
      const fresh = this.record();
      this.view.seedSync(
        omitUndefined({
          ...persisted,
          ...fresh,
          createdAt: persisted.createdAt,
          executionCount: persisted.executionCount,
          usage: persisted.usage,
          currentExecutionId: undefined,
        }) as SessionRecord,
      );
      this.commit({}, { persist: true });
      return;
    }
    this.commit({}, { persist: false });
  }

  // ────────── record read-modify-write ──────────

  /**
   * The cached record — always present after construction (the view is never
   * `deleteSync`'d), so a miss is a hard invariant violation.
   */
  private record(): SessionRecord {
    const record = this.view.getSync(this.id);
    if (record === undefined) {
      throw new Error(`SessionRuntime[${this.id}]: record missing from view cache`);
    }
    return record;
  }

  /**
   * Apply `patch` to the cached record and commit it: `persist: true` ⇒
   * `view.write` (cache + store.put + notify); `persist: false` ⇒
   * `view.seedSync` (cache-only — no store write, no notify). `updatedAt` bumps
   * only on a persisting write, mirroring the old `syncSessionRecord` which
   * stamped it at `store.put` time.
   */
  private commit(patch: SessionRecordPatch, opts: { persist: boolean }): void {
    const cur = this.record();
    const persist = opts.persist && this.durable;
    const record = omitUndefined({
      ...cur,
      ...patch,
      updatedAt: persist ? Date.now() : cur.updatedAt,
    }) as SessionRecord;
    if (persist) {
      this.view.write(record, this.storeCtx());
    } else {
      this.view.seedSync(record);
    }
  }

  // ────────── status ──────────

  status(): SessionStatus {
    return this.record().status;
  }
  /** PERSIST + NOTIFY — the metadata-change trigger (the old `notify()`). */
  setStatus(next: SessionStatus, outcome?: SessionRunOutcome): void {
    const prev = this.record().status;
    this.commit({ status: next }, { persist: true });
    if (next !== prev) this.onStatusTransition?.(next, outcome);
  }

  // ────────── tick (execution-local — see the file TODO; not in SessionRecord) ──────────

  currentTick(): number {
    return this._currentTick;
  }
  bumpTick(): number {
    return ++this._currentTick;
  }
  resetTick(): void {
    this._currentTick = 0;
  }
  /** Restore the execution-local tick counter from a snapshot. */
  setTick(tick: number): void {
    this._currentTick = tick;
  }

  currentExecutionId(): string | null {
    return this.record().currentExecutionId ?? null;
  }
  /** CACHE-ONLY — rides the next `setStatus` into the store (parity). */
  setCurrentExecutionId(id: string | null): void {
    this.commit({ currentExecutionId: id ?? undefined }, { persist: false });
  }

  /** Whether the SESSION is internal (durable, backlog F) — the spine's top rung. */
  isInternal(): boolean {
    return this.record().internal === true;
  }
  /** Whether the in-flight EXECUTION is internal (live-only) — `session || send`. */
  currentExecutionInternal(): boolean {
    return this._currentExecutionInternal;
  }
  /** Set at execution start (`record.internal || send.internal`); cleared at end. */
  setCurrentExecutionInternal(value: boolean): void {
    this._currentExecutionInternal = value;
  }

  /**
   * Number of executions started against this session — hierarchy-aware
   * accounting (session → execution → tick) for the durable
   * `SessionRecord` (E11). Bumped once per `send` at execution start.
   * Distinct from `currentTick`, which is execution-local (resets per
   * execution) and never enters the session record.
   */
  executionCount(): number {
    return this.record().executionCount;
  }
  /** CACHE-ONLY — rides the next `setStatus` into the store (parity). */
  bumpExecutionCount(): number {
    const next = this.record().executionCount + 1;
    this.commit({ executionCount: next }, { persist: false });
    return next;
  }

  // ────────── usage ──────────

  usage(): UsageStats {
    return this.record().usage;
  }
  /** Per-model breakdown; absent until the first tick folds in. */
  byModel(): Readonly<Record<ModelKey, ModelUsage>> | undefined {
    return this.record().byModel;
  }
  /** The session's cost rollup; absent until the first tick folds in. */
  cost(): CostRollup | undefined {
    return this.record().cost;
  }

  /**
   * Fold ONE tick into the session's accounting: the flat `usage` total, the
   * per-model breakdown, and the cost rollup — all three from
   * {@link foldUsageRollup}, so they can never disagree.
   *
   * `cost === undefined` means the tick was UNPRICED, and the fold records it
   * as such: the rollup degrades to `partial` with the tick counted in
   * `unpricedTicks`. It never contributes a zero to a `complete` total —
   * zero is the claim "this cost nothing", which is a different (and
   * silently low) statement from "we cannot say what this cost".
   *
   * CACHE-ONLY — rides the next `setStatus` into the store (parity; usage was
   * never persisted eagerly per tick). The flat arithmetic is unchanged: the
   * seeded {@link ZERO_USAGE} has every field defined, so the fold's
   * absent-stays-absent rule collapses to the old in-place accumulator.
   */
  addTickAccounting(
    usage: UsageStats,
    model: Pick<ExecutionTarget, "provider" | "modelId"> | undefined,
    cost: Cost | undefined,
  ): void {
    const cur = this.record();
    const folded = foldUsageRollup(
      { usage: cur.usage, byModel: cur.byModel ?? {}, ...(cur.cost ? { cost: cur.cost } : {}) },
      model,
      usage,
      cost,
    );
    this.commit(
      { usage: folded.usage, byModel: folded.byModel, cost: folded.cost },
      { persist: false },
    );
  }

  /**
   * SET the whole aggregate from a snapshot (restore). CACHE-ONLY — rides
   * the next `setStatus` into the store, like {@link addTickAccounting}.
   * Distinct from the fold (accumulate): restore replaces wholesale, and it
   * restores the breakdown and the stamped cost alongside the flat total —
   * a cost that does not survive a reload defeats the point of stamping it.
   */
  setAccounting(
    usage: UsageStats,
    byModel?: Readonly<Record<ModelKey, ModelUsage>>,
    cost?: CostRollup,
  ): void {
    this.commit({ usage, byModel, cost }, { persist: false });
  }

  // ────────── app-owned descriptive slots (E11) ──────────

  /**
   * Set the app-owned `title` / `description` / `metadata` slots on the durable
   * record. Provided fields overwrite; omitted fields are left as-is. PERSISTS
   * (mirroring the old `syncSessionRecord` call in the harness's `setMeta`);
   * with no store injected the write-through is a NULL_STORE no-op but the
   * in-memory slots still update.
   */
  setMeta(meta: {
    readonly title?: string;
    readonly description?: string;
    readonly metadata?: Record<string, unknown>;
  }): void {
    this.commit(
      omitUndefined({
        title: meta.title,
        description: meta.description,
        metadata: meta.metadata,
      }),
      { persist: true },
    );
  }

  // ────────── subscriptions (status / metadata changes only) ──────────

  /**
   * Subscribe to metadata-change pings (status / meta writes). Delegates to the
   * view's keyed render notifier for this session's single key — the fold of
   * the old hand-rolled `Notifier`.
   */
  subscribeMetadata(listener: () => void): () => void {
    return this.view.subscribe(this.id, listener);
  }
}
