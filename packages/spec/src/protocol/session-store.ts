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
 *     `appId` / `status` / `fromSessionId` / recent-`updatedAt` is the query
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
 * Port home is @agentick/spec (data-layer plan §6-D): the cross-package contract —
 * the app populates it, adapter packages implement it, only @agentick/spec is a
 * shared dep. The bundled `InMemorySessionStore` (composing `MemoryCollection`)
 * and the `runSessionStoreConformance` suite live in `@agentick/session`,
 * mirroring `TaskStore` / `InMemoryTaskStore`.
 *
 * @see docs/proposals/v2/data-layer-plan.md §E11
 */

import type { UsageStats } from "../data/execution-result.js";
import type { SessionStatus } from "./hook-bridges.js";
import type { CursorPage, PageRequest } from "./paging.js";
import type { CollectionStore } from "./store.js";
import type { StoreCtx } from "./store-ctx.js";

// ============================================================================
// SessionRecord — the durable session-metadata record
// ============================================================================

/**
 * Where a session came from — the ONE edge (ADR 100). Absent on the record ⇒
 * a root session.
 *
 * `inherited` and `anchored` are the same category of descriptor:
 * birth-declared, immutable adjectives about the branch's standing
 * relationship to its origin — what it carried away, and whether it left.
 *
 * @see docs/proposals/v2/blueprint/100-conversation-branches.md
 */
export interface SessionFrom {
  /** The session it branched from. */
  readonly sessionId: string;
  /**
   * The timeline entry it branched at. ABSENT when the source had no entries
   * (a spawn off a fresh session): the edge still records lineage, anchored to
   * nothing. Entry ids are message ids — boundary entries cannot anchor.
   */
  readonly entryId?: string;
  /**
   * {@link entryId}'s seq in the source timeline AS THE STORE REPORTS IT
   * (the bundled store is 0-based) — resolved once, at genesis, and used as
   * the INCLUSIVE inherit bound (`entry.seq <= seq`). `-1` ⇔ no
   * {@link entryId}: below every store's floor, so an inherited copy bounded
   * by it copies nothing.
   */
  readonly seq: number;
  /**
   * It took the source's state up to {@link seq} — timeline AND knobs AND
   * state (the branch fan-out, checkpointing §5). A store satisfies this
   * invariant its own way: copy at genesis, or stitch at read.
   */
  readonly inherited: boolean;
  /**
   * It stays at the entry it came from — a side-thread rendered under its
   * anchor, rather than a new direction that leaves.
   */
  readonly anchored: boolean;
}

/**
 * The DOOR shape — no `seq` (genesis resolves it). `entryId` absent at the
 * door means "the source's tip, as of genesis"; on the RECORD, absent means
 * the source had no entries. Two layers, two meanings, one resolution site.
 */
export type SessionFromInput = Omit<SessionFrom, "seq">;

/**
 * What a session IS, folded from `internal` + `from` (ADR 100) — README
 * vocabulary for lists, UI, and logs. Derived on read, stored nowhere.
 */
export type SessionRelation = "conversation" | "fork" | "reply" | "worker" | "forked-worker";

/**
 * The fold. `internal` is the worker axis (a spawn is always internal, and a
 * host-created plumbing session is a worker with no origin); among
 * principal-facing sessions, `anchored` separates a side-thread from a new
 * direction.
 */
export function relation(record: Pick<SessionRecord, "internal" | "from">): SessionRelation {
  if (record.internal) return record.from?.inherited ? "forked-worker" : "worker";
  if (!record.from) return "conversation";
  return record.from.anchored ? "reply" : "fork";
}

