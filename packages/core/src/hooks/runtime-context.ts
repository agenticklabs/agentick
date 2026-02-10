/**
 * Runtime Context
 *
 * Holds per-session state that hooks need access to.
 * This is what makes each FiberCompiler/Session isolated.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { CompiledStructure } from "../compiler/types";
import type {
  TickStartCallback,
  TickEndCallback,
  AfterCompileCallback,
  TickResult,
  TickState,
} from "./types";
import type { COM } from "../com/object-model";
import type { COMTimelineEntry } from "../com/types";

// Helper for createElement
const h = React.createElement;

// ============================================================
// Persistence Options
// ============================================================

/**
 * Base options for hook snapshot persistence.
 *
 * Hooks that store state (`useData`, `useComState`) extend this to let
 * callers opt individual entries out of session snapshots.
 *
 * Values **must be JSON-serializable** — no Dates, Maps, Sets, functions,
 * or circular references. Non-serializable values are silently skipped
 * at snapshot time.
 */
export interface HookPersistenceOptions {
  /**
   * Whether to include this entry in session snapshots.
   *
   * When `true` (default), the value is saved in session snapshots
   * and restored when the session is loaded from store.
   *
   * Set to `false` for large datasets, frequently-changing data, or
   * values already persisted elsewhere.
   *
   * @default true
   */
  persist?: boolean;
}

// ============================================================
// Cache Entry Types
// ============================================================

export interface CacheEntry {
  value: unknown;
  tick: number;
  deps?: unknown[];
  persist?: boolean;
}

export interface SerializableCacheEntry {
  value: unknown;
  tick: number;
  deps?: unknown[];
}

// ============================================================
// Knob Registration
// ============================================================

/**
 * Registration for a single knob in the runtime store.
 * Stores primitive info + constraints — the resolved value is internal to useKnob.
 */
export interface KnobRegistration {
  name: string;
  description: string;
  getPrimitive: () => string | number | boolean;
  setPrimitive: (value: string | number | boolean) => void;
  defaultValue: string | number | boolean;
  options?: (string | number | boolean)[];
  valueType: "string" | "number" | "boolean";
  // Grouping
  group?: string;
  // Constraints
  required?: boolean;
  validate?: (value: any) => true | string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  pattern?: string;
}

// ============================================================
// Runtime Store
// ============================================================

/**
 * Per-session runtime state.
 * Each FiberCompiler creates one of these.
 */
export interface RuntimeStore {
  /** Data cache for useData */
  dataCache: Map<string, CacheEntry>;

  /** Pending data fetches */
  pendingFetches: Map<string, Promise<unknown>>;

  /** Persistence opt-outs for COM state keys (useComState with persist: false) */
  comStatePersist: Map<string, boolean>;

  /** Lifecycle callbacks */
  tickStartCallbacks: Set<TickStartCallback>;
  tickEndCallbacks: Set<TickEndCallback>;
  afterCompileCallbacks: Set<AfterCompileCallback>;

  /** Knob registry — all active knobs registered by useKnob */
  knobRegistry: Map<string, KnobRegistration>;

  /** Get session's full timeline (source of truth) */
  getSessionTimeline: () => COMTimelineEntry[];
  /** Replace session's timeline */
  setSessionTimeline: (entries: COMTimelineEntry[]) => void;

  /**
   * Resolve results accessible via useResolved().
   * Set once during restore in ensureCompilationInfrastructure().
   * Read-only after initialization — hooks read by key, never mutate.
   */
  resolvedData: Record<string, unknown>;
}

/**
 * Create a new runtime store.
 */
export function createRuntimeStore(): RuntimeStore {
  return {
    dataCache: new Map(),
    pendingFetches: new Map(),
    comStatePersist: new Map(),
    tickStartCallbacks: new Set(),
    tickEndCallbacks: new Set(),
    afterCompileCallbacks: new Set(),
    knobRegistry: new Map(),
    getSessionTimeline: () => [],
    setSessionTimeline: () => {},
    resolvedData: {},
  };
}

// ============================================================
// React Context
// ============================================================

const RuntimeContext = createContext<RuntimeStore | null>(null);

/**
 * Get the runtime store from context.
 */
export function useRuntimeStore(): RuntimeStore {
  const store = useContext(RuntimeContext);
  if (!store) {
    throw new Error("useRuntimeStore must be used within a RuntimeProvider");
  }
  return store;
}

