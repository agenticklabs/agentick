/**
 * Session Store implementations.
 *
 * @module @tentickle/server/session-store
 */

import type { Session } from "@tentickle/core/app";
import type { SessionStore } from "./types.js";

/**
 * In-memory session store.
 *
 * Suitable for:
 * - Development
 * - Testing
 * - Single-instance deployments
 *
 * NOT suitable for:
 * - Production multi-instance deployments
 * - Persistent sessions across restarts
 *
 * @example
 * ```typescript
 * const store = new InMemorySessionStore();
 *
 * // Use with session handler
 * const handler = createSessionHandler({
 *   app,
 *   store,
 * });
 * ```
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  /**
   * Get session by ID.
   */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Store session.
   */
  set(id: string, session: Session): void {
    this.sessions.set(id, session);
  }

  /**
   * Delete session.
   */
  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      return this.sessions.delete(id);
    }
    return false;
  }

  /**
   * List all session IDs.
   */
  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if session exists.
   */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Get number of sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}
