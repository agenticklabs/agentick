/**
 * `InMemorySessionStore` — the bundled, zero-dependency {@link SessionStore}
 * default (E11). App / status / parent / recency filtering over a keyed
 * collection with `:memory:` semantics — lost on process exit.
 *
 * Built by parameterizing the generic {@link MemoryCollection}
 * (`@agentick/store-next`): the only session-specific code is `keyOf`
 * (`record.id`), the `matchQuery` predicate (the scope-shaped `appId` /
 * `parentSessionId` dims via the shared `matchesScope`, plus a status
 * set-membership check and an `updatedAfter` recency bound), and the
 * `prunePredicate` (closed-and-old). The `Map` mechanics, fresh-array `list`,
 * idempotent delete, and predicate-driven prune are the generic's.
 *
 * This is the store the app uses when no durable one is injected, and the
 * reference the `runSessionStoreConformance` suite validates every adapter
 * against. A `@agentick/session-store-postgres-next` conforms to the SAME
 * {@link SessionStore} port later (not built here) — swapping durability across
 * app restart, which is the store's reason to exist as the resume index.
 *
 * Records are stored as-is (already plain serializable data — no live handles
 * live on a {@link SessionRecord}). `list` returns a fresh array each call so
 * callers can't mutate the backing map by reference.
 *
 * @see docs/proposals/v2/data-layer-plan.md §E11
 */

import type { SessionRecord, SessionStore, SessionStoreQuery } from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";
import { matchesScope } from "@agentick/utils-next";

/** Does `record.status` satisfy the query's `status` filter (single value or set)? */
function statusMatches(record: SessionRecord, query: SessionStoreQuery): boolean {
  if (query.status === undefined) return true;
  return Array.isArray(query.status)
    ? query.status.includes(record.status)
    : record.status === query.status;
}

/**
 * Session-terminal statuses eligible for prune. `close()` lands a session on
 * `"closed"`; a completed/failed session is likewise done. In-flight
 * (`idle` / `running` / `paused` / `hibernated`) records are never pruned no
 * matter how old.
 */
function isClosed(record: SessionRecord): boolean {
  return record.status === "closed" || record.status === "completed" || record.status === "failed";
}

/** `true` when a closed record was last touched before the cutoff. */
function isPrunable(record: SessionRecord, before: number): boolean {
  return isClosed(record) && record.updatedAt < before;
}

export class InMemorySessionStore implements SessionStore {
  readonly backend = "memory";
  private readonly collection = new MemoryCollection<SessionRecord, SessionStoreQuery, number>({
    backend: "memory",
    keyOf: (record) => record.id,
    matchQuery: (record, query) => {
      if (query === undefined) return true;
      // Scope-shaped equality dims (appId, parentSessionId) via the shared
      // containment predicate — `undefined` query dims are not constraints.
      if (
        !matchesScope(
          { appId: query.appId, parentSessionId: query.parentSessionId },
          { appId: record.appId, parentSessionId: record.parentSessionId },
        )
      ) {
        return false;
      }
      if (!statusMatches(record, query)) return false;
      // Recency: include records last touched at-or-after the cutoff (`>=`).
      if (query.updatedAfter !== undefined && record.updatedAt < query.updatedAfter) return false;
      return true;
    },
    prunePredicate: isPrunable,
  });

  put(record: SessionRecord): Promise<void> {
    return this.collection.put(record);
  }

  get(id: string): Promise<SessionRecord | undefined> {
    return this.collection.get(id);
  }

  list(query?: SessionStoreQuery): Promise<readonly SessionRecord[]> {
    return this.collection.list(query);
  }

  async delete(id: string): Promise<void> {
    await this.collection.delete(id);
  }

  /**
   * GC closed records last updated before `before` (ms-epoch). Only closed /
   * completed / failed records are eligible — an in-flight session is never
   * pruned no matter how old.
   */
  prune(before: number): Promise<void> {
    // `prunePredicate` is configured above, so the generic's `prune` is present.
    return this.collection.prune!(before);
  }
}
