/**
 * TimelineHarnessProtocol — the session's conversation log + projection.
 *
 * What this is, in CS terms: an **append-only event log paired with a
 * materialized projection**. The log is sacred — only `append` mutates
 * it, and once mutated it is never destructive. The projection is what
 * consumers (the formatter, the reconciler hook, the UI) actually read,
 * and it can diverge from the log via compaction or wholesale replacement.
 * Direct prior art: event sourcing + CQRS materialized views (Greg Young,
 * Kafka + ksqlDB); LSM/WAL + compaction; git's object-db vs working-tree
 * split. The novel piece is that the projection function is allowed to
 * be non-deterministic (an LLM-driven compaction), with strategy
 * metadata recorded on the snapshot for reproducible rehydrate.
 *
 *   Log         — `_persisted` — append-only, the durable record of
 *                  every entry ever appended. Survives hibernate/restore
 *                  as the source of truth. Readable via `readPersisted`
 *                  for tooling / custom compactors; subscribe to its
 *                  changes via the bus (`surface: "timeline"`,
 *                  `name: "timeline:append"`).
 *   Projection  — `_projection` — what `read()`/`subscribe()` expose.
 *                  Normally a live mirror of the log; after `compact` /
 *                  `replaceProjection`, can diverge. Subsequent appends
 *                  land at the end of the projection.
 *
 * Per ADR 26 ("Harness as the single shape"), this is a full harness —
 * identity, lifecycle, substrate, inbox addressability, journaled write
 * Operations.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { ContentBlock } from "../data/content-blocks.js";
import type { TimelineEntry } from "./session-harness.js";
import type { Unsubscribe } from "./inbox.js";

// ============================================================================
// Public snapshot shape (what `read()` returns)
// ============================================================================

export interface TimelineSnapshot {
  readonly entries: readonly TimelineEntry[];
  /** Monotonic counter; bumps on every projection mutation. */
  readonly version: number;
}

// ============================================================================
// Operation inputs
// ============================================================================

export interface TimelineAppendInput {
  readonly entry: TimelineEntry;
}

export interface TimelineReplaceProjectionInput {
  readonly entries: readonly TimelineEntry[];
}

// ─── compact() ───

/**
 * The function a {@link CompactStrategy} runs. Receives the chosen
 * source (log or current projection) and optional instructions;
 * returns the new projection entries. Implementations are typically
 * a model call but anything async works (rule-based, dedup, custom
 * vector-store summarization, sub-agent execution, ...).
 */
export type CompactRun = (ctx: {
  readonly entries: readonly TimelineEntry[];
  readonly instructions?: string | readonly ContentBlock[];
}) => Promise<readonly TimelineEntry[]>;

/**
 * Opaque strategy object the harness consumes. Built by factory
 * functions (`withHandler`, `withModel`, `withApp`, adopter-defined).
 * The `metadata` field is preserved on the snapshot so a later
 * `importSnapshot({ mode: "rehydrate" })` can re-run the same strategy.
 */
