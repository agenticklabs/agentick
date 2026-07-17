/**
 * `SessionRuntime` — the current session's **live, synchronous** runtime state,
 * owned by a `SessionHarness`.
 *
 * This is the **projection** half of the session's (projection, store) pair —
 * NOT a store (do not confuse with the durable `SessionStore`, which is the
 * app-singleton `CollectionStore<SessionRecord>` holding every session's
 * record). `SessionRuntime` is the sync working copy of THIS session's
 * `SessionRecord`: it holds the record's mutable subset (`status`,
 * `currentExecutionId`, `executionCount`, `usage`) plus non-persisted live
 * extras (`currentTick`, the metadata-change listeners). The harness bridges it
 * to the durable store — `subscribeMetadata → rebuild SessionRecord →
 * void sessionStore.put(...)` (write-through, off the critical path).
 *
 * It is the **augmented single-record projection** archetype — the
 * session-scoped sibling of tasks' `live` (record + non-persisted handles):
 * the durable fields mirror the `SessionRecord`, the live extras never persist.
 * Held as a single record (not a collection), so it is a hand-rolled variant
 * rather than a `CollectionProjection` (a collection primitive for one item
 * would be ceremony) — same call the tasks harness made.
 *
 * Synchronous on purpose: the runtime reads `status`/`currentTick`/`usage` per
 * tick, and the substrate's FiberRef scope flows through the harness's
 * `runOperation` wrap around this mutable cell. The timeline lives in the
 * `TimelineHarness` (ADR 26 Step 5a) — its two-tier log+projection surface
 * doesn't fit this synchronous metadata cell.
 *
 * TODO(store-phase-N): `currentTick` is **execution-local** (resets per
 * execution — session → execution → tick), so it does not belong in session
 * state at all; its clean home is execution-scoped state (ADR 77 execution
 * spine). It lives here today only for lack of an execution-state holder, and
 * is correctly excluded from the durable `SessionRecord`.
 */

import type { SessionStatus, UsageStats } from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";

export class SessionRuntime {
  readonly id: string;

  private _status: SessionStatus = "idle";
  private _currentTick = 0;
  private _executionCount = 0;
  private _currentExecutionId: string | null = null;
  private readonly _listeners: Notifier = createNotifier();
  private readonly _usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
  };

  constructor(id: string) {
    this.id = id;
  }

  // ────────── status ──────────

  status(): SessionStatus {
    return this._status;
  }
  setStatus(next: SessionStatus): void {
    this._status = next;
    this.notify();
  }

  // ────────── tick (execution-local — see the file TODO; not in SessionRecord) ──────────

  currentTick(): number {
    return this._currentTick;
  }
  bumpTick(): number {
    return ++this._currentTick;
  }
  resetTick(): void {
    this._currentTick = 0;
  }

  currentExecutionId(): string | null {
    return this._currentExecutionId;
  }
  setCurrentExecutionId(id: string | null): void {
    this._currentExecutionId = id;
  }

  /**
   * Number of executions started against this session — hierarchy-aware
   * accounting (session → execution → tick) for the durable
   * `SessionRecord` (E11). Bumped once per `send` at execution start.
   * Distinct from `currentTick`, which is execution-local (resets per
   * execution) and never enters the session record.
   */
  executionCount(): number {
    return this._executionCount;
  }
  bumpExecutionCount(): number {
    return ++this._executionCount;
  }

  // ────────── usage ──────────

  usage(): UsageStats {
    return this._usage;
  }
  addUsage(delta?: UsageStats): void {
    if (!delta) return;
    const u = this._usage as {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
    };
    u.inputTokens += delta.inputTokens ?? 0;
    u.outputTokens += delta.outputTokens ?? 0;
    u.totalTokens += delta.totalTokens ?? 0;
    u.cachedInputTokens = (u.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0);
    u.cacheCreationTokens = (u.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0);
    u.reasoningTokens = (u.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
  }

  // ────────── subscriptions (status / metadata changes only) ──────────

  subscribeMetadata(listener: () => void): () => void {
    return this._listeners.subscribe(listener);
  }

  private notify(): void {
    // Notifier isolates listener errors so state can't be corrupted.
    this._listeners.notify();
  }
}
