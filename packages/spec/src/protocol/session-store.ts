/**
 * `SessionStore` (E11) — the durable **session registry**: the record a
 * session's metadata lives in, the CRUD store port that persists it, and the
 * scope/status/recency query that backs every "list / resume my sessions"
 * surface.
 *
 * This is bigger than a metadata bag. Per the data-layer plan (E11), the
 * `SessionStore` IS:
 *   - **the session registry** — `sessionId → SessionRecord`, the durable
 *     superset of the app's in-memory live-harness map (which drops closed
 *     sessions; the store keeps every session ever);
 *   - **the resume index** — the natural home for the Phase-4 per-store cursor
 *     **manifest** (`stores?`, placeholder below), making a record the entry
 *     point for `SessionHarness.restore`;
 *   - **the backing for the sessions-list wire surface** — `list(query)` by
 *     `appId` / `status` / `parentSessionId` / recent-`updatedAt` is the query
 *     the client's "my sessions" list projects from (`enumerate` is
 *     foundational).
 *
 * The **live-registry-vs-record-store distinction** (E11): the app's session
 * registry maps `sessionId → LIVE SessionHarness` (routing, in-memory,
 * ephemeral — a live-object map like tasks' `live`) and is NOT replaced by this
 * store. The `SessionStore` holds `sessionId → SessionRecord` (durable,
 * queryable). They coexist: routing reads the registry, "list/resume" reads the
 * store.
 *
 * **No projection** (E11): the record is written async and off the render hot
 * path (`void store.put(record).catch(...)`, mirroring tasks' persist) and read
 * by the client / app asynchronously — like credentials, not like the knobs
 * synchronous read-model. There is deliberately no `CollectionProjection` here.
 *
 * Port home is spec-next (data-layer plan §6-D): the cross-package contract —
 * the app populates it, adapter packages implement it, only spec-next is a
 * shared dep. The bundled `InMemorySessionStore` (composing `MemoryCollection`)
 * and the `runSessionStoreConformance` suite live in `@agentick/session`,
 * mirroring `TaskStore` / `InMemoryTaskStore`.
 *
 * @see docs/proposals/v2/data-layer-plan.md §E11
 */

import type { UsageStats } from "../data/execution-result.js";
import type { SessionStatus } from "./hook-bridges.js";
import type { CollectionStore } from "./store.js";
import type { StoreCtx } from "./store-ctx.js";

// ============================================================================
// SessionRecord — the durable session-metadata record
// ============================================================================

/**
 * The durable metadata for one session — a serializable snapshot keyed by
 * `id`. Grouped by ownership (E11):
 *
 *   - **identity / lifecycle** (framework-owned) — `id`, `createdAt`,
 *     `updatedAt`, `status`, `parentSessionId`, `appId`, `agentId`.
 *   - **runtime accounting** (framework-owned), hierarchy-aware
 *     (session → execution → tick) — `currentExecutionId`, `executionCount`,
 *     `usage`. NOTE: there is deliberately **NO `currentTick`** — a tick is
 *     **execution-local** (resets per execution), so it is execution-scoped
 *     runtime, not session metadata. The session's aggregate `usage` spans
 *     executions.
 *   - **descriptive** (app-owned SLOTS — the framework STORES them, never
 *     POPULATES them) — `title`, `description`, `metadata`. The app generates
 *     these (auto-summary, user-edit, the open over-fetch bag); the framework
 *     is blind to their semantics.
 *
 * No live handles live here (no `SessionHarness`, `AbortController`, `Promise`)
 * — a hydrated record must round-trip across a durable backend / process
 * boundary, exactly like `TaskRecord`.
 */
export interface SessionRecord {
  // ─── identity / lifecycle (framework-owned) ───
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: SessionStatus;
  /** Spawn ancestry (1 agent : 1 session) — the parent's id forms the session tree. */
  readonly parentSessionId?: string;
  /**
   * Full spawn lineage (SP5) — ancestor session ids, root-first
   * (`[root, …, parent]`); its length is the session's spawn depth. Absent
   * for a root session. Lets a sessions-list attribute a sub-agent to its
   * whole ancestor chain, not just its immediate `parentSessionId`.
   */
  readonly spawnPath?: readonly string[];
  /** Owning app id — the primary `list` scope dimension. */
  readonly appId?: string;
  /**
   * Stable agent id / name when the session's agent has one (1:1 makes it
   * meaningful for the sessions-list). Optional — populated by the app when a
   * stable id exists, never fabricated by the framework.
   */
  readonly agentId?: string;
  /**
   * Construction-bound owning principal (ADR 48) — the durable projection of
   * the session harness's `principal`. Stamped at construction (from
   * {@link CreateSessionInput.principal}, itself set host-door or from the wire
   * caller's authenticated identity) and inherited by spawned / forked
   * children. The resume index carries ownership so a rehydrated / historical
   * record still attributes the session to its owner. Absent for
   * principal-less deployments (local single-user agent).
   *
   * NOTE (downstream store adapters): a durable `SessionStore` adapter
   * (`@agentick/session-store-postgres`, etc.) must persist + round-trip this
   * field alongside the other identity slots — it is part of the record's
   * durable identity, not a transient runtime accounting value.
   */
  readonly principal?: string;

