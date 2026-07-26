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
 * PLUS the captured identity (`createdAt`, `appId`, `agentId`,
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
 * **Persist/notify parity (this migration is parity-only):**
 *   - `setStatus` / `setMeta` PERSIST (`view.write` → cache + store.put +
 *     notify). `setStatus` is the metadata-change notify trigger, exactly as
 *     the old `notify()` was; `setMeta` persists directly (as it did).
 *   - `setCurrentExecutionId` / `bumpExecutionCount` / `addUsage` are
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
  SessionRecord,
  SessionStatus,
  SessionStore,
  SessionStoreQuery,
  Store,
  StoreCtx,
  UsageStats,
} from "@agentick/spec";
import { View } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";

/**
 * The zero-value usage accumulator seeded into a fresh session's record —
 * every field explicit so `addUsage`'s running sums start defined.
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
 * (`createdAt` captured internally; `appId` / `agentId` / `parentSessionId`
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
  readonly agentId?: string;
  readonly parentSessionId?: string;
  /** Owning principal (ADR 48) — construction-bound; folded into every record write. */
  readonly principal?: string;
  /** Spawn lineage (SP5) — ancestor session ids, root-first. Folded into the record. */
  readonly spawnPath?: readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

export class SessionRuntime {
  readonly id: string;

  /** Captured identity (E11) — folded into every record write. */
  private readonly createdAt: number;
  private readonly appId: string | undefined;
  private readonly agentId: string | undefined;
  private readonly parentSessionId: string | undefined;
  /** Owning principal (ADR 48) — folded into every record write; absent when principal-less. */
  private readonly principal: string | undefined;
  /** Spawn lineage (SP5) — folded into every record write; absent for a root. */
  private readonly spawnPath: readonly string[] | undefined;
  private readonly storeCtx: () => StoreCtx;

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
   * App-owned descriptive slots (E11) — the framework STORES these, never
   * populates their semantics. Seeded at construction, mutated by {@link
   * setMeta}, folded into every record write.
   */
  private _meta: {
    title?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  };

  constructor(init: SessionRuntimeInit) {
    this.id = init.id;
    this.createdAt = Date.now();
    this.appId = init.appId;
    this.agentId = init.agentId;
    this.parentSessionId = init.parentSessionId;
    this.principal = init.principal;
    this.spawnPath = init.spawnPath;
    this.storeCtx = init.storeCtx;
    this._meta = omitUndefined({
      title: init.title,
      description: init.description,
      metadata: init.metadata,
    });

    const store: Store<
      SessionRecord,
      SessionStoreQuery,
      CollectionMutation<SessionRecord>
    > = init.store ?? NULL_STORE;
    this.view = View.collection(store, (record) => record.id);

    // Seed + persist the initial record (idle / count 0 / zero usage). With a
    // real store this is the E11 construction upsert; with NULL_STORE the write
    // is a no-op and only the cache is seeded (parity with the old
    // store-guarded initial `syncSessionRecord`). No metadata subscribers exist
    // at construction, so the view's notify is inert either way.
    const initial: SessionRecord = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      status: "idle",
      executionCount: 0,
      usage: { ...ZERO_USAGE },
      ...omitUndefined({
        parentSessionId: this.parentSessionId,
        principal: this.principal,
        spawnPath: this.spawnPath,
        appId: this.appId,
        agentId: this.agentId,
        title: this._meta.title,
        description: this._meta.description,
        metadata: this._meta.metadata,
      }),
    };
    this.view.write(initial, this.storeCtx());
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
   * Rebuild the full record from the cached one with `patch` applied, then
   * commit it: `persist: true` ⇒ `view.write` (cache + store.put + notify);
   * `persist: false` ⇒ `view.seedSync` (cache-only — no store write, no
   * notify). `updatedAt` bumps only on a persisting write, mirroring the old
   * `syncSessionRecord` which stamped it at `store.put` time. `currentExecutionId`
   * is three-valued: a `string` sets it, `null` clears it (omitted from the
   * record), and absence from `patch` preserves the cached value.
   */
  private commit(
    patch: {
      status?: SessionStatus;
      executionCount?: number;
      usage?: UsageStats;
      currentExecutionId?: string | null;
    },
    opts: { persist: boolean },
  ): void {
    const cur = this.record();
    const nextExecutionId =
      patch.currentExecutionId !== undefined
        ? patch.currentExecutionId
        : (cur.currentExecutionId ?? null);
    const record: SessionRecord = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: opts.persist ? Date.now() : cur.updatedAt,
      status: patch.status ?? cur.status,
      executionCount: patch.executionCount ?? cur.executionCount,
      usage: patch.usage ?? cur.usage,
      ...omitUndefined({
        parentSessionId: this.parentSessionId,
        principal: this.principal,
        spawnPath: this.spawnPath,
        appId: this.appId,
        agentId: this.agentId,
        currentExecutionId: nextExecutionId ?? undefined,
        title: this._meta.title,
        description: this._meta.description,
        metadata: this._meta.metadata,
      }),
    };
    if (opts.persist) {
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
  setStatus(next: SessionStatus): void {
    this.commit({ status: next }, { persist: true });
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
    this.commit({ currentExecutionId: id }, { persist: false });
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
  /**
   * CACHE-ONLY accumulate — rides the next `setStatus` into the store (parity;
   * usage was never persisted eagerly per tick). Arithmetic is byte-identical
   * to the pre-View in-place accumulator.
   */
  addUsage(delta?: UsageStats): void {
    if (!delta) return;
    const u = this.record().usage;
    const usage: UsageStats = {
      inputTokens: u.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: u.outputTokens + (delta.outputTokens ?? 0),
      totalTokens: u.totalTokens + (delta.totalTokens ?? 0),
      cachedInputTokens: (u.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0),
      cacheCreationTokens: (u.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0),
      reasoningTokens: (u.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0),
    };
    this.commit({ usage }, { persist: false });
  }

  /**
   * SET the aggregate usage from a snapshot (restore). CACHE-ONLY — rides
   * the next `setStatus` into the store, like {@link addUsage}. Distinct
   * from `addUsage` (accumulate): restore replaces wholesale.
   */
  setUsage(usage: UsageStats): void {
    this.commit({ usage }, { persist: false });
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
    this._meta = {
      ...this._meta,
      ...omitUndefined({
        title: meta.title,
        description: meta.description,
        metadata: meta.metadata,
      }),
    };
    this.commit({}, { persist: true });
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
