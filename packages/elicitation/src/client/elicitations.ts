/**
 * Client-side elicitation resource handle — the far side of the
 * `session:channel:elicitation` request channel plus the
 * `session/respond_to_elicitation` reply command, on the unified `ClientHandle`
 * contract (B2 slice 3, `docs/proposals/v2/client-handles.md`).
 *
 * `elicitationsHandle` folds the elicitation channel into the set of PENDING
 * asks and presents them as ITEM HANDLES: `list()` returns
 * `ClientElicitationHandle[]` — each an ask's data (correlationId, message,
 * schema, hints, …) PLUS its bound verbs `accept`/`decline`/`cancel`. The item
 * handle is constructed IDENTICALLY whether the ask arrived via the slice-2
 * SNAPSHOT frame (pending before this client connected — the live-only fix) or a
 * live request delta: ONE constructor, both sources. So a client connecting
 * mid-ask sees the outstanding prompt in `list()` and `list()[0].accept(value)`
 * round-trips exactly like a live one (north-star §1's dialog-button line).
 *
 * The contract:
 *   - CORE — `subscribe(cb)` (zero-arg store contract; fires when the pending set
 *     changes) + `close()`.
 *   - {@link Enumerable}<{@link ClientElicitationHandle}> — `list()` = current
 *     pending asks (as item handles), `get(correlationId)`.
 *   - {@link Respondable} — `respond(correlationId, body)`, the by-id escape hatch
 *     for code not holding an item handle (the item's `.accept`/… route the same
 *     wire path). Replying — by verb or by id — removes the ask from `list()`.
 *
 * Async iteration is REMOVED (principle #4 — no handle is `AsyncIterable`;
 * iterate BOUNDED things, observe UNBOUNDED ones). The frame feed survives only
 * internally, as the fold's input.
 *
 * Depends on `@agentick/client-core` (`liveStore`) + `@agentick/spec`
 * types + `@agentick/utils` only — NOT on the elicitation harness runtime,
 * so it stays out of a browser bundle. Mirrors the tasks/knobs `/client`
 * convention.
 *
 * @verifiedBy packages/elicitation/src/client/__tests__/elicitations-handle.conformance.spec.ts
 * @verifiedBy packages/transport-in-process/src/__tests__/elicitation.spec.ts
 */

