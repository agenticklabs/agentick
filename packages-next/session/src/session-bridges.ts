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

import { Effect } from "effect";
import { InMemoryDataBridge, InMemoryModelBridge } from "@agentick/reconciler-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { KnobsHarness } from "@agentick/knobs-next";
import { StateHarness } from "@agentick/state-next";
import { TasksHarness } from "@agentick/tasks-next";
import { ResourcesHarness } from "@agentick/resources-next";
import { GatesController, type GateOverrideAudit } from "@agentick/gates-next";
import { TimelineHarness, type TimelineHarnessOptions } from "@agentick/timeline-next";
import { ulid } from "@agentick/runtime-next";
import type {
  ElicitationHarnessProtocol,
  EventBus,
  HookBridges,
  LoopBridge,
  MessageInbox,
  OperationJournal,
  ProtocolEvent,
  Resources,
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
  readonly resources: Resources;
  /**
   * The session's gate wiring core (ADR 27). Gates is NOT a harness —
   * a gate's value is a knob value — so this is a runtime transport
   * property on the bridge bundle, NOT a typed `HookBridges` harness
   * slot and NOT snapshot-captured (the controller exposes no
   * `exportSnapshot`). It rides the existing `BridgeContext` so
   * `useGate` and the programmatic `session.gates` converge on ONE
   * controller (unified registry).
   */
  readonly gates: GatesController;
  readonly data: InMemoryDataBridge;
  /**
   * Model registration bridge (ADR 56). The session builds one per
   * mount; `useModelRegistration` registers tree-declared models on it
   * and the loop's `resolveModel` closes over it. Non-optional here (the
   * session always wires it) even though `HookBridges.models` is optional.
   */
  readonly models: InMemoryModelBridge;
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
  /**
   * Pre-constructed resources harness (ADR 62). Same wiring rationale
   * as `elicitation` / `tasks` — the AppHarness shares ONE instance
   * with the per-session `ToolExecutorHarness` (`ctx.resource`), the
   * session bridges (`bridges.resources`), and the SessionInstaller
   * (`installer.resources`). When omitted, a fresh harness is
   * constructed on the substrate (the standalone / test path).
   */
  readonly resources?: Resources;
  /**
   * Timeline durability + policy slots (ADR 49 / A2.2) — shared store
   * adapter, write policy, construction-bound default compaction
   * strategy. Threaded from `SessionHarnessOptions.timeline`.
   */
  readonly timeline?: Pick<TimelineHarnessOptions, "store" | "writePolicy" | "compact">;
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
    // Durability + policy slots (ADR 49 / A2.2): shared store adapter,
    // write policy, construction-bound default compaction strategy.
    options.timeline ?? {},
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
  const resources =
    options.resources ??
    new ResourcesHarness(
      `${store.id}:resources`,
      substrate.journal,
      substrate.bus,
      substrate.inbox,
    );

  const base = {
    timeline,
    knobs,
    state,
    elicitation,
    tasks,
    resources,
    data: new InMemoryDataBridge(),
    models: new InMemoryModelBridge(),
    loop: loopBridgeStub(),
    session: sessionBridgeFor(store),
    ...omitUndefined({ tools: options.toolBridge }),
  } as SessionHookBridges;

  // Gate wiring core (ADR 27). Injected with the session's KnobsHarness
  // + a live getter over the loop bridge (so the same loop the tree sees
  // via `useLoopControl` drives continuation) + a bus-backed audit sink
  // for the trusted-host `.override()` escape. NOT a harness slot — the
  // tick-end seam is attached from the reconciler mount (see gates-next
  // `useGatesController`); the controller carries no independent state.
  const gates = new GatesController({
    knobs,
    loopControl: () => base.loop,
    audit: makeGateAudit(substrate.bus, store.id),
  });
  (base as { gates: GatesController }).gates = gates;

  if (options.extensionBridges && options.extensionBridges.size > 0) {
    return {
      ...base,
      ...Object.fromEntries(options.extensionBridges),
    } as SessionHookBridges;
  }
  return base;
}

/**
 * Audit sink for verified-gate host overrides — appends a session-surface
 * terminal event so `.override()` calls are traceable on `app.events()`.
 * Fire-and-forget (`Effect.runFork`); an audit append never blocks or
 * fails the override.
 */
function makeGateAudit(bus: EventBus, sessionId: string): (event: GateOverrideAudit) => void {
  return (event) => {
    const envelope: ProtocolEvent = {
      id: ulid(),
      surface: "session",
      name: "session:gate:override",
      phase: "terminal",
      outcome: "succeeded",
      timestamp: Date.now(),
      scope: { sessionId },
      payload: { name: event.name, value: event.value, reason: event.reason, at: event.at },
      tags: ["gate", "override", "audit"],
    };
    Effect.runFork(bus.append(envelope));
  };
}
