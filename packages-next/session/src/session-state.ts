/**
 * `SessionStateStore` — in-memory metadata owned by a `SessionHarness`.
 *
 * Holds session-level status, tick counter, current execution id, and
 * usage stats. The timeline itself lives in the `TimelineHarness` since
 * ADR 26 Step 5a — that two-tier surface (append-only log + projection)
 * doesn't fit in this synchronous metadata bag.
 *
 * Synchronous on purpose. The substrate's FiberRef scope still flows
 * through the harness's `runOperation` wrap; this layer is the
 * underlying mutable cell.
 *
 * Future phases (persistence backends, hibernate/restore) wrap this
 * with durable storage; the interface stays the same.
 */

import type { SessionStatus, UsageStats } from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/utils-next";

export class SessionStateStore {
  readonly id: string;

  private _status: SessionStatus = "idle";
  private _currentTick = 0;
  private _currentExecutionId: string | null = null;
  private readonly _listeners: Notifier = createNotifier();
  private readonly _usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
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
    if (delta.reasoningTokens !== undefined) {
      u.reasoningTokens = (u.reasoningTokens ?? 0) + delta.reasoningTokens;
    }
  }

  // ────────── subscriptions (status / metadata changes only) ──────────

  subscribeMetadata(listener: () => void): () => void {
    return this._listeners.subscribe(listener);
  }

  private notify(): void {
    // Notifier isolates listener errors so store state can't be corrupted.
    this._listeners.notify();
  }
}
