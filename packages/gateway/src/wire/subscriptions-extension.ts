/**
 * `subscriptionsWireExtension` — framework-supplied `WireExtension`
 * that projects the `sub/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Wire methods:
 *   - `sub/subscribe` — open a durable subscription on a scope's
 *     event bus under the CLIENT-allocated `params.subscriptionId`. Uses
 *     `ctx.wire.registerSubscription(id, cleanup)` to adopt that id + fan out
 *     `notifications/subscription/event` frames under it, and echoes it in
 *     the response as confirmation.
 *   - `sub/unsubscribe` — client-initiated teardown. Uses
 *     `ctx.wire.closeSubscription(id)`.
 *
 * The namespace prefix rename (bare `subscribe` / `unsubscribe` →
 * `sub/subscribe` / `sub/unsubscribe`) satisfies the wire-extension
 * validator (every method must start with `${namespace}/`) and
 * closes #300.
 *
 * ## Scope, and what each one is for
 *
 * `gateway` / `app` / `session` / `session-tree` ({@link SubscriptionScope}).
 * The last is the living-subtree rung: a session AND its live spawn
 * descendants, which is how a client attached to a root sees a detached task's
 * or a cross-turn sub-agent's channels — work that outlives any turn and so has
 * no turn stream to ride. Its turn-scoped twin is `session/send`'s `fanIn`
 * (one turn's progress, widened to that turn's descendants).
 *
 * ## Authorization
 *
 * Every scope kind passes through the dispatcher's verb-derived `sub:subscribe`
 * label. Scope-target resolution — the same-principal rule and the session's
 * scope ceiling — keys on `params.sessionId`, which these params do not carry
 * (the target rides `params.scope.id`), so it does not run for ANY subscription
 * scope. `session-tree` therefore adds no reachability a `session` subscription
 * did not already have, and it is the right shape when it does run: principal
 * descends the spawn tree (ADR 48), so admitting a root admits its tree. That
 * gap is already named — `TODO(trail-session-resolution-seam)` in
 * `@agentick/transport`'s `authorizeDispatch`, which is where subscribe scopes
 * must route to be seen.
 *
 * Until they do, the two UNBOUNDED scopes carry their own admission: `gateway`
 * and `app` are narrowed to the caller's principal by {@link onlyOwnedBy}.
 * Without it, holding `sub:subscribe` was enough to receive every tenant's
 * traffic — a live leak (#297), not a theoretical one, since a thread list
 * subscribes at gateway scope by design.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  AppNotFoundError,
  SessionNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type EventEnvelope,
  type GatewayHarnessProtocol,
  type SubscribeParams,
  type WireExtension,
} from "@agentick/spec";

/** The app whose LIVE registry holds `sessionId`, or `undefined`. */
function ownerApp(
  gateway: GatewayHarnessProtocol,
  sessionId: string,
): AppHarnessProtocol | undefined {
  for (const app of gateway.apps() as readonly AppHarnessProtocol[]) {
    if (app.getSession(sessionId)) return app;
  }
  return undefined;
}

/**
 * Admit only what the live tree rooted at `rootSessionId` emits.
 *
 * The subtree cannot be expressed as a bus-side `scope` filter — a query names
 * ONE sessionId, and the membership set changes on every spawn — so the
 * subscription is widened to the owning app and narrowed on arrival, the same
 * shape `session/send`'s `fanIn` uses one rung down. An envelope with no
 * `sessionId` (app-level lifecycle) belongs to no session and is refused: this
 * scope is about the tree's sessions.
 */
async function* onlyInTree(
  live: AsyncIterable<EventEnvelope>,
  app: AppHarnessProtocol,
  rootSessionId: string,
): AsyncGenerator<EventEnvelope> {
  for await (const envelope of live) {
    const sessionId = envelope.scope.sessionId;
    if (sessionId !== undefined && app.sessionTreeContains(rootSessionId, sessionId)) {
      yield envelope;
    }
  }
}

/**
 * Admit only what the CALLER owns — the identity axis of {@link onlyInTree}'s
 * lineage one, and the thing that makes the two unbounded scopes tenant-safe.
 *
 * TENANT DATA is what a session emits, so naming a session is what subjects an
 * envelope to the rule — and an envelope that names one had better be stamped,
 * because an UNSTAMPED session envelope fails CLOSED. That is the whole point:
 * a channel frame that forgot to stamp itself must not become the way around
 * the filter, and the fix for one belongs at its emitter.
 *
 * An envelope that names NO session is control plane — `gateway:capabilities:
 * changed` carries `gatewayId` and nothing else — and passes. Filtering it out
 * would break capability reactivity for every authenticated deployment while
 * protecting nothing: it is a signal that the extension set moved, with no
 * tenant content to leak. The soft edge, stated rather than discovered: an
 * app-level operation event carries no session either, so app lifecycle is
 * visible across tenants. That is a metadata surface, not a data one, and
 * closing it means stamping the emitter — not widening this predicate, which
 * would only move the hole.
 *
 * A principal-LESS deployment (the local pole, no authenticator) matches
 * `undefined === undefined` and is unaffected: nothing is stamped, nobody is
 * authenticated, everything is admitted exactly as before.
 *
 * INTERIM per #297. The structural end-state is bus topology — a subscriber
 * ATTACHES to the bus it is entitled to, so isolation is a property of what you
 * are connected to rather than of a predicate every new event kind has to
 * remember to satisfy. This filter is the stopgap that closes the live leak.
 */
