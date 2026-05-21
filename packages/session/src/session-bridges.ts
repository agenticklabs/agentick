/**
 * `HookBridges` backed by session state.
 *
 * The reconciler harness needs five bridges at mount time:
 *
 *   - `TimelineBridge` — synchronous read of accumulated timeline
 *   - `KnobBridge`     — get/set/list/subscribe on model-visible knobs
 *   - `DataBridge`     — `useData` cache + Promise tracking
 *   - `LoopBridge`     — `useLoopControl` continuation knob
 *   - `SessionBridge`  — id + status + tick metadata
 *
 * In Phase 4e we back the first three with the session's own in-memory
 * state. `LoopBridge` is a stub (no continuation override yet), and
 * `DataBridge` reuses the `InMemoryDataBridge` shipped from
 * `@agentick/reconciler-react` (no session-level persistence yet).
 */

import {
  InMemoryDataBridge,
  inMemoryKnobBridge,
  inMemoryStateBridge,
  type InMemoryKnobBridge,
} from "@agentick/reconciler-react";
import type {
  HookBridges,
  LoopBridge,
  MessageRole,
  SessionBridge,
  StateBridge,
  TimelineBridge,
  TimelineEntrySummary,
  TimelineSnapshot,
  ToolBridge,
  Unsubscribe,
} from "@agentick/spec";

import type { SessionStateStore } from "./session-state.js";

/**
 * Map the session's persistence-shaped `TimelineEntry` (message wrapper
 * with visibility/tags) to the reconciler bridge's
 * `TimelineEntrySummary` (flat row the hooks consume).
 */
function toEntrySummary(entry: {
  readonly kind: "message";
  readonly message: {
    readonly id: string;
    readonly role: string;
    readonly content: readonly unknown[];
    readonly ts: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}): TimelineEntrySummary {
  const m = entry.message;
  return {
    id: m.id,
    role: m.role as MessageRole,
    content: m.content as TimelineEntrySummary["content"],
    timestamp: m.ts,
    ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
  };
}

export function timelineBridgeFor(store: SessionStateStore): TimelineBridge {
  return {
    read: (): TimelineSnapshot => ({
      entries: store
        .timeline()
        .filter((e) => e.visibility !== "log")
        .map(toEntrySummary),
      version: store.timelineVersion(),
    }),
    subscribe: (listener: () => void): Unsubscribe => store.subscribeTimeline(listener),
  };
}

/**
 * @deprecated Use `InMemoryKnobBridge` from `@agentick/reconciler-react`
 * directly. Kept as a re-export alias to avoid a breaking surface change
 * in this commit.
 */
export type KnobBridgeWithSnapshot = InMemoryKnobBridge;

export function knobBridgeFor(initial: Readonly<Record<string, unknown>> = {}): InMemoryKnobBridge {
  return inMemoryKnobBridge({ ...initial });
}

export function stateBridgeFor(initial: Readonly<Record<string, unknown>> = {}): StateBridge {
  return inMemoryStateBridge({ ...initial });
}

export function loopBridgeStub(): LoopBridge {
  return {
    continueAfterTick: () => {},
    stopAfterTick: () => {},
  };
}

export function sessionBridgeFor(store: SessionStateStore): SessionBridge {
  return {
    id: store.id,
    get status() {
      return store.status() as SessionBridge["status"];
    },
    get currentTick() {
      return store.currentTick();
    },
    get executionId() {
      return store.currentExecutionId() ?? undefined;
    },
  };
}

/**
 * Assemble the full `HookBridges` bundle from session state. The
 * `DataBridge` is fresh per-mount; future phases may persist it on the
 * session snapshot.
 */
export interface SessionHookBridges extends HookBridges {
  readonly knobs: InMemoryKnobBridge;
  readonly data: InMemoryDataBridge;
}

export function buildSessionBridges(
  store: SessionStateStore,
  options: {
    readonly toolBridge?: ToolBridge;
    /**
     * Extension-provided bridges. Merged into the bundle by name —
     * adopters install extensions (`@agentick/sandbox`, etc.) via
     * `AppHarnessOptions.extensions`; the AppHarness then forwards
     * the merged map to every session it constructs.
     */
    readonly extensionBridges?: ReadonlyMap<string, unknown>;
  } = {},
): SessionHookBridges {
  const base: SessionHookBridges = {
    timeline: timelineBridgeFor(store),
    knobs: knobBridgeFor(),
    state: stateBridgeFor(),
    data: new InMemoryDataBridge(),
    loop: loopBridgeStub(),
    session: sessionBridgeFor(store),
    ...(options.toolBridge !== undefined ? { tools: options.toolBridge } : {}),
  };
  if (options.extensionBridges && options.extensionBridges.size > 0) {
    // Spread extension bridges into the bundle by name. Adopters
    // augment `HookBridges` (via `declare module "@agentick/spec"`)
    // so the slots are typed correctly at the consumer.
    return {
      ...base,
      ...Object.fromEntries(options.extensionBridges),
    } as SessionHookBridges;
  }
  return base;
}
