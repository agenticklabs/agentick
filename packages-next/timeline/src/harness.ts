/**
 * TimelineHarness — append-only log + materialized projection.
 *
 * Implements {@link TimelineHarnessProtocol}. Extends `BaseHarness<"timeline">`
 * so writes participate in the substrate's Operation contract.
 *
 * **Two-tier storage:**
 *
 *   - `persisted` — the durable, append-only log. Only `append` mutates
 *     it; once an entry lands, the harness will never remove or modify
 *     it. The session's source of truth for "what happened."
 *   - `projection` — what `read()`/`subscribe()` expose. Normally a
 *     live mirror of `persisted`; after `compact` or `replaceProjection`,
 *     can diverge. Subsequent appends land at the tail of the projection
 *     too — the natural "compacted prefix + recent" shape.
 *
 * **Invocation (ADR 51)** — every verb is a DECLARED COMMAND
 * (constructor, `this.command()`): `timeline:append`, `timeline:replaceProjection`,
 * `timeline:resetProjection`, and `timeline:compact` (the **signal
 * form**). One canonical string per verb is simultaneously the inbox
 * message type over `timeline:{scopeId}`, the op-name root, the authz
 * scope label, and the (matrix-gated) wire method name.
 *
 * `compact` crosses boundaries as a bare verb + optional advisory
 * `instructions` (serializable data) resolved against the
 * construction-bound default strategy (`TimelineHarnessOptions.compact`
 * / `withTimeline({ compact })`). The strategy itself — executable
 * configuration — never travels; the explicit-arg `compact(strategy)`
 * form is an in-process-only override and stays a hand-built Operation
 * by doctrine (ADR 51 §1.2).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { omitUndefined } from "@agentick/utils-next";

import { Effect } from "effect";
import {
  BaseHarness,
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
  type Unsubscribe,
} from "@agentick/runtime-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";

import { MemoryTimelineStore, type SeqTaggedEntry, type TimelineStore } from "./store.js";
import type {
  CompactResult,
  CompactStrategy,
  EventBus,
  MessageEnvelope,
  EventScope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  OperationOrigin,
  StandardSchemaV1,
  TimelineAppendInput,
  TimelineEntry,
  TimelineHarnessProtocol,
  TimelineHarnessSnapshot,
  TimelineImportSnapshotOptions,
  TimelineReplaceProjectionInput,
  TimelineSnapshot,
  MessageTimelineEntry,
  TurnBoundaryEntry,
  UsageStats,
} from "@agentick/spec-next";
import {
  CompactHandlerFailed,
  CompactStrategyMissing,
  HandlerError,
  RehydrateStrategyMissing,
  TimelineWriteFailed,
} from "@agentick/spec-next";

// ADR 80/83 — light up the compaction verb. `timeline:compact` is a DECLARED
// command (`compactCmd`, the signal form) routed through `runOperation`, so
// typing it here mints `onBeforeTimelineCompact` / `onAfterTimelineCompact` on
// the derived `CommandHooks` surface. Input is the wire-safe compact SIGNAL
// (the `compactCmd` generic — the resident strategy never travels); output the
// `CompactResult`. The in-process-only explicit-arg `compact(strategy)` form
// shares the op name, so its hooks fire too; the signal input is the widest
// type both carry on the registry key.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "timeline:compact": {
      input: { readonly instructions?: string | readonly unknown[] };
      output: CompactResult;
    };
  }
}

/** A declared command's public invoker (ADR 51). */
type Cmd<I, R> = (input: I, opts?: { readonly origin?: OperationOrigin }) => Promise<R>;

/**
 * Construction options for {@link TimelineHarness} (ADR 49). Flat, per the
 * `withX` options convention — construction types live with the runtime.
 */