async function* onlyOwnedBy(
  live: AsyncIterable<EventEnvelope>,
  principal: string | undefined,
): AsyncGenerator<EventEnvelope> {
  for await (const envelope of live) {
    if (envelope.scope.sessionId === undefined) {
      yield envelope;
    } else if (envelope.scope.principal === principal) {
      yield envelope;
    }
  }
}

/**
 * Resolve the scope's event iterable — mirrors the pre-#303
 * `openScopeEvents` helper. `null` return means the scope's target
 * (app or session) wasn't found.
 *
 * The two UNBOUNDED scopes (`gateway`, and `app` — which the shared default bus
 * makes gateway-wide in practice) are narrowed to the caller's principal on
 * arrival by {@link onlyOwnedBy}. The two session scopes are already bounded by
 * an id the caller named.
 *
 * TODO(gateway-scope-subscription): what remains of #297 is the OPERATOR view —
 * a caller entitled to the whole gateway rather than to one tenant's slice of
 * it. Deliberately not built here: there is no privileged-caller notion in this
 * layer to key it off, and inventing one inside a leak fix is how a privilege
 * escalation gets shipped. Its natural home is the authorizer's existing scope
 * label (`AuthorizeInput.scope`), asked once at subscribe time.
 */
function openScopeEvents(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
  principal: string | undefined,
): AsyncIterable<EventEnvelope> | null {
  const scope = params.scope;
  if (scope.kind === "gateway") {
    return onlyOwnedBy(gateway.events(params.query) as AsyncIterable<EventEnvelope>, principal);
  }
  if (scope.kind === "app") {
    const app = gateway.app(scope.id);
    if (!app) return null;
    return onlyOwnedBy(app.events(params.query) as AsyncIterable<EventEnvelope>, principal);
  }
  if (scope.kind === "session") {
    const app = ownerApp(gateway, scope.id);
    if (!app) return null;
    const query = {
      ...(params.query ?? {}),
      scope: { ...(params.query?.scope ?? {}), sessionId: scope.id },
    };
    return app.events(query) as AsyncIterable<EventEnvelope>;
  }
  if (scope.kind === "session-tree") {
    const app = ownerApp(gateway, scope.id);
    if (!app) return null;
    return onlyInTree(app.events(params.query) as AsyncIterable<EventEnvelope>, app, scope.id);
  }
  return null;
}

/** Fully-qualified prefix every channel event's `name` carries. */
const CHANNEL_NAME_PREFIX = "session:channel:";

/**
 * When a subscription targets exactly ONE session channel, render that
 * channel's current snapshot(s) as the opening frame(s). Empty unless: the
 * scope is a session or a session tree, the query is a single-channel
 * `{ exact }` name under `session:channel:`, the target session resolves, AND
 * a provider owns that channel.
 *
 * A `session` scope yields at most ONE frame. A `session-tree` scope yields one
 * per LIVE MEMBER that has the channel, in {@link AppHarnessProtocol.sessionTree}
 * order — root first, then breadth-first — so a late joiner paints the root's
 * board before its descendants'. A member with nothing on that channel
 * contributes nothing rather than an empty frame.
 *
 * Members that spawn AFTER this runs need no retro-splice: a new session's
 * channel emits as it populates, and those deltas arrive on the live tail the
 * arrival filter is already admitting. The splice is for what happened BEFORE
 * the subscriber arrived, which is precisely what the live stream cannot
 * replay.
 */
