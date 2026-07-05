import type { SeqTaggedEntry } from "./store.js";
/**
 * `TimelineHandle` — the user-facing surface of the timeline harness
 * as exposed on `session.timeline`.
 *
 * A deliberate subset of {@link TimelineHarnessProtocol}: we hide the
 * substrate-flavored fields (`id`, `ready`, `close`,
 * `replaceProjection`, `resetProjection`, snapshot import/export) that
 * the SessionHarness owns the lifecycle of. Adopters get the methods
 * they need to read, write, queue, drain, compact, and subscribe — the
 * five things you actually do with a conversation timeline.
 *
 * Structural subset: the runtime `TimelineHarness` satisfies this
 * interface without wrapping. The SessionHarness exposes
 * `this.bridges.timeline` directly, narrowed to this type by the
 * module augmentation in `./augment.ts`.
 *
 * @see ./augment.ts (module augmentation onto `SessionHarnessProtocol`)
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { Unsubscribe, MessageTimelineEntry, TimelineEndTurnInput } from "@agentick/spec-next";
import type {
  CompactResult,
  CompactStrategy,
  TimelineEntry,
  TimelineSnapshot,
} from "@agentick/spec-next";

export interface TimelineHandle {
  /** Snapshot of the current projection + monotonic version. */
  read(): TimelineSnapshot;
  /** Read the durable append-only log (uncompacted ground truth). */
  readPersisted(): readonly TimelineEntry[];
  /** Input entries after the last assistant entry — "unanswered" (ADR 53). */
  unansweredInput(): readonly MessageTimelineEntry[];
  /** Count of input entries in the persisted log (live continuation check). */
  inputEntryCount(): number;
  /** Fires on any projection OR pending mutation. */
  subscribe(listener: () => void): Unsubscribe;
  /**
   * Append one or more entries to log + projection, atomically. Calling
   * with zero args is a no-op.
   */
  append(...entries: TimelineEntry[]): Promise<void>;
  /** Emit the turn-boundary record (ADR 53). */
  endTurn(input: TimelineEndTurnInput): Promise<void>;
  /** Run a strategy that rewrites the projection; log is untouched. */
  compact(strategy: CompactStrategy): Promise<CompactResult>;
  /**
   * Cursored, seq-tagged read of the DURABLE log (#187). Flushes the
   * write-behind buffer first so the read is complete, then delegates
   * to the store's optional `history`. Throws when the configured store
   * does not implement cursored reads — use `readPersisted()` for the
   * seq-less full read.
   */
  history(options?: {
    readonly fromSeq?: number;
    readonly limit?: number;
  }): Promise<ReadonlyArray<SeqTaggedEntry>>;
}
