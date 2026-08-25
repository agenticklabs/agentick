/**
 * TimelineHarnessProtocol — the session's conversation log + projection.
 *
 * What this is, in CS terms: an **append-only event log paired with a
 * materialized projection**. The log is sacred — only `append` mutates
 * it, and once mutated it is never destructive. The projection is what
 * consumers (the formatter, the compiler hook, the UI) actually read,
 * and it can diverge from the log via compaction or wholesale replacement.
 * Direct prior art: event sourcing + CQRS materialized views (Greg Young,
 * Kafka + ksqlDB); LSM/WAL + compaction; git's object-db vs working-tree
 * split. The novel piece is that the projection function is allowed to
 * be non-deterministic (an LLM-driven compaction), with strategy
 * metadata recorded as projection provenance.
 *
 *   Log         — append-only, the durable record of every entry ever
 *                  appended. The source of truth, durable in the harness's
 *                  own store — its ONLY home (§2.7: no in-memory mirror).
 *                  Read it through the store / `history`; subscribe to its
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

import type { Effect } from "effect";
import type { ContentBlock } from "../data/content-blocks.js";
import type { TokenEstimate } from "../data/execution-result.js";
import type { OperationCtx } from "../data/runtime-context.js";
import type { SubstrateError } from "../data/errors.js";
import type { TimelineWriteFailed } from "../errors/lifecycle.js";
import type { HarnessFx } from "./middleware.js";
import type { MessageTimelineEntry, TimelineEntry, TurnBoundaryEntry } from "./session-harness.js";
import type { Unsubscribe } from "./inbox.js";

// ============================================================================
// Public snapshot shape (what `read()` returns)
// ============================================================================

/**
 * One execution's durable footprint, as coordinates (execution-resume.md §3.4).
 * The two-signal detection reads `boundary` (a present boundary means the turn
 * FINISHED — only the record's idle-write was lost; never re-drive); the
 * re-drive seed reads `lastTickIndex`.
 */
export interface ExecutionCursor {
  /**
   * Highest 1-based `tickIndex` stamped on the execution's persisted entries;
   * 0 when its entries carry no tick provenance (e.g. only caller input).
   */
  readonly lastTickIndex: number;
  /**
   * The turn boundary's outcome when the execution ended on the record
   * (ADR 53). Absent = no boundary — an in-flight or crashed turn.
   */
  readonly boundary?: TurnBoundaryEntry["boundary"]["outcome"];
}

export interface TimelineSnapshot {
  readonly entries: readonly TimelineEntry[];
  /** Monotonic counter; bumps on every projection mutation. */
  readonly version: number;
}

// ============================================================================
// Operation inputs
// ============================================================================

/**
 * Internal Operation input — a batch of entries to append atomically.
 * The protocol's `append(...entries)` is variadic at the call site;
 * the harness wraps the rest-args into this shape so the Operation
 * envelope's `input` field carries a single named payload.
 */
export interface TimelineAppendInput {
  readonly entries: readonly TimelineEntry[];
}

export interface TimelineReplaceProjectionInput {
  readonly entries: readonly TimelineEntry[];
}

// ─── Turn boundaries (ADR 53) ───

/** Input to {@link TimelineHarnessProtocol.endTurn} — emit the
 *  turn-boundary RECORD (segmentation + turn-aggregate usage).
 *  Load-bearing NOWHERE (ADR 53 §2.3b). */
export interface TimelineEndTurnInput {
  readonly executionId: string;
  readonly outcome: "succeeded" | "failed" | "aborted" | "vetoed";
  /** Backlog F — the whole execution was internal (client-hidden). */
  readonly internal?: boolean;
  readonly usage?: import("../data/execution-result.js").UsageStats;
  /**
   * The turn's PER-MODEL breakdown. The flat `usage` above is safe to sum
   * and meaningless to price — a turn changes model (a per-tick `<Model>`,
   * a steer, a `setModel`), so it routinely mixes rate tiers.
   */
  readonly byModel?: Readonly<Record<string, import("../data/usage-cost.js").ModelUsage>>;
  /**
   * What the turn cost, folded from per-tick stamps. `partial` when any
   * tick was unpriced — never a zero standing in for "we don't know".
   */
  readonly cost?: import("../data/usage-cost.js").CostRollup;
  /**
   * The target that ran the turn. Present on the concrete harness and on
   * `TurnBoundaryEntry.boundary` since ADR 53, and missing here the whole
   * time — this type had already drifted from its one implementation
   * before cost arrived. Declared now so the drift stops.
   */
  readonly target?: {
    readonly provider?: string;
    readonly modelId?: string;
  };
  /**
   * Why the turn ended badly — recorded on the boundary. Supply it whenever the
   * outcome is `failed` or `vetoed` and a cause is known; see
   * `TurnBoundaryEntry.boundary.stopCause` on why the outcome alone leaves
   * everything downstream unable to explain itself.
   */
  readonly stopCause?: import("../data/execution-result.js").StopCause;
}

