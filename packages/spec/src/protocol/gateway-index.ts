/**
 * **Gateway indexes** — the optional adopter-provided door for a query that
 * spans every mounted app, with a k-way merge over the per-app stores as the
 * fallback when no door is provided.
 *
 * ## The pattern
 *
 * Agentick's stores are scoped where their records are OWNED. A session record
 * belongs to an app, so `SessionStore` is app-scoped; a task record likewise
 * (ADR 68 lifted the task store from session scope to app scope for exactly this
 * reason — so "this app's tasks" stopped being a fan-out over sessions and
 * became one query).
 *
 * A cross-app read at the gateway is that same lift, one scope further up. And
 * it has the same two-mode shape every time:
 *
 *   - **Index mounted** — the adopter hands the gateway a single door onto all
 *     of it. One query per page, one cursor, and the ordering is theirs. In any
 *     real deployment the records already live in one table with an `app_id`
 *     column, so this is not an extra system to build; it is a query against the
 *     system they already have.
 *   - **No index** — the gateway merges the mounted apps' stores. Correct, and
 *     the honest default, but it costs N reads per page and the framework must
 *     impose the merged ordering (see below). This is the DEGRADED mode.
 *
 * The framework cannot pick the first mode for you: it does not know whether two
 * apps share a backend. An app running on Postgres beside one running on an
 * in-memory store cannot be merged by a single query, and pretending otherwise
 * would produce a fast wrong answer.
 *
 * {@link SessionIndex} is the first tenant. `gateway/list_tasks` is the
 * anticipated second one and should land as a `TaskIndex` here beside it, with
 * no renaming of anything: same optional slot on the gateway, same delegation,
 * same fallback merge over the app-scoped task stores.
 *
 * ## Why the fallback's cursor is the FRAMEWORK's, not a bag of the stores'
 *
 * The tempting design for the merge is a composite cursor carrying each store's
 * own token. It does not work, and the reason is worth stating so nobody
 * re-derives it:
 *
 * A merged page of 50 rows might draw 48 from app A and 2 from app B. To resume,
 * the gateway must record that it consumed 2 rows of app B's stream — but app
 * B's token is OPAQUE and advances a whole page at a time. There is no rewind,
 * so the next request either re-serves app B's other 48 fetched rows or skips
 * them. Recording a per-app POSITION instead of a token requires a key the
 * framework can compare, at which point the per-app bag is exactly equivalent to
 * one merged key (the session sort key is total across apps) and strictly more
 * machinery.
 *
 * So the merge owns the ordering, and therefore mints the cursor — which is the
 * general rule from {@link ./paging.ts} resolving the only way it can. Opaque to
 * the caller either way.
 */

import type { CursorPage, PageRequest } from "./paging.js";
import type { GatewaySessionRecord } from "./gateway-harness.js";
import type { SessionStoreQuery } from "./session-store.js";
import type { StoreCtx } from "./store-ctx.js";

/**
 * The cross-app session query — the app-scoped {@link SessionStoreQuery}
 * verbatim, because a gateway-level read narrows on the same dimensions an
 * app-level one does.
 *
 * `appId` is the dimension that goes from pointless to meaningful at this scope:
 * at an app's own store every record has the same one, here it selects.
 */
export type SessionIndexQuery = SessionStoreQuery;

/**
 * An adopter-provided door onto every app's sessions at once — the scale answer
 * for `gateway/list_sessions`, and the place cross-app session ORDERING POLICY
 * lives.
 *
 * Mount it as `createGateway({ sessionIndex })`. When present the gateway
 * delegates its session enumeration here and does no merging; when absent it
 * falls back to reading every mounted app's store and merging (correct, N reads
 * per page, framework-imposed order).
 *
 * **Not a `SessionStore`, deliberately.** There is no `put` / `delete` here and
 * there should not be: sessions are WRITTEN through their app's store, which
 * owns the record's lifecycle. This is a read projection over all of them — in
 * SQL terms, the same table the app stores write to, queried without the
 * `app_id` predicate. Giving it a write surface would invite a second writer to
 * a record with an owner.
 *
 * **Ordering is yours.** Unlike {@link SessionStore.page}, whose rows must come
 * back in the framework's canonical order so that N stores can be merged,
 * nothing merges an index's output — so it is terminal, and free to order by
 * whatever the product needs. Pinned threads first, unread first, relevance:
 * all legitimate here and none expressible at the store. That freedom is a
 * second reason to mount one, independent of scale.
 *
 * Unread counts and inbox-style projections are the anticipated next things to
 * join against this door, which is another reason the rows are the durable
 * record rather than a wire shape.
 */
export interface SessionIndex {
  /**
   * One page of sessions across every app, in whatever order this index defines,
   * with a cursor this index mints.
   *
   * Every returned record carries the `appId` it belongs to — required, not
   * optional, because a cross-app row that cannot say which app it came from
   * cannot be addressed afterward.
   *
   * The obligation is the same one every cursored read carries: walk the pages
   * under concurrent writes and no row that stayed put is skipped, none appears
   * twice. Honor `query.principal` — the gateway relies on this read to be
   * scoped, and a filter applied after the page is cut would shorten it.
   */
  page(
    query: SessionIndexQuery | undefined,
    page: PageRequest,
    ctx: StoreCtx,
  ): Promise<CursorPage<GatewaySessionRecord>>;
  /** Self-identifying backend label for observability (`"postgres"`, …). */
  readonly backend: string;
}