export interface TimelineHarnessOptions extends BaseHarnessOptions {
  /**
   * Emit a turn-boundary record at each execution end (ADR 53) —
   * segmentation + turn-aggregate usage, load-bearing NOWHERE.
   * Default true; set false to keep boundary rows out of your store.
   */
  readonly turnBoundaries?: boolean;
  /**
   * Durable backing for the persisted tier. Defaults to a bundled
   * {@link MemoryTimelineStore} (`:memory:`, lost on exit). Inject a
   * durable adapter (`@agentick/timeline-fs-next`, `-sqlite-next`,
   * `-postgres-next`) for cross-restart durability.
   */
  readonly store?: TimelineStore;
  /**
   * When the store observes appends:
   *   - `"behind"` (default) — memory-authoritative write-behind pump;
   *     no store latency inside the tick loop. A crash mid-execution
   *     loses at most the in-flight turn (drained at the `flush()`
   *     barrier the loop executor awaits at execution end).
   *   - `"through"` — every append awaits the store, for products that
   *     demand zero loss at the cost of per-append latency.
   */
  readonly writePolicy?: "behind" | "through";
  /**
   * Construction-bound default compaction strategy (ADR 51 signal-form
   * rule). With a default configured, `compact()` — the no-arg signal
   * form, the one that can cross the inbox/wire as a bare verb — runs
   * this strategy. An explicit `compact(strategy)` call-site argument
   * overrides it (inner-scope-wins, in-process only: strategies are
   * executable configuration and never travel).
   */
  readonly compact?: CompactStrategy;
}

/**
 * Payload schema for the `timeline:compact` **signal form** (ADR 51):
 * a bare verb with optional advisory `instructions`. The resident
 * default strategy is authoritative to honor or ignore them; the
 * strategy itself never travels.
 */
const compactSignalSchema: StandardSchemaV1<{
  readonly instructions?: string | readonly unknown[];
}> = {
  "~standard": {
    version: 1,
    vendor: "@agentick/timeline-next",
    validate: (value) => {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== "object") {
        return { issues: [{ message: "compact signal payload must be an object" }] };
      }
      const instructions = (value as { instructions?: unknown }).instructions;
      if (
        instructions !== undefined &&
        typeof instructions !== "string" &&
        !Array.isArray(instructions)
      ) {
        return {
          issues: [{ message: "instructions must be a string or an array of content blocks" }],
        };
      }
      return { value: value as { instructions?: string | readonly unknown[] } };
    },
  },
};

export class TimelineHarness extends BaseHarness<"timeline"> implements TimelineHarnessProtocol {
  // ─── Storage ───
  private _persisted: TimelineEntry[] = [];
  private _projection: TimelineEntry[] = [];
  private _persistedVersion = 0;
  private _projectionVersion = 0;
  private _lastCompaction?: TimelineHarnessSnapshot["lastCompaction"];

  // Cached snapshot reference — useSyncExternalStore identity stability.
  // Re-allocated only when the projection mutates.
  private _snapshot: TimelineSnapshot = { entries: [], version: 0 };

  private readonly listeners: Notifier = createNotifier();

  // ─── Durable backing (ADR 49) ───
  /** Append-only durable store for the persisted tier; keyed by scopeId (= sessionId). */
  private readonly store: TimelineStore;
  /** Emit turn-boundary records (ADR 53). Default true. */
  private readonly turnBoundaries: boolean;
  private readonly writePolicy: "behind" | "through";
  /** Write-behind buffer — entries appended to memory, not yet drained to the store. */
  private writeBuffer: TimelineEntry[] = [];
  /** The in-flight pump promise, or null when the buffer is empty and drained. */
  private pumpRunning: Promise<void> | null = null;
  /**
   * A captured write-behind failure. Set when a pump batch fails; surfaced
   * (and left set) by {@link flush}. The pump itself never rejects — it
   * absorbs the error here so an un-awaited pump can't become an unhandled
   * rejection, and so `flush()` at the barrier is the single place a
   * durability failure is observed.
   */
  private pumpError: unknown = null;
  /** Construction-bound default compaction strategy (ADR 51 signal form). */
  private readonly defaultCompact?: CompactStrategy;

