/**
 * `appWireExtension` — framework-supplied `WireExtension` that
 * projects the `app/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Part of the ADR 46 eat-our-own-dogfood commitment (#295 Phase C):
 * every framework-supplied wire method is a `WireExtension`, dispatched
 * through the same registry adopter extensions use. Registered by
 * default when a `GatewayHarness` is constructed — see
 * `../harness.ts`.
 *
 * `app/runOnce` is NOT yet in this extension — no runtime handler
 * exists in the transport dispatcher today either. It lands when
 * app-level one-shot send is implemented (out of scope for #295).
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  AppNotFoundError,
  defineWireExtension,
  SessionNotFoundError,
  type WireExtension,
} from "@agentick/spec-next";

export const appWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway-next#app",
  namespace: "app",
  version: "1.0.0",
  methods: {
    "app/createSession": async ({ appId, sessionId, metadata }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      const session = await app.createSession({
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return { sessionId: session.id };
    },
    "app/getSession": async ({ appId, sessionId }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      const entry = app.listSessions().find((e) => e.id === sessionId);
      if (!entry) throw new SessionNotFoundError({ sessionId });
      return entry;
    },
    "app/listSessions": async ({ appId, filter }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      return { sessions: app.listSessions(filter) };
    },
  },
});
