/**
 * `RequestResponder` — the durable dimension of a harness's request/response,
 * factored into one place.
 *
 * `BaseHarness` still owns the live primitive (`RequestResponseRegistry`, a pure
 * in-memory `correlationId → Deferred` map) and the transport (building +
 * publishing the channel envelope). This responder wraps that SAME registry plus
 * the harness's `PendingRequestStore` and owns everything durable:
 *
 *   - {@link track} — register the live `Deferred`, and for a `durable` request
 *     persist a {@link PendingRequestRecord} BEFORE the caller publishes, with a
 *     single-finalizer eviction wired through the registry's `onSettle` (no second
 *     `ensuring`, no split teardown).
 *   - {@link resume} — deliver an out-of-band answer: fast path resolves a live
 *     parked `Deferred`; slow path (no live fiber — recycled / another replica)
 *     hydrates the record from the store, records the answer, and marks it
 *     consumed for the caller to re-drive.
 *
 * Transport-agnostic like the registry it wraps: it never touches the bus. The
 * harness hands it the two facts it can't own (`surface`, `address`) at
 * construction and the store/ctx as closures, so the lazy `pendingStore` slot
 * stays resolved on the harness.
 */

import type {
  EscalationHop,
  PendingRequestRecord,
  PendingRequestStore,
  StoreCtx,
} from "@agentick/spec";
import { generateId, omitUndefined } from "@agentick/utils";

import type {
  PendingRequestSnapshot,
  RequestResponseRegistry,
} from "./request-response-registry.js";
import type { RequestStateCodec } from "./request-state-codec.js";

/**
 * Handle TTL when the durable record carries no `expiresAt` of its own — the
 * sealed `requestState` should not outlive a bounded window even for a request
 * with no explicit deadline.
 */
const DEFAULT_HANDLE_TTL_MS = 10 * 60 * 1000;

/**
 * The `durable` option on a tracked request — turns it into a durable suspension.
 * `class` is the escalation payload class (`"elicit"`, …); the request `payload`
 * becomes the record's `request`; `ttlMs` sets `expiresAt`.
 */
export interface DurableRequestOptions {
  readonly class: string;
  readonly lineage?: readonly EscalationHop[];
  readonly ttlMs?: number;
}

export interface TrackOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly durable?: DurableRequestOptions;
}

/**
 * Outcome of {@link RequestResponder.resume} — delivering an out-of-band answer.
 *
 *   - `resolved-live` — a live `Deferred` was still parked; the awaiting fiber was
 *     unblocked directly (fast path, same process).
 *   - `hydrated`      — no live fiber (recycled / another replica); the record was
 *     read from the store, the answer recorded, and it was marked consumed.
 *     Re-driving the suspended operation from the journal is the caller's next
 *     step (the handler-replay contract).
 *   - `not-found`     — no live request and no stored record for this id.
 *   - `consumed`      — the stored record was already answered (replay rejected).
 *   - `invalid`       — a `requestState` handle failed verification (tampered,
 *     expired, unknown key, or bound to a different principal). Wire path only.
 */
export type ResumeOutcome =
  | { readonly status: "resolved-live" }
  | { readonly status: "hydrated"; readonly record: PendingRequestRecord }
  | { readonly status: "not-found" }
  | { readonly status: "consumed" }
  | { readonly status: "invalid" };

export interface RequestResponderDeps {
  readonly registry: RequestResponseRegistry<unknown, PendingRequestSnapshot>;
  /** Lazy accessor for the harness's pending store (resolved on first durable use). */
  readonly store: () => PendingRequestStore;
  readonly storeCtx: () => StoreCtx;
  /** Harness identity — the record's `surface` and the snapshot's `replyTo`. */
  readonly surface: string;
  readonly address: string;
  /**
   * Optional sealed-handle codec for the `requestState` wire binding. When
   * present, {@link RequestResponder.mintHandle} seals a durable record into a
   * `requestState` and {@link RequestResponder.resumeWithState} verifies one.
   * Absent (the default) means no wire handles are issued — the in-process
   * fast path and `correlationId`-addressed {@link RequestResponder.resume} still
   * work; there is simply nothing to seal.
   */
  readonly codec?: RequestStateCodec;
}

export class RequestResponder {
  constructor(private readonly deps: RequestResponderDeps) {}

