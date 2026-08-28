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
 * `app/run_once` is NOT yet in this extension — no runtime handler
 * exists in the transport dispatcher today either. It lands when
 * app-level one-shot send is implemented (out of scope for #295).
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import { omitUndefined } from "@agentick/utils";
import {
  AppNotFoundError,
  defineWireExtension,
  SessionNotFoundError,
  sessionKeysetPage,
  sortSessionRecords,
  type WireExtension,
  WireRpcError,
} from "@agentick/spec";

import {
  mayBranchFrom,
  metadataMatches,
  needsSnapshotPath,
  toSessionEntry,
  toSessionStoreQuery,
  visibleTo,
} from "./session-list.js";

export const appWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway#app",
  namespace: "app",
  version: "1.0.0",
  methods: {
    "app/create_session": async ({ appId, sessionId, metadata, eager, from }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      // ADR 100 law 4 — the wire admits `from` only from a caller who owns the
      // SOURCE session, because `inherited` reads the source's timeline, knobs
      // and state into a session the caller then owns. Refused before anything
      // is created, and refused the same way for an absent source (see
      // {@link mayBranchFrom}).
      if (from !== undefined && !(await mayBranchFrom(app, from, ctx.principal))) {
        throw WireRpcError.forbidden("app:create_session");
      }
      const session = await app.createSession({
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(from !== undefined ? { from } : {}),
        // E11 — lazy genesis by default; the client opts in to an immediate
        // durable write for a session it wants listed before the first message.
        ...(eager !== undefined ? { eager } : {}),
        // ADR 48 — stamp the OWNING principal from the authenticated caller's
        // identity (resolved once at ingress, ADR 51 §4.1). This is the
        // framework's own concept feeding the framework's own dispatch gate
        // (the same-principal target rule) — completing it is a capability, not
        // an opinion. The wire params type carries NO `principal` field, so a
        // value smuggled in the request body is never read: ownership is the
        // edge's to assert, not the caller's to claim. Unauthenticated (local
        // pole) → `ctx.principal` undefined → the session is left unstamped.
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      });
      // Read from the LIVE session, not the durable record: `createSession` is
      // create-or-resume, and a resumed session that is mid-turn is running
      // here before the store round trip would say so.
      return { sessionId: session.id, status: session.status };
    },
    "app/get_session": async ({ appId, sessionId }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      // E11 — read the durable record (the superset: resolves closed/historical
      // sessions too), not the live registry.
      const record = await app.getSessionRecord(sessionId);
      if (!record) throw new SessionNotFoundError({ sessionId });
      return toSessionEntry(record);
    },
    "app/model_info": async ({ appId, provider, modelId }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      // The request rides back with the answer so a cached row is
      // self-describing. `null`, not a throw: "no layer describes this model"
      // is a legitimate answer from a catalog that never fabricates.
      return { provider, modelId, info: app.modelInfo(provider, modelId) ?? null };
    },
    "app/destroy_session": async ({ appId, sessionId, reason }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      // ADR 48 ownership, second door. The dispatch gate already resolved the
      // TARGET session from `params.sessionId` and applied the same-principal
      // rule — but it resolves through the LIVE registry, and destroy's whole
      // point is that it also reaches a session that is no longer live. A closed
      // session has no live target, so the gate sees no target principal and the
      // rule goes quiet; the durable record still carries the owner. Check it
      // here, where the record is in hand, or the strongest verb in the API is
      // the one place a caller can act on someone else's thread.
      //
      // The same {@link visibleTo} predicate the list verb scopes with — one
      // statement of the rule, two verbs, and they differ only in what a `false`
      // means (a list hides, a named destroy refuses).
      const record = await app.getSessionRecord(sessionId);
      if (record !== undefined && !visibleTo(record, ctx.principal)) {
        throw WireRpcError.forbidden("app:destroy_session");
      }
      return app.destroySession(sessionId, omitUndefined({ reason }));
    },
    "app/list_sessions": async ({ appId, filter, cursor, limit }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      // Scoping rides the QUERY (ADR 48), so it reaches the store and is honored
      // INSIDE the page. It is not a duplicate of the dispatch gate: the gate
      // resolves a live TARGET from `params.sessionId`, and a list names no
      // session — so the gate has nothing to check, and without this the verb
      // would enumerate every principal's threads.
      const query = toSessionStoreQuery(filter, ctx.principal);
      const { items, nextCursor } = needsSnapshotPath(filter)
        ? // `metadata` has no store dimension, so it cannot be pushed down and
          // the page has to be cut AFTER it is applied. The store's own paging is
          // bypassed here on purpose — a page cut before this filter would come
          // back short.
          sessionKeysetPage(
            sortSessionRecords(
              (await app.listSessions(query)).filter((r) => metadataMatches(r, filter)),
            ),
            { cursor, limit },
          )
        : // The fast path, and the normal one: the store pages if it can (it
          // mints the cursor), else the app falls back to snapshot-and-cut.
          await app.pageSessions(query, { cursor, limit });
      return { sessions: items.map(toSessionEntry), ...omitUndefined({ nextCursor }) };
    },
  },
});
