/**
 * Stub HookBridges for tests and minimal-runtime use.
 *
 * Each function returns a small implementation with no-op or in-memory
 * behavior. Real runtimes replace these with backed implementations.
 */

import type {
  HookBridges,
  KnobPrimitive,
  KnobsHarnessProtocol,
  LoopBridge,
  SessionBridge,
  StateBridge,
  TimelineBridge,
  TimelineEntrySummary,
  TimelineSnapshot,
  Unsubscribe,
} from "@agentick/spec";
import { KnobsHarness } from "@agentick/knobs";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { InMemoryDataBridge } from "./in-memory-data-bridge.js";

/**
 * In-memory TimelineBridge with an `append` writer for tests. Real
 * runtimes back the bridge with a persistent journal; this stub is a
 * thin Map + version counter that fires subscribers on `append`.
 */
export interface InMemoryTimelineBridge extends TimelineBridge {
  append(entry: TimelineEntrySummary): void;
  replace(entries: readonly TimelineEntrySummary[]): void;
}

export function stubTimelineBridge(
  initial: readonly TimelineEntrySummary[] = [],
): InMemoryTimelineBridge {
  let entries: readonly TimelineEntrySummary[] = initial.slice();
  let version = initial.length > 0 ? 1 : 0;
  // Cache the snapshot reference — useSyncExternalStore compares with
  // Object.is, so returning a fresh object each call would loop forever.
  let snapshot: TimelineSnapshot = { entries, version };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const bump = () => {
    version += 1;
    snapshot = { entries, version };
    notify();
  };
  return {
    read: (): TimelineSnapshot => snapshot,
    subscribe: (listener: () => void): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    append: (entry) => {
      entries = [...entries, entry];
      bump();
    },
    replace: (next) => {
      entries = next.slice();
      bump();
    },
  };
}

/**
 * Build a {@link KnobsHarness} for use in test bridges. Wraps the harness
 * with an in-memory substrate (own journal/bus/inbox). Real session
 * deployments share substrate with the host AppHarness; this factory
 * is for standalone unit tests where the substrate plumbing isn't
 * exercised.
 *
 * `initial` seeds values eagerly via `importSnapshot`.
 */
export function stubKnobsHarness(
  initial: Readonly<Record<string, KnobPrimitive>> = {},
): KnobsHarness {
  const harness = new KnobsHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  if (Object.keys(initial).length > 0) {
    harness.importSnapshot(initial);
  }
  return harness;
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
  readonly knobs?: Readonly<Record<string, KnobPrimitive>>;
  readonly state?: Record<string, unknown>;
  readonly onDataSettled?: (key: string) => void;
}

/**
 * Convenience: produce a `HookBridges` bundle with in-memory + stub
 * implementations. Useful for unit tests; real runtimes plug in their
 * own concrete bridges.
 *
 * `knobs` is a real {@link KnobsHarness} (per ADR 26 — knobs is a
 * harness, not a bridge). Tests that need to invoke knob operations
 * use the harness's async surface (`set` / `register` / `dispatch`)
 * and the eager-mutation guarantee.
 */
export function stubBridges(options: StubBridgesOptions = {}): HookBridges {
  return {
    timeline: stubTimelineBridge(),
    knobs: stubKnobsHarness(options.knobs) as KnobsHarnessProtocol,
    state: inMemoryStateBridge(options.state),
    data: new InMemoryDataBridge({ onSettled: options.onDataSettled }),
    loop: stubLoopBridge(),
    session: stubSessionBridge(options.sessionId),
  };
}
