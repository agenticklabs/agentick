/**
 * `HookBridges` backed by session state.
 *
 * The reconciler harness consumes a bundle of bridges/harnesses at
 * mount time:
 *
 *   - `TimelineBridge`        — synchronous read of accumulated timeline
 *   - `KnobsHarnessProtocol`  — model-visible knobs (full harness per ADR 26)
 *   - `StateBridge`           — session-internal reactive state
 *   - `DataBridge`            — `useData` cache + Promise tracking
 *   - `LoopBridge`            — `useLoopControl` continuation knob
 *   - `SessionBridge`         — id + status + tick metadata
 *
 * Knobs is constructed as a `KnobsHarness` per ADR 26 — wired to the
 * session's substrate so its Operation envelopes flow into the app
 * bus and journal, and remote actors (admin dashboards, cluster
 * nodes) can address it at `inbox://knobs:{sessionId}:knobs`.
 */

import { InMemoryDataBridge } from "@agentick/reconciler-react";
import { KnobsHarness } from "@agentick/knobs";
import { StateHarness } from "@agentick/state";
import type {
  EventBus,
  HookBridges,
  LoopBridge,
  MessageInbox,
  MessageRole,
  OperationJournal,
  SessionBridge,
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

// StateHarness is constructed inline in buildSessionBridges so it can
// share the session's substrate; no per-call factory needed.

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
 * Assemble the full `HookBridges` bundle from session state. KnobsHarness
 * is constructed against the session's shared substrate so its
 * envelopes flow into the app's bus + journal (visible via
 * `app.events({ surface: "knobs" })`).
 */
export interface SessionHookBridges extends HookBridges {
  readonly knobs: KnobsHarness;
  readonly state: StateHarness;
  readonly data: InMemoryDataBridge;
}

export interface BuildSessionBridgesOptions {
  readonly toolBridge?: ToolBridge;
  /**
   * Extension-provided bridges. Merged into the bundle by name —
   * adopters install extensions (`@agentick/sandbox`, etc.) via
   * `AppHarnessOptions.extensions`; the AppHarness then forwards
   * the merged map to every session it constructs.
   */
  readonly extensionBridges?: ReadonlyMap<string, unknown>;
}

export function buildSessionBridges(
  store: SessionStateStore,
  substrate: {
    readonly journal: OperationJournal;
    readonly bus: EventBus;
    readonly inbox: MessageInbox;
  },
  options: BuildSessionBridgesOptions = {},
): SessionHookBridges {
  // Knobs + State are harnesses wired to the session's substrate (ADR 26).
  const knobs = new KnobsHarness(
    `${store.id}:knobs`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
  );
  const state = new StateHarness(
    `${store.id}:state`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
  );

  const base: SessionHookBridges = {
    timeline: timelineBridgeFor(store),
    knobs,
    state,
    data: new InMemoryDataBridge(),
    loop: loopBridgeStub(),
    session: sessionBridgeFor(store),
    ...(options.toolBridge !== undefined ? { tools: options.toolBridge } : {}),
  };
  if (options.extensionBridges && options.extensionBridges.size > 0) {
    return {
      ...base,
      ...Object.fromEntries(options.extensionBridges),
    } as SessionHookBridges;
  }
  return base;
}
