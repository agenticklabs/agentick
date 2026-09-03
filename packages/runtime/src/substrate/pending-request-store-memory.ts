/**
 * `createInMemoryPendingRequestStore` — the default backing for BaseHarness's
 * `pendingStore` substrate slot: a `MemoryCollection` keyed by `correlationId`,
 * matched + GC'd by the SHARED spec rules (`matchPendingRequestQuery` /
 * `pendingRequestExpired`) so it never drifts from a durable adapter.
 *
 * Process-local — the durability floor. It gives every harness the same
 * persist/hydrate/resume code path a durable store would; recycle-survival comes
 * from swapping this slot for a durable adapter (Postgres, Redis) via the
 * cascade, with no change at the harness.
 */

import type {
  PendingRequestQuery,
  PendingRequestRecord,
  PendingRequestStore,
} from "@agentick/spec";
import { matchPendingRequestQuery, pendingRequestExpired, pendingRequestKey } from "@agentick/spec";
import { MemoryCollection } from "@agentick/store";

export function createInMemoryPendingRequestStore(): PendingRequestStore {
  return new MemoryCollection<PendingRequestRecord, PendingRequestQuery, number>({
    backend: "memory",
    keyOf: pendingRequestKey,
    matchQuery: matchPendingRequestQuery,
    prunePredicate: pendingRequestExpired,
  });
}
