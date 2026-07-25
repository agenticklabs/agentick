/**
 * `subscriptionsWireExtension` — framework-supplied `WireExtension`
 * that projects the `sub/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Wire methods:
 *   - `sub/subscribe` — open a durable subscription on a scope's
 *     event bus. Uses `ctx.transport.registerSubscription(...)` to
 *     allocate a server-side id + fan out
 *     `notifications/subscription/event` frames.
 *   - `sub/unsubscribe` — client-initiated teardown. Uses
 *     `ctx.transport.closeSubscription(id)`.
 *
 * The namespace prefix rename (bare `subscribe` / `unsubscribe` →
 * `sub/subscribe` / `sub/unsubscribe`) satisfies the wire-extension
 * validator (every method must start with `${namespace}/`) and
 * closes #300.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  AppNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type EventEnvelope,
  type GatewayHarnessProtocol,
  type SubscribeParams,
  type WireExtension,
} from "@agentick/spec";

/**
 * Resolve the scope's event iterable — mirrors the pre-#303
 * `openScopeEvents` helper. `null` return means the scope's target
 * (app or session) wasn't found.
 */
function openScopeEvents(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
): AsyncIterable<EventEnvelope> | null {
  const scope = params.scope;
  if (scope.kind === "gateway") {
    return gateway.events(params.query) as AsyncIterable<EventEnvelope>;
  }
  if (scope.kind === "app") {
    const app = gateway.app(scope.id);
    if (!app) return null;
    return app.events(params.query) as AsyncIterable<EventEnvelope>;
  }
  if (scope.kind === "session") {
    for (const app of gateway.apps() as readonly AppHarnessProtocol[]) {
      const sess = app.getSession(scope.id);
      if (sess) {
        const query = {
          ...(params.query ?? {}),
          scope: { ...(params.query?.scope ?? {}), sessionId: scope.id },
        };
        return app.events(query) as AsyncIterable<EventEnvelope>;
      }
    }
    return null;
  }
  return null;
}

/** Fully-qualified prefix every channel event's `name` carries. */
const CHANNEL_NAME_PREFIX = "session:channel:";

/**
 * When a subscription targets exactly ONE session channel, resolve the
 * owning session and render the channel's current snapshot as the opening
 * frame. Returns `undefined` unless: the scope is a session, the query is a
 * single-channel `{ exact }` name under `session:channel:`, a session
 * resolves, AND a provider owns that channel. Session resolution mirrors
 * the `session` branch of {@link openScopeEvents}.
 */
async function resolveChannelSnapshot(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
): Promise<EventEnvelope | undefined> {
  const scope = params.scope;
  if (scope.kind !== "session") return undefined;
  const name = params.query?.name;
  if (name === undefined || !("exact" in name)) return undefined;
  if (!name.exact.startsWith(CHANNEL_NAME_PREFIX)) return undefined;
  const channel = name.exact.slice(CHANNEL_NAME_PREFIX.length);
  for (const app of gateway.apps() as readonly AppHarnessProtocol[]) {
    const sess = app.getSession(scope.id);
    if (sess) return sess.channelSnapshot(channel);
  }
  return undefined;
}

/**
 * Prepend the channel snapshot as the FIRST frame, then relay live deltas
 * on the same stream (K8s `sendInitialEvents` / watch-list).
 */
async function* withSnapshot(
  snap: EventEnvelope,
  live: AsyncIterable<EventEnvelope>,
): AsyncGenerator<EventEnvelope> {
  yield snap;
  yield* live;
}

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
      let iterable = openScopeEvents(ctx.gateway, params);
      if (!iterable) {
        // No conforming AgentickError class covers "scope target not
        // found" today. AppNotFoundError is the closest fit (session
        // scope resolution ultimately traverses apps).
        throw new AppNotFoundError({
          appId: params.scope.kind === "app" ? params.scope.id : String(params.scope),
        });
      }

      // Open-with-snapshot: when this is a single-session-channel
      // subscription and a provider owns the channel, the FIRST frame the
      // subscriber receives is the channel's current snapshot; live deltas
      // follow on the same stream.
      const snapEnvelope = await resolveChannelSnapshot(ctx.gateway, params);
      if (snapEnvelope) {
        iterable = withSnapshot(snapEnvelope, iterable);
      }

      let cancelled = false;
      const sub = ctx.transport.registerSubscription(async () => {
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
      ctx.transport.closeSubscription(subscriptionId);
      return null;
    },
  },
});
