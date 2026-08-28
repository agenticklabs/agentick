/**
 * The session-list WIRE concerns — what a record looks like over the wire, how a
 * wire filter becomes a store query, and which records the caller may see.
 *
 * What is deliberately NOT here any more: the session ORDER and the cursor. Both
 * moved to `@agentick/spec` (`session-paging.ts`) once the store gained an
 * optional cursored read, because the order stopped being a wire detail and
 * became a port CONTRACT — a `SessionStore.page` implementation has to return
 * rows in it so that N stores can be merged at the gateway. The wire now asks
 * for a page and projects whatever comes back; it no longer decides where pages
 * cut.
 *
 * @see packages/spec/src/protocol/paging.ts — who owns a cursor
 * @see packages/gateway/src/wire/app-extension.ts — `app/list_sessions`
 * @see packages/gateway/src/wire/gateway-extension.ts — `gateway/list_sessions`
 */

import { omitUndefined } from "@agentick/utils";
import type {
  AppHarnessProtocol,
  SessionEntry,
  SessionFilter,
  SessionFromInput,
  SessionRecord,
  SessionStoreQuery,
} from "@agentick/spec";

// ============================================================================
// Projection
// ============================================================================

/**
 * Project a durable {@link SessionRecord} (E11 store) onto the wire's
 * {@link SessionEntry} shape. The wire keeps `SessionEntry` for now — the
 * per-store wire surface (carrying the full record) is Phase 7. `updatedAt`
 * maps to the wire's `lastActiveAt`, which is also the sort key a client sees,
 * so a paged list is orderable client-side without a second read.
 */
export function toSessionEntry(record: SessionRecord): SessionEntry {
  return {
    id: record.id,
    status: record.status,
    metadata: record.metadata ?? {},
    createdAt: record.createdAt,
    lastActiveAt: record.updatedAt,
    // The thread's own title / blurb were on the durable record and dropped here,
    // so a session list had no label per row and no second door to one. Omitted
    // when unset rather than sent as `null` — a renderer branches on presence.
    ...omitUndefined({
      title: record.title,
      description: record.description,
      // ADR 100 — the branch bag and the disposition, verbatim: a row that came
      // back from a list wider than the conversation list has to be
      // classifiable (`relation()`), and an anchored row has to know which
      // entry it hangs under.
      from: record.from,
      internal: record.internal,
    }),
  };
}

/**
 * Map the wire's {@link SessionFilter} onto the store's
 * {@link SessionStoreQuery}. `status` / `fromSessionId` / `anchored` /
 * `internal` are STORE dimensions and must reach the query — a paged list that
 * post-filtered them would drop rows from the page it already fetched instead
 * of fetching more matches. `metadata` has no store dimension (E11's query is
 * scope/status/graph/recency), so it stays the in-process post-filter below.
 *
 * The conversation list is the composed predicate `{ internal: false,
 * anchored: false }` (ADR 100 law 2), which the CALLER writes: there is no
 * `root` dimension to synthesize here, because a fork of a conversation has a
 * `from` and is still a conversation. Both dims match absence (an unstamped
 * record is not internal; a record with no `from` is not anchored) — the
 * store's obligation, carried by the session-store conformance suite.
 */
export function toSessionStoreQuery(
  filter: SessionFilter | undefined,
  principal: string | undefined,
): SessionStoreQuery | undefined {
  const query = omitUndefined({
    status: filter?.status,
    fromSessionId: filter?.fromSessionId,
    anchored: filter?.anchored,
    internal: filter?.internal,
    // Scoping rides the QUERY, not a filter over the answer. Once the store cuts
    // the page, a caller-side ownership filter would shorten it — and leave a
    // `nextCursor` pointing past rows that were dropped after the cut.
    principal,
  });
  return Object.keys(query).length === 0 ? undefined : (query as SessionStoreQuery);
}

/**
 * Does this filter carry a dimension the STORE cannot express? Today that is
 * exactly `metadata` — E11's query is scope/status/tree/recency/owner, with no
 * metadata dimension.
 *
 * It matters because such a filter cannot be pushed down, and applying it after
 * a page is cut shortens the page. So a metadata filter forces the SNAPSHOT
 * path: read every match, filter, then cut. Correct, and slower — which is the
 * honest trade for a dimension the store cannot index anyway.
 */
export function needsSnapshotPath(filter?: SessionFilter): boolean {
  return filter?.metadata !== undefined;
}

/** In-process metadata containment post-filter (the store query has no metadata dim). */
export function metadataMatches(record: SessionRecord, filter?: SessionFilter): boolean {
  if (filter?.metadata === undefined) return true;
  const meta = record.metadata ?? {};
  for (const [k, v] of Object.entries(filter.metadata)) {
    if (meta[k] !== v) return false;
  }
  return true;
}

// ============================================================================
// Ownership (ADR 48)
// ============================================================================

/**
 * May `principal` see this record? The ADR 48 same-principal rule stated once,
 * as a predicate.
 *
 * A record with NO principal asserts no ownership (principal-less deployment /
 * local pole) and is visible to everyone. A record WITH one is matched exactly —
 * an unauthenticated caller does not match an owned session, the same answer
 * `sameOwner` gives on the live path.
 *
 * Read by the `destroy_session` handlers, which hold ONE named record and owe
 * the caller an answer about it — a `false` there is a refusal. The list verbs
 * apply the identical rule through `SessionStoreQuery.principal` instead, where
 * it reaches the store and can be honored inside the page rather than over it;
 * a `false` there is invisibility, since a list answers with what you may see
 * and a 403 would confirm the id exists.
 */
export function visibleTo(
  record: { readonly principal?: string },
  principal: string | undefined,
): boolean {
  return record.principal === undefined || record.principal === principal;
}

/**
 * ADR 100 law 4 — may this caller open a session branched from `from`?
 *
 * The load-bearing line of the feature. `from.inherited` reads the SOURCE's
 * timeline, knobs and state into the new session, so a `from` the caller does
 * not own is a cross-tenant state read rather than a bad parameter — and the
 * new session is the caller's own, which is where the read comes back out.
 *
 * The rule is {@link visibleTo}'s, asked of the source record: an unstamped
 * source asserts no ownership and is open to anyone (the principal-less
 * deployment / local pole), an owned one matches its principal exactly.
 *
 * A source that does not exist refuses IDENTICALLY to one owned by someone
 * else. A distinct "no such session" would answer, for any id a caller cares to
 * name, whether that session exists.
 */
export async function mayBranchFrom(
  app: Pick<AppHarnessProtocol, "getSessionRecord">,
  from: SessionFromInput,
  principal: string | undefined,
): Promise<boolean> {
  const source = await app.getSessionRecord(from.sessionId);
  return source !== undefined && visibleTo(source, principal);
}
