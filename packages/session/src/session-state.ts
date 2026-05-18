/**
 * `SessionStateStore` — in-memory state owned by a `SessionHarness`.
 *
 * Implements the writes the loop's `StateApplicator` needs (timeline
 * appends from executor + tool results) and the reads the reconciler's
 * hooks consume (timeline snapshot, session metadata).
 *
 * Synchronous on purpose. The substrate's FiberRef scope still flows
 * through the harness's `runOperation` wrap; this layer is the
 * underlying mutable cell.
 *
 * Future phases (persistence backends, hibernate/restore) wrap this
 * with durable storage; the interface stays the same.
 */

import { ulid } from "@agentick/runtime";
import type {
  ContentBlock,
  SessionMessage,
  SessionMessageRole,
  SessionStatus,
  TimelineEntry,
  UsageStats,
} from "@agentick/spec";

export interface AppendMessageInput {
  readonly role: SessionMessageRole;
  readonly content: readonly ContentBlock[];
  readonly visibility?: "model" | "observer" | "log";
  readonly toolCallId?: string;
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class SessionStateStore {
  readonly id: string;

  private _status: SessionStatus = "idle";
  private _currentTick = 0;
  private _currentExecutionId: string | null = null;
  private readonly _timeline: TimelineEntry[] = [];
  private _timelineVersion = 0;
  private readonly _listeners = new Set<() => void>();
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

  // ────────── timeline ──────────

  timeline(): readonly TimelineEntry[] {
    return this._timeline;
  }

  timelineVersion(): number {
    return this._timelineVersion;
  }

  /** Append a message-shaped entry. Returns the entry's id. */
  appendMessage(input: AppendMessageInput): string {
    const message: SessionMessage = {
      id: `m_${ulid()}`,
      role: input.role,
      content: input.content,
      ts: Date.now(),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const entry: TimelineEntry = {
      kind: "message",
      message,
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    this._timeline.push(entry);
    this._timelineVersion += 1;
    this.notify();
    return message.id;
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

  // ────────── subscriptions ──────────

  subscribeTimeline(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this._listeners) {
      try {
        l();
      } catch {
        // Listener errors must not corrupt store state.
      }
    }
  }
}