  /**
   * Register a request's live `Deferred` (with its projectable snapshot) and,
   * when `durable`, persist its record before returning — so it is durable
   * before the caller publishes and the request can be safely suspended. Returns
   * the correlationId and the answer promise the caller awaits.
   */
  async track(
    channel: string,
    payload: unknown,
    opts: TrackOptions,
  ): Promise<{ correlationId: string; promise: Promise<unknown> }> {
    const { registry, store, storeCtx, surface, address } = this.deps;
    const correlationId = `req:${generateId()}`;
    const durable = opts.durable;
    const registered = registry.register({
      correlationId,
      snapshot: { correlationId, replyTo: address, channel, payload },
      ...omitUndefined({ timeoutMs: opts.timeoutMs, signal: opts.signal }),
      ...(durable !== undefined
        ? {
            onSettle: async (): Promise<void> => {
              await store().delete(correlationId, storeCtx());
            },
          }
        : {}),
    });
    if (durable !== undefined) {
      const now = Date.now();
      const record: PendingRequestRecord = {
        correlationId,
        surface,
        payload: {
          class: durable.class,
          request: payload,
          ...(durable.lineage !== undefined ? { lineage: durable.lineage } : {}),
        },
        round: 0,
        createdAt: now,
        ...(durable.ttlMs !== undefined ? { expiresAt: now + durable.ttlMs } : {}),
      };
      await store().put(record, storeCtx());
    }
    return { correlationId, promise: registered.promise };
  }

  /** Resolve a live parked `Deferred` (the inbox path). `false` if none is live. */
  resolve(correlationId: string, response: unknown): boolean {
    return this.deps.registry.resolve(correlationId, response);
  }

  /**
   * Seal a durable record into its `requestState` wire handle (MRTR) — the sealed
   * pointer the client echoes back. Binds `correlationId` + the record's owning
   * `principal` (from its escalation `lineage`, ADR 51) + `round` + expiry.
   * `undefined` when no codec is configured or the record is gone (nothing to
   * seal). The handle's `exp` never outlives the record's own TTL.
   */
  async mintHandle(
    correlationId: string,
    ctx: StoreCtx = this.deps.storeCtx(),
  ): Promise<string | undefined> {
    const { codec } = this.deps;
    if (codec === undefined) return undefined;
    const record = await this.deps.store().get(correlationId, ctx);
    if (record === undefined) return undefined;
    const principal = record.payload.lineage?.find((hop) => hop.principal !== undefined)?.principal;
    const now = Date.now();
    return codec.mint({
      correlationId,
      ...(principal !== undefined ? { principal } : {}),
      round: record.round,
      iat: now,
      exp: record.expiresAt ?? now + DEFAULT_HANDLE_TTL_MS,
    });
  }

  /**
   * Deliver an out-of-band answer carried by a sealed `requestState` handle (the
   * wire path). Verifies the handle (integrity, expiry, key), enforces the MRTR
   * MUST that it is bound to the currently-authenticated principal, then delegates
   * to {@link resume} with the handle's `correlationId`. `invalid` if the handle
   * fails any check or no codec is configured.
   */
  async resumeWithState(
    requestState: string,
    response: unknown,
    opts: { readonly principal?: string; readonly ctx?: StoreCtx } = {},
  ): Promise<ResumeOutcome> {
    const { codec } = this.deps;
    if (codec === undefined) return { status: "invalid" };
    const claims = await codec.verify(requestState);
    if (claims === null) return { status: "invalid" };
    // MRTR §Security MUST: a handle carrying a user identity is only honored for
    // that same authenticated user.
    if (
      opts.principal !== undefined &&
      claims.principal !== undefined &&
      opts.principal !== claims.principal
    ) {
      return { status: "invalid" };
    }
    return this.resume(claims.correlationId, response, opts.ctx ?? this.deps.storeCtx());
  }

  /**
   * Deliver an out-of-band answer to a durable request. Fast path resolves a live
   * `Deferred`; slow path hydrates the record, records the answer, marks it
   * consumed, and hands it back. See {@link ResumeOutcome}.
   */
  async resume(
    correlationId: string,
    response: unknown,
    ctx: StoreCtx = this.deps.storeCtx(),
  ): Promise<ResumeOutcome> {
    if (this.deps.registry.resolve(correlationId, response)) {
      return { status: "resolved-live" };
    }
    const store = this.deps.store();
    const record = await store.get(correlationId, ctx);
    if (record === undefined) return { status: "not-found" };
    if (record.consumedAt !== undefined) return { status: "consumed" };
    const consumed: PendingRequestRecord = {
      ...record,
      responses: { ...(record.responses ?? {}), [correlationId]: response },
      consumedAt: Date.now(),
    };
    await store.put(consumed, ctx);
    return { status: "hydrated", record: consumed };
  }
}
