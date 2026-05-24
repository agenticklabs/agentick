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
  TimelineEntry,
  TimelineHarnessProtocol,
} from "@agentick/spec";
import { KnobsHarness } from "@agentick/knobs";
import { StateHarness } from "@agentick/state";
import { TimelineHarness } from "@agentick/timeline";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { InMemoryDataBridge } from "./in-memory-data-bridge.js";

/**
 * Build a {@link TimelineHarness} for use in test bridges. Wraps the
 * harness with an in-memory substrate (own journal/bus/inbox). Real
 * session deployments share substrate with the host AppHarness; this
 * factory is for standalone unit tests where the substrate plumbing
 * isn't exercised.
 *
 * `initial` seeds entries eagerly via `importSnapshot({ mode: "as-is" })` —
 * both log and projection start as a live mirror of the supplied array.
 */
export function stubTimelineHarness(initial: readonly TimelineEntry[] = []): TimelineHarness {
  const harness = new TimelineHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  if (initial.length > 0) {
    void harness.importSnapshot(
      {
        persisted: initial,
        projection: initial,
        persistedVersion: initial.length,
        projectionVersion: initial.length,
      },
      { mode: "as-is" },
    );
  }
  return harness;
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
  readonly timeline?: readonly TimelineEntry[];
  readonly onDataSettled?: (key: string) => void;
}

/**
 * Convenience: produce a `HookBridges` bundle with in-memory + stub
 * implementations. Useful for unit tests; real runtimes plug in their
 * own concrete bridges.
 *
 * `timeline` / `knobs` / `state` are real harnesses (per ADR 26 — these
 * are harnesses, not bridges). Tests that need to invoke harness
 * operations use the async surface and the eager-mutation guarantee.
 */
export function stubBridges(options: StubBridgesOptions = {}): HookBridges {
  return {
    timeline: stubTimelineHarness(options.timeline) as TimelineHarnessProtocol,
    knobs: stubKnobsHarness(options.knobs) as KnobsHarnessProtocol,
    state: stubStateHarness(options.state) as StateHarnessProtocol,
    data: new InMemoryDataBridge({ onSettled: options.onDataSettled }),
    loop: stubLoopBridge(),
    session: stubSessionBridge(options.sessionId),
  };
}