// ─── compact() ───

/**
 * The function a {@link CompactStrategy} runs. Receives the chosen
 * source (log or current projection) and optional instructions;
 * returns the new projection entries. Implementations are typically
 * a model call but anything async works (rule-based, dedup, custom
 * vector-store summarization, sub-agent execution, ...).
 */
export type CompactRun = (ctx: CompactRunCtx) => Promise<readonly TimelineEntry[]>;

/**
 * What a compaction strategy is handed. Extends {@link OperationCtx} because
 * the `(entries, ctx)` shorthand is sugar over this — a configured strategy
 * that saw less than its own sugar would make the general form the poorer one,
 * and every facet added later would land on one side only.
 *
 * The harness mints this ONCE and both forms receive it; the shorthand adapter
 * is a destructure, not a second construction.
 */
export interface CompactRunCtx extends OperationCtx {
  readonly entries: readonly TimelineEntry[];
  readonly instructions?: string | readonly ContentBlock[];
  /**
   * Bound by whoever can see both a timeline and a model — the session, or an
   * adopter wiring `withTimeline`. Absent for strategies that need no model.
   */
  readonly generate?: CompactGenerate;
  /**
   * Reports as the summary streams. `total` is the cap the caller set, so a bar
   * is determinate exactly when a cap exists — nothing here is a forecast.
   */
  readonly progress?: (u: import("../data/signals.js").ProgressUpdate) => void;
}

/**
 * The one model call a compaction strategy needs. Narrower than an executor on
 * purpose: a strategy asks for prose over entries, and everything about how the
 * request is built stays with whoever bound this.
 */
export type CompactGenerate = (input: {
  readonly entries: readonly TimelineEntry[];
  readonly instructions: string | readonly ContentBlock[];
  readonly maxOutputTokens?: number;
  readonly onDelta?: (d: { readonly text: string; readonly outputTokens: number }) => void;
}) => Promise<CompactGenerateResult>;

export interface CompactGenerateResult {
  readonly text: string;
  /**
   * What the call cost. A compaction rides the same prefix as the next tick, so
   * `cachedInputTokens` against `inputTokens` is what says whether that held —
   * a strategy that records it makes the claim auditable instead of asserted.
   * Absent when the provider reports none.
   */
  readonly usage?: import("../data/execution-result.js").UsageStats;
  /** The cap was hit — the text is cut mid-thought and must not be persisted. */
  readonly truncated: boolean;
}

/**
 * Opaque strategy object the harness consumes. Built by strategy-value
 * factories at `@agentick/timeline/strategies` (`fromHandler`,
 * `rollingSummary`, `slidingWindow`, adopter-defined) — NOT `withX`
 * session extensions; a strategy is a portable configured value.
 * The `metadata` field is preserved as PROVENANCE — what
 * shaped the projection last (read by tooling / a later `compact`).
 */
/**
 * What a trigger knows when it asks whether to fold (ADR 97).
 *
 * `usedTokens` is the provider's number for the whole last request. `estimate`
 * is the locally-measured split, and a strategy that has it should prefer
 * `estimate.messages`: folding the conversation cannot shrink a tool schema, so
 * a threshold compared against the total can be crossed by something folding
 * has no power to relieve — and is then crossed again on every tick, forever.
 */
export interface CompactDecisionCtx {
  /** Input tokens the provider billed for the last request. */
  readonly usedTokens: number;
  readonly contextWindow?: number;
  /** The locally-measured split, when a tick has been measured. */
  readonly estimate?: TokenEstimate;
}

