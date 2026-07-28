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

import type { Unsubscribe, MessageTimelineEntry, TimelineEndTurnInput } from "@agentick/spec";
import type {
  CompactResult,
  CompactStrategy,
  LogHistoryOptions,
  SeqTagged,
  TimelineEntry,
  TimelineSnapshot,
} from "@agentick/spec";

export interface TimelineHandle {
  /** Snapshot of the current projection + monotonic version. */
  read(): TimelineSnapshot;
  /** Read the durable append-only log (uncompacted ground truth). */
  readPersisted(): readonly TimelineEntry[];
  /** Input entries trailing the last assistant entry (ADR 53). */
  trailingInput(): readonly MessageTimelineEntry[];
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
  /**
   * Run a strategy that rewrites the projection; the durable log is untouched.
   *
   * No-arg is the ADR-51 SIGNAL form: it runs the construction-bound default
   * from the definition (`defineTimeline({ compact })`) — the form that can
   * cross the inbox/wire as a bare verb, because it carries no executable
   * configuration. An explicit strategy is the in-process override.
   *
   * @throws {TimelineError._tag === "CompactStrategyMissing"} no-arg with no
   *   construction-bound default configured.
   */
  compact(strategy?: CompactStrategy): Promise<CompactResult>;
  /**
   * Cursored, seq-tagged read of the DURABLE log (#187) over the port's seq
   * window. Flushes the write-behind buffer first so the read is complete, then
   * delegates to the store's optional `history`. Throws when the configured store
   * does not implement cursored reads — use `readPersisted()` for the seq-less
   * full read.
   *
   * The in-process face of the `timeline:history` command — the same body a
   * grant-gated wire client reaches for scroll-back (ADR 93). `{ limit: n }` is
   * the log's LAST `n` (the anchor rule); page forward with `fromSeq: lastSeq + 1`
   * or backward with `toSeq: firstSeq - 1`. The wire face additionally returns
   * that cursor.
   */
  history(options?: LogHistoryOptions): Promise<ReadonlyArray<SeqTagged<TimelineEntry>>>;
}
