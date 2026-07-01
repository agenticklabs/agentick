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
} from "@agentick/spec-next";

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

export const subscriptionsWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway-next#subscriptions",
  namespace: "sub",
  version: "1.0.0",
  methods: {
    "sub/subscribe": async (params, ctx) => {
      const iterable = openScopeEvents(ctx.gateway, params);
      if (!iterable) {
        // No conforming AgentickError class covers "scope target not
        // found" today. AppNotFoundError is the closest fit (session
        // scope resolution ultimately traverses apps).
        throw new AppNotFoundError({
          appId: params.scope.kind === "app" ? params.scope.id : String(params.scope),
        });
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