/**
 * The durable metadata for one session — a serializable snapshot keyed by
 * `id`. Grouped by ownership (E11):
 *
 *   - **identity / lifecycle** (framework-owned) — `id`, `createdAt`,
 *     `updatedAt`, `status`, `from`, `internal`, `appId`.
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
  /**
   * Where this session came from (ADR 100) — the one edge every branch rides:
   * a fork, a reply, and a spawned worker differ only in this bag plus
   * {@link internal}. Absent ⇒ a root session. See {@link relation}.
   *
   * NOTE (downstream store adapters): columnize it — `from_session`,
   * `from_entry`, `from_seq`, `inherited`, `anchored` — and index the columns
   * the list predicates read. Never jsonb-in-a-WHERE.
   */
  readonly from?: SessionFrom;
  /**
   * Full spawn lineage (SP5) — ancestor session ids, root-first
   * (`[root, …, parent]`); its length is the session's spawn depth. Absent
   * for a root session. Lets a sessions-list attribute a sub-agent to its
   * whole ancestor chain, not just its immediate {@link from}.
   */
  readonly spawnPath?: readonly string[];
  /**
   * The parent EXECUTION that spawned this session (EX1) — which of the
   * parent's executions fanned out, where {@link from} names only which
   * session did. Construction-bound; absent for a root session and for a
   * child spawned outside any execution (a host calling `session.spawn()`).
   *
   * This is the edge `AppHarnessProtocol.abortExecutionTree` walks: it is the
   * only durable record of which agent-tree branch belongs to which turn, and
   * it stays readable long after the execution settled.
   *
   * NOTE (downstream store adapters): persist + round-trip this and
   * {@link originCallId} with the other identity slots — an ancestry edge that
   * does not survive a reload cannot answer the question it exists for.
   */
  readonly originExecutionId?: string;
  /**
   * The parent TOOL CALL whose handler asked for the spawn, when the spawn came
   * from one. The finer-grained twin of {@link originExecutionId} — an audit
   * surface, not a walk key (nothing cascades over it).
   */
  readonly originCallId?: string;
  /** Owning app id — the primary `list` scope dimension. */
  readonly appId?: string;
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
  /**
   * The session is INTERNAL (backlog F — see internal-visibility.md): every
   * execution/message/block it produces is stamped `internal` (client-hidden;
   * the model still reads it, and the bus/journal stay whole). The top of the
   * stamp spine, set from {@link CreateSessionInput.internal}.
   *
   * At SESSION granularity (ADR 100 laws 2 + 3): an internal session renders
   * nowhere in a principal-facing list, and its record is written at genesis —
   * lineage is not speculative, so the create-early/persist-late rule that
   * spares an abandoned conversation a blank row does not apply to plumbing.
   *
   * NOTE (downstream store adapters): persist + round-trip this — it is a durable
   * session-level disposition, and losing it un-hides a session's whole history
   * from the client on reload. `KnowifySessionStore` needs the column.
   */
  readonly internal?: boolean;

  // ─── runtime accounting (framework-owned), hierarchy-aware ───
  /** The in-flight execution's id (`exec:${generateId()}`), or absent when idle. */
  readonly currentExecutionId?: string;
  /**
   * The execution a boot-time reconcile found `running` and marked interrupted —
   * a crash mid-turn (a durable `running` can only be a crash: eviction refuses
   * in-flight sessions). Set as `currentExecutionId` is cleared and `status` goes
   * to `idle`; the queryable handle a resume policy keys on. Cleared when the
   * execution is resumed-to-completion or dropped. See `docs/proposals/v2/execution-resume.md`.
   *
   * NOTE (downstream store adapters): persist + round-trip this alongside the
   * other accounting slots — a resume policy reads it off the reloaded record, so
   * an adapter that drops it cannot answer "was this session interrupted."
   */
  readonly interruptedExecutionId?: string;
  /**
   * How many times an interruption of this session has been recorded — the
   * crash-loop budget a resume policy reads (drop a poisoned execution rather
   * than re-drive it into the same crash). Bumped by the reconcile.
   *
   * NOTE (downstream store adapters): persist + round-trip this — an adapter that
   * drops it silently resets the crash-loop budget on every reload, defeating its
   * purpose (a poisoned execution re-drives into the same crash forever).
   * `KnowifySessionStore` is the live adapter that needs the column.
   */
  readonly resumeAttempts?: number;
  /** Number of executions started against this session. */
  readonly executionCount: number;
  /**
   * Usage aggregated across every execution — FLAT across models. Safe
   * to sum, meaningless to price: a session changes model (`setModel`, a
   * per-send override, a per-tick `<Model>`), so this bag routinely
   * mixes rate tiers. Read {@link byModel} to compute money.
   */
  readonly usage: UsageStats;
  /**
   * Per-model breakdown, keyed `` `${provider}/${modelId}` ``, aggregated
   * across every execution.
   *
   * NOTE (downstream store adapters): persist + round-trip this and
   * {@link cost} alongside `usage` — they are the durable accounting
   * record, and a stamped cost that does not survive a reload defeats
   * the point of stamping it.
   */
  readonly byModel?: Readonly<Record<string, import("../data/usage-cost.js").ModelUsage>>;
  /**
   * What this session cost, folded from per-tick costs stamped at act
   * time. `partial` when any tick was unpriced.
   *
   * A SPAWNED session's cost is deliberately NOT folded in here.
   * Attribution across an agent tree is a QUERY over {@link spawnPath},
   * never a write-time rollup — write-time double-counts, and freezes
   * one scope answer while destroying the others.
   *
   * @see docs/proposals/v2/usage-cost.md §7.1
   */
  readonly cost?: import("../data/usage-cost.js").CostRollup;

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
// Execution-resume policy — the crashed-execution decision (execution-resume.md §3.2)
// ============================================================================

