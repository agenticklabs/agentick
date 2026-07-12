/**
 * `SessionHarness` — reference implementation of
 * `SessionHarnessProtocol`.
 *
 * Owns the integration between JSX agent + reconciler + loop executor.
 * The user-facing entry point: `session.send({ messages })` runs one
 * agent execution and returns a `SessionExecutionHandle`.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

import { Effect, Fiber, ManagedRuntime, Stream } from "effect";

import {
  BaseHarness,
  runHarnessProtocol,
  ulid,
  SESSION_ESCALATION_MESSAGE_TYPE,
  ESCALATION_TIMEOUT_MS,
  type EscalationEnvelopePayload,
  type EscalationHop,
  type EscalationInterceptor,
  type EscalationOutcome,
} from "@agentick/runtime-next";
import type {
  JournalingPolicy,
  LoopExecutorProtocol,
  ReconcilerProtocol,
} from "@agentick/spec-next";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ChannelSnapshotProvider,
  ContentBlock,
  EventEnvelope,
  ElicitationRequest,
  FormElicitationRequest,
  EventBus,
  EventBusFactory,
  ExecutionTarget,
  ExecutorProtocol,
  KnobHandle,
  LanguageModelExecutionResult,
  LoopEmittedEvent,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MessageInboxFactory,
  NotifyTickEndInput,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  ProtocolEvent,
  RenderContext,
  SendInput,
  SendMessageInput,
  SendResult,
  SessionError,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionSnapshot,
  SessionSubstrateParent,
  SpawnContext,
  SpawnInput,
  StateApplyError,
  TickEndForwardDecision,
  TickResult,
  TimelineEntry,
  ToolExecutorProtocol,
  Unsubscribe,
} from "@agentick/spec-next";
import {
  channelEventName,
  DEFAULT_JOURNALING_POLICY,
  ExecutionFailed,
  HandlerError,
  isChannelSnapshotProvider,
  SessionClosedError,
  SPEC_VERSION,
  TimelineWriteFailed,
} from "@agentick/spec-next";
import { mergeLayered, omitUndefined } from "@agentick/utils-next";
import { buildSessionElicit } from "@agentick/elicitation-next";
import { withScope } from "@agentick/tool-executor-next";
import { effectiveModelInfo, mergeUsageStats, type ModelRegistry } from "@agentick/model-next";
import type { KnobsHandle } from "@agentick/knobs-next";
import type { GateHandle, GatesHandle } from "@agentick/gates-next";
import type { StateHandle } from "@agentick/state-next";
import type { TimelineHandle, TimelineHarnessOptions } from "@agentick/timeline-next";

import { buildSessionBridges, type SessionHookBridges } from "./session-bridges.js";
import { SessionStateStore } from "./session-state.js";
import { createSessionExecutionHandle, type SessionEmitInput } from "./session-execution-handle.js";

// ============================================================================
// Construction options
// ============================================================================

/**
 * Re-export the canonical `SessionSubstrateParent` from spec so
 * adopters can write portable factory types without importing the
 * spec package directly.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Two-phase construction
 */
export type { SessionSubstrateParent };

export interface SessionHarnessOptions<P = unknown> {
  /** Stable session id. */
  readonly sessionId: string;
  /**
   * Agent root element. Opaque to the session — forwarded as-is to
   * `reconciler.mount({ element })`. The concrete reconciler impl owns
   * the type contract (React, Angular, etc.); the session is
   * reconciler-agnostic.
   */
  readonly agent: unknown;
  /** Initial component props (optional). */
  readonly props?: P;
  /**
   * Optional per-session substrate overrides. Each accepts a
   * pre-built instance (sharing with the app) or a factory
   * `(parent: SessionSubstrateParent) => R` that constructs a
   * session-scoped wrapper. When omitted, the session inherits the
   * app's substrate directly (today's default behavior).
   *
   * The factory pattern is how multi-tenant isolation lands:
   * `bus: LocalEventBus.factory()` returns a fresh bus that wraps the
   * app's bus (fan-in writes, isolated reads). Adopter metadata flows
   * through `parent.metadata` so the factory can branch on
   * per-session context (e.g. an adopter-defined `tenant` key).
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly bus?: EventBus | EventBusFactory<SessionSubstrateParent>;
  readonly inbox?: MessageInbox | MessageInboxFactory<SessionSubstrateParent>;
  readonly journal?: OperationJournal | OperationJournalFactory<SessionSubstrateParent>;
  /**
   * Timeline durability + policy slots (ADR 49 / A2.2), threaded to the
   * per-session `TimelineHarness`:
   *   - `store` — the shared durable append-log adapter (one instance
   *     serves all sessions, keyed by scope). Supplying it makes
   *     session construction **open-or-rehydrate**: the persisted tier
   *     is loaded from the store before first render.
   *   - `writePolicy` — `"behind"` (default) | `"through"`.
   *   - `compact` — the construction-bound default compaction strategy
   *     (ADR 51 signal form): `timeline.compact()` with no argument —
   *     including a bare `timeline:compact` verb over the inbox/wire —
   *     runs it.
   * Flows from `createApp({ session: { timeline } })` via
   * SessionDefaults.
   */
  readonly timeline?: Pick<TimelineHarnessOptions, "store" | "writePolicy" | "compact">;
  /** Scope ceiling (#199) — construction-bound, checked at the wire
   *  dispatch gate. See SessionHarnessProtocol.requiredScopes. */
  readonly requiredScopes?: readonly string[];
  /**
   * Model registry (#206) — provider→prefix→ModelInfo, merged over
   * SEED_MODELS. The session resolves the active model's contextWindow
   * from it for `useContextInfo` (dispatched as tick-start lifecycle
   * metadata). Federated: adapters export fragments, the adopter/app
   * merges and injects.
   */
  readonly models?: ModelRegistry;
  /**
   * Adopter-defined metadata bag carried on the session and exposed
   * to substrate factories via `parent.metadata`. Framework defines
   * no keys; adopters stash whatever they want (tenant id, trace id,
   * routing hints).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Reconciler that owns the agent's element tree. Typed as the
   * protocol — any conformant impl (React reconciler, future Angular
   * reconciler, etc.) drops in.
   */
  readonly reconciler: ReconcilerProtocol;
  /**
   * Loop executor that orchestrates ticks. Typed as the protocol so
   * alternative orchestrators (cluster-aware, replay-based, etc.) can
   * be injected without changing the session boundary.
   */
  readonly loop: LoopExecutorProtocol;
  /** Executor harness for model invocations. */
  readonly executor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  /** Tool executor harness for tool dispatch. */
  readonly toolExecutor: ToolExecutorProtocol;
  /** Default execution target — overridable per send (later). */
  readonly target: ExecutionTarget;
  /** Default per-execution max tick bound. Default: 8. */
  readonly defaultMaxTicks?: number;
  /**
   * Session-level streaming default. Overridden by `SendInput.stream`
   * per-call. Falls through to the executor-capability default when
   * unset (streaming on when `executor.executeStream` exists AND
   * `target.capabilities.supportsStreaming` ≠ false).
   */
  readonly defaultStreaming?: boolean;
  /** Optional initial knob values. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /** Optional initial session-state values (`useSessionState`). */
  readonly initialState?: Readonly<Record<string, unknown>>;
  /**
   * Extension-provided bridges (sandbox, mcp, subscriptions, …) merged
   * into the per-session HookBridges. Adopters typically don't supply
   * this directly — the AppHarness installs extensions and passes the
   * resulting map through.
   */
  readonly extensionBridges?: ReadonlyMap<string, unknown>;
  /**
   * Optional tool bridge exposed to the reconciler via HookBridges.
   * When supplied, reconciler-side tools (e.g. React `createTool`
   * with `use()` hook) register handlers at render time. The bridge
   * is typically built by the AppHarness wrapping its shared
   * HandlerResolver.
   */
  readonly toolBridge?: import("@agentick/spec-next").ToolBridge;
  /**
   * Optional pre-constructed elicitation harness. When supplied,
   * `buildSessionBridges` uses this instance for the `elicitation`
   * slot instead of constructing its own — which lets the AppHarness
   * share the SAME elicitation harness with the per-session
   * `ToolExecutorHarness` (the confirmation gate needs to be paired
   * with the bridges' elicitation so client `respond()` calls reach
   * the registry the tool-executor is waiting on).
   */
  readonly elicitation?: import("@agentick/spec-next").ElicitationHarnessProtocol;
  /**
   * Optional pre-constructed tasks harness. Same wiring rationale
   * as `elicitation` — the AppHarness shares ONE tasks harness
   * instance between the per-session `ToolExecutorHarness` (so
   * TaskHandle-return detection routes against the right registry)
   * and the session bridges (so JSX `bridges.tasks` consumers see
   * the same in-flight tasks).
   */
  readonly tasks?: import("@agentick/spec-next").TasksHarnessProtocol;
  /**
   * Optional pre-constructed resources harness (ADR 62). Same wiring
   * rationale as `elicitation` / `tasks` — the AppHarness shares ONE
   * instance between the per-session `ToolExecutorHarness`
   * (`ctx.resource`), the session bridges (`bridges.resources`), and
   * the SessionInstaller (`installer.resources`). When omitted,
   * `buildSessionBridges` constructs a fresh one on the substrate (the
   * standalone / test path).
   */
  readonly resources?: import("@agentick/spec-next").Resources;
  /**
   * Spawn context for child sessions. Typically injected by the
   * AppHarness when it constructs a session — the session keeps a
   * narrow back-reference to its parent app so `spawn()` works.
   * Sessions without a spawnContext throw when `spawn()` is called.
   */
  readonly spawnContext?: SpawnContext<P>;
  /** Parent session id when this session is itself a spawned child. */
  readonly parentSessionId?: string;
  /**
   * Telemetry runtime (ADR 77 Stage 4 / ADR 78). The app-scoped
   * `ManagedRuntime` built ONCE from the adopter's `telemetry` Layer.
   * The session runs the composed execution (`loop.fx.runExecution`) on
   * it so the whole fiber's `Effect.withSpan` annotations reach the
   * configured tracer — and, because the loop is now one fiber (Stage 3),
   * every downstream span (executor / tool / reconciler) nests under the
   * execution span via FiberRef `parentOpId` auto-threading. Forwarded by
   * the AppHarness; `undefined` (standalone / test) → the default runtime,
   * behavior-preserving (no-op tracer).
   */
  readonly telemetryRuntime?: ManagedRuntime.ManagedRuntime<never, never>;
  /**
   * Whitelabel namespace for telemetry attribute keys (`<ns>.op_id`, …).
   * Forwarded from the app so session/execution spans carry the same
   * prefix as app-edge spans. Defaults to `"agentick"` (BaseHarness).
   */
  readonly telemetryNamespace?: string;
  /**
   * Construction parent (ADR 76 tier 3 — structural middleware
   * inheritance). Typically the AppHarness. When set, middleware
   * registered via `app.use(...)` composes OUTERMOST of the session's own
   * chain around every session operation — deployment-global concerns
   * (audit / trace / journal) wrapping session commands. Undefined →
   * top-of-tree, inherits nothing (behavior-preserving).
   */
  readonly parent?: unknown;
}

