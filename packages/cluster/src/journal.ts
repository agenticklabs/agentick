/**
 * `DurableJournal` — optional seam for rung (d) durability. Extends
 * the framework's `OperationJournal` with replay primitives so a
 * crashed/restarted node can re-derive in-flight state.
 *
 * Out of scope for v2.0 — the seam is documented now so adapters
 * (`@agentick/cluster-effect` wrapping `@effect/cluster`, or
 * custom Postgres-backed journals) can be built incrementally. The
 * framework's continuation primitives (idempotency keys, replay-safe
 * side-effect markers) ship in v2.x; cluster journal becomes
 * load-bearing then.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §8
 */

import type { OperationJournal } from "@agentick/spec";

import type { JournalEntry, JournalOffset } from "./types.js";

/**
 * Durable journal — a clustered/persistent {@link OperationJournal}
 * with replay. Implementations back the append shape with durable
 * storage (Postgres, Redis Streams, NATS JetStream, S3+manifest,
 * etc.) and expose a replay iterator for resumption.
 *
 * Reads from `replay(offset)` MUST honor the append order at the
 * given offset and forward. The iterator continues until caught up
 * with the live tail; adapters MAY choose to return the iterator
 * AND keep pushing new entries (tail-follow), but the canonical
 * pattern is "replay to caught-up, then subscribe to live appends
 * via the underlying OperationJournal."
 */
export interface DurableJournal extends OperationJournal {
  /**
   * Replay entries from `from` (inclusive) forward. `null` means
   * "from the beginning of retained history."
   *
   * The iterator terminates when the replay reaches the live
   * tail; subsequent calls with the last-yielded offset resume
   * from where the previous iterator left off.
   *
   * Adapters MAY choose to throw if `from` is older than the
   * retained-history window (e.g., the underlying storage has
   * pruned that offset). Adopters handle the error with explicit
   * recovery policy.
   */
  replay(from: JournalOffset): AsyncIterable<JournalEntry>;
}
