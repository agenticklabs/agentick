/**
 * `knobsWireExtension` — the `knobs/*` `WireExtension` that projects the
 * knobs WRITE command over the Agentick client↔gateway wire.
 *
 * Write half of the knobs resource (CQRS command). The client's read half
 * is the wired `knobs-state` channel (`knobsStateView` / `knobsHandle`); the
 * write is a single `knobs/set` RPC whose effect returns as a delta on that
 * channel and re-folds the view. No response payload carries state — state
 * flows one way, through the channel.
 *
 * This extension implements ONLY `knobs/set`. The `knobs/commands` row in the
 * `knobs` namespace is declared (augment.ts) but unowned here — a wire
 * extension may implement a subset of its namespace's declared methods.
 *
 * Session resolution mirrors the `session` branch of
 * `subscriptionsWireExtension`'s `openScopeEvents`: iterate the gateway's
 * apps, take the first whose `getSession(sessionId)` resolves. An
 * unresolved id throws `AppNotFoundError` — the same "scope target not
 * found" failure the subscriptions extension raises.
 *
 * @see packages/gateway/src/wire/subscriptions-extension.ts
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 * @verifiedBy packages/knobs/src/__tests__/wire.spec.ts
 */

import {
  AppNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type KnobPrimitive,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec";

export const knobsWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/knobs#wire",
  namespace: "knobs",
  version: "1.0.0",
  methods: {
    "knobs/set": async (params, ctx) => {
      // Resolve the owning session — mirrors the `session` branch of the
      // subscriptions extension's `openScopeEvents`.
      let session: SessionHarnessProtocol | undefined;
      for (const app of ctx.gateway.apps() as readonly AppHarnessProtocol[]) {
        const sess = app.getSession(params.sessionId);
        if (sess) {
          session = sess;
          break;
        }
      }
      if (!session) {
        // No AgentickError class covers "session not found" precisely;
        // AppNotFoundError is the fit the subscriptions extension uses for
        // unresolved scope targets (session resolution traverses apps).
        throw new AppNotFoundError({ appId: params.sessionId });
      }

      // The wire row (`id`/`value`) IS the handle's `KnobsSetInput` shape
      // (friction #13: one name — `id` — client to server, no rename at the
      // boundary). The handle returns void; the write's observable effect
      // returns to the client as a `knobs-state` delta (CQRS).
      await session.knobs.set({ id: params.id, value: params.value as KnobPrimitive });
      return null;
    },
  },
});
