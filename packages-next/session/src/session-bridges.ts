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

import { InMemoryDataBridge } from "@agentick/reconciler-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { KnobsHarness } from "@agentick/knobs-next";
import { StateHarness } from "@agentick/state-next";
import { TasksHarness } from "@agentick/tasks-next";
import { TimelineHarness } from "@agentick/timeline-next";
import type {
  ElicitationHarnessProtocol,
  EventBus,
  HookBridges,
  LoopBridge,
  MessageInbox,
  OperationJournal,
  SessionBridge,
  TasksHarnessProtocol,
  ToolBridge,
} from "@agentick/spec-next";

import type { SessionStateStore } from "./session-state.js";
import { omitUndefined } from "@agentick/utils-next";

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
  readonly tasks: TasksHarnessProtocol;
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
  /**
   * Pre-constructed elicitation harness. When supplied, this instance
   * is used for the `elicitation` slot — letting the AppHarness share
   * the SAME harness with the per-session `ToolExecutorHarness`'s
   * confirmation gate. When omitted, a fresh harness is constructed
   * on the substrate (the tool-executor and bridges then disagree
   * about which registry to resolve to, so adopters who want the
   * confirmation gate MUST supply this).
   */
  readonly elicitation?: ElicitationHarnessProtocol;
  /**
   * Pre-constructed tasks harness. Same wiring rationale as
   * `elicitation` — the AppHarness shares ONE instance with the
   * per-session `ToolExecutorHarness` (so its TaskHandle-return
   * detection routes against the same registry that JSX
   * `bridges.tasks` consumers see). When omitted, a fresh harness
   * is constructed on the substrate.
   */
  readonly tasks?: TasksHarnessProtocol;
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
  const elicitation =
    options.elicitation ??
    new ElicitationHarness(
      `${store.id}:elicitation`,
      substrate.journal,
      substrate.bus,
      substrate.inbox,
      { parentScope: { sessionId: store.id } },
    );
  const tasks =
    options.tasks ??
    new TasksHarness(`${store.id}:tasks`, substrate.journal, substrate.bus, substrate.inbox, {
      parentScope: { sessionId: store.id },
    });

  const base: SessionHookBridges = {
    timeline,
    knobs,
    state,
    elicitation,
    tasks,
    data: new InMemoryDataBridge(),
    loop: loopBridgeStub(),
    session: sessionBridgeFor(store),
    ...omitUndefined({ tools: options.toolBridge }),
  };
  if (options.extensionBridges && options.extensionBridges.size > 0) {
    return {
      ...base,
      ...Object.fromEntries(options.extensionBridges),
    } as SessionHookBridges;
  }
  return base;
}
