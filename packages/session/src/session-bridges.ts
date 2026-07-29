/**
 * `HookBridges` backed by session state.
 *
 * The compiler harness consumes a bundle of bridges/harnesses at
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
import { InMemoryDataBridge, InMemoryModelBridge } from "@agentick/compiler";
import { ElicitationHarness, buildElicitSugar } from "@agentick/elicitation";
import { KnobsHarness } from "@agentick/knobs";
import { StateHarness } from "@agentick/state";
import { TasksHarness } from "@agentick/tasks";
import { ResourcesHarness } from "@agentick/resources";
import { GatesController, GatesHarness, type GateOverrideAudit } from "@agentick/gates";
import { TimelineHarness, type TimelineDefinition } from "@agentick/timeline";
import { type BaseHarness, type Middleware, ulid } from "@agentick/runtime";
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
} from "@agentick/spec";

import type { SessionRuntime } from "./session-state.js";
import { omitUndefined } from "@agentick/utils";

/**
 * The `HookBridges.loop` slot, made LIVE (ADR 67). `useLoopControl()`
 * hands the tree this bridge; the tree's `continueAfterTick` /
 * `stopAfterTick` calls — plus the gate controller's continuation holds,
 * which drive the SAME seam — accumulate here across a tick. The session
 * drains them once per tick-end (in `notifyLifecycle`) and folds them
 * into its `TickEndForwardDecision`.
 *
 * Provenance falls out of the recorder for free (ADR 51): gates only ever
 * call `continueAfterTick` (they hold the loop open, never stop-force), so
 * a `stop` signal can ONLY originate from trusted tree code — exactly the
 * "host/tree may stop-force, the model may not" rule.
 */
export interface RecordingLoopBridge extends LoopBridge {
  /**
   * Drain the continue/stop requests recorded since the last drain,
   * resetting the recorder. First-writer-wins on the reason string.
   */
  drainLoopRequests(): { continue?: string; stop?: string };
}

export function recordingLoopBridge(): RecordingLoopBridge {
  let cont: string | undefined;
  let stop: string | undefined;
  return {
    continueAfterTick: (reason?: string) => {
      cont ??= reason ?? "continue";
    },
    stopAfterTick: (reason?: string) => {
      stop ??= reason ?? "stop";
    },
    drainLoopRequests() {
      const out = omitUndefined({ continue: cont, stop });
      cont = undefined;
      stop = undefined;
      return out;
    },
  };
}

export function sessionBridgeFor(store: SessionRuntime): SessionBridge {
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
  /**
   * The LIVE loop-control bridge (ADR 67). Narrowed from
   * `HookBridges.loop` to the drainable {@link RecordingLoopBridge} so
   * `session.notifyLifecycle` can fold tree + gate continuation signals
   * into the tick-end decision.
   */
  readonly loop: RecordingLoopBridge;
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
   * The timeline's ADR-93 namespace DEFINITION — store, genesis seam
   * (`hydrate`), shaping seams (`compact`, `writePolicy`), and the
   * `hooks:`/`guards:` bags. Threaded from `createApp({ timeline })` through
   * `SessionHarnessOptions.timeline`; the definition IS the harness's options,
   * so it passes through with no translation.
   */
  readonly timeline?: TimelineDefinition;
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * session's `resolvedInterceptors()` (app-inherited incl. the app+session
   * command hooks as op-scoped middleware, plus the session's own), forwarded by
   * the SessionHarness. Threaded into the per-session bridges built here (today:
   * knobs) so their commands (`knobs:set`, …) inherit `session.use()` /
   * `app.use()` AND the hook cascade via the construction-fold. Defaults to `[]`
   * per bridge.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the SessionHarness. Forwarded to the
   * per-session bridge harnesses (today: knobs) so a LATER `session.use()` /
   * `session.guard()` / `session.hook()` reaches them, not just the
   * construction-time snapshot ({@link inheritedInterceptors}).
   */
  readonly interceptorParent?: BaseHarness;
}