/**
 * Provider for runtime context.
 */
export function RuntimeProvider({
  store,
  children,
}: {
  store: RuntimeStore;
  children?: ReactNode; // Optional since React.createElement can pass it as third arg
}): React.ReactElement {
  return h(RuntimeContext.Provider, { value: store }, children);
}

// ============================================================
// Store Operations (for use outside React render)
// ============================================================

/**
 * Check if store has pending data fetches.
 */
export function storeHasPendingData(store: RuntimeStore): boolean {
  return store.pendingFetches.size > 0;
}

/**
 * Wait for all pending data fetches in store.
 */
export async function storeResolvePendingData(store: RuntimeStore): Promise<void> {
  if (store.pendingFetches.size === 0) return;
  await Promise.all(store.pendingFetches.values());
}

/**
 * Run tick start callbacks with TickState and COM.
 */
export async function storeRunTickStartCallbacks(
  store: RuntimeStore,
  tickState: TickState,
  ctx: COM,
): Promise<void> {
  for (const callback of store.tickStartCallbacks) {
    await callback(tickState, ctx);
  }
}

/**
 * Run tick end callbacks with TickResult and COM.
 *
 * Callbacks receive TickResult (data) and COM (context).
 * TickResult contains both data about the completed tick and control methods
 * (stop/continue) to influence whether execution continues.
 *
 * If a callback returns a boolean, it's automatically converted to a continue/stop call:
 * - true = result.continue()
 * - false = result.stop()
 * - void/undefined = no automatic action (callback may have called methods directly)
 */
export async function storeRunTickEndCallbacks(
  store: RuntimeStore,
  result: TickResult,
  ctx: COM,
): Promise<void> {
  for (const callback of store.tickEndCallbacks) {
    const decision = await callback(result, ctx);
    // If callback returns boolean, auto-convert to continue/stop
    if (decision === true) {
      result.continue();
    } else if (decision === false) {
      result.stop();
    }
    // void/undefined = callback handled it or wants default behavior
  }
}

/**
 * Run after compile callbacks.
 */
export async function storeRunAfterCompileCallbacks(
  store: RuntimeStore,
  compiled: CompiledStructure,
  ctx: COM,
): Promise<void> {
  for (const callback of store.afterCompileCallbacks) {
    await callback(compiled, ctx);
  }
}

/**
 * Clear lifecycle callbacks.
 */
export function storeClearLifecycleCallbacks(store: RuntimeStore): void {
  store.tickStartCallbacks.clear();
  store.tickEndCallbacks.clear();
  store.afterCompileCallbacks.clear();
}

/**
 * Clear data cache.
 */
export function storeClearDataCache(store: RuntimeStore): void {
  store.dataCache.clear();
}

/**
 * Get serializable data cache.
 */
export function storeGetSerializableDataCache(
  store: RuntimeStore,
): Record<string, SerializableCacheEntry> {
  const result: Record<string, SerializableCacheEntry> = {};
  for (const [key, entry] of store.dataCache) {
    // Skip entries opted out of persistence
    if (entry.persist === false) continue;

    // Skip entries that fail serialization
    try {
      JSON.stringify(entry.value);
    } catch {
      continue;
    }

    result[key] = {
      value: entry.value,
      tick: entry.tick,
      deps: entry.deps,
    };
  }
  return result;
}

/**
 * Filter COM state for snapshot serialization.
 *
 * Skips keys opted out via `useComState(..., { persist: false })`
 * and values that fail JSON.stringify.
 */
export function storeGetSerializableComState(
  store: RuntimeStore,
  rawState: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawState)) {
    if (store.comStatePersist.get(key) === false) continue;

    try {
      JSON.stringify(value);
    } catch {
      continue;
    }

    result[key] = value;
  }
  return result;
}

/**
 * Restore data cache from serializable format.
 */
export function storeSetDataCache(
  store: RuntimeStore,
  data: Record<string, SerializableCacheEntry>,
): void {
  store.dataCache.clear();
  for (const [key, entry] of Object.entries(data)) {
    store.dataCache.set(key, entry);
  }
}

/**
 * Invalidate cached data matching a pattern.
 */
export function storeInvalidateData(store: RuntimeStore, pattern: string | RegExp): void {
  for (const key of store.dataCache.keys()) {
    const matches = typeof pattern === "string" ? key === pattern : pattern.test(key);
    if (matches) {
      store.dataCache.delete(key);
    }
  }
}