/**
 * What an {@link OnInterruptedExecution} policy decides about — pure data, no
 * harness state, so the decision is testable and reaches no store. There is NO
 * per-execution record: an execution is named by its id plus the timeline
 * coordinates a re-drive reads.
 */
export interface InterruptedExecution {
  /** The reconciled session record (status `idle`, `interruptedExecutionId` set). */
  readonly session: SessionRecord;
  /** The interrupted execution's id (`exec:…`). */
  readonly executionId: string;
  /**
   * Consecutive interruptions of THIS execution — the crash-loop budget
   * ({@link SessionRecord.resumeAttempts}). A different execution resets it to 1.
   */
  readonly attempt: number;
}

/**
 * Adopter policy for an execution a boot-time reconcile found crashed
 * (`running` → `interrupted`). Fires ONCE per transition, on the resume/create
 * path only — never a destroy-rebuild. `"resume"` re-drives it; `"drop"` leaves it
 * as honest history. Absent (the default): `drop`. This is where crash-loop
 * budgeting, multi-node ownership, and product policy live — the framework owns the
 * capability, the adopter owns the decision.
 */
export type OnInterruptedExecution = (
  interrupted: InterruptedExecution,
) => "resume" | "drop" | Promise<"resume" | "drop">;

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
 *   - `fromSessionId` — one level of the session graph (equality); pass a
 *     session's id to list everything branched from it.
 *   - `anchored` / `internal` — the two dispositions, matched exactly.
 *   - `updatedAfter` — recency: only records last touched at-or-after this
 *     ms-epoch (`>=`).
 *
 * The conversation list is the composed predicate
 * `{ internal: false, anchored: false, principal }` (ADR 100 law 2). There is
 * no `root` dimension: a root session is one with no `from`, which is not what
 * a conversation list is asking for — a fork of a conversation is a
 * conversation.
 */