import {
  liveStore,
  type ClientHandle,
  type Enumerable,
  type Respondable,
} from "@agentick/client-core";
import type {
  ClientElicitation,
  ClientElicitationHandle,
  ClientTransport,
  Cursor,
  EventEnvelope,
  Unsubscribe,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { ELICITATION_CHANNEL_FQN, type PendingElicitation } from "../channel.js";

/**
 * The client surface the elicitation handle consumes — a subscribe stream (the
 * fold's input) + `request` (the reply command). A minimal
 * `Pick<ClientTransport, …>`, so a full `ClientProtocol` satisfies it (floors,
 * not ceilings). Writes ride `transport.request` — uniform with `session.knobs`
 * / `session.tasks` (client-level `client.use` interception is a later slice).
 */
export interface ElicitationClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/** The reply body a caller supplies — the outcome plus its optional payload. */
export interface ElicitationReplyBody {
  readonly outcome: "accepted" | "declined" | "cancelled";
  readonly value?: unknown;
  readonly reason?: string;
}

/** The reply body for a pending elicitation addressed by `correlationId` (the
 * free-function `respondToElicitation` shape). */
export interface ElicitationReplyInput extends ElicitationReplyBody {
  readonly correlationId: string;
}

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The elicitation resource handle — the `ClientHandle` contract:
 * {@link Enumerable} pending asks (as item handles) + {@link Respondable} by id.
 * A plain structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface ElicitationsHandle
  extends
    ClientHandle,
    Enumerable<ClientElicitationHandle<unknown>>,
    Respondable<ElicitationReplyBody> {
  /** The current PENDING asks as item handles (each with `.accept`/`.decline`/`.cancel`). */
  list(): readonly ClientElicitationHandle<unknown>[];
  /** Look one pending ask up by `correlationId`. */
  get(correlationId: string): ClientElicitationHandle<unknown> | undefined;
  /**
   * Reply to a pending ask by `correlationId` (the escape hatch for code not
   * holding the item handle). Rejects an unknown/already-answered id. The item's
   * own `.accept`/`.decline`/`.cancel` route the same wire path.
   */
  respond(correlationId: string, body: ElicitationReplyBody): Promise<void>;
  /** Tear down the underlying elicitation subscription. */
  close(): void;
}

/**
 * Open the elicitation resource handle. Folds the channel's SNAPSHOT frame
 * (pending asks, pre-connection) and live request deltas into the pending set;
 * `list()`/`get()` read it; replying removes the ask. Single-consumer.
 */
export function elicitationsHandle(
  client: ElicitationClient,
  sessionId: string,
  fromCursor?: Cursor,
): ElicitationsHandle {
  const sub = client.transport.subscribe(
    { kind: "session", id: sessionId },
    { surface: "session", name: { exact: ELICITATION_CHANNEL_FQN } },
    fromCursor,
  );

  const pending = new Map<string, ClientElicitationHandle<unknown>>();
  const store = liveStore<readonly ClientElicitationHandle<unknown>[], void>([], () => {
    void sub.close();
  });
  const notify = (): void => store.set([...pending.values()]);

  // Answering an ask (by verb or by id) removes it from the pending set locally
  // — the reply resolves the op server-side; nothing more will arrive for it.
  const resolveLocal = (correlationId: string): void => {
    if (pending.delete(correlationId)) notify();
  };

  const send = async (correlationId: string, body: ElicitationReplyBody): Promise<void> => {
    await respondToElicitation(client, sessionId, { correlationId, ...body });
    resolveLocal(correlationId);
  };

  const add = (elic: ClientElicitation): void => {
    pending.set(
      elic.correlationId,
      wrapHandle(elic, (body) => send(elic.correlationId, body)),
    );
  };

  // The fold: SNAPSHOT frame seeds pending (pre-connection), live request deltas
  // add. Snapshot is discriminated by `kind: "snapshot"` and (per the channel
  // contract) carries NO `metadata.requestType: "request"`, so it is checked
  // FIRST — before the live-delta request guard.
  void (async () => {
    for await (const frame of sub) {
      if (store.closed) return;
      const env = frame.envelope as EnvelopeWithMetadata;
      const snapshot = asSnapshotFrame(env.payload);
      if (snapshot) {
        // The snapshot is the AUTHORITATIVE pending set (opening frame, or a
        // re-seed after a gap) — clear then reseed so answered-while-away asks
        // don't linger.
        pending.clear();
        for (const req of snapshot.requests) {
          const parsed = buildElicitation(req.correlationId, req.replyTo, req.payload);
          if (parsed) add(parsed);
        }
        notify();
        continue;
      }
      // Only request envelopes — responses go on the inbox, not the bus.
      if (env.metadata?.requestType !== "request") continue;
      const parsed = buildElicitation(
        env.metadata.correlationId,
        env.metadata.replyTo,
        env.payload,
      );
      if (!parsed) continue;
      add(parsed);
      notify();
    }
  })();

  return {
    list: () => store.get(),
    get: (correlationId) => pending.get(correlationId),
    subscribe: (cb: () => void): Unsubscribe => store.subscribe(() => cb()),
    close: () => store.close(),
    respond: (correlationId, body) => {
      if (!pending.has(correlationId)) {
        return Promise.reject(new Error(`unknown elicitation "${correlationId}"`));
      }
      return send(correlationId, body);
    },
  };
}

/**
 * Reply to a pending elicitation by `correlationId` — the direct command for
 * code that does not hold a {@link ClientElicitationHandle}. Routes through
 * `session/respond_to_elicitation` (the handle's `respond` and the item verbs
 * use the same path).
 */
export async function respondToElicitation(
  client: ElicitationClient,
  sessionId: string,
  input: ElicitationReplyInput,
): Promise<void> {
  await client.transport.request("session/respond_to_elicitation", {
    sessionId,
    correlationId: input.correlationId,
    outcome: input.outcome,
    ...omitUndefined({ value: input.value, reason: input.reason }),
  });
}

/** Narrow an envelope payload to the channel's opening SNAPSHOT frame. */
function asSnapshotFrame(
  payload: unknown,
): { readonly requests: readonly PendingElicitation[] } | undefined {
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { kind?: unknown }).kind === "snapshot" &&
    Array.isArray((payload as { requests?: unknown }).requests)
  ) {
    return payload as { readonly requests: readonly PendingElicitation[] };
  }
  return undefined;
}

/**
 * Build a {@link ClientElicitation} from a correlationId + replyTo + the
 * elicitation wire payload — the ONE constructor shared by the snapshot path
 * (fields off a {@link PendingElicitation}) and the live path (fields off the
 * envelope metadata + payload).
 */
function buildElicitation(
  correlationId: unknown,
  replyTo: unknown,
  payload: unknown,
): ClientElicitation | undefined {
  if (typeof correlationId !== "string" || typeof replyTo !== "string") return undefined;
  const body = payload as
    | {
        readonly mode?: "form" | "url";
        readonly message?: string;
        readonly schema?: Readonly<Record<string, unknown>>;
        readonly url?: string;
        readonly elicitationId?: string;
        readonly hints?: Readonly<Record<string, unknown>>;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | undefined;
  if (!body || typeof body.message !== "string") return undefined;
  return {
    correlationId,
    replyTo,
    mode: body.mode ?? "form",
    message: body.message,
    ...omitUndefined({
      schema: body.schema,
      url: body.url,
      elicitationId: body.elicitationId,
      hints: body.hints,
      metadata: body.metadata,
    }),
    receivedAt: Date.now(),
  };
}

function wrapHandle(
  elic: ClientElicitation,
  send: (body: ElicitationReplyBody) => Promise<void>,
): ClientElicitationHandle<unknown> {
  return {
    ...elic,
    accept(value: unknown): Promise<void> {
      return send({ outcome: "accepted", value });
    },
    decline(reason?: string): Promise<void> {
      return send(reason !== undefined ? { outcome: "declined", reason } : { outcome: "declined" });
    },
    cancel(reason?: string): Promise<void> {
      return send(
        reason !== undefined ? { outcome: "cancelled", reason } : { outcome: "cancelled" },
      );
    },
  };
}