export function buildSessionBridges(
  store: SessionRuntime,
  substrate: {
    readonly journal: OperationJournal;
    readonly bus: EventBus;
    readonly inbox: MessageInbox;
  },
  options: BuildSessionBridgesOptions = {},
): SessionHookBridges {
  /**
   * The options EVERY session-owned bridge takes — assembled ONCE.
   *
   * Two facts have to reach all of them, and both were previously hand-threaded per
   * site. Both were then forgotten at some of the sites, in the same way, twice:
   *
   *   - The interceptor cascade (ADR 93 landmine 11). Timeline was the one bridge that
   *     took no threading, so `app.guard()` / `createApp({ hooks })` silently skipped
   *     `timeline:append` and friends. Fixed by threading it to all N — by hand.
   *   - `parentScope`, the owning session's runtime coordinates. Threaded to 2 of 7 by
   *     exactly the method the old comment here warned against: "whichever bridge
   *     someone remembered to thread". The five that missed out emitted events no
   *     session-scoped subscription could match, so every client-side live projection
   *     over them was silently dead.
   *
   * A comment cannot enforce an invariant; a function can. Adding an eighth bridge now
   * means calling this, and forgetting a fact is no longer expressible.
   *
   * `extra` spreads FIRST so the framework-owned wiring wins: an adopter-supplied
   * namespace definition (`createApp({ timeline })`) must not be able to overwrite the
   * cascade or the scope.
   */
  const sessionScoped = <T extends object>(extra: T = {} as T) => ({
    ...extra,
    parentScope: { sessionId: store.id },
    inheritedInterceptors: options.inheritedInterceptors,
    interceptorParent: options.interceptorParent,
  });

  const timeline = new TimelineHarness(
    `${store.id}:timeline`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
    // The ADR-93 namespace DEFINITION — store, genesis seam, shaping seams,
    // hooks/guards bags — threaded verbatim from `createApp({ timeline })`. The
    // definition IS the options, so there is nothing to translate.
    sessionScoped(options.timeline ?? {}),
  );
  const knobs = new KnobsHarness(
    `${store.id}:knobs`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
    // Layer-chain parent (ADR 34 cascade). Absent today — no app tier
    // exists yet, so the chain is just `[self]`. Threaded explicitly so
    // the seam is present at the single construction site; a future
    // app-scoped KnobsHarness drops in here with no rewrite. Session
    // snapshots capture the self layer only (never inherited app state).
    undefined,
    sessionScoped(),
  );
  const state = new StateHarness(
    `${store.id}:state`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
    sessionScoped(),
  );
  const elicitation =
    options.elicitation ??
    new ElicitationHarness(
      `${store.id}:elicitation`,
      substrate.journal,
      substrate.bus,
      substrate.inbox,
      // This arm only runs when the app did NOT construct + inject the harness; the
      // app's own construction already threads the same facts.
      sessionScoped(),
    );
  const tasks =
    options.tasks ??
    new TasksHarness(
      `${store.id}:tasks`,
      substrate.journal,
      substrate.bus,
      substrate.inbox,
      sessionScoped({
        // ADR 69 — task `ctx.elicit` escalation. Inject the elicit-sugar
        // factory so a task's `ctx.elicit.*` escalates to this session
        // (`session:{sessionId}`) via `inbox.ask` and resolves with the
        // client's response. Keeps `@agentick/tasks` free of an
        // elicitation dependency (the escalation relay is payload-agnostic).
        // NOTE: per-originating-session escalation now works at the harness —
        // `submit({ scope })` stamps each task's owning session on the record
        // and `ctx.elicit` escalates from `record.scope`, not the harness scope
        // (tasks/harness.ts `makeEscalate`). The only remaining piece for a
        // shared/app-scoped `options.tasks` path is app-owned wiring: the
        // AppHarness must inject `buildElicit` on that shared harness too and
        // pass the originating `scope` per submit.
        buildElicit: buildElicitSugar,
      }),
    );
  const resources =
    options.resources ??
    new ResourcesHarness(
      `${store.id}:resources`,
      substrate.journal,
      substrate.bus,
      substrate.inbox,
      sessionScoped(),
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
    loop: recordingLoopBridge(),
    session: sessionBridgeFor(store),
    ...omitUndefined({ tools: options.toolBridge }),
  } as SessionHookBridges;

  // Gate wiring core (ADR 27 + ADR 67), now OWNED by a slim GatesHarness (the
  // command surface + inbox address `gates:<sessionId>:gates` the dynamic-command
  // lane routes to). The harness constructs the ONE controller; we staple that
  // controller onto `bridges.gates` so every existing consumer (`useGate`,
  // `session.gates`, `session.notifyLifecycle → handleTickEnd`) keeps resolving
  // the SAME instance. The controller is injected with the session's KnobsHarness
  // + a live getter over the LIVE loop bridge + a bus-backed audit sink for the
  // trusted-host `.override()` escape. NOT a `HookBridges` slot — gates own no
  // independent state (a gate's value IS a knob value). Per ADR 67 the controller
  // is DRIVEN from `session.notifyLifecycle` (which calls `handleTickEnd` with the
  // settled `TickResult`), NOT from a compiler-mount tick-end subscription. A held
  // gate calls `continueAfterTick` on this same loop bridge; the session drains it
  // and folds the hold into the tick-end `TickEndForwardDecision`. `parent`
  // (ADR 34 cascade) is absent today — no app-tier gate layer exists yet;
  // threaded explicitly so a future one drops in with no rewrite.
  const gatesHarness = new GatesHarness(
    `${store.id}:gates`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
    sessionScoped({
      knobs,
      loopControl: () => base.loop,
      audit: makeGateAudit(substrate.bus, store.id),
      parent: undefined,
    }),
  );
  (base as { gates: GatesController }).gates = gatesHarness.controller;
  // Lifecycle: the harness owns an inbox registration; staple it onto the bundle
  // (a runtime-only, non-typed property — NOT a bridge slot) so the session's
  // close-loop (which closes any bridge value exposing `.close()`) tears it down.
  // It is not SnapshotCapable, so the snapshot/restore fan-out skips it.
  (base as unknown as { gatesHarness: GatesHarness }).gatesHarness = gatesHarness;

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