export interface SessionStoreQuery {
  /** Scope to one owning app. */
  readonly appId?: string;
  /** Match a single status or any of a set. */
  readonly status?: SessionStatus | readonly SessionStatus[];
  /**
   * Match sessions branched from exactly this id (`from.sessionId`) — ONE
   * level of the graph, forks and replies and workers alike. Not the
   * transitive tree.
   *
   * // TODO(trail-spawn-tree-query): a `spawnPathContains?: string` ancestor
   * // predicate is what cost attribution across an agent tree needs (see
   * // `SessionRecord.cost` and docs/proposals/v2/usage-cost.md §7.1); today
   * // that means walking this field level by level, which is N+1 and does
   * // not page. It has to go in the QUERY for the same reason `principal`
   * // does — a filter the store doesn't know about is applied after the
   * // page is cut. Deliberately NOT added piecemeal: an adapter that does
   * // not recognize a new field ignores it silently and returns too many
   * // records, which for a cost query is an over-count with nothing in the
   * // result shape to signal it. Land it in the conformance suite and every
   * // adapter as one change, or not at all.
   */
  readonly fromSessionId?: string;
  /**
   * Match `from.anchored` exactly. `false` also matches a session with no
   * `from` at all — an unanchored session is one that does not hang off an
   * entry, and a root hangs off nothing.
   */
  readonly anchored?: boolean;
  /**
   * Match {@link SessionRecord.internal} exactly. `false` also matches a
   * record that never stamped the field — absent IS not-internal.
   */
  readonly internal?: boolean;
  /** Recency: `record.updatedAt >= updatedAfter`. */
  readonly updatedAfter?: number;
  /**
   * Owning principal (ADR 48) — a STORE dimension rather than a caller-side
   * filter for one specific reason: once a store pages
   * ({@link SessionStore.page}), any filter the store does not know about has to
   * be applied AFTER the page is cut, which hands back pages shortened by rows
   * the caller was never allowed to see and a `nextCursor` promising rows
   * already discarded. Scoping has to be inside the query, or paging and scoping
   * cannot both be correct.
   *
   * **Matches a record owned by this principal OR owned by nobody** — the ADR 48
   * rule verbatim, not a strict equality. A record with no `principal` asserts no
   * ownership (principal-less deployment, the local pole) and is visible to
   * everyone; that posture is the framework's, and moving the filter into the
   * store must not quietly change it. In SQL: `(principal = ? OR principal IS
   * NULL)`. The `destroy_session` handlers apply the identical rule to a single
   * named record, so the two verbs cannot disagree about who owns what.
   *
   * `undefined` is an unconstrained query, not "everyone" as a security default:
   * it is what an in-process caller — who has already passed whatever gate
   * applies — asks for. The wire handlers always supply the authenticated
   * caller's identity.
   */
  readonly principal?: string;
}

// ============================================================================
// SessionStore — CRUD port (mirrors TaskStore)
// ============================================================================

/**
 * Adopter-pluggable durable backing for session metadata — a CRUD port keyed
 * by `id`, queryable by app / status / origin / recency. Upsert-on-transition
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
  /** By app / status / origin / disposition / recency. Omitting the query returns every record. */
  list(query: SessionStoreQuery | undefined, ctx: StoreCtx): Promise<readonly SessionRecord[]>;
  /**
   * OPTIONAL cursored read — one page of the same query, with the store minting
   * the cursor. Mirrors `TimelineStore`'s optional `history`: a capability, not a
   * mandate, detected by presence and degraded around when absent.
   *
   * **Why optional and why it matters.** {@link list} is a bounded SNAPSHOT — it
   * returns every match, which is the right shape for an in-process caller
   * holding a modest store and the wrong one for an app with a hundred thousand
   * threads whose client wants fifty. Without this method the framework can only
   * page by fetching everything and slicing, which is correct but reads the whole
   * table per page. Implement it and paging reaches the backend, where a `WHERE
   * (updated_at, id) < (?, ?) ORDER BY … LIMIT ?` is one indexed query.
   *
   * **Two obligations, both pinned by `runSessionStoreConformance`:**
   *
   *   1. **Rows come back in {@link compareSessionRecords} order.** This is the
   *      one place the framework does dictate ordering, and it is not
   *      presentation policy: when no cross-app {@link SessionIndex} is mounted,
   *      the gateway MERGES N of these stores, and a merge needs an order every
   *      source agrees on. (An adopter who wants a different order for product
   *      reasons — pinned first, unread first — mounts a `SessionIndex`, whose
   *      output nothing merges and whose ordering is therefore entirely theirs.)
   *   2. **The walk is sound under concurrent writes.** Page through the whole
   *      store while records are being written: no row that stayed put may be
   *      skipped, and no row may appear twice.
   *
   * The cursor itself is yours. Encode a keyset, a seek offset, a snapshot id —
   * the framework passes the token back to you verbatim and never inspects it. A
   * token you cannot decode SHOULD yield page one rather than raise.
   *
   * @see sessionKeysetPage — the framework's default realization, free to reuse.
   */
  page?(
    query: SessionStoreQuery | undefined,
    page: PageRequest,
    ctx: StoreCtx,
  ): Promise<CursorPage<SessionRecord>>;
  delete(id: string, ctx: StoreCtx): Promise<void>;
  /** Optional GC of CLOSED sessions older than `before` (ms-epoch `updatedAt`). */
  prune?(before: number, ctx: StoreCtx): Promise<void>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}
