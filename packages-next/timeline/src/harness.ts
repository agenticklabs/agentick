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

import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol, ulid, type Unsubscribe } from "@agentick/runtime-next";
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

  private readonly listeners = new Set<() => void>();

  get id(): string {
    return this.scopeId;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("timeline", scopeId, journal, bus, inbox);
  }

  // ─────────── Sync surface — projection (the primary consumer view) ───────────

  read(): TimelineSnapshot {
    return this._snapshot;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
  private appendEffect(input: TimelineAppendInput): Effect.Effect<void, never, never> {
    const op: Operation<TimelineAppendInput, void, never> = {
      opId: `timeline:append:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:append",
      scope: { sessionId: this.scopeId },
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.sync(() => {
        this.applyAppend(i);
      }),
    ) as Effect.Effect<void, never, never>;
  }

  compact(strategy: CompactStrategy): Promise<CompactResult> {
    const source: "persisted" | "projection" = strategy.source ?? "persisted";
    const op: Operation<CompactStrategy, CompactResult, never> = {
      opId: `timeline:compact:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:compact",
      scope: { sessionId: this.scopeId },
      input: strategy,
    };
    return runHarnessProtocol(
      this.runOperation(op, (s) =>
        Effect.gen(this, function* () {
          const sourceEntries = source === "persisted" ? this._persisted : this._projection;
          const before = sourceEntries.length;
          const next = yield* Effect.tryPromise({
            try: () =>
              s.run({
                entries: sourceEntries,
                ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
              }),
            catch: (cause) => ({ _tag: "CompactHandlerFailed" as const, cause }),
          }).pipe(
            // Surface as a defect — substrate prints + journals it; caller
            // sees the original cause through OperationOutcomeError.
            Effect.orDie,
          );
          const entries = [...next];
          this.applyProjectionReplace(entries, {
            at: Date.now(),
            source,
            entriesBefore: before,
            entriesAfter: entries.length,
            ...(s.metadata !== undefined ? { strategyMetadata: s.metadata } : {}),
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
            ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
          }));
          this._pending = [...this._pending, ...entries];
          this.notify();
          return { ids: entries.map((e) => e.id) };
        }),
      ),
    );
  }

  drain(): Promise<TimelineDrainResult> {
    const op: Operation<undefined, TimelineDrainResult, never> = {
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
              ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
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
      ...(this._lastCompaction !== undefined ? { lastCompaction: this._lastCompaction } : {}),
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
          throw {
            _tag: "RehydrateStrategyMissing",
            reason:
              "importSnapshot({ mode: 'rehydrate' }) requires `rehydrateStrategy`. " +
              "Derive it from snapshot.lastCompaction.strategyMetadata or supply a new one.",
          };
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
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "timeline:replaceProjection":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.replaceProjection(m.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "timeline:resetProjection":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.resetProjection(),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "timeline:queue":
        return Effect.tryPromise<TimelineQueueResult, MessageHandlerError>({
          try: () => this.queue(...m.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "timeline:drain":
        return Effect.tryPromise<TimelineDrainResult, MessageHandlerError>({
          try: () => this.drain(),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      default:
        return Effect.fail({
          _tag: "HandlerError",
          cause: `Unknown timeline message type: ${(m as { type: string }).type}`,
        });
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
    this.listeners.forEach((l) => l());
  }
}
