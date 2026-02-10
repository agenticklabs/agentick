/**
 * Session Store Implementations
 *
 * Provides storage adapters for session persistence.
 */

import type { SessionSnapshot, SessionStore } from "./types";

/**
 * In-memory session store for testing and development.
 *
 * Sessions are stored in a Map and lost when the process exits.
 * Use this for:
 * - Unit tests
 * - Development/debugging
 * - Single-process applications that don't need persistence
 *
 * For production, implement SessionStore with a persistent backend
 * (Redis, database, filesystem, etc.).
 *
 * @example
 * ```typescript
 * const app = createApp(MyAgent, {
 *   sessions: {
 *     store: new MemorySessionStore(),
 *     idleTimeout: 60000, // 1 minute
 *   },
 * });
 * ```
 */
export class MemorySessionStore implements SessionStore {
  private store = new Map<string, SessionSnapshot>();

  /**
   * Create a new in-memory session store.
   *
   * @param options - Optional configuration
   * @param options.maxSize - Maximum number of sessions to store (LRU eviction)
   */
  constructor(private options: { maxSize?: number } = {}) {}

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    // Enforce max size with LRU eviction
    if (this.options.maxSize && this.store.size >= this.options.maxSize) {
      // Remove oldest entry (first in insertion order)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    // Delete and re-add to maintain LRU order
    this.store.delete(sessionId);
    this.store.set(sessionId, snapshot);
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    const snapshot = this.store.get(sessionId);
    if (!snapshot) {
      return null;
    }

    // Move to end to maintain LRU order
    this.store.delete(sessionId);
    this.store.set(sessionId, snapshot);

    return snapshot;
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  async has(sessionId: string): Promise<boolean> {
    return this.store.has(sessionId);
  }

  /**
   * Get the number of stored sessions.
   * Useful for testing and monitoring.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clear all stored sessions.
   * Useful for testing.
   */
  clear(): void {
    this.store.clear();
  }
}
