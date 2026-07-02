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
 * **Inbox routing** — three message types reach the harness over
 * `timeline:{scopeId}`:
 *
 *   - `"timeline:append"` → invokes {@link append}
 *   - `"timeline:replaceProjection"` → invokes {@link replaceProjection}
 *   - `"timeline:resetProjection"` → invokes {@link resetProjection}
 *
 * `compact` is intentionally NOT inbox-addressable — the strategy carries
 * a function reference (non-serializable) so it can't cross actor
 * boundaries today. Cross-process compaction would route through a
 * higher-level surface (e.g., a session command) once that landing is
 * designed.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
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

import { MemoryTimelineStore, type TimelineStore } from "./store.js";
import type {
  CompactResult,
  CompactStrategy,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  PendingEntry,
  TimelineAppendInput,
  TimelineDrainResult,
  TimelineEntry,
  TimelineHarnessProtocol,
  TimelineHarnessSnapshot,
  TimelineImportSnapshotOptions,
  TimelineQueueInput,
  TimelineQueueResult,
  TimelineReplaceProjectionInput,
  TimelineSnapshot,
} from "@agentick/spec-next";
import {
  CompactHandlerFailed,
  CompactStrategyMissing,
  HandlerError,
  RehydrateStrategyMissing,
  TimelineWriteFailed,
} from "@agentick/spec-next";

/**
 * Construction options for {@link TimelineHarness} (ADR 49). Flat, per the
 * `withX` options convention — construction types live with the runtime.
 */
export interface TimelineHarnessOptions extends BaseHarnessOptions {
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

type TimelineInboxMessage =
  | { readonly type: "timeline:append"; readonly payload: TimelineAppendInput }
  | {
      readonly type: "timeline:replaceProjection";
      readonly payload: TimelineReplaceProjectionInput;
    }
  | { readonly type: "timeline:resetProjection" }
  | { readonly type: "timeline:queue"; readonly payload: readonly TimelineQueueInput[] }
  | { readonly type: "timeline:drain" };

export class TimelineHarness extends BaseHarness<"timeline"> implements TimelineHarnessProtocol {
  // ─── Storage ───
  private _persisted: TimelineEntry[] = [];
  private _projection: TimelineEntry[] = [];
  private _pending: PendingEntry[] = [];
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
    this.writePolicy = options.writePolicy ?? "behind";
    this.defaultCompact = options.compact;
    // Drain buffered write-behind entries before the harness tears down —
    // ADR 49: session close() awaits the flush barrier.
    this.onClose(() => this.flush());
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

  readPending(): readonly PendingEntry[] {
    return this._pending;
  }

  // ─────────── Sync surface — log (tooling / custom compactors) ───────────

  readPersisted(): readonly TimelineEntry[] {
    return this._persisted;
  }

  // ─────────── Async surface — full Operations ───────────

  append(...entries: TimelineEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return runHarnessProtocol(this.appendEffect({ entries }));
  }

  /**
   * Effect-native append — used by `drain` so that inner appends
   * compose within the drain's Effect fiber, letting BaseHarness
   * auto-thread `parentOpId` onto every emitted envelope (Step 3.5).
   * Going through the Promise-typed `append` would cross
   * `Effect.runPromise`, lose the FiberRef, and break the causality
   * tree.
   */
  private appendEffect(
    input: TimelineAppendInput,
  ): Effect.Effect<void, TimelineWriteFailed, never> {
    const op: Operation<TimelineAppendInput, void, TimelineWriteFailed> = {
      opId: `timeline:append:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:append",
      scope: { sessionId: this.scopeId },
      input,
    };
    return this.runOperation(
      op,
      (i) =>
        Effect.gen(this, function* () {
          // Memory is authoritative — update it first, synchronously, inside
          // the tick loop (no store latency added here).
          this.applyAppend(i);
          if (this.writePolicy === "through") {
            // Zero-loss mode: the append operation does not complete until the
            // store has the entries. A store-write failure is OPERATIONAL, not
            // a defect — surface it as a typed `TimelineWriteFailed` in the
            // error channel so the session barrier can `catchTag` it and
            // transition to errored (same treatment compact() gives its own
            // operational failure). The harness wraps whatever the adapter
            // rejected with, so adapters need not import spec errors.
            yield* Effect.tryPromise({
              try: () => Promise.resolve(this.store.append(this.scopeId, i.entries)),
              catch: (cause) => new TimelineWriteFailed({ cause }),
            });
          } else {
            // Write-behind: buffer + kick the pump; the flush barrier
            // (execution end / close) awaits durability.
            this.enqueueWriteBehind(i.entries);
          }
        }),
      // runOperation adds `SubstrateError` to the channel; erase only THAT
      // (as the original append did) so this composes inside drain's handler
      // without widening drain's op error. The new `TimelineWriteFailed` stays
      // visible — it's a real, catchable failure mode the barrier surfaces.
      // Substrate-level failures still reach callers via runHarnessProtocol.
    ) as Effect.Effect<void, TimelineWriteFailed, never>;
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
      // TODO(A2.2): the session/loop-executor barrier owns the errored-
      // status transition + adapter retry policy; here we only surface.
      throw new TimelineWriteFailed({ cause: this.pumpError });
    }
  }

  /**
   * Load the session's persisted log from the store into the in-memory
   * tiers — the resume path (ADR 49 §Hydration). Called once at session
   * init, before first render and before any append. Replaces both tiers
   * with the durable log (the projection reconstructs by re-render / a
   * subsequent compaction).
   *
   * TODO(A2.2): wire this into `app.createSession({ sessionId })` through
   * `session-next` so open-or-rehydrate is idempotent at the session
   * boundary; today the harness exposes it for direct/tested use.
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
    // Signal form (ADR 51): no-arg resolves the construction-bound
    // default; the explicit call-site argument overrides it
    // (inner-scope-wins, in-process only — strategies never travel).
    const resolved = strategy ?? this.defaultCompact;
    if (resolved === undefined) {
      return Promise.reject(new CompactStrategyMissing());
    }
    const source: "persisted" | "projection" = resolved.source ?? "persisted";
    const op: Operation<CompactStrategy, CompactResult, CompactHandlerFailed> = {
      opId: `timeline:compact:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:compact",
      scope: { sessionId: this.scopeId },
      input: resolved,
    };
    return runHarnessProtocol(
      this.runOperation(op, (s) =>
        Effect.gen(this, function* () {
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
        }),
      ),
    );
  }