async function resolveChannelSnapshots(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
): Promise<readonly EventEnvelope[]> {
  const scope = params.scope;
  if (scope.kind !== "session" && scope.kind !== "session-tree") return [];
  const name = params.query?.name;
  if (name === undefined || !("exact" in name)) return [];
  if (!name.exact.startsWith(CHANNEL_NAME_PREFIX)) return [];
  const channel = name.exact.slice(CHANNEL_NAME_PREFIX.length);
  const app = ownerApp(gateway, scope.id);
  if (!app) return [];
  const members = scope.kind === "session" ? [scope.id] : app.sessionTree(scope.id);
  const snapshots: EventEnvelope[] = [];
  for (const id of members) {
    const snap = await app.getSession(id)?.channelSnapshot(channel);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}

/**
 * Prepend the channel snapshots as the FIRST frames, then relay live deltas
 * on the same stream (K8s `sendInitialEvents` / watch-list).
 */
async function* withSnapshots(
  snaps: readonly EventEnvelope[],
  live: AsyncIterable<EventEnvelope>,
): AsyncGenerator<EventEnvelope> {
  yield* snaps;
  yield* live;
}

// TODO(wire-resume): `SubscribeParams.fromCursor` is ACCEPTED AND IGNORED
// here — `openScopeEvents` builds its query from `scope` + `query` only, and
// the stream opens at head. The client half is complete (it tracks each
// subscription's `lastCursor` and resends it as `fromCursor` on reconnect,
// `BaseClientTransport`), and it keeps sending it so the day this is
// implemented needs no client change. Until then the server answers
// `initialize` with `cursorResume: false`; the gap-free cold start a client
// DOES get is the channel snapshot frame below, not replay.
//
// Real resume is a subsystem, not a parameter, and needs three things that do
// not exist:
//   1. RETENTION — a bounded per-scope ring on the bus (`gateway.events` is a
//      live fan-out today), with a declared window and a memory ceiling.
//   2. REPLAY — open at `fromCursor` by draining retained events before
//      splicing the live tail, without dropping or duplicating across the
//      seam (the same overlap the snapshot path already reasons about).
//   3. EVICTION — when the requested cursor predates the window, tell the
//      client rather than silently starting at head: that is the reserved
//      `notifications/subscription/evicted` frame (`SubscriptionEvictedParams`
//      in `@agentick/spec`), whose producer is precisely this step.
// Landing 1+2 without 3 is the dangerous half: a client that asked to resume
// and was quietly given head believes it has a gap-free stream.
export const subscriptionsWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway#subscriptions",
  namespace: "sub",
  version: "1.0.0",
  methods: {
    "sub/subscribe": async (params, ctx) => {
      // Subscribe to the live bus FIRST (openScopeEvents pins the cursor at
      // head; the ring buffer retains events), THEN read the channel
      // snapshot. Opening the live stream before the snapshot closes the
      // gap where a delta could land between snapshot and subscribe; the
      // tiny overlap (a delta counted in both the snapshot version and the
      // live tail) is absorbed by the client's idempotent, version-gated
      // reducer.
      let iterable = openScopeEvents(ctx.gateway, params, ctx.principal);
      if (!iterable) {
        // Name the thing that is missing. Not cosmetic: a client deciding
        // whether to re-ask needs to tell "this scope is not here (yet)" from
        // "refused", and it reads that off the JSON-RPC code — SessionNotFound
        // / AppNotFound, both of which a restarted gateway answers about
        // everything the adopter has not rebuilt yet. Naming a session scope
        // as an app whose id stringified to `[object Object]` told a caller
        // neither.
        if (params.scope.kind === "session" || params.scope.kind === "session-tree") {
          // A tree is named by its ROOT, so an unknown root is an unknown
          // session — the same answer, and the id in it is the one the caller
          // asked about.
          throw new SessionNotFoundError({ sessionId: params.scope.id });
        }
        throw new AppNotFoundError({
          appId: params.scope.kind === "app" ? params.scope.id : params.scope.kind,
        });
      }

      // Open-with-snapshot: when this is a single-channel subscription and a
      // provider owns the channel, the FIRST frames the subscriber receives are
      // the channel's current snapshots — one for a session scope, one per live
      // tree member (root first) for a session-tree scope; live deltas follow on
      // the same stream.
      const snapEnvelopes = await resolveChannelSnapshots(ctx.gateway, params);
      if (snapEnvelopes.length > 0) {
        iterable = withSnapshots(snapEnvelopes, iterable);
      }

      // The id is the CLIENT's, adopted verbatim (`SubscribeParams.
      // subscriptionId`). That is what makes the drain below race-free: the
      // client registered its stream under this id BEFORE it wrote the request
      // frame, so whichever of the two frames lands first — this drain's
      // opening snapshot or the RPC response echoing the id — the snapshot is
      // routable on arrival. There is no server-side ordering to arrange, and
      // none would help: over `@agentick/transport-http` the response rides
      // the POST body while notifications ride a separate SSE GET, two
      // connections with no ordering relation. A collision on this connection
      // throws InvalidParams out of `registerSubscription`.
      let cancelled = false;
      const sub = ctx.wire.registerSubscription(params.subscriptionId, async () => {
        cancelled = true;
      });

      // Drain the iterable in the background; per-event fan-out via
      // sub.publish (which auto-tracks the cursor). Server-initiated
      // teardown on iteration error goes through sub.close.
      (async () => {
        try {
          for await (const envelope of iterable) {
            if (cancelled) return;
            sub.publish(envelope);
          }
        } catch (e) {
          sub.close({
            code: -32603, // JSON-RPC InternalError
            message: e instanceof Error ? e.message : String(e),
          });
        }
      })();

      return { subscriptionId: sub.id };
    },
    "sub/unsubscribe": async ({ subscriptionId }, ctx) => {
      ctx.wire.closeSubscription(subscriptionId);
      return null;
    },
  },
});
