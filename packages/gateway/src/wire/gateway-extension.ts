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

import { omitUndefined } from "@agentick/utils";
import {
  AppNotFoundError,
  defineWireExtension,
  type AppInfo,
  type AppHarnessProtocol,
  type WireExtension,
} from "@agentick/spec";

/**
 * Project an app onto the wire's {@link AppInfo}.
 *
 * `id` is what a client routes on; `title` is what it renders — and what it joins
 * a session's `appId` to in order to say who answered. Both `title` and
 * `description` are omitted when unset rather than sent as `null`, so a client
 * falls back to `id` on presence rather than on a sentinel.
 */
function toAppInfo(app: AppHarnessProtocol): AppInfo {
  return {
    id: app.id,
    ...omitUndefined({ title: app.title, description: app.description }),
  };
}

export const gatewayWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway#gateway",
  namespace: "gateway",
  version: "1.0.0",
  methods: {
    "gateway/list_apps": async (_params, ctx) => {
      // This used to project `{ id }` alone, because `AppHarnessProtocol` carried
      // no display metadata — so a client could enumerate apps and had nothing to
      // label one with. `title` / `description` now live on the protocol (#254).
      return { apps: ctx.gateway.apps().map(toAppInfo) };
    },
    "gateway/get_app": async ({ appId }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      return toAppInfo(app);
    },
  },
  // No notifications on this namespace today. Adopter extensions
  // publishing gateway-level events can layer on with their own
  // namespaces.
});