export interface CompactStrategy {
  /** Where the strategy reads entries from. Default: `"persisted"`. */
  readonly source?: "persisted" | "projection";
  /** The async function that produces the new projection entries. */
  readonly run: CompactRun;
  /** Optional instructions threaded to `run`. */
  readonly instructions?: string | readonly ContentBlock[];
  /**
   * Whether this strategy wants to run at the current size. A strategy knows
   * both when it should fire and how much it may emit, so a trigger asks rather
   * than carrying its own copy of the thresholds.
   */
  readonly shouldCompact?: (ctx: CompactDecisionCtx) => boolean;
  /**
   * Stable metadata describing the strategy (model id, sliding-window
   * size, etc). Recorded as projection provenance.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Provenance of the last projection fold — see
 * {@link TimelineHarnessProtocol.lastCompaction}. `strategyMetadata` is the
 * {@link CompactStrategy.metadata} the strategy declared, carried verbatim.
 */
export interface TimelineProjectionMeta {
  readonly at: number;
  readonly source: "persisted" | "projection";
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  readonly strategyMetadata?: Readonly<Record<string, unknown>>;
}

export interface CompactResult {
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  readonly source: "persisted" | "projection";
}

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  CompactHandlerFailed,
  TimelineHydrateFailed,
  TimelineError,
  type TimelineErrorChannel,
} from "../errors/harnesses.js";

// ============================================================================
// Protocol
// ============================================================================

/**
 * The Effect-canonical composable surface of the timeline (ADR 77) — the twin
 * the loop's tick body composes into ITS fiber.
 *
 * This existed nowhere until it was needed for correlation, and its absence was
 * a correctness bug, not an ergonomics one. `BaseHarness` hands every harness a
 * working `.fx` carrying `use`, so `timeline.fx` resolved and typechecked while
 * having no operation twins at all — the harness looked complete. Every append
 * therefore went through the Promise facade, and `runHarnessProtocol` is a
 * `runPromise` ROOT: it severs the fiber. `RuntimeContext` is ambient on the
 * fiber, so the tick scope was gone by the time `timeline:append`'s Operation
 * was built, and no timeline envelope on the bus was attributable to the tick
 * that caused it.
 *
 * Same discipline as {@link import("./loop-executor.js").StateApplicatorFx} and
 * {@link import("./tool-executor.js").ToolExecutorFx}: the twins are the un-run
 * inners so a caller already in a fiber stays in it.
 */
export interface TimelineHarnessFx extends HarnessFx {
  /**
   * Append entries in the CALLER's fiber — see {@link TimelineHarnessProtocol.append}
   * for the semantics. Composing this rather than awaiting the facade is what
   * keeps the ambient scope (`tickId`, `executionId`) on the resulting
   * operation.
   */
  append(
    entries: readonly TimelineEntry[],
  ): Effect.Effect<void, TimelineWriteFailed | SubstrateError, never>;
}

export interface TimelineHarnessProtocol {
  /**
   * The Effect-canonical composable surface (ADR 77). Callers already inside a
   * fiber — the loop's tick, the session's applicator — MUST reach through this
   * rather than awaiting the Promise facade, or the operation loses the ambient
   * scope its envelopes are correlated by.
   */
  readonly fx: TimelineHarnessFx;

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
   * Notify when ANY observable timeline state changes — projection
   * (append, compact, replace, reset) OR pending queue (queue, drain).
   * One signal; consumers re-render and re-read whichever surfaces they
   * care about. Listeners should trigger re-render in React consumers.
   */
  subscribe(listener: () => void): Unsubscribe;

  // ─────────── Derived reads + turn records (ADR 53) ───────────

  /**
   * Input entries after the LAST assistant entry — input trailing the last assistant entry (the
   * fold. UI styling and resume prompts read this; nothing load-bearing
   * does (consumption is non-destructive: every tick re-renders the
   * whole log).
   */
  trailingInput(): readonly MessageTimelineEntry[];

  /** Count of input (user-role message) entries in the persisted log —
   *  the session's live continuation check compares this across ticks. */
  inputEntryCount(): number;

  /** Emit the turn-boundary record. No-op when disabled at construction. */
  endTurn(input: TimelineEndTurnInput): Promise<void>;

  // ─────────── Sync surface (log — for tooling + custom compactors) ───────────

  /**
   * One execution's durable coordinates — the resume seam
   * (execution-resume.md §3.4). Coordinates out, never entries: the harness
   * derives them from its own persisted tier, so no consumer scans contents
   * to compute metadata. `undefined` when the log holds nothing for the id.
   */
  executionCursor(executionId: string): ExecutionCursor | undefined;