  // ─── runtime accounting (framework-owned), hierarchy-aware ───
  /** The in-flight execution's id (`exec:${ulid()}`), or absent when idle. */
  readonly currentExecutionId?: string;
  /** Number of executions started against this session. */
  readonly executionCount: number;
  /** Usage aggregated across every execution. */
  readonly usage: UsageStats;

  // ─── descriptive (app-owned slots — framework STORES, never POPULATES) ───
  /** App-generated title (auto-summary / user-edit). Framework is blind to it. */
  readonly title?: string;
  /** App-generated description. Framework is blind to it. */
  readonly description?: string;
  /** The open bag / over-fetch home. Adopter-owned. */
  readonly metadata?: Record<string, unknown>;

  // ─── Phase-4 placeholder — the per-store cursor manifest (E11 / E12) ───
  // The `SessionRecord` is the natural home for the resume manifest: a map
  // from store name → its backend + flushed cursor, written at
  // `SessionHarness.snapshot()` (flush-then-record barrier) and read to
  // rehydrate each store to its cursor on `restore`. NOT populated this run —
  // the Phase-4 manifest sweep lands it. Left commented so the shape is on
  // record without being a live (unpopulated) field.
  //
  // TODO(store-phase-4): populate the manifest at snapshot / consume at restore.
  // readonly stores?: Record<string, { readonly backend: string; readonly cursor: unknown }>;
}

// ============================================================================
// SessionStoreQuery — the sessions-list query
// ============================================================================

/**
 * Scope + status + tree + recency filter for {@link SessionStore.list} — the
 * query the "list/resume my sessions" surface projects from. Every provided
 * dimension must match (AND):
 *
 *   - `appId` — scope to one app (equality).
 *   - `status` — a single status or any of a set (set membership).
 *   - `parentSessionId` — one level of the session tree (equality); pass the
 *     parent's id to list its direct children.
 *   - `updatedAfter` — recency: only records last touched at-or-after this
 *     ms-epoch (`>=`).
 */
export interface SessionStoreQuery {
  /** Scope to one owning app. */
  readonly appId?: string;
  /** Match a single status or any of a set. */
  readonly status?: SessionStatus | readonly SessionStatus[];
  /** Match sessions whose parent is exactly this id (the session tree). */
  readonly parentSessionId?: string;
  /** Recency: `record.updatedAt >= updatedAfter`. */
  readonly updatedAfter?: number;
}

// ============================================================================
// SessionStore — CRUD port (mirrors TaskStore)
// ============================================================================

/**
 * Adopter-pluggable durable backing for session metadata — a CRUD port keyed
 * by `id`, queryable by app / status / parent / recency. Upsert-on-transition
 * (construction, status change, execution boundary); NO `subscribe` (liveness
 * is the bus / the session's own event stream, like the tasks store). Swappable
 * + conformance-parameterized (`runSessionStoreConformance(factory)` in
 * `@agentick/session`), exactly like the task / timeline stores.
 *
 * Bundled default: `InMemorySessionStore` (`@agentick/session`). A
 * `@agentick/session-store-postgres` conforms to this SAME port later —
 * swapping durability across app restart, the store's whole point as the resume
 * index.
 *
 * A `CollectionStore<SessionRecord, SessionStoreQuery, number>` (the collection
 * archetype, data-layer plan §2.1) — the prune argument is the ms-epoch cutoff
 * for GC of closed sessions. The method declarations below narrow the
 * archetype's contract to the session-specific shape (parameter names, and
 * `delete` → `Promise<void>`); they MUST stay assignable to
 * {@link CollectionStore} so generic collection-store tooling accepts a
 * `SessionStore`.
 */
export interface SessionStore extends CollectionStore<SessionRecord, SessionStoreQuery, number> {
  /** Upsert — a later `put` of the same `id` replaces the record. */
  put(record: SessionRecord, ctx: StoreCtx): Promise<void>;
  get(id: string, ctx: StoreCtx): Promise<SessionRecord | undefined>;
  /** By app / status / parent / recency. Omitting the query returns every record. */
  list(query: SessionStoreQuery | undefined, ctx: StoreCtx): Promise<readonly SessionRecord[]>;
  delete(id: string, ctx: StoreCtx): Promise<void>;
  /** Optional GC of CLOSED sessions older than `before` (ms-epoch `updatedAt`). */
  prune?(before: number, ctx: StoreCtx): Promise<void>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}
