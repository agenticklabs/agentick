/**
 * `InMemoryTaskStore` — the bundled, zero-dependency {@link TaskStore}
 * default (ADR 68). Scope + status filtering over a keyed collection with
 * `:memory:` semantics — lost on process exit.
 *
 * Built by parameterizing the generic {@link MemoryCollection}
 * (`@agentick/store-next`): the only task-specific code is `keyOf`
 * (`taskId`), the `matchQuery` predicate (scope containment via the shared
 * `matchesScope` + task-local `statusMatches`), and the `prunePredicate`
 * (terminal-and-old). The `Map` mechanics, fresh-array `list`, idempotent
 * delete, and predicate-driven prune are the generic's.
 *
 * This is the store the `TasksHarness` uses when the app/gateway doesn't
 * inject a durable one, and the reference the `runTaskStoreConformance`
 * suite validates every adapter against. A `@agentick/tasks-store-postgres-next`
 * conforms to the SAME {@link TaskStore} port later (not built here) — the
 * harness never sees the difference beyond durability across restart.
 *
 * Records are stored as-is (they are already plain serializable data — no
 * live handles live on a {@link TaskRecord}). `list` returns a fresh array
 * each call so callers can't mutate the backing map by reference.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

import type {
  CollectionMutation,
  StoreCtx,
  TaskRecord,
  TaskStore,
  TaskStoreQuery,
} from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";
import { matchesScope } from "@agentick/utils-next";

/** Does `record.status` satisfy the query's `status` filter (single value or set)? */
function statusMatches(record: TaskRecord, query: TaskStoreQuery): boolean {
  if (query.status === undefined) return true;
  return Array.isArray(query.status)
    ? query.status.includes(record.status)
    : record.status === query.status;
}

/** `true` when a terminal record was last touched before the cutoff. */
function isPrunable(record: TaskRecord, before: number): boolean {
  const terminal =
    record.status === "completed" ||
    record.status === "failed" ||
    record.status === "cancelled" ||
    record.status === "interrupted";
  return terminal && record.updatedAt < before;
}

export class InMemoryTaskStore implements TaskStore {
  readonly backend = "memory";
  private readonly collection = new MemoryCollection<TaskRecord, TaskStoreQuery, number>({
    backend: "memory",
    keyOf: (record) => record.taskId,
    matchQuery: (record, query) => {
      if (query === undefined) return true;
      // Scope: every provided dimension must match (shared containment predicate).
      if (query.scope !== undefined && !matchesScope(query.scope, record.scope)) return false;
      return statusMatches(record, query);
    },
    prunePredicate: isPrunable,
  });

  put(record: TaskRecord, ctx: StoreCtx): Promise<void> {
    return this.collection.put(record, ctx);
  }

  get(taskId: string, ctx: StoreCtx): Promise<TaskRecord | undefined> {
    return this.collection.get(taskId, ctx);
  }

  list(query: TaskStoreQuery | undefined, ctx: StoreCtx): Promise<readonly TaskRecord[]> {
    return this.collection.list(query, ctx);
  }

  async delete(taskId: string, ctx: StoreCtx): Promise<void> {
    await this.collection.delete(taskId, ctx);
  }

  /**
   * GC terminal records last updated before `before` (ms-epoch). Only
   * terminal records are eligible — an in-flight `working` /
   * `input_required` task is never pruned no matter how old.
   */
  prune(before: number, ctx: StoreCtx): Promise<void> {
    // `prunePredicate` is configured above, so the generic's `prune` is present.
    return this.collection.prune!(before, ctx);
  }

  // ── Store seam — required now `CollectionStore extends Store`. Delegated to
  // the composed `MemoryCollection`, which owns the seam over its `Map`.
  query(query: TaskStoreQuery | undefined, ctx: StoreCtx): Promise<readonly TaskRecord[]> {
    return this.collection.query(query, ctx);
  }

  mutate(m: CollectionMutation<TaskRecord>, ctx: StoreCtx): Promise<void> {
    return this.collection.mutate(m, ctx);
  }
}
