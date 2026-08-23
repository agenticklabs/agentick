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
 * scope. It is the right shape when it does run: principal descends the spawn
 * tree (ADR 48), so admitting a root admits its tree. That gap is what leaves
 * `session-tree` reaching further than a `session` subscription on the same
 * root — the latter is now carved by topology and the former still is not. It is
 * already named — `TODO(trail-session-resolution-seam)` in
 * `@agentick/transport`'s `authorizeDispatch`, which is where subscribe scopes
 * must route to be seen.
 *
 * Three of the four scopes resolve the same way, and TOPOLOGICALLY (ADR 102):
 * to an ATTACHMENT SET over the caller's own scope nodes. A frame from outside
 * that subtree never transits the buses the caller is attached to, so there is
 * nothing to filter and no emitter's stamping discipline to depend on. The
 * arrival filter this replaces (`onlyOwnedBy`, #299) closed the same leak by
 * inspecting every envelope, and failed closed on any emitter that forgot to
 * stamp (#304).
 *
 * The two UNBOUNDED scopes (`gateway`, `app`) carry the full query on those
 * nodes plus a second attachment at the root restricted to
 * {@link CONTROL_PLANE_NAMES} — fan-in goes up, so a root-level fact reaches a
 * leaf no other way.
 *
 * `session` is the same attachment narrowed to one sessionId by TOPIC, and it
 * resolves NOTHING: live, evicted, and never-created ids are one shape, which is
 * what lets a client mint an id, subscribe, and only then send
 * (`session-doors.md` §4). Cross-principal visibility is what that costs —
 * another principal's session never transits your subtree — and sharing one back
 * is an `attachableNodes` grant (ADR 102 ship order 4), never a filter.
 *
 * `session-tree` is the exception. Subtree membership is a fact only a MOUNTED
 * tree holds, so it stays a root-ring read narrowed on arrival, and it is the
 * one scope that still answers `SessionNotFound`.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 * @see docs/proposals/v2/blueprint/102-subscription-bus-topology.md
 */

import {
  AppNotFoundError,
  GATEWAY_CAPABILITIES_CHANGED,
  SessionNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type EventEnvelope,
  type EventQuery,
  type GatewayHarnessProtocol,
  type IngressIdentity,
  type SubscribeParams,
  type WireExtension,
} from "@agentick/spec";
import { busAsyncIterator, nameMatches } from "@agentick/runtime";

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
 * The control-plane frames a node attachment ALSO hears, via a second
 * attachment at the ROOT. Fan-in goes up, so a root-level fact never reaches a
 * leaf on its own; mirroring it into every node instead would cost write
 * amplification proportional to the node count plus a second emitter discipline
 * to get wrong (ADR 102 §4).
 *
 * Selection is by TOPIC — what you hear, never whose frame arrived — so the
 * no-per-event-filter doctrine holds. HOST-OWNED per the ADR's resolved
 * questions: extension registration of control-plane surfaces waits for a third
 * consumer. The one entry is the one behavioral guarantee the arrival filter
 * this replaces made explicitly (its no-sessionId branch also let app-level
 * lifecycle across tenants through — a metadata leak it named as a soft edge,
 * and this list closes).
 */
const CONTROL_PLANE_NAMES: readonly string[] = [GATEWAY_CAPABILITIES_CHANGED];

/**
 * One bus the caller is attached to, with the query it reads through.
 *
 * TODO(gateway-scope-subscription): what remains of #297 is the OPERATOR view —
 * a caller entitled to a node ABOVE their own. Under topology that is no longer
 * a filter question but an attachment one: `attachableNodes` already returns a
 * list, so an operator's entry is a broader path in it, authorized ONCE at
 * subscribe time via the authorizer's scope label (`AuthorizeInput.scope`).
 */
interface Attachment {
  readonly events: AsyncIterable<EventEnvelope>;
  /** Release the node lease this attachment holds, if any. */
  readonly release?: () => void;
}

interface OpenedScope {
  readonly iterable: AsyncIterable<EventEnvelope>;
  /**
   * Release every ROOT bus iterator NOW, then the node leases.
   * `busAsyncIterator.return()` interrupts the producer fiber and resolves any
   * pending pull immediately — which the generator wrappers (`onlyInTree` /
   * `withSnapshots` / the merge) cannot do: an async generator's `return()`
   * queues behind its suspended inner await, so tearing down from the OUTSIDE
   * hangs until the next event arrives.
   */
  readonly closeRoot: () => Promise<void>;
}

function opened(
  attachments: readonly Attachment[],
  wrap?: (inner: AsyncIterable<EventEnvelope>) => AsyncIterable<EventEnvelope>,
): OpenedScope {
  const roots = attachments.map((a) => a.events[Symbol.asyncIterator]());
  const merged: AsyncIterable<EventEnvelope> =
    roots.length === 1
      ? { [Symbol.asyncIterator]: () => roots[0]! }
      : { [Symbol.asyncIterator]: () => mergeIterators(roots) };
  return {
    iterable: wrap ? wrap(merged) : merged,
    closeRoot: async () => {
      await Promise.all(roots.map((root) => root.return?.()));
      for (const attachment of attachments) attachment.release?.();
    },
  };
}

/**
 * Interleave the attachment set, one outstanding pull per iterator. Each
 * settled pull is re-issued for its own source only, so a quiet attachment
 * never holds up a busy one and a `return()` on any source retires just that
 * source — which is what lets {@link OpenedScope.closeRoot} unblock a merge
 * parked on several pending pulls at once.
 */
async function* mergeIterators(
  iterators: readonly AsyncIterator<EventEnvelope>[],
): AsyncGenerator<EventEnvelope> {
  const pending = new Map<
    AsyncIterator<EventEnvelope>,
    Promise<{
      readonly from: AsyncIterator<EventEnvelope>;
      readonly step: IteratorResult<EventEnvelope>;
    }>
  >();
  const pull = (from: AsyncIterator<EventEnvelope>): void => {
    pending.set(
      from,
      from.next().then((step) => ({ from, step })),
    );
  };
  for (const iterator of iterators) pull(iterator);
  try {
    while (pending.size > 0) {
      const { from, step } = await Promise.race(pending.values());
      pending.delete(from);
      if (step.done === true) continue;
      pull(from);
      yield step.value;
    }
  } finally {
    for (const iterator of pending.keys()) void iterator.return?.();
  }
}

/**
 * Resolve the scope to its attachment set. `null` means the scope's target
 * wasn't found — which only `app` and `session-tree` can be, because they are
 * the only kinds that still name something that has to exist.
 */
function openScopeEvents(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
  paths: readonly (readonly string[])[],
): OpenedScope | null {
  const scope = params.scope;
  if (scope.kind === "gateway") {
    return opened(attachUnbounded(gateway, paths, params.query, gateway));
  }
  if (scope.kind === "app") {
    const app = gateway.app(scope.id);
    if (!app) return null;
    return opened(attachUnbounded(gateway, paths, params.query, app));
  }
  if (scope.kind === "session") {
    return opened(
      attachToOwnNodes(gateway, paths, narrowToSession(params.query, scope.id), gateway),
    );
  }
  if (scope.kind === "session-tree") {
    const app = ownerApp(gateway, scope.id);
    if (!app) return null;
    return opened([{ events: app.events(params.query) as AsyncIterable<EventEnvelope> }], (inner) =>
      onlyInTree(inner, app, scope.id),
    );
  }
  return null;
}

/**
 * The caller as the node resolvers see them. `identity` is the structured
 * ingress stamp; `principal` alone is what the `as()` doors leave, and both
 * resolvers key on the principal either way.
 */
function identityOf(ctx: {
  readonly identity?: IngressIdentity;
  readonly principal?: string;
}): IngressIdentity | undefined {
  if (ctx.identity !== undefined) return ctx.identity;
  return ctx.principal !== undefined ? { principal: ctx.principal } : undefined;
}

/** The scope's own root — the gateway's bus, or one app's. */
interface ScopeRoot {
  events(query?: EventQuery): AsyncIterable<unknown>;
}

/** A caller whose every attachable path is `[]` reads the scope's root ring itself. */
function ownsRoot(paths: readonly (readonly string[])[]): boolean {
  return paths.every((path) => path.length === 0);
}

/**
 * The caller's own nodes, read through `query`. An unauthenticated caller
 * resolves to `[]`, which IS the root, so the local/no-auth pole keeps seeing
 * everything (ADR 102 §Resolved questions).
 */
function attachToOwnNodes(
  gateway: GatewayHarnessProtocol,
  paths: readonly (readonly string[])[],
  query: EventQuery | undefined,
  root: ScopeRoot,
): readonly Attachment[] {
  if (ownsRoot(paths)) return [{ events: root.events(query) as AsyncIterable<EventEnvelope> }];
  return paths.map((path) => {
    const lease = gateway.attachScopeNode(path);
    return {
      events: {
        [Symbol.asyncIterator]: () => busAsyncIterator(lease.bus, query ?? {}),
      } as AsyncIterable<EventEnvelope>,
      release: () => lease.release(),
    };
  });
}

/**
 * `root` restricted to the control plane. A caller whose only node IS the root
 * hears these already through its full-query attachment, so the entry would be a
 * strictly narrower duplicate.
 *
 * The attachment carries the caller's own query too, minus its name: a
 * subscriber that asked for model deltas did not ask to be told the capability
 * set moved, and the attachment set must not widen what was requested.
 */
function attachToControlPlane(
  paths: readonly (readonly string[])[],
  query: EventQuery | undefined,
  root: ScopeRoot,
): readonly Attachment[] {
  if (ownsRoot(paths)) return [];
  return CONTROL_PLANE_NAMES.filter(
    (name) => query?.name === undefined || nameMatches(name, query.name),
  ).map((name) => ({
    events: root.events({ ...query, name: { exact: name } }) as AsyncIterable<EventEnvelope>,
  }));
}

/** An unbounded scope (`gateway` / `app`): own nodes, plus the control plane. */
function attachUnbounded(
  gateway: GatewayHarnessProtocol,
  paths: readonly (readonly string[])[],
  query: EventQuery | undefined,
  root: ScopeRoot,
): readonly Attachment[] {
  return [
    ...attachToOwnNodes(gateway, paths, query, root),
    ...attachToControlPlane(paths, query, root),
  ];
}

/**
 * The caller's query, narrowed to one session id. Topic selection inside a
 * subtree the caller already owns — choosing WHAT they hear, never inspecting
 * WHOSE frame arrived.
 */
function narrowToSession(query: EventQuery | undefined, sessionId: string): EventQuery {
  return { ...(query ?? {}), scope: { ...(query?.scope ?? {}), sessionId } };
}

/**
 * Whether a session owned by `principal` sits inside a node this caller may
 * attach to. The live stream gets this from the bus tree and needs no such
 * question asked; a channel SNAPSHOT is a read of session state rather than a
 * delivery, so it asks the paths directly — once, at subscribe, which is where
 * ADR 102 puts every authorization decision.
 */
function withinAttachment(
  gateway: GatewayHarnessProtocol,
  paths: readonly (readonly string[])[],
  principal: string | undefined,
): boolean {
  const node = gateway.sessionNodeFor(principal === undefined ? {} : { principal });
  return paths.some((path) => path.every((segment, depth) => node[depth] === segment));
}

/** Fully-qualified prefix every channel event's `name` carries. */
const CHANNEL_NAME_PREFIX = "session:channel:";

/**
 * When a subscription targets exactly ONE session channel, render that
 * channel's current snapshot(s) as the opening frame(s). Empty unless: the
 * scope is a session or a session tree, the query is a single-channel
 * `{ exact }` name under `session:channel:`, the target session is LIVE and
 * inside a node the caller may attach to, AND a provider owns that channel. An
 * evicted or speculative id has no snapshot to open on and simply gets none —
 * the subscription is still admitted.
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
  paths: readonly (readonly string[])[],
): Promise<readonly EventEnvelope[]> {
  const scope = params.scope;
  if (scope.kind !== "session" && scope.kind !== "session-tree") return [];
  const name = params.query?.name;
  if (name === undefined || !("exact" in name)) return [];
  if (!name.exact.startsWith(CHANNEL_NAME_PREFIX)) return [];
  const channel = name.exact.slice(CHANNEL_NAME_PREFIX.length);
  const app = ownerApp(gateway, scope.id);
  if (!app) return [];
  // `session-tree` is still reached by naming its root id (ADR 102 ship order
  // 4), live stream included, so only the carved scope asks.
  if (
    scope.kind === "session" &&
    !withinAttachment(gateway, paths, app.getSession(scope.id)?.principal)
  ) {
    return [];
  }
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
      // ONE node resolution per subscribe: the attachment set and the opening
      // snapshot both answer to it.
      const paths = ctx.gateway.attachableNodesFor(identityOf(ctx));
      const opened = openScopeEvents(ctx.gateway, params, paths);
      if (!opened) {
        // Name the thing that is missing. Not cosmetic: a client deciding
        // whether to re-ask needs to tell "this scope is not here (yet)" from
        // "refused", and it reads that off the JSON-RPC code — SessionNotFound
        // / AppNotFound, both of which a restarted gateway answers about
        // everything the adopter has not rebuilt yet. Naming a session scope
        // as an app whose id stringified to `[object Object]` told a caller
        // neither.
        if (params.scope.kind === "session-tree") {
          // A tree is named by its ROOT, so an unknown root is an unknown
          // session, and the id in the error is the one the caller asked about.
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
      const snapEnvelopes = await resolveChannelSnapshots(ctx.gateway, params, paths);
      const iterable =
        snapEnvelopes.length > 0 ? withSnapshots(snapEnvelopes, opened.iterable) : opened.iterable;

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
      // Teardown MUST release the root bus iterator, not merely flag the
      // drain: the drain parks inside `await next()`, and a flag is only
      // observed when the next MATCHING event arrives — which for an idle or
      // dead session is never. Every client refresh re-subscribes under fresh
      // ids while the old connection's flag-only cleanup left its bus
      // subscriber parked forever: the unbounded subscriber growth behind the
      // 2026-08-18 event-loop saturation outage.
      let cancelled = false;
      const sub = ctx.wire.registerSubscription(params.subscriptionId, async () => {
        cancelled = true;
        await opened.closeRoot();
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