  replaceProjection(input: TimelineReplaceProjectionInput): Promise<void> {
    const op: Operation<TimelineReplaceProjectionInput, void, never> = {
      opId: `timeline:replaceProjection:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:replaceProjection",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          const entries = [...i.entries];
          this.applyProjectionReplace(entries, {
            at: Date.now(),
            source: "projection",
            entriesBefore: this._projection.length,
            entriesAfter: entries.length,
          });
        }),
      ),
    );
  }

  resetProjection(): Promise<void> {
    const op: Operation<undefined, void, never> = {
      opId: `timeline:resetProjection:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:resetProjection",
      scope: { sessionId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.sync(() => {
          this._projection = [...this._persisted];
          this._projectionVersion += 1;
          this._lastCompaction = undefined;
          this.refreshSnapshot();
          this.notify();
        }),
      ),
    );
  }

  // ─────────── Async surface — pending queue (queue / drain) ───────────

  queue(...inputs: TimelineQueueInput[]): Promise<TimelineQueueResult> {
    if (inputs.length === 0) return Promise.resolve({ ids: [] });
    const op: Operation<readonly TimelineQueueInput[], TimelineQueueResult, never> = {
      opId: `timeline:queue:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:queue",
      scope: { sessionId: this.scopeId },
      input: inputs,
    };
    return runHarnessProtocol(
      this.runOperation(op, (batch) =>
        Effect.sync(() => {
          const ts = Date.now();
          const entries: PendingEntry[] = batch.map((m) => ({
            id: `m_${ulid()}`,
            role: m.role,
            content: m.content,
            ts,
            ...omitUndefined({ metadata: m.metadata }),
          }));
          this._pending = [...this._pending, ...entries];
          this.notify();
          return { ids: entries.map((e) => e.id) };
        }),
      ),
    );
  }

  drain(): Promise<TimelineDrainResult> {
    // Error channel widened to TimelineWriteFailed: drain appends via
    // appendEffect, so in write-through mode the store failure propagates
    // through the drain op as the same typed error.
    const op: Operation<undefined, TimelineDrainResult, TimelineWriteFailed> = {
      opId: `timeline:drain:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:drain",
      scope: { sessionId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.gen(this, function* () {
          if (this._pending.length === 0) {
            return { entries: [] as readonly TimelineEntry[] };
          }
          // Snapshot pending atomically (callers may add more between
          // operations); clear it before appending so subscribers see
          // pending=[] once the appends start.
          const draining = this._pending;
          this._pending = [];
          this.notify();

          const drained: TimelineEntry[] = draining.map((p) => ({
            kind: "message",
            message: {
              id: p.id,
              role: p.role,
              content: p.content,
              ts: p.ts,
              ...omitUndefined({ metadata: p.metadata }),
            },
          }));
          // appendEffect is Effect-native — staying in this fiber lets
          // the substrate auto-thread parentOpId onto the emitted
          // envelope so observers see the causality tree. One envelope
          // covers the whole batch.
          yield* this.appendEffect({ entries: drained });
          return { entries: drained as readonly TimelineEntry[] };
        }),
      ),
    );
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

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const m = msg as MessageEnvelope<unknown> & TimelineInboxMessage;
    switch (m.type) {
      case "timeline:append":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.append(...m.payload.entries),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "timeline:replaceProjection":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.replaceProjection(m.payload),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "timeline:resetProjection":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.resetProjection(),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "timeline:queue":
        return Effect.tryPromise<TimelineQueueResult, MessageHandlerError>({
          try: () => this.queue(...m.payload),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "timeline:drain":
        return Effect.tryPromise<TimelineDrainResult, MessageHandlerError>({
          try: () => this.drain(),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      default:
        return Effect.fail(
          new HandlerError({
            cause: `Unknown timeline message type: ${(m as { type: string }).type}`,
          }),
        );
    }
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
