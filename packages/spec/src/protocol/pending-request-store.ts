/**
 * `PendingRequestStore` — the durable backing port for a harness's SUSPENDED
 * request/response state (the input-required durable-suspension capability on
 * `BaseHarness`).
 *
 * A `BaseHarness.request` today holds its pending state in a live `Deferred`
 * inside the `RequestResponseRegistry` — lost on recycle, unreachable from
 * another replica. This port lifts that state into a store: the harness
 * `persist`s a {@link PendingRequestRecord} when a request suspends and reads
 * it back when the answer arrives — inline on the same tick (fast path, the
 * `Deferred` still lives) or out-of-band on a fresh process (resume, where the
 * record is all that survives). Store-driven per ADR 49: the record is the
 * serializable slice the store keeps and restores, NOT a snapshot blob.
 *
 * The record REUSES the escalation vocabulary rather than restating it — it
 * embeds an {@link EscalationEnvelopePayload} (ADR 69) verbatim as `payload`
 * (the same `class` / `request` / `lineage` a blocked node forwards up its
 * ownership chain) and adds only correlation + lifecycle metadata. So the
 * owning `principal` lives inside `payload.lineage` (ADR 51), never restated at
 * the top level.
 *
 * A `CollectionStore<PendingRequestRecord, PendingRequestQuery, number>` (the
 * collection archetype, data-layer plan §2.1), keyed by `correlationId`, with a
 * ms-epoch `prune` cutoff over `expiresAt` for TTL GC. The default in-memory
 * backing is `MemoryCollection` (`@agentick/store`); a durable adapter
 * (Postgres, Redis) conforms to this SAME port for cross-replica resume.
 *
 * @see ./escalation.ts — the payload the record embeds (ADR 69).
 * @see ./store.ts — the CollectionStore archetype.
 */

import type { EscalationEnvelopePayload } from "./escalation.js";
import type { CollectionStore } from "./store.js";
import type { StoreCtx } from "./store-ctx.js";

/**
 * The serializable slice of one suspended request. Keyed by `correlationId`;
 * everything the store needs to reconstitute the pending ask on a fresh process
 * and nothing more (the live `Deferred` and the reply channel stay derivable).
 */
export interface PendingRequestRecord {
  /**
   * The suspended request's correlation id — the `BaseHarness.request` id, and
   * this record's stable store key. Answers (in-process or out-of-band) address
   * the inbox by it.
   */
  readonly correlationId: string;
  /**
   * The owning harness KIND — the `<surface>` half of its `address`
   * (`${surface}:${scopeId}`). The discriminator a shared durable backing
   * scopes rows by, so one table can serve every harness's pending store
   * (elicitation, tool-executor, app, …).
   */
  readonly surface: string;
  /**
   * The escalation envelope verbatim (ADR 69) — `class` (the payload
   * discriminator: `"elicit"` today; `"sampling"` / `"permission"` /
   * `"credential"` later), `request` (the class-specific ask), and `lineage`
   * (provenance + the owning `principal`, ADR 51). Embedded, not restated: this
   * IS what the blocked node forwarded, held for replay.
   */
  readonly payload: EscalationEnvelopePayload;
  /**
   * Answered inputs accumulated across rounds, keyed exactly as the wire
   * `inputRequests` / `inputResponses` maps (MRTR / SEP-2322). Absent until the
   * first answer. The store — not the sealed `requestState` handle — carries
   * this, so the handle stays thin.
   */
  readonly responses?: Readonly<Record<string, unknown>>;
  /** Monotonic round counter — the replay / round-ordering guard the sealed handle binds to. */
  readonly round: number;
  /** Creation time, ms epoch. */
  readonly createdAt: number;
  /** TTL expiry, ms epoch. The GC cutoff `prune` compares against. */
  readonly expiresAt?: number;
  /**
   * Set once the request has been terminally answered — the store-driven
   * single-use gate (`consumeOnce`): a replayed `requestState` whose record is
   * already consumed is rejected here, not by the token.
   */
  readonly consumedAt?: number;
}

