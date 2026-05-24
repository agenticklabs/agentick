/**
 * `HookBridges` backed by session state.
 *
 * The reconciler harness consumes a bundle of bridges/harnesses at
 * mount time:
 *
 *   - `TimelineHarnessProtocol` — log + projection (full harness per ADR 26)
 *   - `KnobsHarnessProtocol`    — model-visible knobs (full harness per ADR 26)
 *   - `StateHarnessProtocol`    — session-internal reactive state (full harness)
 *   - `DataBridge`              — `useData` cache + Promise tracking
 *   - `LoopBridge`              — `useLoopControl` continuation knob
 *   - `SessionBridge`           — id + status + tick metadata
 *
 * Timeline / Knobs / State are constructed against the session's
 * substrate (journal + bus + inbox) so their Operation envelopes flow
 * into the app bus and journal, and remote actors (admin dashboards,
 * cluster nodes) can address them at `inbox://{surface}:{sessionId}:{surface}`.
 */

import { InMemoryDataBridge } from "@agentick/reconciler-react";
import { KnobsHarness } from "@agentick/knobs";
import { StateHarness } from "@agentick/state";
import { TimelineHarness } from "@agentick/timeline";
import type {
  EventBus,
  HookBridges,
  LoopBridge,
  MessageInbox,
  OperationJournal,
  SessionBridge,
  ToolBridge,
} from "@agentick/spec";

import type { SessionStateStore } from "./session-state.js";

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
 * Assemble the full `HookBridges` bundle from session state. Timeline /
 * Knobs / State are constructed against the session's shared substrate
 * so their envelopes flow into the app's bus + journal.
 */
export interface SessionHookBridges extends HookBridges {
  readonly timeline: TimelineHarness;
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
  // Timeline / Knobs / State are harnesses wired to the session's substrate (ADR 26).
  const timeline = new TimelineHarness(
    `${store.id}:timeline`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
  );
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
    timeline,
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