// ============================================================================
// SessionHarness
// ============================================================================

export class SessionHarness<P = unknown>
  extends BaseHarness<"session">
  implements SessionHarnessProtocol<P>
{
  get id(): string {
    return this.scopeId;
  }

  private readonly store: SessionStateStore;
  private readonly bridges: SessionHookBridges;
  private readonly mountId: string;
  private readonly reconciler: ReconcilerProtocol;
  private readonly loop: LoopExecutorProtocol;
  private readonly executor: SessionHarnessOptions<P>["executor"];
  private readonly toolExecutor: ToolExecutorProtocol;
  private readonly target: ExecutionTarget;
  private readonly spawnContext: SpawnContext<P> | undefined;
  private readonly parentSessionId: string | undefined;
  /**
   * Lazily-built index of the channel-owning harnesses among this
   * session's bridges (knobs, tasks, state, gates, timeline). Keyed by
   * `provider.snapshotChannel`. Built once on first `channelSnapshot`.
   */
  private _snapshotProviders: Map<string, ChannelSnapshotProvider> | null = null;
  /**
   * Telemetry runtime (ADR 77 Stage 4). The composed execution runs on
   * it so spans export + nest; `undefined` → default runtime (no-op
   * tracer, behavior-preserving). See {@link SessionHarnessOptions.telemetryRuntime}.
   */
  private readonly telemetryRuntime: ManagedRuntime.ManagedRuntime<never, never> | undefined;
  /**
   * Single-slot escalation interceptor (ADR 69 T2a). `undefined` =
   * forward/resolve as T1 did (parity); set via `interceptEscalation`.
   */
  private escalationInterceptor: EscalationInterceptor | undefined;
  private readonly defaultMaxTicks: number;
  private readonly defaultStreaming: boolean | undefined;

  private _closed = false;
  private _mountReady: Promise<void>;
  /** #199 — structural scope ceiling, surfaced for the dispatch gate. */
  readonly requiredScopes?: readonly string[] | undefined;
  /** Injected model registry (#206) — window resolution for useContextInfo. */
  private readonly models: ModelRegistry | undefined;
  private _currentExecution: Promise<unknown> | null = null;
  /** In-flight handle — join target for steering sends (ADR 53 §5). */
  private _currentHandle: import("@agentick/spec-next").SessionExecutionHandle | null = null;
  /**
   * SYNCHRONOUS send reservation (review finding: two un-awaited fresh
   * sends both passed the null-guard across its awaits). Set before the
   * first await in sendBody; a concurrent send awaits it and JOINS.
   */
  private _handleReservation: {
    promise: Promise<import("@agentick/spec-next").SessionExecutionHandle>;
    resolve: (h: import("@agentick/spec-next").SessionExecutionHandle) => void;
    reject: (e: unknown) => void;
  } | null = null;
  /**
   * Latched the instant the loop settles (review finding: a steering
   * send in the terminal window joined a DEAD handle — the message
   * appended after the boundary with no execution to see it). Once
   * true, joins are refused and the sender falls through to a fresh
   * execution after cleanup.
   */
  private _loopDone = false;
  /** The running turn's aggregate usage — the boundary record's payload. */
  private _executionUsage: import("@agentick/spec-next").UsageStats | undefined;
  /** Input entries the running execution has observed (ADR 53 live check). */
  private _inputEntriesSeen = 0;

  /**
   * Construct a SessionHarness.
   *
   * **Substrate parameters (`journal`, `bus`, `inbox`)** carry the
   * PARENT'S substrate — typically the AppHarness's. They act as
   * defaults: when `options.bus / inbox / journal` is omitted, the
   * session inherits these directly (the most common case). When
   * `options.*` is set (instance or factory), the session uses that
   * instead, with the parent's substrate available to factories via
   * the resolution shell as upstream for wrapping.
   *
   * **Options bag** carries everything else: id, agent, reconciler,
   * loop, executor, toolExecutor, target, plus the per-session
   * substrate overrides and adopter metadata.
   *
   * The positional+options shape is intentional — it makes the
   * "substrate flows from parent by default" semantic visible at
   * every call site without forcing every adopter to construct the
   * options bag with substrate fields. ADR 31 Phase 3 documented this.
   */
  constructor(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SessionHarnessOptions<P>,
  ) {
    // Substrate slot resolution is owned by BaseHarness (ADR 31). The
    // positional `journal / bus / inbox` here are the SESSION's DEFAULTS
    // — typically the APP's substrate. When `options.{bus,inbox,journal}`
    // is supplied (instance or factory), BaseHarness uses that instead;
    // factories see a HarnessShell whose .bus/.inbox/.journal point at
    // these positional defaults, so the fan-in/wrap pattern composes.
    //
    // `session:command:close` envelopes are bus-only via policy
    // override — substrate-close handlers fire inside `super.close()`
    // without crashing the framework (ADR 31 Option G).
    super("session", options.sessionId, journal, bus, inbox, {
      metadata: options.metadata,
      ...omitUndefined({
        journal: options.journal,
        bus: options.bus,
        inbox: options.inbox,
        telemetryNamespace: options.telemetryNamespace,
        // ADR 76 tier 3 — the app is the session's construction parent, so
        // `app.use(...)` structurally wraps every session operation.
        parent: options.parent,
      }),
      policy: mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, {
        override: { "session:command:close": "bus-only" },
      }),
    });
    // Local aliases for the resolved substrate. BaseHarness has set
    // `this.journal / .bus / .inbox` to the resolved instances; we
    // alias for readability through the rest of the constructor.
    const resolvedJournal = this.journal;
    const resolvedBus = this.bus;
    const resolvedInbox = this.inbox;

    this.store = new SessionStateStore(options.sessionId);
    // TODO(adr-76: bridge-parent-threading) — pass `parent: this` to the
    // per-session bridge harnesses (knobs/state/gates/timeline) so
    // `session.use()` structurally wraps their ops (tier 3). Safe because the
    // bridges are per-session (no cross-session leak). Not wired yet — the
    // bridge constructors don't take a parent; app→session (above) is live.
    this.bridges = buildSessionBridges(
      this.store,
      { journal: resolvedJournal, bus: resolvedBus, inbox: resolvedInbox },
      {
        ...omitUndefined({
          toolBridge: options.toolBridge,
          extensionBridges: options.extensionBridges,
          elicitation: options.elicitation,
          tasks: options.tasks,
          resources: options.resources,
          timeline: options.timeline,
        }),
      },
    );
    if (options.initialKnobs) {
      this.bridges.knobs.importSnapshot(
        options.initialKnobs as Readonly<Record<string, string | number | boolean>>,
      );
    }
    if (options.initialState) {
      this.bridges.state.importSnapshot(options.initialState);
    }
    this.reconciler = options.reconciler;
    this.loop = options.loop;
    this.executor = options.executor;
    this.toolExecutor = options.toolExecutor;
    this.target = options.target;
    this.spawnContext = options.spawnContext;
    this.parentSessionId = options.parentSessionId;
    this.telemetryRuntime = options.telemetryRuntime;
    this.defaultMaxTicks = options.defaultMaxTicks ?? 8;
    this.requiredScopes = options.requiredScopes;
    this.models = options.models;
    this.defaultStreaming = options.defaultStreaming;
    this.mountId = `mount:${options.sessionId}`;

    // Open-or-rehydrate (ADR 49 §Hydration): when a durable store was
    // injected, load the session's persisted log into the timeline
    // BEFORE first render — the mount's first render must see the
    // resumed conversation, and Class B state reconstructs from it.
    // Without an injected store there is nothing durable to load
    // (the bundled in-memory default is empty per-construction) and
    // the chain is a resolved promise — zero-cost hot path.
    const hydrated: Promise<void> =
      options.timeline?.store !== undefined ? this.bridges.timeline.hydrate() : Promise.resolve();

    // Eagerly mount — the reconciler exposes `.ready` for its own
    // inbox registration; our mount is awaited via `_mountReady`. The
    // element type is opaque here — `MountInput.element: unknown` in
    // the spec — and the bound reconciler impl interprets it.
    this._mountReady = hydrated
      .then(() =>
        this.reconciler.mount({
          mountId: this.mountId,
          sessionId: options.sessionId,
          element: options.agent,
          bridges: this.bridges,
        }),
      )
      .then(() => {});
  }

  /**
   * Resolves once the underlying reconciler mount is complete. Most
   * callers can `await session.ready` (the base inbox ready) and then
   * `await session.mountReady` if they need to be sure the JSX tree
   * has rendered at least once.
   */
  get mountReady(): Promise<void> {
    return this._mountReady;
  }

  /**
   * The session's elicitation harness — exposed on
   * `SessionHarnessProtocol.elicitation` (slot added by the elicitation
   * package's module augmentation). Gateway routes
   * `session/respondToElicitation` here.
   */
  get elicitation(): import("@agentick/spec-next").ElicitationHarnessProtocol {
    return this.bridges.elicitation;
  }

  /**
   * Sugar surface — `Elicit` noun-aliased API over the session's
   * `elicitation` harness. Same `Elicit` interface tool handlers see
   * as `ctx.elicit` (whether dispatched in-process or via MCP server).
   * Use this to elicit from session-level code paths (commands,
   * agent-side asks) that don't have a tool ctx.
   *
   * Lazily constructed on first access; cached per session.
   *
   * @see docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md
   */
  get elicit(): import("@agentick/spec-next").Elicit {
    if (!this._elicit) {
      this._elicit = buildSessionElicit({ harness: this.bridges.elicitation });
    }
    return this._elicit;
  }
  private _elicit?: import("@agentick/spec-next").Elicit;

  /**
   * Per-session tasks harness — same instance the tool-executor's
   * TaskHandle-return detection routes against (#156) and that
   * `bridges.tasks` exposes. Augmented onto `SessionHarnessProtocol`
   * via the `@agentick/tasks-next` package's module augmentation.
   */
  get tasks(): import("@agentick/spec-next").TasksHarnessProtocol {
    return this.bridges.tasks;
  }

  /**
   * Per-session resources harness (ADR 62) — the SAME instance the
   * tool-executor's `ctx.resource` reaches, that `bridges.resources`
   * exposes, and that `withMCP` proxy-registers remote resources into.
   * Augmented onto `SessionHarnessProtocol` via the
   * `@agentick/resources-next` package's module augmentation. Adopter /
   * server-side code reads resources without a tool ctx:
   * `await session.resources.read(uri)`.
   */
  get resources(): import("@agentick/spec-next").Resources {
    return this.bridges.resources;
  }

  // ──────── SessionHarnessProtocol ────────

  send(input: SendInput<P>): Promise<SessionExecutionHandle> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.sendBody(input),
        catch: (cause): SessionError => coerceSessionError(cause),
      }),
    );
  }

  // ──────── Top-level harness handles (ADR 27 augmentations) ────────

  /**
   * The session's timeline handle — append/queue/drain/compact/subscribe
   * + sync reads of projection, persisted log, and pending. Curated
   * subset of `TimelineHarnessProtocol`. The `bridges.timeline` runtime
   * harness satisfies the `TimelineHandle` interface structurally;
   * no wrapper.
   *
   * Adopters who previously called `session.timeline()`, `session.append()`,
   * `session.queue()`, or `session.observe()` now reach for
   * `session.timeline.{read, append, queue, observe?, ...}`.
   */
  get timeline(): TimelineHandle {
    return this.bridges.timeline;
  }

  /**
   * The session's knobs handle — list/get/set/dispatch/subscribe over
   * the model-visible reactive state. Per-knob access (by reference)
   * remains `session.knob(name)`.
   */
  get knobs(): KnobsHandle {
    return this.bridges.knobs;
  }

  /**
   * The session's gates — the unified gate registry. Both tree-declared
   * gates (`useGate`) and programmatically-registered gates
   * (`session.gates.register(...)`) land in the SAME controller, so
   * `list()` shows all of them. Per-gate access is `session.gate(name)`.
   *
   * Gates are NOT a harness — a gate's value IS a knob value. The
   * controller rides the bridge bundle so this handle and every `useGate`
   * are the same instance.
   */
  get gates(): GatesHandle {
    return this.bridges.gates;
  }

  /**
   * Per-gate handle by name — value/engaged reads, `clear()`/`defer()`,
   * and the trusted-host `override()` escape for verified gates.
   * Undefined when no gate by that name is registered.
   */
  gate(name: string): GateHandle | undefined {
    return this.bridges.gates.get(name);
  }

  /**
   * The session's adopter-stash state handle — K/V get/set/has/delete/
   * list + per-key and global subscription. Not model-visible.
   */
  get state(): StateHandle {
    return this.bridges.state;
  }

  snapshot(): SessionSnapshot {
    // Step 5a: snapshot.timeline holds the durable persisted log. The
    // projection (potentially compacted) is not yet round-tripped via
    // SessionSnapshot — Step 6 (SnapshotHarness) will compose per-harness
    // snapshots into the session shape and carry both layers.
    return {
      specVersion: SPEC_VERSION,
      id: this.store.id,
      status: this.store.status(),
      currentTick: this.store.currentTick(),
      timeline: [...this.bridges.timeline.readPersisted()],
      knobs: this.bridges.knobs.exportSnapshot(),
      usage: this.store.usage(),
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.store.setStatus("closed" as never);
    // Tear down the reconciler mount; ignore errors during shutdown.
    try {
      await this.reconciler.unmount({ mountId: this.mountId });
    } catch {
      // shutdown — best effort
    }
    // Close every bridge that exposes a `close()` — built-ins
    // (timeline/knobs/state) and extension-installed bridges
    // (sandbox/mcp/subscriptions/...) alike. Duck-typed: any bridge
    // entry whose `close` is a function gets shut down. Plain accessor
    // bridges (data/loop/session) are no-ops here.
    const closes: Promise<unknown>[] = [];
    for (const value of Object.values(this.bridges)) {
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { close?: unknown }).close === "function"
      ) {
        closes.push(
          Promise.resolve((value as { close: () => unknown }).close()).catch(() => undefined),
        );
      }
    }
    await Promise.all(closes);
    await super.close();
  }

  // ── StateApplicator ──────────────────────────────────────────────

  /**
   * The composable `applyExecutorResult` Effect — the state-applicator
   * `fx` twin the loop composes in-fiber (ADR 77). Returns the un-run
   * `Effect.tryPromise` so the timeline write's exit-normalization stays
   * in the loop's fiber rather than launching its own `runPromise` root.
   * {@link applyExecutorResult} is the facade.
   */
  private applyExecutorResultFx(
    input: ApplyExecutorResultInput,
  ): Effect.Effect<ApplyResult, StateApplyError, never> {
    return Effect.tryPromise({
      try: () => this.applyExecutorResultBody(input),
      catch: (cause): StateApplyError => new TimelineWriteFailed({ cause }),
    });
  }

  applyExecutorResult(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    return runHarnessProtocol(this.applyExecutorResultFx(input));
  }

  /** The composable `applyToolResults` Effect — see {@link applyExecutorResultFx}. */
  private applyToolResultsFx(
    input: ApplyToolResultsInput,
  ): Effect.Effect<ApplyResult, StateApplyError, never> {
    return Effect.tryPromise({
      try: () => this.applyToolResultsBody(input),
      catch: (cause): StateApplyError => new TimelineWriteFailed({ cause }),
    });
  }

  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult> {
    return runHarnessProtocol(this.applyToolResultsFx(input));
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.appendEntryBody(input),
        catch: (cause): StateApplyError => new TimelineWriteFailed({ cause }),
      }),
    );
  }

  async notifyLifecycle(input: NotifyTickEndInput): Promise<TickEndForwardDecision> {
    // The session's continuation decision (ADR 67). The loop calls this
    // AFTER the reconciler tick-end has settled the tree, with the settled
    // `TickResult`. We fold every session-owned continuation predicate
    // into ONE `TickEndForwardDecision`, in tier order (mirroring the
    // loop's own resolution): stop-force > continue-force > abstain. The
    // loop still enforces `maxTicks` as the tier-1 hard cap on top.
    const result = input.result as TickResult | undefined;

    // (a) Gates — evaluate the unified registry against the settled
    // `TickResult`. This drives arming / satisfied / fail-closed /
    // auto-clear / read-only (unchanged controller logic); a blocking gate
    // holds the loop open by calling `continueAfterTick` on the session's
    // loop bridge (below). We evaluate BEFORE draining so a gate's hold is
    // captured in the same drain as any tree request.
    if (result !== undefined) {
      await this.bridges.gates.handleTickEnd(result);
    }

    // (b) Tree + gate loop-control requests recorded on the live loop
    // bridge across this tick (`useLoopControl().stop/continueAfterTick`
    // from tree effects, plus the gate holds from (a)). Provenance (ADR
    // 51): only trusted tree code ever emits `stop` — gates only ever
    // `continue` — so a drained `stop` is legitimately a tier-1 halt.
    const loopReq = this.bridges.loop.drainLoopRequests();

    // (c) Steering (ADR 53) — new input appended since this execution's
    // last-observed count means the next render has new user input →
    // continue. LIVE, in-memory, nothing durable (crashes never
    // auto-resume).
    const count = this.bridges.timeline.inputEntryCount();
    const steering = count > this._inputEntriesSeen;
    if (steering) this._inputEntriesSeen = count;

    // Tier resolution.
    if (loopReq.stop !== undefined) {
      return { kind: "stop", reason: loopReq.stop };
    }
    if (loopReq.continue !== undefined || steering) {
      return { kind: "continue" };
    }
    return undefined;
  }

  // ──────── Extended interaction surface (block 5) ────────

  async spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "spawn" }) satisfies SessionError;
    }
    if (this.spawnContext === undefined) {
      throw new ExecutionFailed({
        cause: new Error(
          "spawn() requires a spawnContext — the session was constructed without an app-level parent",
        ),
      }) satisfies SessionError;
    }
    const childInput = {
      parentSessionId: this.store.id,
      agent: input.agent,
      ...omitUndefined({
        sessionId: input.sessionId,
        metadata: input.metadata,
        initialProps: input.initialProps,
        initialKnobs: input.initialKnobs,
        maxTicks: input.maxTicks,
      }),
    };
    const child = await this.spawnContext.createChildSession(childInput);
    if (input.send !== undefined) {
      return child.send(input.send);
    }
    return child;
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
    options?: import("@agentick/spec-next").DispatchOptions,
  ): Promise<readonly ContentBlock[]> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "dispatch" }) satisfies SessionError;
    }
    await this._mountReady;
    // Defaults to Pattern A — when the tool returns a TaskHandle, the
    // executor awaits the handle's result and the caller observes
    // final blocks. Opt into Pattern B with `{ task: "ref" }`; see
    // `DispatchOptions`.
    const result = await this.toolExecutor.dispatch({
      toolCallId: `host:${ulid()}`,
      name,
      input,
      context: { via: "dispatch", sessionId: this.store.id },
      ...(options?.task !== undefined ? { task: options.task } : {}),
    });
    return result.content;
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    const fullName = `session:channel:${name}`;
    const sessionId = this.store.id;
    const bus = this.bus;
    const inbox = this.inbox;
    const sessionAddress = this.address;
    return {
      name,
      publish: async (payload: T, metadata?: Readonly<Record<string, unknown>>) => {
        const ev: ProtocolEvent = {
          id: ulid(),
          surface: "session",
          name: fullName,
          phase: "delta",
          timestamp: Date.now(),
          scope: { sessionId },
          payload,
          ...(metadata !== undefined ? { metadata } : {}),
        } as ProtocolEvent;
        await Effect.runPromise(bus.append(ev));
      },
      subscribe: (listener) => {
        // Subscribe is pub/sub only — drop envelopes tagged as
        // requests so handlers using onRequest aren't double-routed.
        const fiber = Effect.runFork(
          Stream.runForEach(
            bus.subscribe({ surface: "session", name: { exact: fullName } }),
            (ev) =>
              Effect.sync(() => {
                const evx = ev as {
                  channelSequence?: number;
                  parentOpId?: string;
                  metadata?: Readonly<Record<string, unknown>>;
                  correlationId?: string;
                };
                if (evx.metadata?.requestType === "request") return;
                const meta: import("@agentick/spec-next").ChannelEventMeta = {
                  id: ev.id,
                  timestamp: ev.timestamp,
                  ...omitUndefined({
                    metadata: evx.metadata,
                    correlationId: evx.correlationId,
                    parentOpId: evx.parentOpId,
                    channelSequence: evx.channelSequence,
                  }),
                };
                listener(ev.payload as T, meta);
              }),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
      },
      request: async <TReq, TResp>(
        payload: TReq,
        opts?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<TResp> => {
        // Delegate to the session's BaseHarness.request capability.
        // The session is itself a BaseHarness — protected method
        // accessed via the public sessionRequest helper below.
        return this.sessionRequest<TReq, TResp>(name, payload, opts);
      },
      onRequest: <TReq = unknown, TResp = unknown>(
        listener: (payload: TReq, ctx: import("@agentick/spec-next").RequestContext<TResp>) => void,
      ) => {
        const fiber = Effect.runFork(
          Stream.runForEach(
            bus.subscribe({ surface: "session", name: { exact: fullName } }),
            (ev) =>
              Effect.sync(() => {
                const evx = ev as {
                  metadata?: Readonly<Record<string, unknown>>;
                };
                const md = evx.metadata;
                if (md?.requestType !== "request") return;
                const correlationId = md.correlationId as string | undefined;
                const replyTo = md.replyTo as string | undefined;
                if (!correlationId || !replyTo) return;
                const ctx: import("@agentick/spec-next").RequestContext<TResp> = {
                  correlationId,
                  replyTo,
                  metadata: md,
                  respond: async (response: TResp) => {
                    await Effect.runPromise(
                      inbox.send(replyTo, {
                        type: "request-response",
                        messageId: `m_${correlationId}`,
                        payload: { correlationId, response },
                      }),
                    );
                  },
                };
                listener(ev.payload as TReq, ctx);
              }),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
        // sessionAddress acknowledged via the outer closure so the
        // lint doesn't flag it as unused when the parent uses it.
        void sessionAddress;
      },
    };
  }

  /**
   * Current snapshot of a channel as a ready-to-publish envelope, or
   * `undefined` when no bridge owns `channel`. Scans the session's
   * bridges for the {@link ChannelSnapshotProvider} keyed by `channel`
   * and renders its current state into a `delta`-phase channel envelope —
   * the opening frame the `sub/subscribe` handler prepends so a fresh
   * subscriber opens WITH the current state (the K8s `sendInitialEvents`
   * model). Async so a future provider can render its frame off-thread;
   * today `channelSnapshotPayload()` is sync.
   */
  async channelSnapshot(channel: string): Promise<EventEnvelope | undefined> {
    const provider = this.snapshotProviders().get(channel);
    if (provider === undefined) return undefined;
    const payload = provider.channelSnapshotPayload();
    return {
      id: ulid(),
      surface: "session",
      name: channelEventName(channel),
      phase: "delta",
      timestamp: Date.now(),
      scope: { sessionId: this.store.id },
      payload,
    };
  }

  /**
   * Build (once) the `channel → ChannelSnapshotProvider` index by scanning
   * every bridge value for one passing {@link isChannelSnapshotProvider}.
   * No hardcoded slot list — any harness that conforms is discovered
   * generically (mirrors the SnapshotCapable feature-detection pattern).
   */
  private snapshotProviders(): Map<string, ChannelSnapshotProvider> {
    if (this._snapshotProviders === null) {
      const map = new Map<string, ChannelSnapshotProvider>();
      for (const value of Object.values(this.bridges)) {
        if (isChannelSnapshotProvider(value)) map.set(value.snapshotChannel, value);
      }
      this._snapshotProviders = map;
    }
    return this._snapshotProviders;
  }

  /**
   * Public bridge to `BaseHarness.request` — channel handles call
   * this so they don't need access to the protected method.
   */
  async sessionRequest<TReq, TResp>(
    channel: string,
    payload: TReq,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TResp> {
    const eff = this.request<TReq, TResp>(channel, payload, opts ?? {});
    return runHarnessProtocol(eff);
  }

  /**
   * Register this session's escalation interceptor (ADR 69 T2a). ONE
   * per session — a later registration replaces the current one. The
   * returned unsubscribe clears it only if it is still the current
   * handler (a stale unsubscribe from a replaced handler is a no-op).
   * With none registered, escalation behaves exactly as T1 (parity).
   */
  interceptEscalation(handler: EscalationInterceptor): Unsubscribe {
    this.escalationInterceptor = handler;
    return () => {
      if (this.escalationInterceptor === handler) {
        this.escalationInterceptor = undefined;
      }
    };
  }

  knob<T = unknown>(name: string): KnobHandle<T> {
    const bridge = this.bridges.knobs;
    return {
      name,
      get: () => bridge.get(name) as T,
      // Fire-and-forget the async Operation; callers using this
      // sync surface expect "queue the mutation, move on."
      set: (value: T) => {
        void bridge.set({ id: name, value: value as string | number | boolean });
      },
      subscribe: (listener) => bridge.subscribe(name, listener),
    };
  }

  // ──────── inbox dispatch ────────

  // TODO(adr-51-session-verbs): session commands are NOT declared
  // commands yet — and NOT mechanically migratable, for two recorded
  // reasons (classified during the adr-51 wave):
  //   1. Session's public commands (send/dispatch/queue/append) do not
  //      run through `runOperation` at all today (the pre-existing gap
  //      base-harness.ts §"commands don't currently go through
  //      runOperation" notes). Declaring them is the fix, but:
  //   2. `SendInput` carries non-serializable per-call overrides
  //      (`executor`, `target`, `signal`, tool registrations with live
  //      handlers) — by ADR 51 §1.2 those are in-process-only. An
  //      ADDRESSABLE `session:send` needs a designed serializable
  //      signal form (messages + maxTicks + stream — the subset the
  //      wire's `session/send` porcelain already carries), same move
  //      as `timeline:compact`'s signal form. `session:dispatch`
  //      (name + JSON input) is fully serializable and is the easy
  //      first declaration. Design rides the slice-5/verb-matrix pass.
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // ADR 69 — substrate request escalation. A nested unit of work (a
    // task, a spawned sub-agent) `ask`s its escalation-parent for
    // something only the client can provide; the session is a hop on that
    // chain.
    if (msg.type === SESSION_ESCALATION_MESSAGE_TYPE) {
      return this.handleEscalation(msg as MessageEnvelope<EscalationEnvelopePayload>);
    }
    return Effect.fail(
      new HandlerError({ cause: new Error("session inbox dispatch not yet wired (Phase 4e+)") }),
    );
  }

  /**
   * Escalation hop (ADR 69). The `ask` return value IS the response — the
   * nested-`ask` stack is both the relay AND the reply route:
   *
   *   - a registered **interceptor** (ADR 69 T2a) is consulted FIRST — it
   *     may **answer** (`{ forward: false, response }` → short-circuit,
   *     this hop resolves), **deny** (throw → the ask rejects), or **fall
   *     through** (`{ forward: true }`). With none registered, behavior is
   *     byte-identical to T1 (parity).
   *   - **spawned session** (`parentSessionId` set) → **forward** one hop
   *     up to `session:{parentSessionId}`, appending this session's
   *     {@link EscalationHop} to `payload.lineage` first (provenance, ADR
   *     69 §Provenance); the parent's eventual response threads back down
   *     through this `ask`'s return.
   *   - **root session** (no `parentSessionId`) → resolve **terminally**.
   *     Today the one implemented class is `"elicit"`: run the real client
   *     elicitation on this session's harness and return the outcome,
   *     which routes back to the origin task automatically.
   *
   * A long timeout (not the 30s `ask` default) governs the human-scale
   * wait; the origin's `signal` (cancel / ttl) interrupts the chain.
   */
  private handleEscalation(
    msg: MessageEnvelope<EscalationEnvelopePayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const payload = msg.payload;
    if (payload === undefined) {
      return Effect.fail(new HandlerError({ cause: "escalation envelope missing payload" }));
    }

    const interceptor = this.escalationInterceptor;
    if (interceptor === undefined) {
      return this.forwardOrResolveEscalation(payload);
    }

    // Consult the interceptor FIRST (ADR 69 T2a). A throw is a hard DENY
    // — it propagates as this ask's rejection, so the origin's ctx.elicit
    // rejects. `{ forward: false }` means THIS hop answered → short-circuit
    // (the parent / terminal never sees it). `{ forward: true }` falls
    // through to the existing forward-or-terminal logic.
    return Effect.tryPromise<EscalationOutcome, MessageHandlerError>({
      try: () => interceptor(payload),
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
    }).pipe(
      Effect.flatMap((outcome) =>
        outcome.forward === false
          ? Effect.succeed(outcome.response)
          : this.forwardOrResolveEscalation(payload),
      ),
    );
  }

  /**
   * The forward-or-terminal half of an escalation hop (ADR 69). Split
   * out from {@link handleEscalation} so the interceptor consult composes
   * cleanly in front of it. Forwards to the spawner (appending a lineage
   * hop) when this is a spawned session; resolves terminally against the
   * real client otherwise.
   */
  private forwardOrResolveEscalation(
    payload: EscalationEnvelopePayload,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // Forward branch — a spawned session bubbles to its spawner. Append
    // this session's hop to the lineage path (origin → each hop) before
    // forwarding; `principal` is best-effort (ADR 51).
    if (this.parentSessionId !== undefined) {
      const hop: EscalationHop = {
        scopeId: `session:${this.scopeId}`,
        ...(this.principal !== undefined ? { principal: this.principal } : {}),
      };
      const forwarded: EscalationEnvelopePayload = {
        ...payload,
        lineage: [...(payload.lineage ?? []), hop],
      };
      return this.inbox
        .ask(
          `session:${this.parentSessionId}`,
          { type: SESSION_ESCALATION_MESSAGE_TYPE, payload: forwarded },
          { timeoutMs: ESCALATION_TIMEOUT_MS },
        )
        .pipe(Effect.catchAll((cause) => Effect.fail(new HandlerError({ cause }))));
    }

    // Terminal branch (root) — resolve against the real client.
    if (payload.class === "elicit") {
      const request = payload.request as ElicitationRequest;
      return Effect.tryPromise<unknown, MessageHandlerError>({
        // Branch so overload resolution picks the form / url signature.
        try: () =>
          request.mode === "url"
            ? this.elicitation.elicit(request)
            : this.elicitation.elicit(request as FormElicitationRequest),
        catch: (cause): MessageHandlerError => new HandlerError({ cause }),
      });
    }

    // TODO(ADR-69 T2b+): non-elicit payload classes (sampling, permission,
    // credential, error) resolve terminally here via their own resolvers.
    return Effect.fail(
      new HandlerError({ cause: `unknown escalation class: ${String(payload.class)}` }),
    );
  }

  // ──────── internals ────────

  private async sendBody(input: SendInput<P>): Promise<SessionExecutionHandle> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "send" });
    }
    // JOIN semantics (ADR 53 §5): a send() while an execution is
    // running is STEERING — append the messages (visible next tick via
    // the continuation predicate + <Timeline/>) and return the
    // in-flight handle. The reservation check is SYNCHRONOUS (before
    // any await) so concurrent fresh sends cannot both pass it; a
    // terminal-window send (loop settled, cleanup pending) is NOT
    // joinable — it waits out the old execution and runs fresh.
    while (this._handleReservation !== null) {
      if (!this._loopDone) {
        const reservation = this._handleReservation;
        const handle = await reservation.promise;
        // Re-check: the loop may have settled while we awaited the
        // reservation — a dead handle must not be joined.
        if (!this._loopDone) {
          for (const m of input.messages ?? []) await this.appendInputMessage(m);
          return handle;
        }
      }
      // Terminal window: wait for the previous execution's cleanup
      // (.finally clears the reservation), then run fresh.
      await (this._currentExecution ?? Promise.resolve()).catch(() => {});
      await Promise.resolve(); // let .finally clear the reservation
      if (this._handleReservation === null) break;
    }

    // SYNCHRONOUS reservation — no await between here and the guard
    // above having passed.
    let reserveResolve!: (h: import("@agentick/spec-next").SessionExecutionHandle) => void;
    let reserveReject!: (e: unknown) => void;
    const reservationPromise = new Promise<import("@agentick/spec-next").SessionExecutionHandle>(
      (res, rej) => {
        reserveResolve = res;
        reserveReject = rej;
      },
    );
    reservationPromise.catch(() => {});
    this._handleReservation = {
      promise: reservationPromise,
      resolve: reserveResolve,
      reject: reserveReject,
    };
    this._loopDone = false;

    await this._mountReady;

    // Input appends the moment it arrives (ADR 53 §2.1) — no queue, no
    // drain. The first tick's render sees it via <Timeline/>.
    for (const m of input.messages ?? []) await this.appendInputMessage(m);

    // ADR 53: the first render will include everything appended so far.
    this._inputEntriesSeen = this.bridges.timeline.inputEntryCount();
    this._executionUsage = undefined;

    const executionId = `exec:${ulid()}`;
    this.store.setCurrentExecutionId(executionId);
    this.store.setStatus("running");

    // Per-call overrides — executor + target — fall through from
    // SendInput. The app-level executor/target is the default; this
    // send swaps in caller-supplied alternatives without changing
    // session state.
    const executorForCall = input.executor ?? this.executor;
    const targetForCall = input.target ?? this.target;

    // Resolve streaming preference. Cascade:
    //   SendInput.stream  >  session-level streaming default
    //                     >  executor capability default
    // The capability default is true when both:
    //   - the executor exposes `executeStream`
    //   - target.capabilities.supportsStreaming is not explicitly false
    const capabilityStreamDefault =
      typeof executorForCall.executeStream === "function" &&
      (targetForCall.capabilities?.supportsStreaming ?? true);
    const streamForCall = input.stream ?? this.defaultStreaming ?? capabilityStreamDefault;

    // Set up the handle + emit chain BEFORE running the loop so the
    // loop can pump events into it from the first tick.
    // `durabilityFailed` latches when the ADR 49 flush barrier below
    // surfaces a store-write failure — the session has diverged from
    // its durable log and must land on "failed", not "idle" (the
    // `.finally` runs after our reject and would otherwise clobber it).
    let durabilityFailed = false;
    const resultDeferred = {} as { resolve: (r: SendResult) => void; reject: (e: unknown) => void };
    const resultPromise = new Promise<SendResult>((resolve, reject) => {
      resultDeferred.resolve = resolve;
      resultDeferred.reject = reject;
    }).finally(() => {
      this._currentExecution = null;
      this._currentHandle = null;
      this._handleReservation = null;
      this.store.setCurrentExecutionId(null);
      this.store.setStatus(durabilityFailed ? "failed" : "idle");
    });
    resultPromise.catch(() => {
      // Prevent unhandled rejections — handle has its own .result.
    });

    const { handle, emit, close } = createSessionExecutionHandle({
      sessionId: this.store.id,
      executionId,
      resultPromise,
      abort: async (reason) => {
        await this.loop.abort({ executionId, ...(reason !== undefined ? { reason } : {}) });
      },
    });

    const onEvent = this.buildOnEvent(emit);

    // Execution-scoped tools (#139) are bound for the duration of the
    // loop run via `withScope`: register each tool, run the loop,
    // remove the scope's binding in `finally`. Atomic — cleanup runs
    // on success, failure, or throw.
    const runPromise = withScope(
      this.toolExecutor,
      { scope: "execution", executionId },
      input.tools ?? [],
      // ADR 77 Stage 4 — run the COMPOSED loop (`loop.fx.runExecution`, one
      // fiber) on the telemetry runtime. `loop.runExecution` (the facade) is
      // exactly `runHarnessProtocol(loop.fx.runExecution(...))` on the DEFAULT
      // runtime; swapping in `this.telemetryRuntime` routes the whole
      // execution's `Effect.withSpan` tree to the adopter's tracer, and
      // because the loop is one fiber every downstream span nests under the
      // execution via FiberRef `parentOpId` auto-threading. `undefined`
      // runtime → default → behavior-preserving (no-op tracer).
      () =>
        runHarnessProtocol(
          this.loop.fx.runExecution({
            executionId,
            sessionId: this.store.id,
            reconciler: this.reconciler,
            mountId: this.mountId,
            executor: executorForCall,
            target: targetForCall,
            toolExecutor: this.toolExecutor,
            stateApplicator: {
              // The `.fx` twins compose in the loop's fiber (Stage 3); the
              // Promise facades below stay the derived edge. `Effect.asVoid`
              // drops the session's `ApplyResult` to the loop-facing `void`.
              fx: {
                applyExecutorResult: (i) => this.applyExecutorResultFx(i).pipe(Effect.asVoid),
                applyToolResults: (i) => this.applyToolResultsFx(i).pipe(Effect.asVoid),
              },
              applyExecutorResult: (i) => this.applyExecutorResult(i).then(() => undefined),
              applyToolResults: (i) => this.applyToolResults(i).then(() => undefined),
              appendEntry: (i) => this.appendEntry(i).then(() => undefined),
            },
            notifyTickEnd: (i) => this.notifyLifecycle(i),
            // ADR 55 — the session is the per-render fact producer. It folds
            // every RenderContext slot it can supply: the active model's
            // window (via effectiveModelInfo) into `contextInfo`, and the
            // active model itself (a projection of the target) into
            // `activeModel`. Future slots (budget, caller) add a field here.
            // Today the model is construction-bound (this.target); TODO(trail-
            // per-tick-model): under #169 it's IR-derived per tick and this
            // re-resolves per render.
            resolveRenderContext: () => {
              const contextWindow = effectiveModelInfo(targetForCall, this.models)?.contextWindow;
              const rc: RenderContext = {
                ...(contextWindow !== undefined ? { contextInfo: { contextWindow } } : {}),
                activeModel: {
                  provider: targetForCall.provider,
                  modelId: targetForCall.modelId,
                  capabilities: targetForCall.capabilities,
                },
              };
              return rc;
            },
            // ADR 56 — resolve tree-declared per-tick model refs against the
            // mount's ModelBridge. `useModelRegistration` registers models
            // here at render time; the loop looks up `declarations.model
            // .modelRef` per tick. No default registration — the loop's
            // fallback (this.executor/target via executorForCall/
            // targetForCall) covers the undeclared case.
            resolveModel: (ref) => this.bridges.models.resolve(ref),
            maxTicks: input.maxTicks ?? this.defaultMaxTicks,
            stream: streamForCall,
            onEvent,
            // Stage 5 — per-send tool concurrency (default "unbounded" in
            // the loop) + optional execution timeout, both opt-in.
            ...omitUndefined({
              signal: input.signal,
              toolConcurrency: input.toolConcurrency,
              timeoutMs: input.timeoutMs,
            }),
          }),
          this.telemetryRuntime,
        ),
    );

    this._currentExecution = runPromise;
    this._currentHandle = handle;
    this._handleReservation?.resolve(handle);
    // Latch loop completion SYNCHRONOUSLY on settle — joins during the
    // terminal window (endTurn/flush/resolve) must be refused.
    runPromise.then(
      () => {
        this._loopDone = true;
      },
      () => {
        this._loopDone = true;
      },
    );

    // Resolve the result promise + emit the final `result` StreamEvent
    // when the loop terminates. Iterator closes after the result event.
    void runPromise.then(
      async (terminal) => {
        // ADR 49 flush barrier — execution end. Invariant: any process
        // that subsequently loads the store sees every completed
        // execution. A buffered store-write failure is a durability
        // divergence: fail the send with the typed TimelineWriteFailed
        // (catchTag-able) and land the session on "failed" status —
        // it must not keep running against a log its store doesn't have.
        // ADR 53: emit the turn-boundary RECORD (segmentation +
        // turn-aggregate usage; load-bearing nowhere) before the flush
        // barrier so it rides the same durability guarantee.
        await this.bridges.timeline
          .endTurn({
            executionId,
            // The loop RESOLVES provider failures (outcome "succeeded"
            // with stopReason "executor_failed") — the boundary record
            // must not launder them (review finding).
            outcome:
              terminal.outcome === "succeeded"
                ? terminal.result?.stopReason === "executor_failed"
                  ? "failed"
                  : "succeeded"
                : "aborted",
            ...omitUndefined({ usage: this._executionUsage }),
          })
          .catch(() => {});
        try {
          await this.bridges.timeline.flush();
        } catch (err) {
          durabilityFailed = true;
          resultDeferred.reject(err);
          close();
          return;
        }
        const result = terminal.result;
        if (terminal.outcome === "succeeded" && result) {
          const response = result.output
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          const sendResult: SendResult = {
            response,
            output: result.output,
            toolResults: result.toolResults,
            usage: result.usage,
            stopReason: result.stopReason,
            ticks: result.ticks,
            executionId,
          };
          emit({ type: "result", tick: 0, result: sendResult });
          resultDeferred.resolve(sendResult);
        } else {
          resultDeferred.reject(
            new Error(`execution ended with outcome=${terminal.outcome}: ${terminal.reason ?? ""}`),
          );
        }
        close();
      },
      async (err) => {
        // The execution error wins as the rejection reason; the barrier
        // still runs so a completed-but-unflushed prefix lands in the
        // store (best-effort — a flush failure here latches "failed"
        // status but does not mask the execution error).
        await this.bridges.timeline
          .endTurn({
            executionId,
            outcome: "failed",
            ...omitUndefined({ usage: this._executionUsage }),
          })
          .catch(() => {});
        try {
          await this.bridges.timeline.flush();
        } catch {
          durabilityFailed = true;
        }
        resultDeferred.reject(err);
        close();
      },
    );

    return handle;
  }

  /**
   * Translate a `LoopEmittedEvent` into the public StreamEvent shape
   * and push it onto the handle's iterator queue. Used as the loop's
   * `onEvent` callback during `runExecution`.
   */
  private buildOnEvent(emit: (event: SessionEmitInput) => void): (event: LoopEmittedEvent) => void {
    return (loopEvent) => {
      switch (loopEvent.kind) {
        case "model":
          emit({ ...loopEvent.delta, tick: loopEvent.tick } as never);
          return;
        case "tick-start":
          emit({ type: "tick-start", tick: loopEvent.tick, tickIndex: loopEvent.tickIndex });
          return;
        case "tick-end":
          emit({
            type: "tick-end",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            shouldContinue: loopEvent.shouldContinue,
            ...omitUndefined({ stopReason: loopEvent.stopReason, usage: loopEvent.usage }),
          });
          return;
        case "tick":
          emit({
            type: "tick",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            stopReason: loopEvent.stopReason,
            usage: loopEvent.usage,
            durationMs: loopEvent.durationMs,
          });
          return;
        case "execution-start":
          emit({
            type: "execution-start",
            tick: loopEvent.tick,
            ...omitUndefined({ rootExecutionId: loopEvent.rootExecutionId }),
          });
          return;
        case "execution-end":
          emit({
            type: "execution-end",
            tick: loopEvent.tick,
            stopReason: loopEvent.stopReason,
            ...omitUndefined({ aborted: loopEvent.aborted, error: loopEvent.error }),
          });
          return;
        case "tool-dispatch-start":
          emit({
            type: "tool-dispatch-start",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            via: loopEvent.via,
          });
          return;
        case "tool-dispatch-end":
          emit({
            type: "tool-dispatch-end",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            outcome: loopEvent.outcome,
            durationMs: loopEvent.durationMs,
          });
          return;
        case "tool-dispatch":
          emit({
            type: "tool-dispatch",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            content: loopEvent.content,
            succeeded: loopEvent.succeeded,
            durationMs: loopEvent.durationMs,
            ...omitUndefined({ executedBy: loopEvent.executedBy, isError: loopEvent.isError }),
          });
          return;
      }
    };
  }

  private async applyExecutorResultBody(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    const ids: string[] = [];
    if (input.result.output.length > 0) {
      const id = await this.appendMessageEntry({
        role: "assistant",
        content: input.result.output,
        // ADR 53 §2.2: one tick = one generation = one assistant entry;
        // stamp provenance + the GENERATION's usage on the record.
        metadata: {
          executionId: input.executionId,
          tickId: input.tickId,
          ...omitUndefined({ usage: input.result.usage }),
        },
      });
      ids.push(id);
    }
    this._executionUsage =
      this._executionUsage && input.result.usage
        ? mergeUsageStats(this._executionUsage, input.result.usage)
        : (input.result.usage ?? this._executionUsage);
    this.store.addUsage(input.result.usage);
    this.store.bumpTick();
    return { appendedEntryIds: ids };
  }

  private async applyToolResultsBody(input: ApplyToolResultsInput): Promise<ApplyResult> {
    const ids: string[] = [];
    for (const tr of input.results) {
      const block: ContentBlock = {
        type: "tool_result",
        toolUseId: tr.toolCallId,
        name: tr.toolName,
        content: tr.content,
        ...(tr.succeeded === false ? { isError: true } : {}),
      };
      const id = await this.appendMessageEntry({
        role: "tool",
        content: [block],
        toolCallId: tr.toolCallId,
        name: tr.toolName,
        metadata: { executionId: input.executionId, tickId: input.tickId },
      });
      ids.push(id);
    }
    return { appendedEntryIds: ids };
  }

  private async appendEntryBody(input: AppendEntryInput): Promise<ApplyResult> {
    const id = await this.appendMessageEntry({
      role: input.entry.role,
      content: input.entry.content,
    });
    return { appendedEntryIds: [id] };
  }

  /**
   * Append a user-input message directly to the timeline (ADR 53 §2.1)
   * — the user's words are a fact the moment they arrive. Input carries
   * no execution provenance (it wasn't produced BY an execution).
   */
  private async appendInputMessage(m: SendMessageInput): Promise<void> {
    const content =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    await this.appendMessageEntry({
      role: m.role,
      content,
      ...omitUndefined({ metadata: m.metadata }),
    });
  }

  /**
   * Internal helper — build a `TimelineEntry` for a message and route
   * the append through the TimelineHarness. Returns the message id so
   * `StateApplicator` callers can include it in their `ApplyResult`.
   */
  private async appendMessageEntry(input: {
    readonly role: import("@agentick/spec-next").SessionMessageRole;
    readonly content: readonly ContentBlock[];
    readonly visibility?: "model" | "observer" | "log";
    readonly toolCallId?: string;
    readonly name?: string;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const messageId = `m_${ulid()}`;
    const message: import("@agentick/spec-next").SessionMessage = {
      id: messageId,
      role: input.role,
      content: input.content,
      ts: Date.now(),
      ...omitUndefined({
        toolCallId: input.toolCallId,
        name: input.name,
        metadata: input.metadata,
      }),
    };
    const entry: TimelineEntry = {
      kind: "message",
      message,
      ...omitUndefined({ visibility: input.visibility, tags: input.tags }),
    };
    await this.bridges.timeline.append(entry);
    return messageId;
  }
}

// Resolve unused-import lint for Operation when concrete subclasses
// add commands that use it.
void (undefined as unknown as Operation<unknown, unknown, unknown>);

/**
 * If the thrown value is already a tagged `SessionError`, pass it
 * through; otherwise wrap as `ExecutionFailed`. Without this, internal
 * pre-execution failures (e.g., `SessionClosedError`, `SessionBusyError`)
 * get swallowed into a generic ExecutionFailed and the caller can't
 * tell what went wrong.
 */
function coerceSessionError(cause: unknown): SessionError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as SessionError;
  }
  return new ExecutionFailed({ cause });
}
