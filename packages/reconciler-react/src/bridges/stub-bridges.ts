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
  StateHarnessProtocol,
  TimelineBridge,
  TimelineEntrySummary,
  TimelineSnapshot,
  Unsubscribe,
} from "@agentick/spec";
import { KnobsHarness } from "@agentick/knobs";
import { StateHarness } from "@agentick/state";
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
 * Build a {@link StateHarness} for use in test bridges. Like
 * {@link stubKnobsHarness}, wraps the harness with its own in-memory
 * substrate. `initial` seeds entries via `importSnapshot`.
 */
export function stubStateHarness(initial: Readonly<Record<string, unknown>> = {}): StateHarness {
  const harness = new StateHarness(
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
    state: stubStateHarness(options.state) as StateHarnessProtocol,
    data: new InMemoryDataBridge({ onSettled: options.onDataSettled }),
    loop: stubLoopBridge(),
    session: stubSessionBridge(options.sessionId),
  };
}
