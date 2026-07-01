/**
 * `gatewayWireExtension` — framework-supplied `WireExtension` that
 * projects the `gateway/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Part of the ADR 46 eat-our-own-dogfood commitment (#295 Phase C):
 * every framework-supplied wire method is a `WireExtension`, dispatched
 * through the same registry adopter extensions use. Registered by
 * default when a `GatewayHarness` is constructed — see
 * `../harness.ts`.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md §"The framework's own wire methods ARE wire extensions"
 */

import { AppNotFoundError, defineWireExtension, type WireExtension } from "@agentick/spec-next";

export const gatewayWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway-next#gateway",
  namespace: "gateway",
  version: "1.0.0",
  methods: {
    "gateway/listApps": async (_params, ctx) => {
      // Metadata isn't part of AppHarnessProtocol yet; project the
      // stable subset the client depends on (id). Extensible via
      // #254 when the full app-info shape settles.
      return {
        apps: ctx.gateway.apps().map((a) => ({ id: a.id })),
      };
    },
    "gateway/getApp": async ({ appId }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      return { id: app.id };
    },
  },
  // No notifications on this namespace today. Adopter extensions
  // publishing gateway-level events can layer on with their own
  // namespaces.
});
