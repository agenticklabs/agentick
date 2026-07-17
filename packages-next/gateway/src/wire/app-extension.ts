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

import {
  AppNotFoundError,
  defineWireExtension,
  SessionNotFoundError,
  type SessionEntry,
  type SessionFilter,
  type SessionRecord,
  type SessionStoreQuery,
  type WireExtension,
} from "@agentick/spec-next";

/**
 * Project a durable {@link SessionRecord} (E11 store) onto the wire's
 * {@link SessionEntry} shape. The wire keeps `SessionEntry` for now — the
 * per-store wire surface (carrying the full record) is Phase 7. `updatedAt`
 * maps to the wire's `lastActiveAt`.
 */
function toSessionEntry(record: SessionRecord): SessionEntry {
  return {
    id: record.id,
    status: record.status,
    metadata: record.metadata ?? {},
    createdAt: record.createdAt,
    lastActiveAt: record.updatedAt,
  };
}

/**
 * Map the wire's {@link SessionFilter} onto the store's
 * {@link SessionStoreQuery}. `status` maps directly; `metadata` has no store
 * dimension (E11's query is scope/status/tree/recency) — it is applied as an
 * in-process post-filter below so the wire's metadata filter does not regress.
 */
function toQuery(filter?: SessionFilter): SessionStoreQuery | undefined {
  if (filter?.status === undefined) return undefined;
  return { status: filter.status };
}

/** In-process metadata containment post-filter (the store query has no metadata dim). */
function metadataMatches(record: SessionRecord, filter?: SessionFilter): boolean {
  if (filter?.metadata === undefined) return true;
  const meta = record.metadata ?? {};
  for (const [k, v] of Object.entries(filter.metadata)) {
    if (meta[k] !== v) return false;
  }
  return true;
}

export const appWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway-next#app",
  namespace: "app",
  version: "1.0.0",
  methods: {
    "app/create_session": async ({ appId, sessionId, metadata }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      const session = await app.createSession({
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return { sessionId: session.id };
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
    "app/list_sessions": async ({ appId, filter }, ctx) => {
      const app = ctx.gateway.app(appId);
      if (!app) throw new AppNotFoundError({ appId });
      const records = await app.listSessions(toQuery(filter));
      const sessions = records.filter((r) => metadataMatches(r, filter)).map(toSessionEntry);
      return { sessions };
    },
  },
});