/**
 * Filter for {@link PendingRequestStore.list} beyond exact-key `get`. Every
 * provided dimension ANDs; an omitted / empty query returns every record.
 */
export interface PendingRequestQuery {
  /** Match one harness kind only. */
  readonly surface?: string;
  /** Match one escalation payload class (`payload.class`). */
  readonly class?: string;
  /** Match records whose `payload.lineage` names this principal (ADR 51). */
  readonly principal?: string;
}

/**
 * Adopter-pluggable durable backing for a harness's suspended requests — a CRUD
 * port keyed by `correlationId`, queryable by surface / class / principal, GC'd
 * by a ms-epoch `expiresAt` cutoff via the archetype's `prune`. Upsert on
 * suspend + each round; delete on terminal resolution. NO `watch` — the harness
 * owns its own resolve fan-out. Swappable + conformance-parameterized like
 * `TaskStore` / `SkillStore`.
 *
 * The narrowed methods MUST stay assignable to {@link CollectionStore} so
 * generic collection-store tooling accepts a `PendingRequestStore`.
 */
export interface PendingRequestStore extends CollectionStore<
  PendingRequestRecord,
  PendingRequestQuery,
  number
> {
  /** Upsert — a later `put` of the same `correlationId` replaces the record (a new round). */
  put(record: PendingRequestRecord, ctx: StoreCtx): Promise<void>;
  get(correlationId: string, ctx: StoreCtx): Promise<PendingRequestRecord | undefined>;
  /** By surface / class / principal. Omitting the query returns every pending record. */
  list(
    query: PendingRequestQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly PendingRequestRecord[]>;
  /**
   * Remove one by `correlationId`. Idempotent — deleting an absent key never
   * throws. Returns `void | boolean` per the archetype: a fire-and-forget
   * backing resolves `void`, one that reports prior existence resolves the
   * `boolean` (the in-memory default does the latter).
   */
  delete(correlationId: string, ctx: StoreCtx): Promise<void | boolean>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}

/**
 * A parent-resolving factory for the {@link PendingRequestStore} substrate slot
 * — the twin of `EventBusFactory` / `MessageInboxFactory`. `P` is the harness
 * shell the factory resolves against (so a child can derive its store from the
 * parent's).
 */
export type PendingRequestStoreFactory<P> = (parent: P) => PendingRequestStore;

/**
 * The one matching rule for {@link PendingRequestQuery}, exported so the default
 * in-memory backing, any durable adapter, and the conformance tests all share
 * it (drift would desync them — same reason `resourceDeclarationKey` is shared).
 * Every provided dimension ANDs; an omitted / empty query matches every record.
 */
export function matchPendingRequestQuery(
  record: PendingRequestRecord,
  query: PendingRequestQuery | undefined,
): boolean {
  if (query === undefined) return true;
  if (query.surface !== undefined && record.surface !== query.surface) return false;
  if (query.class !== undefined && record.payload.class !== query.class) return false;
  if (
    query.principal !== undefined &&
    !(record.payload.lineage?.some((hop) => hop.principal === query.principal) ?? false)
  ) {
    return false;
  }
  return true;
}

/**
 * The one GC rule: a record is prunable once it carries an `expiresAt` older
 * than the ms-epoch `cutoff`. Records with no `expiresAt` never expire. Shared
 * for the same anti-drift reason as {@link matchPendingRequestQuery}.
 */
export function pendingRequestExpired(record: PendingRequestRecord, cutoff: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt < cutoff;
}

/**
 * The stable store key for a pending record — its `correlationId`. Exported so
 * the harness's registry and the store share ONE keying rule (mirrors
 * `resourceDeclarationKey`).
 */
export function pendingRequestKey(record: PendingRequestRecord): string {
  return record.correlationId;
}
