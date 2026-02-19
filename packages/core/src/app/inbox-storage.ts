/**
 * In-Memory Inbox Storage
 *
 * Reference implementation of InboxStorage for development and single-process use.
 * Messages are stored in Maps and lost when the process exits.
 *
 * For production durability, implement InboxStorage with a persistent backend
 * (Postgres with LISTEN/NOTIFY, Redis Streams, etc.).
 */

import { randomUUID } from "node:crypto";
import type { InboxStorage, InboxMessage, InboxMessageInput } from "./types";

export class MemoryInboxStorage implements InboxStorage {
  private pending_ = new Map<string, InboxMessage[]>();
  private subscribers = new Map<string, Set<() => void>>();

  async write(sessionId: string, message: InboxMessageInput): Promise<string> {
    const id = randomUUID();
    const entry: InboxMessage = {
      ...message,
      id,
      timestamp: Date.now(),
    };

    let queue = this.pending_.get(sessionId);
    if (!queue) {
      queue = [];
      this.pending_.set(sessionId, queue);
    }
    queue.push(entry);

    // Notify subscribers — swallow errors to avoid breaking writes
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb();
        } catch {
          // Subscriber errors must not propagate
        }
      }
    }

    return id;
  }

  async pending(sessionId: string): Promise<InboxMessage[]> {
    const queue = this.pending_.get(sessionId);
    if (!queue || queue.length === 0) return [];
    // Defensive copy — callers cannot mutate our internal array
    return [...queue];
  }

  async markDone(sessionId: string, messageId: string): Promise<void> {
    const queue = this.pending_.get(sessionId);
    if (!queue) return;
    const idx = queue.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
    // Clean up empty queues
    if (queue.length === 0) {
      this.pending_.delete(sessionId);
    }
  }

  subscribe(sessionId: string, cb: () => void): () => void {
    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(cb);

    return () => {
      subs!.delete(cb);
      if (subs!.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  async sessionsWithPending(): Promise<string[]> {
    const result: string[] = [];
    for (const [sessionId, queue] of this.pending_) {
      if (queue.length > 0) {
        result.push(sessionId);
      }
    }
    return result;
  }

  /** Number of sessions with pending messages. For testing. */
  get size(): number {
    let count = 0;
    for (const queue of this.pending_.values()) {
      if (queue.length > 0) count++;
    }
    return count;
  }

  /** Clear all pending messages and subscribers. For testing. */
  clear(): void {
    this.pending_.clear();
    this.subscribers.clear();
  }
}