  // ─── Declared commands (ADR 51) — assigned in the constructor ───
  private readonly appendCmd: Cmd<TimelineAppendInput, void>;
  private readonly replaceProjectionCmd: Cmd<TimelineReplaceProjectionInput, void>;
  private readonly resetProjectionCmd: Cmd<undefined, void>;
  private readonly compactCmd: Cmd<
    { readonly instructions?: string | readonly unknown[] },
    CompactResult
  >;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: TimelineHarnessOptions = {},
  ) {
    super("timeline", scopeId, journal, bus, inbox, options);
    this.store = options.store ?? new MemoryTimelineStore();
    this.turnBoundaries = options?.turnBoundaries ?? true;
    this.writePolicy = options.writePolicy ?? "behind";
    this.defaultCompact = options.compact;
    // Drain buffered write-behind entries before the harness tears down —
    // ADR 49: session close() awaits the flush barrier.
    this.onClose(() => this.flush());

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming, enumeration, and
    // (future, matrix-gated) wire methods all derive from these; the
    // pre-registry `handleMessage` switch is gone. Payload shapes are
    // unchanged (zero wire-shape change). Payloads carried no
    // validation before the registry; schemas stay off for parity —
    // EXCEPT the new compact signal form, a new surface that validates.
    const scope = (): EventScope => ({ sessionId: this.scopeId });
    this.appendCmd = this.command({
      name: "timeline:append",
      scope,
      handler: (i: TimelineAppendInput) => this.appendBody(i),
    });
    this.replaceProjectionCmd = this.command({
      name: "timeline:replaceProjection",
      scope,
      handler: (i: TimelineReplaceProjectionInput) => this.replaceProjectionBody(i),
    });
    this.resetProjectionCmd = this.command({
      name: "timeline:resetProjection",
      scope,
      handler: () => this.resetProjectionBody(),
    });
    // The ADR 51 signal form: a bare `timeline:compact` verb — from the
    // inbox, another node, or (matrix-gated) the wire — runs the
    // construction-bound default strategy. Optional advisory
    // `instructions` ride as data; the resident strategy is
    // authoritative to honor or ignore them. The strategy itself never
    // travels (the explicit-arg `compact(strategy)` stays an
    // in-process-only hand-built operation by doctrine).
    this.compactCmd = this.command({
      name: "timeline:compact",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      input: compactSignalSchema,
      scope,
      handler: (signal) =>
        Effect.gen(this, function* () {
          const base = this.defaultCompact;
          if (base === undefined) {
            return yield* Effect.fail(new CompactStrategyMissing());
          }
          const effective: CompactStrategy =
            signal.instructions !== undefined
              ? { ...base, instructions: signal.instructions as CompactStrategy["instructions"] }
              : base;
          return yield* this.compactBody(effective);
        }),
    });
  }

  /**
   * Durable-backing store label — observability / conformance.
   * `"memory"` for the bundled default.
   */
  get backend(): string {
    return this.store.backend;
  }

  // ─────────── Sync surface — projection (the primary consumer view) ───────────

  read(): TimelineSnapshot {
    return this._snapshot;
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.listeners.subscribe(listener);
  }

  // ─────────── Sync surface — pending (queued, awaiting drain) ───────────

  // ─────────── Sync surface — log (tooling / custom compactors) ───────────

  /**
   * Cursored, seq-tagged read of the durable log (#187). Flushes the
   * write-behind buffer first so the read reflects every completed
   * append, then delegates to the store's optional `history`.
   */
  async history(options?: {
    readonly fromSeq?: number;
    readonly limit?: number;
  }): Promise<ReadonlyArray<SeqTaggedEntry>> {
    await this.flush();
    if (this.store.history === undefined) {
      throw new Error(
        `TimelineStore "${this.store.backend}" does not implement the optional ` +
          "cursored read (history). Implement it (see runTimelineStoreConformance) " +
          "or use readPersisted() for the seq-less full read.",
      );
    }
    return this.store.history(this.scopeId, options);
  }

  readPersisted(): readonly TimelineEntry[] {
    return this._persisted;
  }

  // ─────────── Async surface — full Operations ───────────

  append(...entries: TimelineEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.appendCmd({ entries });
  }

  /**
   * The append command body (runs inside the `timeline:append`
   * operation — declared in the constructor, ADR 51).
   */
  private appendBody(input: TimelineAppendInput): Effect.Effect<void, TimelineWriteFailed, never> {
    return Effect.gen(this, function* () {
      // Memory is authoritative — update it first, synchronously, inside
      // the tick loop (no store latency added here).
      this.applyAppend(input);
      if (this.writePolicy === "through") {
        // Zero-loss mode: the append operation does not complete until the
        // store has the entries. A store-write failure is OPERATIONAL, not
        // a defect — surface it as a typed `TimelineWriteFailed` in the
        // error channel so the session barrier can `catchTag` it and
        // transition to errored (same treatment compact() gives its own
        // operational failure). The harness wraps whatever the adapter
        // rejected with, so adapters need not import spec errors.
        yield* Effect.tryPromise({
          try: () => Promise.resolve(this.store.append(this.scopeId, input.entries)),
          catch: (cause) => new TimelineWriteFailed({ cause }),
        });
      } else {
        // Write-behind: buffer + kick the pump; the flush barrier
        // (execution end / close) awaits durability.
        this.enqueueWriteBehind(input.entries);
      }
    });
  }

  /**
   * Await the write-behind pump — every appended entry is durable in the
   * store on resolution (ADR 49 flush barrier). The loop executor awaits
   * this at execution end, and `session.close()` awaits it via `onClose`.
   * A no-op in `"through"` mode (nothing is ever buffered). Rejects if a
   * buffered store write failed.
   *
   * Invariant: any process that subsequently `load`s the store sees every
   * completed execution.
   */
  async flush(): Promise<void> {
    // Loop: a write that arrived after the pump settled starts a fresh one.
    while (this.pumpRunning) {
      await this.pumpRunning;
    }
    if (this.pumpError !== null) {
      // A buffered write failed; the barrier surfaces it as the typed
      // TimelineWriteFailed (same error the write-through path fails with),
      // so callers catchTag one thing regardless of write policy. Left set —
      // the harness has diverged from its store and cannot silently "recover".
      // The session's execution-end barrier catchTags this and lands the
      // session on "failed" status (A2.2 — see session-next sendBody).
      throw new TimelineWriteFailed({ cause: this.pumpError });
    }
  }

  /**
   * Load the session's persisted log from the store into the in-memory
   * tiers — the resume path (ADR 49 §Hydration). Called once at session
   * init, before first render and before any append (the session's
   * constructor chains this ahead of the reconciler mount when a store
   * is injected — A2.2). Replaces both tiers with the durable log (the
   * projection reconstructs by re-render / a subsequent compaction).
   */
  async hydrate(): Promise<void> {
    const entries = await this.store.load(this.scopeId);
    this._persisted = [...entries];
    this._projection = [...entries];
    this._persistedVersion += 1;
    this._projectionVersion += 1;
    this.refreshSnapshot();
    this.notify();
  }

  /** Buffer entries for the write-behind pump and ensure it's running. */
  private enqueueWriteBehind(entries: readonly TimelineEntry[]): void {
    if (entries.length === 0) return;
    this.writeBuffer.push(...entries);
    if (!this.pumpRunning) this.pumpRunning = this.runPump();
  }

  /**
   * Drain the write-behind buffer to the store in order. Picks up entries
   * appended mid-drain (the buffer is re-checked each iteration), so a
   * single pump run persists everything enqueued up to the point it empties.
   *
   * TODO(A2.2): on store-write failure the current batch is dropped from
   * the buffer and the rejection surfaces via `flush()`. ADR 49 wants this
   * to transition the session to an errored status + retry per adapter
   * policy — that belongs in the session/loop-executor barrier, not here.
   */
  private async runPump(): Promise<void> {
    try {
      while (this.writeBuffer.length > 0) {
        const batch = this.writeBuffer;
        this.writeBuffer = [];
        await this.store.append(this.scopeId, batch);
      }
    } catch (err) {
      // Absorb — never reject the pump promise (an un-awaited pump would
      // become an unhandled rejection). `flush()` surfaces this.
      this.pumpError = err;
    } finally {
      this.pumpRunning = null;
    }
  }

  compact(strategy?: CompactStrategy): Promise<CompactResult> {
    if (strategy === undefined) {
      // Signal form (ADR 51): the declared `timeline:compact` command —
      // same path a bare verb takes over the inbox. Runs the
      // construction-bound default; rejects with CompactStrategyMissing
      // when none is configured.
      return this.compactCmd({});
    }
    // Explicit-arg form: an in-process-only override (inner-scope-wins).
    // Stays a hand-built Operation BY DOCTRINE — the input carries a
    // function (the strategy), so it can never be a declared command
    // (ADR 51 §1.2: executable configuration is unaddressable).
    const op: Operation<CompactStrategy, CompactResult, CompactHandlerFailed> = {
      opId: `timeline:compact:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:compact",
      scope: { sessionId: this.scopeId },
      input: strategy,
    };
    return runHarnessProtocol(this.runOperation(op, (s) => this.compactBody(s)));
  }

  /**
   * The compaction body — shared by the explicit-arg operation above
   * and the declared signal-form command (constructor). `source`
   * selects the fold INPUT (full log vs current projection); the
   * mutation target is always the projection (`applyProjectionReplace`)
   * — the durable log is never rewritten.
   */
  private compactBody(
    s: CompactStrategy,
  ): Effect.Effect<CompactResult, CompactHandlerFailed, never> {
    const source: "persisted" | "projection" = s.source ?? "persisted";
    return Effect.gen(this, function* () {
      const sourceEntries = source === "persisted" ? this._persisted : this._projection;
      const before = sourceEntries.length;
      // A compaction strategy's `run` is typically a model call (the
      // contract says so) — its failure is OPERATIONAL (timeout,
      // rate-limit), not a programming defect. Surface it as the typed,
      // catchable CompactHandlerFailed in the error channel, NOT an
      // orDie defect: an adopter (ernesto's LLM compactor) can catchTag
      // it and retry / skip compaction / error the session.
      const next = yield* Effect.tryPromise({
        try: () =>
          s.run({
            entries: sourceEntries,
            ...omitUndefined({ instructions: s.instructions }),
          }),
        catch: (cause) => new CompactHandlerFailed({ cause }),
      });
      const entries = [...next];
      this.applyProjectionReplace(entries, {
        at: Date.now(),
        source,
        entriesBefore: before,
        entriesAfter: entries.length,
        ...omitUndefined({ strategyMetadata: s.metadata }),
      });
      const result: CompactResult = {
        entriesBefore: before,
        entriesAfter: entries.length,
        source,
      };
      return result;
    });
  }

  replaceProjection(input: TimelineReplaceProjectionInput): Promise<void> {
    return this.replaceProjectionCmd(input);
  }

  /** The replaceProjection command body (declared in the constructor). */
  private replaceProjectionBody(
    i: TimelineReplaceProjectionInput,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const entries = [...i.entries];
      this.applyProjectionReplace(entries, {
        at: Date.now(),
        source: "projection",
        entriesBefore: this._projection.length,
        entriesAfter: entries.length,
      });
    });
  }

  resetProjection(): Promise<void> {
    return this.resetProjectionCmd(undefined);
  }

  /** The resetProjection command body (declared in the constructor). */
  private resetProjectionBody(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this._projection = [...this._persisted];
      this._projectionVersion += 1;
      this._lastCompaction = undefined;
      this.refreshSnapshot();
      this.notify();
    });
  }

  // ─────────── Async surface — pending queue (queue / drain) ───────────

  // ─────────── Turn boundaries (ADR 53, simplified) ───────────
  //
  // Consumption is NON-DESTRUCTIVE — the loop re-renders the whole log
  // every tick — so nothing here is load-bearing. The boundary entry is
  // an emitted RECORD (segmentation + turn-aggregate usage); the
  // trailing-input fold is a derived convenience.

  /** Input predicate (ADR 53 §2.5) — a named constant, not config. */
  private static isInputEntry(e: TimelineEntry): e is MessageTimelineEntry {
    return e.kind === "message" && e.message.role === "user";
  }

  /**
   * Input entries after the LAST assistant entry — the trailing-input fold (ADR 53 §2.3b). UI styling and resume prompts read
   * this; NOTHING load-bearing does. Multi-tick turns append one
   * assistant entry per generation; "after the last" still detects
   * the trailing set correctly.
   */
  trailingInput(): readonly MessageTimelineEntry[] {
    let lastAssistant = -1;
    for (let i = this._persisted.length - 1; i >= 0; i--) {
      const e = this._persisted[i]!;
      if (e.kind === "message" && e.message.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    const out: MessageTimelineEntry[] = [];
    for (let i = lastAssistant + 1; i < this._persisted.length; i++) {
      const e = this._persisted[i]!;
      if (TimelineHarness.isInputEntry(e)) out.push(e);
    }
    return out;
  }

  /** Count of input entries in the persisted log — the session's live
   *  continuation check compares this across ticks. O(n); fine at
   *  conversation scale, revisit with a counter if it ever shows up. */
  inputEntryCount(): number {
    let n = 0;
    for (const e of this._persisted) if (TimelineHarness.isInputEntry(e)) n++;
    return n;
  }

  /**
   * Emit the turn-boundary RECORD (ADR 53 §2.3b) — segmentation,
   * outcome, and the turn's aggregate usage (which may exceed the
   * entry-sum when a tick billed tokens but appended nothing). Read by
   * NOTHING for behavior; disable via `options.turnBoundaries: false`.
   */
  endTurn(input: {
    readonly executionId: string;
    readonly outcome: "succeeded" | "failed" | "aborted";
    readonly usage?: UsageStats;
  }): Promise<void> {
    if (!this.turnBoundaries) return Promise.resolve();
    const entry: TurnBoundaryEntry = {
      kind: "boundary",
      boundary: {
        executionId: input.executionId,
        outcome: input.outcome,
        ...omitUndefined({ usage: input.usage }),
      },
      ts: Date.now(),
      visibility: "log",
    };
    return this.append(entry);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): TimelineHarnessSnapshot {
    return {
      persisted: [...this._persisted],
      projection: [...this._projection],
      persistedVersion: this._persistedVersion,
      projectionVersion: this._projectionVersion,
      ...omitUndefined({ lastCompaction: this._lastCompaction }),
    };
  }

  async importSnapshot(
    snapshot: TimelineHarnessSnapshot,
    options: TimelineImportSnapshotOptions = {},
  ): Promise<void> {
    const mode = options.mode ?? "as-is";

    // Restore the durable log on every mode.
    this._persisted = [...snapshot.persisted];
    this._persistedVersion = snapshot.persistedVersion;

    switch (mode) {
      case "as-is": {
        this._projection = [...snapshot.projection];
        this._projectionVersion = snapshot.projectionVersion;
        this._lastCompaction = snapshot.lastCompaction;
        this.refreshSnapshot();
        this.notify();
        return;
      }
      case "persisted-only": {
        this._projection = [...this._persisted];
        this._projectionVersion += 1;
        this._lastCompaction = undefined;
        this.refreshSnapshot();
        this.notify();
        return;
      }
      case "rehydrate": {
        if (!options.rehydrateStrategy) {
          throw new RehydrateStrategyMissing({
            reason:
              "importSnapshot({ mode: 'rehydrate' }) requires `rehydrateStrategy`. " +
              "Derive it from snapshot.lastCompaction.strategyMetadata or supply a new one.",
          });
        }
        // Reset projection to log, then re-run the strategy.
        this._projection = [...this._persisted];
        this._projectionVersion += 1;
        this._lastCompaction = undefined;
        this.refreshSnapshot();
        this.notify();
        await this.compact(options.rehydrateStrategy);
        return;
      }
    }
  }

  // ─────────── Inbox routing ───────────

  /**
   * All timeline verbs are DECLARED COMMANDS (ADR 51) — the command
   * registry in `BaseHarness.dispatchMessage` routes
   * `timeline:append/queue/drain/replaceProjection/resetProjection/compact`
   * before this fallthrough is ever consulted. Only unknown types land
   * here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown timeline message type: ${msg.type}` }));
  }

  // ─────────── Internals ───────────

  private applyAppend(input: TimelineAppendInput): void {
    for (const entry of input.entries) {
      this._persisted.push(entry);
      this._projection.push(entry);
    }
    this._persistedVersion += 1;
    this._projectionVersion += 1;
    this.refreshSnapshot();
    this.notify();
  }

  private applyProjectionReplace(
    entries: TimelineEntry[],
    provenance: NonNullable<TimelineHarnessSnapshot["lastCompaction"]>,
  ): void {
    this._projection = entries;
    this._projectionVersion += 1;
    this._lastCompaction = provenance;
    this.refreshSnapshot();
    this.notify();
  }

  private refreshSnapshot(): void {
    // Clone entries so the snapshot's array reference changes on every
    // mutation. `useSyncExternalStore` compares snapshots via Object.is,
    // but consumers that destructure + memoize on `entries` rely on the
    // array identity changing too. Cheap O(n) copy on infrequent writes.
    this._snapshot = { entries: [...this._projection], version: this._projectionVersion };
  }

  private notify(): void {
    this.listeners.notify();
  }
}