  /**
   * Provenance of the divergence the current projection carries — what the last
   * `compact` / {@link replaceProjection} folded, and the strategy metadata it
   * declared. `undefined` when the projection mirrors the log
   * ({@link resetProjection} clears it).
   */
  lastCompaction(): TimelineProjectionMeta | undefined;

  // ─────────── Async surface (Operations) ───────────

  /**
   * Append one or more entries to the log AND to the projection,
   * atomically. Goes through `runOperation` — emits a single
   * `timeline:command:append:requested → :terminal` envelope pair
   * around the whole batch. The persisted log is the journal of all
   * appends; the projection sees the new entries at the tail (after
   * the compacted prefix when one exists).
   *
   * Calling with zero args is a no-op (returns a resolved promise
   * without emitting an envelope).
   */
  append(...entries: TimelineEntry[]): Promise<void>;

  /**
   * Await the durable write-behind barrier (ADR 49). On resolution, every
   * entry appended so far is durable in the harness's persisted-tier store.
   * The loop executor awaits this at execution end and `session.close()`
   * awaits it; a no-op under `writePolicy: "through"` (appends are already
   * synchronous with the store). Rejects if a buffered store write failed.
   *
   * Invariant: any process that subsequently loads the store sees every
   * completed execution — the resume guarantee that replaces snapshots.
   */
  flush(): Promise<void>;

  /**
   * Run a strategy that produces a new projection. The log is
   * untouched. After completion, the projection equals the strategy's
   * output; subscribers fire; `lastCompaction` metadata records the
   * strategy's `metadata` as provenance.
   *
   * No-arg is the **signal form** (ADR 51): it runs the
   * construction-bound default strategy (`defineTimeline({ compact })`)
   * — the form that can cross the inbox/wire as a bare verb, because
   * it carries no executable configuration. The explicit argument is
   * the in-process override (inner-scope-wins at the call site).
   *
   * @throws {TimelineError._tag === "CompactHandlerFailed"}
   * @throws {TimelineError._tag === "CompactStrategyMissing"} — no-arg
   *   call with no construction-bound default configured.
   */
  compact(strategy?: CompactStrategy): Promise<CompactResult>;

  /**
   * Cursored, seq-tagged read of the durable log — the async log-read surface
   * (§2.7: the log's only home is the store; there is no sync whole-log read).
   * Flushes the write-behind first so the page reflects every append. Throws
   * when the configured store implements no cursored read.
   */
  history(
    options?: import("./log-store.js").LogHistoryOptions,
  ): Promise<ReadonlyArray<import("./log-store.js").SeqTagged<TimelineEntry>>>;

  /**
   * Whether the resident strategy wants to fold at this size.
   *
   * The harness answers the QUESTION rather than handing out the strategy —
   * executable configuration does not leave this harness, and a trigger that
   * held the strategy would also be free to keep its own copy of the threshold,
   * which is exactly the duplication this replaces (ADR 97). Part of the
   * protocol so the session's tick-end fold can ask without knowing whether the
   * strategy came from config or from the tree.
   *
   * `false` when no strategy is bound, or when the bound one states no policy —
   * an absent opinion is not a yes.
   */
  shouldCompact?(ctx: CompactDecisionCtx): boolean;

  /**
   * Declare the compaction strategy from the agent tree, taking precedence over
   * the construction-bound one (`defineTimeline({ compact })`). Returns an
   * unsubscribe that restores the configured default.
   *
   * The second door (ADR 97): a strategy is configurable either where the app
   * is composed or where the conversation is rendered, resolved
   * **tree > config** — the inner-scope-wins ladder every other layered seam
   * uses.
   *
   * ADR 56 solves the same problem for models by putting a `modelRef` in the IR
   * and the live value on a bridge, because the LOOP resolves it and the loop
   * reads the IR. This resolves in the session's tick-end fold, which holds
   * these bridges directly — so the ref, the intrinsic and the collector
   * contributor would be machinery with no reader. The live half alone is the
   * whole mechanism here.
   *
   * Last writer wins, matching `ToolBridge`. Nesting two declarations is
   * therefore the inner one, which is what a reader expects.
   */
  declareCompact?(strategy: CompactStrategy): Unsubscribe;

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

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