export interface CompactStrategy {
  /** Where the strategy reads entries from. Default: `"persisted"`. */
  readonly source?: "persisted" | "projection";
  /** The async function that produces the new projection entries. */
  readonly run: CompactRun;
  /** Optional instructions threaded to `run`. */
  readonly instructions?: string | readonly ContentBlock[];
  /**
   * Stable metadata describing the strategy (model id, sliding-window
   * size, etc). Recorded on the snapshot for rehydrate replay.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CompactResult {
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  readonly source: "persisted" | "projection";
}

// ============================================================================
// Snapshot (this harness's slice; SnapshotHarness — Step 6 — composes the
// session-wide snapshot from per-harness slices like this one)
// ============================================================================

export interface TimelineHarnessSnapshot {
  /** Append-only log entries in order. */
  readonly persisted: readonly TimelineEntry[];
  /** The projection at snapshot time (may equal `persisted` if no compaction). */
  readonly projection: readonly TimelineEntry[];
  readonly persistedVersion: number;
  readonly projectionVersion: number;
  /** Provenance of the last `compact` / `replaceProjection`, if any. */
  readonly lastCompaction?: {
    readonly at: number;
    readonly source: "persisted" | "projection";
    readonly entriesBefore: number;
    readonly entriesAfter: number;
    readonly strategyMetadata?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Hydration mode for {@link TimelineHarnessProtocol.importSnapshot}.
 *
 *   - "as-is"            (default) — fastest; trust the snapshot's
 *                        projection and persisted as written. No
 *                        recomputation; subscribers fire once.
 *   - "persisted-only"   — restore the persisted log; discard the
 *                        snapshot's projection; projection initializes
 *                        as a live mirror of persisted (caller can
 *                        re-run `compact` later if desired).
 *   - "rehydrate"        — restore persisted; re-run `compact` with a
 *                        caller-supplied strategy (typically derived
 *                        from `snapshot.lastCompaction.strategyMetadata`)
 *                        to rebuild the projection deterministically
 *                        against the latest model. The harness does NOT
 *                        invent a strategy — caller must pass one when
 *                        choosing `"rehydrate"`.
 */
export type TimelineImportMode = "as-is" | "persisted-only" | "rehydrate";

export interface TimelineImportSnapshotOptions {
  readonly mode?: TimelineImportMode;
  /** Required when `mode === "rehydrate"`. */
  readonly rehydrateStrategy?: CompactStrategy;
}

// ============================================================================
// Errors
// ============================================================================

export type TimelineError =
  | { readonly _tag: "CompactHandlerFailed"; readonly cause: unknown }
  | { readonly _tag: "RehydrateStrategyMissing"; readonly reason: string };

// ============================================================================
// Protocol
// ============================================================================

export interface TimelineHarnessProtocol {
  /**
   * Harness identifier. Composes into the inbox address as
   * `timeline:{id}` — admin actors send mutations addressed here.
   */
  readonly id: string;

  /**
   * Resolves once the harness has finished its async construction
   * (inbox registration).
   */
  readonly ready: Promise<void>;

  // ─────────── Sync surface (projection — the primary consumer view) ───────────

  /** Snapshot of the current projection + version. */
  read(): TimelineSnapshot;

  /**
   * Notify when the projection changes (append, compact, replace,
   * reset). Listeners should trigger re-render in React consumers.
   */
  subscribe(listener: () => void): Unsubscribe;

  // ─────────── Sync surface (log — for tooling + custom compactors) ───────────

  /**
   * Read the durable log directly. Most consumers want `read()` — the
   * projection. Use this when you need the uncompacted ground truth
   * (e.g., writing a custom compaction strategy, exporting audit logs).
   */
  readPersisted(): readonly TimelineEntry[];

  // ─────────── Async surface (Operations) ───────────

  /**
   * Append an entry to the log AND to the projection. Goes through
   * `runOperation` — emits `timeline:command:append:requested →
   * :terminal` envelopes. The persisted log is the journal of all
   * appends; the projection sees the new entry at the tail (after the
   * compacted prefix when one exists).
   */
  append(input: TimelineAppendInput): Promise<void>;

  /**
   * Run a strategy that produces a new projection. The log is
   * untouched. After completion, the projection equals the strategy's
   * output; subscribers fire; `lastCompaction` metadata records the
   * strategy's `metadata` for snapshot fidelity.
   *
   * @throws {TimelineError._tag === "CompactHandlerFailed"}
   */
  compact(strategy: CompactStrategy): Promise<CompactResult>;

  /**
   * Overwrite the projection with the supplied entries. The log is
   * untouched. Useful when an offline process produced a better
   * projection (e.g., human-curated summary, batch-computed digest).
   */
  replaceProjection(input: TimelineReplaceProjectionInput): Promise<void>;

  /**
   * Discard the projection; rebuild it as a live mirror of the log.
   * Subscribers fire once with the restored projection.
   */
  resetProjection(): Promise<void>;

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): TimelineHarnessSnapshot;

  /**
   * Restore from a snapshot. See {@link TimelineImportMode} for the
   * three hydration modes.
   *
   * @throws {TimelineError._tag === "RehydrateStrategyMissing"}
   */
  importSnapshot(
    snapshot: TimelineHarnessSnapshot,
    options?: TimelineImportSnapshotOptions,
  ): Promise<void>;

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
