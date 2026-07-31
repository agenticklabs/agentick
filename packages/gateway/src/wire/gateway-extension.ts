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
  sessionKeysetPage,
  sortSessionRecords,
  WireRpcError,
} from "@agentick/spec";

import {
  metadataMatches,
  needsSnapshotPath,
  toSessionEntry,
  toSessionStoreQuery,
  visibleTo,
} from "./session-list.js";

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
    "gateway/destroy_session": async ({ sessionId, reason }, ctx) => {
      // Same verb as `app/destroy_session`, addressed without an app — the
      // gateway resolves the owner. A client holding a session id from a
      // cross-app listing should not have to carry an app id beside it just to
      // delete a thread.
      //
      // Ownership, second door (the first is the dispatch gate, which reads
      // `params.sessionId` and applies the same-principal rule to the LIVE
      // session). A destroy that reaches a paged-out or closed session has no
      // live target for the gate to read, and only the durable record names the
      // owner — so check it here, exactly as the app-level handler does. A
      // record with no principal asserts no ownership and is left to the gate.
      const app = await ctx.gateway.appForSession(sessionId);
      const record = await app?.getSessionRecord(sessionId);
      if (record !== undefined && !visibleTo(record, ctx.principal)) {
        throw WireRpcError.forbidden("gateway:destroy_session");
      }
      // Delegate through the harness verb rather than re-deriving the result
      // here: it owns the ONE construction site for the shape, including the
      // no-app-claims-it miss. The cost is resolving the app twice on a verb
      // called once per deleted thread — the right trade against two places that
      // could disagree about what a destroy result looks like.
      return ctx.gateway.destroySession(sessionId, omitUndefined({ reason }));
    },
    "gateway/list_sessions": async ({ filter, cursor, limit }, ctx) => {
      // The enumeration half of the pair `gateway/destroy_session` completes: a
      // client that can delete a session by id without naming its app has to be
      // able to FIND one the same way. Every row carries the `appId` the gateway
      // resolved it through, which is what the caller then addresses the
      // session's app-scoped verbs with.
      //
      // Delegated to the harness verb for the same reason destroy is: choosing
      // between the mounted index and the fallback merge — and the appId
      // stamping and merged ordering that fallback owes — is one contract with
      // one implementation, and the in-process caller gets the identical list.
      //
      // Scoping rides the query so it reaches whichever source answers — the
      // mounted index, or the apps' stores under the fallback merge. A cross-app
      // list names no session, so the dispatch gate's same-principal target rule
      // has nothing to resolve and this is the only thing scoping the read.
      const query = toSessionStoreQuery(filter, ctx.principal);
      const { items, nextCursor } = needsSnapshotPath(filter)
        ? // `metadata` is not a store dimension, so it cannot be pushed down —
          // and pushing the PAGE down while filtering up here would return short
          // pages. Snapshot the union and cut after filtering. Note this bypasses
          // a mounted index's own ordering; a metadata-filtered cross-app list is
          // a rare, explicitly slower read.
          sessionKeysetPage(
            sortSessionRecords(
              (
                await ctx.gateway.listSessions(query, { limit: Number.MAX_SAFE_INTEGER })
              ).items.filter((r) => metadataMatches(r, filter)),
            ),
            { cursor, limit },
          )
        : await ctx.gateway.listSessions(query, { cursor, limit });
      return {
        sessions: items.map((record) => ({ ...toSessionEntry(record), appId: record.appId })),
        ...omitUndefined({ nextCursor }),
      };
    },
  },
  // No notifications on this namespace today. Adopter extensions
  // publishing gateway-level events can layer on with their own
  // namespaces.
});
