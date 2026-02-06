/**
 * V2 Session Hibernation
 *
 * Serialize and restore session state for persistence.
 *
 * Unlike React's hydration (which is about attaching to pre-rendered DOM),
 * this is about serializing our state and restoring it later.
 *
 * Key insight: We don't need to serialize React's fiber tree. We serialize
 * OUR state, and React rebuilds its tree from scratch on restore. Since our
 * hooks (useData, etc.) read from our caches, the render produces the same
 * output as before hibernation.
 */

import type { FiberCompiler } from "../compiler/fiber-compiler";
import type { TimelineEntry } from "../hooks/types";
import type { SerializableCacheEntry } from "../hooks/runtime-context";

// ============================================================
// Snapshot Types
// ============================================================

/**
 * Serializable session snapshot.
 * This is what gets persisted to storage.
 */
export interface SessionSnapshot {
  /** Version for migration support */
  version: 1;

  /** Session ID */
  sessionId: string;

  /** Current tick number */
  tick: number;

  /** Conversation timeline */
  timeline: SerializableTimelineEntry[];

  /** COM state (key-value pairs) */
  comState: Record<string, unknown>;

  /** Data cache from useData */
  dataCache: Record<string, SerializableCacheEntry>;

  /** Timestamp when snapshot was taken */
  createdAt: string;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Timeline entry without non-serializable fields.
 */
export interface SerializableTimelineEntry {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: string; // ISO string instead of Date
}

// ============================================================
// Hibernate (Serialize)
// ============================================================

export interface HibernateOptions {
  /** Additional metadata to include in snapshot */
  metadata?: Record<string, unknown>;
}

/**
 * Create a serializable snapshot of the session state.
 *
 * @example
 * ```typescript
 * const snapshot = hibernate(compiler, {
 *   sessionId: session.id,
 *   tick: session.currentTick,
 *   timeline: session.timeline,
 *   comState: session.ctx.state,
 * });
 *
 * // Store snapshot
 * await db.sessions.save(session.id, JSON.stringify(snapshot));
 * ```
 */
export function hibernate(
  compiler: FiberCompiler,
  state: {
    sessionId: string;
    tick: number;
    timeline: TimelineEntry[];
    comState: Map<string, unknown>;
  },
  options: HibernateOptions = {},
): SessionSnapshot {
  return {
    version: 1,
    sessionId: state.sessionId,
    tick: state.tick,
    timeline: state.timeline.map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      createdAt: entry.createdAt.toISOString(),
    })),
    comState: Object.fromEntries(state.comState),
    dataCache: compiler.getSerializableDataCache(),
    createdAt: new Date().toISOString(),
    metadata: options.metadata,
  };
}

// ============================================================
// Hydrate (Deserialize)
// ============================================================

export interface HydrateResult {
  /** Session ID from snapshot */
  sessionId: string;

  /** Tick number to resume from */
  tick: number;

  /** Restored timeline */
  timeline: TimelineEntry[];

  /** Restored COM state */
  comState: Map<string, unknown>;

  /** Snapshot metadata */
  metadata?: Record<string, unknown>;

  /** When the snapshot was created */
  snapshotCreatedAt: Date;
}

/**
 * Restore session state from a snapshot.
 *
 * This restores our caches and returns the state to apply to a session.
 * The session can then render and React will produce the same output
 * because our hooks read from the restored caches.
 *
 * @example
 * ```typescript
 * // Load snapshot from storage
 * const json = await db.sessions.get(sessionId);
 * const snapshot = JSON.parse(json) as SessionSnapshot;
 *
 * // Create compiler first
 * const compiler = new FiberCompiler(ctx);
 *
 * // Hydrate - restores data cache into compiler
 * const state = hydrate(compiler, snapshot);
 *
 * // Now create/configure session with restored state
 * session.timeline = state.timeline;
 * session.currentTick = state.tick;
 * // etc.
 * ```
 */
export function hydrate(compiler: FiberCompiler, snapshot: SessionSnapshot): HydrateResult {
  // Validate version
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  }

  // Restore data cache into the compiler's runtime store
  compiler.setDataCache(snapshot.dataCache);

  // Convert timeline dates back
  const timeline: TimelineEntry[] = snapshot.timeline.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.content,
    createdAt: new Date(entry.createdAt),
  }));

  // Convert comState back to Map
  const comState = new Map(Object.entries(snapshot.comState));

  return {
    sessionId: snapshot.sessionId,
    tick: snapshot.tick,
    timeline,
    comState,
    metadata: snapshot.metadata,
    snapshotCreatedAt: new Date(snapshot.createdAt),
  };
}

// ============================================================
// Utilities
// ============================================================

/**
 * Check if a snapshot is valid.
 */
export function isValidSnapshot(obj: unknown): obj is SessionSnapshot {
  if (!obj || typeof obj !== "object") return false;

  const s = obj as SessionSnapshot;
  return (
    s.version === 1 &&
    typeof s.sessionId === "string" &&
    typeof s.tick === "number" &&
    Array.isArray(s.timeline) &&
    typeof s.comState === "object" &&
    typeof s.dataCache === "object" &&
    typeof s.createdAt === "string"
  );
}

/**
 * Get snapshot age in milliseconds.
 */
export function getSnapshotAge(snapshot: SessionSnapshot): number {
  return Date.now() - new Date(snapshot.createdAt).getTime();
}

/**
 * Create a deep clone of a snapshot (for testing/debugging).
 */
export function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}
