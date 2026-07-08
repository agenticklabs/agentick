/**
 * `InMemoryTaskStore` — the bundled, zero-dependency {@link TaskStore}
 * default (ADR 68). A `Map<taskId, TaskRecord>` with scope + status
 * filtering. `:memory:` semantics — lost on process exit.
 *
 * This is the store the `TasksHarness` uses when the app/gateway doesn't
 * inject a durable one, and the reference the `runTaskStoreConformance`
 * suite validates every adapter against. A `@agentick/tasks-postgres-next`
 * conforms to the SAME {@link TaskStore} port later (not built here) — the
 * harness never sees the difference beyond durability across restart.
 *
 * Records are stored as-is (they are already plain serializable data — no
 * live handles live on a {@link TaskRecord}). `list` returns a fresh array
 * each call so callers can't mutate the backing map by reference.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

import type { TaskRecord, TaskStore, TaskStoreQuery, EventScope } from "@agentick/spec-next";

/** Does `record.scope` contain every dimension of `filter`? */
function scopeMatches(scope: EventScope, filter: Partial<EventScope>): boolean {
  for (const key of Object.keys(filter) as Array<keyof EventScope>) {
    if (filter[key] !== undefined && scope[key] !== filter[key]) return false;
  }
  return true;
}

function statusMatches(record: TaskRecord, query: TaskStoreQuery): boolean {
  if (query.status === undefined) return true;
  return Array.isArray(query.status)
    ? query.status.includes(record.status)
    : record.status === query.status;
}

export class InMemoryTaskStore implements TaskStore {
  readonly backend = "memory";
  private readonly records = new Map<string, TaskRecord>();

  put(record: TaskRecord): Promise<void> {
    this.records.set(record.taskId, record);
    return Promise.resolve();
  }

  get(taskId: string): Promise<TaskRecord | undefined> {
    return Promise.resolve(this.records.get(taskId));
  }

  list(query?: TaskStoreQuery): Promise<readonly TaskRecord[]> {
    const out: TaskRecord[] = [];
    for (const record of this.records.values()) {
      if (query?.scope !== undefined && !scopeMatches(record.scope, query.scope)) continue;
      if (query !== undefined && !statusMatches(record, query)) continue;
      out.push(record);
    }
    return Promise.resolve(out);
  }

  delete(taskId: string): Promise<void> {
    this.records.delete(taskId);
    return Promise.resolve();
  }

  /**
   * GC terminal records last updated before `before` (ms-epoch). Only
   * terminal records are eligible — an in-flight `working` /
   * `input_required` task is never pruned no matter how old.
   */
  prune(before: number): Promise<void> {
    for (const [taskId, record] of this.records) {
      const terminal =
        record.status === "completed" ||
        record.status === "failed" ||
        record.status === "cancelled" ||
        record.status === "interrupted";
      if (terminal && record.updatedAt < before) this.records.delete(taskId);
    }
    return Promise.resolve();
  }
}
