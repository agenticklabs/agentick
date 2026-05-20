/**
 * Stub HookBridges for tests and minimal-runtime use.
 *
 * Each function returns a small implementation with no-op or in-memory
 * behavior. Real runtimes replace these with backed implementations.
 */

import type {
  HookBridges,
  KnobBridge,
  KnobDescriptor,
  LoopBridge,
  SessionBridge,
  StateBridge,
  TimelineBridge,
  TimelineSnapshot,
  Unsubscribe,
} from "@agentick/spec";
import { InMemoryDataBridge } from "./in-memory-data-bridge.js";

export function stubTimelineBridge(): TimelineBridge {
  return {
    read: (): TimelineSnapshot => ({ entries: [], version: 0 }),
    subscribe:
      (_listener: () => void): Unsubscribe =>
      () => {},
  };
}

/**
 * Knob bridge extended with snapshot export/import so the harness can
 * persist + restore the model-visible knob state across mounts.
 */
export interface InMemoryKnobBridge extends KnobBridge {
  exportSnapshot(): Readonly<Record<string, unknown>>;
  importSnapshot(values: Readonly<Record<string, unknown>>): void;
}

export function inMemoryKnobBridge(initial: Record<string, unknown> = {}): InMemoryKnobBridge {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (id: string) => values.get(id),
    set: (id: string, value: unknown) => {
      values.set(id, value);
      listeners.get(id)?.forEach((l) => l());
    },
    list: (): readonly KnobDescriptor[] => {
      const out: KnobDescriptor[] = [];
      for (const [id, value] of values) out.push({ id, value });
      return out;
    },
    subscribe: (id: string, listener: () => void): Unsubscribe => {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    exportSnapshot: () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of values) out[k] = v;
      return out;
    },
    importSnapshot: (next: Readonly<Record<string, unknown>>) => {
      // Replace contents, notifying subscribers for every affected id.
      const oldKeys = new Set(values.keys());
      const newKeys = new Set(Object.keys(next));
      const changedIds = new Set<string>([...oldKeys, ...newKeys]);
      values.clear();
      for (const [k, v] of Object.entries(next)) values.set(k, v);
      for (const id of changedIds) listeners.get(id)?.forEach((l) => l());
    },
  };
}

/**
 * In-memory `StateBridge` — sibling of `inMemoryKnobBridge` minus knob
 * descriptor metadata. Wraps a string-keyed bag with subscribe + snapshot
 * round-trip. Used by `useSessionState` (v2 analog of v1's `useComState`).
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D1
 */
export function inMemoryStateBridge(initial: Readonly<Record<string, unknown>> = {}): StateBridge {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
      listeners.get(key)?.forEach((l) => l());
    },
    has: (key: string) => values.has(key),
    list: (): readonly string[] => [...values.keys()],
    subscribe: (key: string, listener: () => void): Unsubscribe => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    exportSnapshot: () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of values) out[k] = v;
      return out;
    },
    importSnapshot: (next: Readonly<Record<string, unknown>>) => {
      const oldKeys = new Set(values.keys());
      const newKeys = new Set(Object.keys(next));
      const changedKeys = new Set<string>([...oldKeys, ...newKeys]);
      values.clear();
      for (const [k, v] of Object.entries(next)) values.set(k, v);
      for (const key of changedKeys) listeners.get(key)?.forEach((l) => l());
    },
  };
}

export function stubLoopBridge(): LoopBridge {
  return {
    continueAfterTick: () => {},
    stopAfterTick: () => {},
  };
}

export function stubSessionBridge(id = "s_stub"): SessionBridge {
  return { id, status: "idle" };
}

export interface StubBridgesOptions {
  readonly sessionId?: string;
  readonly knobs?: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
  readonly onDataSettled?: (key: string) => void;
}

/**
 * Convenience: produce a `HookBridges` bundle with in-memory + stub
 * implementations. Useful for unit tests; real runtimes plug in their
 * own concrete bridges.
 */
export function stubBridges(options: StubBridgesOptions = {}): HookBridges {
  return {
    timeline: stubTimelineBridge(),
    knobs: inMemoryKnobBridge(options.knobs),
    state: inMemoryStateBridge(options.state),
    data: new InMemoryDataBridge({ onSettled: options.onDataSettled }),
    loop: stubLoopBridge(),
    session: stubSessionBridge(options.sessionId),
  };
}
