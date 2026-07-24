/**
 * `SessionHarness` — reference implementation of
 * `SessionHarnessProtocol`.
 *
 * Owns the integration between JSX agent + compiler + loop executor.
 * The user-facing entry point: `session.send({ messages })` runs one
 * agent execution and returns a `SessionExecutionHandle`.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

import { Effect, Fiber, ManagedRuntime, Stream } from "effect";

import {
  BaseHarness,
  composeMiddleware,
  getContext,
  orderInterceptors,
  type Middleware,
  runHarnessProtocol,
  spanAttributes,
  ulid,
  withCallMiddleware,
  SESSION_ESCALATION_MESSAGE_TYPE,
  ESCALATION_TIMEOUT_MS,
  SESSION_TASK_WAKE_MESSAGE_TYPE,
  TASK_WAKE_SOURCE,
  type EscalationEnvelopePayload,
  type EscalationHop,
  type EscalationInterceptor,
  type EscalationOutcome,
  type SessionTaskWakePayload,
  type TelemetryProvider,
} from "@agentick/runtime-next";
import type { JournalingPolicy, LoopExecutorProtocol, CompilerProtocol } from "@agentick/spec-next";
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
  LoopExecutionEvent,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MessageInboxFactory,
  NotifyTickEndInput,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  ProtocolEvent,
  RegisteredModel,
  OutputSpec,
  RenderContext,
  ResponseFormat,
  RestoreSnapshotInput,
  SendInput,
  SendMessageInput,
  SendResult,
  SendTelemetry,
  SessionError,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionSnapshot,
  SessionStore,
  SnapshotMigration,
  SessionSubstrateParent,
  SpawnContext,
  SpawnInput,
  StateApplyError,
  SubstrateError,
  TickEndForwardDecision,
  TickResult,
  TimelineEntry,
  ToolExecutorProtocol,
  TreeInterceptionSource,
  Unsubscribe,
} from "@agentick/spec-next";
import {
  channelEventName,
  DEFAULT_JOURNALING_POLICY,
  ExecutionFailed,
  HandlerError,
  isChannelSnapshotProvider,
  isSnapshotCapable,
  SteerCannotCarryStructuredOutput,
  supportsTreeInterception,
  SessionClosedError,
  SnapshotVersionMismatch,
  SpawnDepthExceededError,
  SPEC_VERSION,
  TimelineWriteFailed,
} from "@agentick/spec-next";
import { mergeAbortSignals, mergeLayered, omitUndefined } from "@agentick/utils-next";
import { buildSessionElicit } from "@agentick/elicitation-next";
import { withScope } from "@agentick/tool-executor-next";
import {
  effectiveModelInfo,
  mergeUsageStats,
  type LanguageModelAdapter,
  type ModelRegistry,
} from "@agentick/model-next";
import type { KnobsHandle } from "@agentick/knobs-next";
import type { GateHandle, GatesHandle } from "@agentick/gates-next";
import type { StateHandle } from "@agentick/state-next";
import type { TimelineHandle, TimelineHarnessOptions } from "@agentick/timeline-next";

import { buildSessionBridges, type SessionHookBridges } from "./session-bridges.js";
import { wireLifecycleProjection, type LifecycleProjection } from "./lifecycle-projection.js";
import {
  SessionModelFacade,
  type ModelSelectionHandle,
  type SetModelInput,
} from "./model-facade.js";
import { SessionRuntime } from "./session-state.js";
import { createSessionExecutionHandle, type SessionEmitInput } from "./session-execution-handle.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// The four public session verbs now route through `runOperation` (see
// `sessionOp`), so each mints a typed `onBefore…` / `onAfter…` hook via the
// derived `CommandHooks` surface. The registry key is the canonical
// `session:<verb>` form (the `:command:` infix `deriveHookNames` strips), so
// `session:send` → `onBeforeSessionSend` / `onAfterSessionSend`.
//
// WIRE (ADR 51): these ops are HOOKABLE but NON-ADDRESSABLE — see the note at
// `handleMessage`. `SendInput` carries non-serializable per-call overrides, so
// no wire command descriptor is declared here; this augmentation is purely the
// in-process hook surface.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "session:send": { input: SendInput<unknown>; output: SessionExecutionHandle };
    "session:append": { input: AppendEntryInput; output: ApplyResult };
    "session:apply-executor-result": { input: ApplyExecutorResultInput; output: ApplyResult };
    "session:apply-tool-results": { input: ApplyToolResultsInput; output: ApplyResult };
    // ADR 89 §2 — the `session.model.setModel` / `setTarget` swap. Declared
    // as a session command so a model swap is journaled + hookable
    // (`onBeforeSessionSetModel` — "this session may not switch to model X").
    "session:set-model": { input: SetModelInput; output: void };
    // Recovery pass #1 — snapshot/restore ARE commands (persist/restore hook
    // quartet). `session:snapshot` mints `onBeforeSessionSnapshot` (veto) +
    // `onAfterSessionSnapshot` (the v1 `onPersist` augment/redact parity —
    // transform the output). `session:restore` mints `onBeforeSessionRestore`
    // (the v1 `onRestore` seam — migration lives at the decision point) +
    // `onAfterSessionRestore`. Both journal.
    "session:snapshot": { input: CaptureSnapshotInput; output: SessionSnapshot };
    "session:restore": { input: RestoreSnapshotInput; output: void };
  }
}

/**
 * Input to the `session:snapshot` command. Empty today — reserved for
 * future capture options (selective bridge capture, redaction hints). The
 * `onBeforeSessionSnapshot` hook receives it; the valuable seam is
 * `onAfterSessionSnapshot` (transform the captured {@link SessionSnapshot}).
 */
export type CaptureSnapshotInput = Record<string, never>;

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
   * `compiler.mount({ element })`. The concrete compiler impl owns
   * the type contract (React, Angular, etc.); the session is
   * compiler-agnostic.
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
   * Compiler that owns the agent's element tree. Typed as the
   * protocol — any conformant impl (React compiler, future Angular
   * compiler, etc.) drops in.
   */
  readonly compiler: CompilerProtocol;
  /**
   * Loop executor that orchestrates ticks. Typed as the protocol so
   * alternative orchestrators (cluster-aware, replay-based, etc.) can
   * be injected without changing the session boundary.
   */
  readonly loop: LoopExecutorProtocol;
  /**
   * Model-executor harness for model invocations — the session default.
   * Optional: a model-less app threads `undefined`. Dispatch, snapshot/restore,
   * and wire plumbing all work without one; a `send` that resolves no model
   * (default + per-send + per-tick `<Model>` all empty) fails at execution time
   * with `NoModelForExecutionError`.
   */
  readonly modelExecutor?: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  /**
   * Adapter→executor builder, INJECTED by the app (ADR 89 §2 ergonomic
   * parity). The app owns the adapter→executor build + the substrate it needs
   * (see `AppHarness.createSessionBody`), so it passes this closure down; the
   * `session.model` facade calls it to normalize the `setModel(adapter)`
   * overload into a `RegisteredModel`. Omitted for a BYO-executor app (one that
   * supplied its own `modelExecutor` rather than a `model` adapter) — the
   * adapter overload then throws `ModelExecutorBuilderMissingError`. Keeps the
   * session adapter-agnostic: it never imports executor-construction machinery.
   */
  readonly buildModelExecutor?: (adapter: LanguageModelAdapter) => RegisteredModel;
  /** Tool executor harness for tool dispatch. */
  readonly toolExecutor: ToolExecutorProtocol;
  /** Default execution target — overridable per send (later). Optional (model-less). */
  readonly target?: ExecutionTarget;
  /** Default per-execution max tick bound. Default: 8. */
  readonly defaultMaxTicks?: number;
  /**
   * Session-level streaming default. Overridden by `SendInput.stream`
   * per-call. Falls through to the executor-capability default when
   * unset (streaming on when `executor.executeStream` exists AND
   * `target.capabilities.supportsStreaming` ≠ false).
   */
  readonly defaultStreaming?: boolean;
  /**
   * Model-call narration switch (default `true`). Threaded into every
   * `loop.runExecution` so the projector gates injection of the reserved
   * `_summary` narration field into each model-facing tool schema. Set
   * `false` to disable narration for this session — the token-cost
   * off-switch (an extra schema property per tool + an extra model-emitted
   * sentence per call). Cascades from the app-level default.
   */
  readonly narrate?: boolean;
  /**
   * Snapshot-migration seam (recovery pass #1 — schema evolution). A typed
   * callback invoked by {@link SessionHarness.restore} when a snapshot's
   * `specVersion` differs from the running `SPEC_VERSION`, to bring the old
   * shape up to current. Construction-bound (threaded from the app) because
   * a given deployment knows how to migrate old snapshots to its own shape.
   * With none supplied, a version mismatch throws `SnapshotVersionMismatch`
   * (fail-closed). See {@link SnapshotMigration}.
   */
  readonly migrateSnapshot?: SnapshotMigration;
  /**
   * Construction-bound abort signal (PA1 — the app-signal cascade + the
   * per-session `CreateSessionInput.signal`). Merged with each call's
   * `SendInput.signal` into the execution signal threaded to the loop:
   *   - firing it mid-run aborts the in-flight execution (the loop honors
   *     the merged signal on its cancellation edges);
   *   - a subsequent `send()` sees the already-aborted signal and resolves
   *     an `aborted` result WITHOUT a model call (the loop stops at the
   *     tick-top abort check) — i.e. new work is refused.
   * Threaded by the App from `AppHarnessOptions.signal`. `undefined` when
   * no signal is wired.
   */
  readonly signal?: AbortSignal;
  /**
   * Spawn lineage (SP5) — ancestor session ids, root-first
   * (`[root, …, parent]`). Empty / absent for a root session; its length is
   * this session's spawn depth. Set by the App's `createChildSession` when
   * this session is itself a spawned child. Stamped onto the
   * `SessionRecord`, the loop's execution/tick `EventScope`, and the
   * per-execution handle stream so sub-agent work is attributable.
   */
  readonly spawnPath?: readonly string[];
  /**
   * Spawn depth ceiling (SP4) — the maximum `spawnPath.length` a session
   * may have and still spawn a child. A session already AT this depth
   * throws {@link SpawnDepthExceededError} from `spawn()` (fail-closed —
   * prevents unbounded self-spawn recursion). App-uniform: the App stamps
   * the same value on every session it constructs. Defaults to 10 (v1
   * `MAX_SPAWN_DEPTH` parity). See `AppHarnessOptions.sessions.maxSpawnDepth`.
   */
  readonly maxSpawnDepth?: number;
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
   * Optional tool bridge exposed to the compiler via HookBridges.
   * When supplied, compiler-side tools (e.g. React `createTool`
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
   * Durable session registry (E11). When injected, the session mirrors its
   * metadata into this store off the critical path — an initial record at
   * construction, then on every status transition / execution boundary (async,
   * NO projection: `void store.put(record).catch(...)`, like tasks' persist).
   * Injected app-singleton by the AppHarness (mirrors `TasksHarness.store`);
   * omitted for ephemeral / standalone sessions, which then persist nothing.
   * @see docs/proposals/v2/data-layer-plan.md §E11
   */
  readonly sessionStore?: SessionStore;
  /** Owning app id — stamped on the session's `SessionRecord.appId`. */
  readonly appId?: string;
  /**
   * Stable agent id / name for the `SessionRecord.agentId` slot (1 agent : 1
   * session). Optional — the app passes it when the agent has a stable id.
   */
  readonly agentId?: string;
  /**
   * App-owned descriptive slots seeded onto the initial `SessionRecord`
   * (E11 — the framework STORES these, never populates their semantics). The
   * app may also set them later via {@link SessionHarness.setMeta}.
   */
  readonly title?: string;
  readonly description?: string;
  /**
   * Telemetry runtime (ADR 77 Stage 4 / ADR 78). The app-scoped
   * `ManagedRuntime` built ONCE from the adopter's `telemetry` Layer.
   * The session runs the composed execution (`loop.fx.runExecution`) on
   * it so the whole fiber's `Effect.withSpan` annotations reach the
   * configured tracer — and, because the loop is now one fiber (Stage 3),
   * every downstream span (executor / tool / compiler) nests under the
   * execution span via FiberRef `parentOpId` auto-threading. Forwarded by
   * the AppHarness; `undefined` (standalone / test) → the default runtime,
   * behavior-preserving (no-op tracer).
   */
  readonly telemetryRuntime?: ManagedRuntime.ManagedRuntime<never, never>;
  /**
   * Telemetry enrichment interceptors (rung 1) built by the AppHarness from
   * `createApp({ telemetry })`. Forwarded here so the session folds them into
   * the tier-4 `withCallMiddleware` seam around every send — the ONE path that
   * reaches every op the send touches (ticks, model calls, tool dispatches),
   * across construction-siblings and per-tick-swapped executors alike. Omit /
   * `[]` when telemetry is off (zero overhead). See "Observability" in
   * `@agentick/runtime-next`'s README.
   */
  readonly telemetryMiddleware?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * Whitelabel namespace for telemetry attribute keys (`<ns>.op_id`, …).
   * Forwarded from the app so session/execution spans carry the same
   * prefix as app-edge spans. Defaults to `"agentick"` (BaseHarness).
   */
  readonly telemetryNamespace?: string;
  /**
   * Resolved telemetry provider (ADR 64/78) — its `meter` lights `ctx.metrics`
   * on this session's interceptor ctx (a session/app hook or guard reaching
   * metrics). Forwarded from the app; undefined ⇒ off-path no-op. (`ctx.trace`
   * / `ctx.log` / `ctx.run` need no provider — they ride the ambient runtime +
   * this harness's own emit/runOperation.)
   */
  readonly telemetryProvider?: TelemetryProvider;
  /** Low-cardinality default metric labels (ADR 78) — e.g. `{ app }`. Forwarded from the app. */
  readonly defaultMetricLabels?: Readonly<Record<string, string>>;
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment —
   * structural interception inheritance as a construction-fold). The app's
   * resolved interceptors PLUS the session's declarative `createSession({ hooks
   * })` (adapted to op-scoped middleware), computed once by `createSessionBody`
   * and folded in here. Guards, `.use` transforms, AND command hooks all ride
   * this ONE seam (app-outer, session-inner) — deployment-global concerns
   * wrapping session commands, plus the app+session hook cascade. Forwarded to
   * {@link BaseHarness} for the session's own commands AND onto the per-session
   * bridges (knobs / state / …) via the session's own `resolvedInterceptors()`.
   * Undefined → top-of-tree, inherits nothing.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the AppHarness. The session is
   * constructed by the app and seeded from `app.resolvedInterceptors()`; passing
   * `interceptorParent: app` keeps that live so a LATER `app.use()` /
   * `app.guard()` / `app.hook()` (and gateway hooks, once the gateway links)
   * reaches every session op — the gateway→app→session requirement. Forwarded to
   * {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
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

  private readonly runtime: SessionRuntime;
  private readonly bridges: SessionHookBridges;
  private readonly mountId: string;
  private readonly compiler: CompilerProtocol;
  private readonly loop: LoopExecutorProtocol;
  /**
   * The session-DEFAULT model-executor. Construction-bound, but MUTABLE:
   * `session.model.setModel(...)` (ADR 89 §2) swaps it via the
   * `session:set-model` command. A per-send `input.modelExecutor` still
   * overrides it, and a per-tick `<Model>` (`resolveModel`) still overrides
   * that — `setModel` changes only this default, effective on the NEXT send.
   */
  private modelExecutor: SessionHarnessOptions<P>["modelExecutor"];
  /** The session model selection / swap facade (ADR 89 §2). */
  private readonly modelFacade: SessionModelFacade;
  /**
   * Per-session tool executor. PUBLIC (not the `private` sibling of `loop` /
   * `modelExecutor`) because it is the seam the gateway wire routes
   * `session/set_client_tools` (client-tool declaration) and
   * `session/respond_to_tool_call` (client relay) through — the tool-executor
   * twin of the public `get elicitation()` seam that backs
   * `session/respond_to_elicitation`. The gateway stays harness-agnostic and
   * casts to `ToolExecutorProtocol` structurally at the call site.
   */
  readonly toolExecutor: ToolExecutorProtocol;
  /**
   * The ADR 89 §4 lifecycle projection: the session-registered
   * command-hook forwarders (loop + tool executor, tier 2) plus the
   * per-send `model:generate[_stream]` tier-4 call middleware.
   * `undefined` when the compiler exposes no
   * `LifecycleProjectionTarget` capability. Disposed on {@link close}.
   */
  private readonly lifecycleProjection: LifecycleProjection | undefined;
  /**
   * The ADR 89 §4 TREE-SIDE interceptor forwarder — one tier-4 middleware,
   * added to every send's `withCallMiddleware` list, that at each operation
   * pulls this mount's in-tree `guard`/`transform` interceptors (by `ctx.op`)
   * from the compiler's {@link TreeInterceptionSource}, orders them
   * guards-outermost, and composes them around the op body. So a tree
   * `useGuardToolDispatch` veto / `useTransformModelInput` injection runs
   * IN-PATH on the model's tool + generate calls. `undefined` when the
   * compiler exposes no `TreeInterceptionSource` capability. It rides the
   * SAME one-fiber tier-4 spine the §2 model facade + §4 lifecycle model
   * forwarders use, so it reaches WHICHEVER executor a per-tick `<Model>`
   * swap resolves; per-mount isolation is automatic (it closes over THIS
   * mount's id and pulls only THIS mount's registry).
   */
  private readonly treeInterceptorForwarder: Middleware<unknown, unknown, unknown> | undefined;
  /**
   * The session-DEFAULT execution target. MUTABLE for the same reason as
   * {@link modelExecutor}: `session.model.setModel` / `setTarget` swap it
   * via the `session:set-model` command (ADR 89 §2).
   */
  private target: ExecutionTarget | undefined;
  private readonly spawnContext: SpawnContext<P> | undefined;
  private readonly parentSessionId: string | undefined;
  /**
   * Spawn lineage (SP5) — ancestor session ids, root-first. `[]` for a root
   * session; `length` is this session's spawn depth (the SP4 bound reads it).
   * A child's lineage is `[...this.spawnPath, this.runtime.id]`.
   */
  private readonly spawnPath: readonly string[];
  /** Spawn depth ceiling (SP4). Default 10 (v1 `MAX_SPAWN_DEPTH`). */
  private readonly maxSpawnDepth: number;
  /**
   * Ids of the children THIS session spawned (SP6). Disposed on parent
   * close / construction-signal abort — a spawned child is a parent-owned
   * resource with no independent lifecycle.
   */
  private readonly _children = new Set<string>();
  /**
   * Durable session registry (E11), captured identity (`createdAt` / `appId` /
   * `agentId`), and the app-owned descriptive slots (`title` / `description` /
   * `metadata`) all live on {@link SessionRuntime} now — folded into the
   * single-key `View<SessionRecord>` that subsumed the harness's former
   * hand-rolled `syncSessionRecord` write-through + metadata notifier.
   * {@link setMeta} delegates there.
   */
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
   * Telemetry enrichment interceptors (rung 1), forwarded by the AppHarness
   * when `createApp({ telemetry })` is on. Composed onto the tier-4
   * `withCallMiddleware` seam around every send (see {@link sendBody}) so they
   * reach every op the send touches — ticks, model calls, tool dispatches —
   * INCLUDING a BYO / per-tick-swapped executor the app's construction tree
   * can't reach structurally. Empty (`[]`) when telemetry is off → the tier-4
   * seam short-circuits to a pass-through (zero overhead). See "Observability"
   * in `@agentick/runtime-next`'s README.
   */
  private readonly telemetryMiddleware: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * Whether telemetry enrichment is on (mirrors {@link telemetryMiddleware}
   * non-empty). Gates the rung-2 per-call `SendInput.telemetry` stamp so a
   * stray `telemetry` field on an un-instrumented app registers NO interceptor.
   */
  private readonly telemetryEnabled: boolean;
  /**
   * Single-slot escalation interceptor (ADR 69 T2a). `undefined` =
   * forward/resolve as T1 did (parity); set via `interceptEscalation`.
   */
  private escalationInterceptor: EscalationInterceptor | undefined;
  private readonly defaultMaxTicks: number;
  private readonly defaultStreaming: boolean | undefined;
  /** Model-call narration switch (default `true`). See SessionHarnessOptions.narrate. */
  private readonly narrate: boolean;
  /** Snapshot-migration seam (recovery pass #1). See {@link SnapshotMigration}. */
  private readonly migrateSnapshot: SnapshotMigration | undefined;
  /**
   * Construction-bound abort signal (PA1 — app-signal cascade). Merged
   * into every send's execution signal, so an abort tears down in-flight
   * work and makes subsequent sends resolve `aborted` without a model
   * call. Threaded by the App from `AppHarnessOptions.signal`; also the
   * home of the per-session `CreateSessionInput.signal`. `undefined` when
   * no signal is wired. See {@link SessionHarnessOptions.signal}.
   */
  private readonly constructionSignal: AbortSignal | undefined;

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
   * Per-execution STEER queue (queue-item 4b). A `send({ delivery: "steer" })`
   * that joins an in-flight execution pushes its messages here instead of
   * appending them to the timeline immediately; the loop drains them at the
   * next tick boundary (in {@link notifyLifecycle}) — after the tick's tool
   * results apply, before the next render — so a steer NEVER lands between an
   * assistant `tool_use` and its `tool_result` (which the immediate-append
   * path could do when the steer raced a mid-tick model call). Logically
   * scoped to the current execution: populated only while one runs, and
   * drained / flushed at every tick boundary + at settle.
   */
  private _steerQueue: SendMessageInput[] = [];
  /**
   * FULL-quiesce signal (queue-item 4b — the "settled ≠ agent_end" fix).
   * Resolves in the current send's result `.finally` — AFTER the ADR-49
   * durability barrier (endTurn + flush) AND after the reservation clears and
   * the status returns to idle — NOT at the loop terminal (which fires
   * earlier, inside `_currentExecution`). `whenQuiescent()` and a
   * `delivery: "followUp"` send await this, so a follow-up never fires in the
   * terminal window before the session is truly idle, nor between a run's
   * internal continuations (retry / compaction all live within one loop run).
   * Initialized resolved (idle sessions quiesce immediately).
   */
  private _settled: Promise<void> = Promise.resolve();

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
   * **Options bag** carries everything else: id, agent, compiler,
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
        telemetryProvider: options.telemetryProvider,
        defaultMetricLabels: options.defaultMetricLabels,
        // ADR 76 tier 3 + ADR 83 amendment — the app's resolved interceptor
        // snapshot (incl. the app+session command hooks as op-scoped
        // middleware), folded in at construction so `app.use(...)` /
        // `app.guard(...)` and the declarative hooks structurally wrap every
        // session operation. LIVE via `interceptorParent` (ADR 83 §4) — a later
        // app/gateway registration reaches this session too.
        inheritedInterceptors: options.inheritedInterceptors,
        interceptorParent: options.interceptorParent,
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

    this.runtime = new SessionRuntime({
      id: options.sessionId,
      // E11 durable registry (or `undefined` → no durable mirror). The runtime
      // holds the single-key View over this store; the write-through +
      // metadata-notifier the harness used to hand-roll (`syncSessionRecord` +
      // `subscribeMetadata`) now live inside `view.write`.
      store: options.sessionStore,
      // The harness's scope carrier, threaded on every persisting record write.
      storeCtx: () => this.storeCtx(),
      ...omitUndefined({
        appId: options.appId,
        agentId: options.agentId,
        parentSessionId: options.parentSessionId,
        // SP5 — persist the full lineage on the record (omit for a root).
        spawnPath:
          options.spawnPath && options.spawnPath.length > 0 ? options.spawnPath : undefined,
        title: options.title,
        description: options.description,
        // The adopter's session metadata bag doubles as the record's open
        // over-fetch bag (E11) — one adopter-owned bag, not two.
        metadata: options.metadata as Record<string, unknown> | undefined,
      }),
    });
    // ADR 76 tier 3 — the per-session bridges (knobs/state/…) inherit
    // `session.use()` / `app.use()` via the construction-fold: the session's
    // `resolvedInterceptors()` snapshot is threaded to `buildSessionBridges`
    // below (see `inheritedInterceptors` there). Safe because the bridges are
    // per-session (no cross-session leak).
    this.bridges = buildSessionBridges(
      this.runtime,
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
        // ADR 76 tier 3 + ADR 83 amendment — the session's RESOLVED
        // interceptors (app-inherited incl. the app+session command hooks as
        // op-scoped middleware, plus the session's own), so `session.use()` /
        // `app.use()` AND the `knobs:set` hooks fold the same cascade onto the
        // per-session bridges (knobs / state) built inside `buildSessionBridges`.
        // ADR 83 §4 — `interceptorParent: this` keeps the relation LIVE: a later
        // `session.use()` / `session.guard()` / `session.hook()` reaches the
        // per-session bridges too, not just the construction snapshot.
        inheritedInterceptors: this.resolvedInterceptors(),
        interceptorParent: this,
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

    // Expose optional-extension bridges (registered via `installer.registerNamespace`
    // — sandbox, live, credentials, …) as `session.<name>` getters — the server
    // twin of the ADR-87 client sub-handles. Built-ins keep their explicit typed
    // getters (`get tasks()`, `get elicitation()`); only names NOT already a member
    // are defined, so an extension can never shadow a real one. This is what lets an
    // optional extension's wire method reach its harness server-side
    // (`session.live` in `liveWireExtension`), not just at render time (`bridges.live`).
    const extBridges = options.extensionBridges;
    if (extBridges) {
      for (const name of extBridges.keys()) {
        if (name in this) continue; // never shadow a built-in getter / real member
        Object.defineProperty(this, name, {
          get: () => extBridges.get(name),
          enumerable: false,
          configurable: true,
        });
      }
    }

    this.compiler = options.compiler;
    this.loop = options.loop;
    this.modelExecutor = options.modelExecutor;
    this.toolExecutor = options.toolExecutor;
    this.target = options.target;
    // ADR 89 §2 — the `session.model` facade over the session-default
    // model. `getDefault` reads the live default (so `current` reflects a
    // prior swap); `applySetModel` routes the swap through the journaled +
    // hookable `session:set-model` command. Its `use`/`guard` interceptors
    // ride the tier-4 seam in `sendBody`, so they persist across swaps.
    this.modelFacade = new SessionModelFacade({
      getDefault: () =>
        this.modelExecutor !== undefined && this.target !== undefined
          ? { modelExecutor: this.modelExecutor, target: this.target }
          : undefined,
      applySetModel: (input) => this.runSetModel(input),
      // ADR 89 §2 — the app-injected adapter→executor builder, so
      // `session.model.setModel(openai("gpt-4o"))` matches construction sugar.
      // Absent for a BYO-executor app; the facade throws on an adapter then.
      ...omitUndefined({ buildModelExecutor: options.buildModelExecutor }),
    });
    this.spawnContext = options.spawnContext;
    this.parentSessionId = options.parentSessionId;
    this.spawnPath = options.spawnPath ?? [];
    // Default 10 — v1 `MAX_SPAWN_DEPTH`.
    this.maxSpawnDepth = options.maxSpawnDepth ?? 10;
    this.telemetryRuntime = options.telemetryRuntime;
    this.telemetryMiddleware = options.telemetryMiddleware ?? [];
    this.telemetryEnabled = this.telemetryMiddleware.length > 0;
    this.defaultMaxTicks = options.defaultMaxTicks ?? 8;
    this.requiredScopes = options.requiredScopes;
    this.models = options.models;
    this.defaultStreaming = options.defaultStreaming;
    // Narration defaults ON — the token-cost off-switch is opt-out.
    this.narrate = options.narrate ?? true;
    this.migrateSnapshot = options.migrateSnapshot;
    this.constructionSignal = options.signal;
    this.mountId = `mount:${options.sessionId}`;

    // ADR 89 §4 — the session is the composition root, so IT wires the
    // lifecycle projection: forwarders on the loop's / tool executor's
    // command hooks (tier 2, identity-filtered — the loop is app-shared)
    // route the real command lifecycle into the compiler's per-mount
    // dispatch, and the `model:generate[_stream]` forwarders ride each
    // send as tier-4 call middleware (see sendBody) so a per-tick
    // swapped executor still projects. Absent when the compiler
    // doesn't expose the `LifecycleProjectionTarget` capability.
    // Unsubscribed on close().
    this.lifecycleProjection = wireLifecycleProjection({
      sessionId: options.sessionId,
      mountId: this.mountId,
      compiler: this.compiler,
      loop: this.loop,
      toolExecutor: this.toolExecutor,
    });

    // ADR 89 §4 (tree-side) — the in-path interceptor forwarder. Built once
    // (a stable tier-4 middleware); its per-op PULL from the compiler reflects
    // live tree mount/unmount, so no re-wire per render. Absent when the
    // compiler exposes no `TreeInterceptionSource` capability.
    this.treeInterceptorForwarder = supportsTreeInterception(this.compiler)
      ? buildTreeInterceptorForwarder(this.compiler, this.mountId)
      : undefined;

    // SP6 — spawned-child teardown. A child is a parent-owned resource with
    // no independent lifecycle, so it is disposed when the parent ends:
    //   - parent close  → `onClose` fires `disposeChildren` (LIFO with the
    //     rest of the session's teardown);
    //   - parent abort  → the construction signal firing disposes children
    //     too, so an aborted (but not yet closed) parent leaves no live
    //     sub-sessions in the registry. The child's in-flight WORK is already
    //     torn down independently: its construction signal IS the parent's
    //     (fanned in at spawn), merged into the child's execution signal.
    // The abort listener is `once` (abort fires at most once) and is removed
    // on close so it never outlives the session on a shared app signal.
    this.onClose(() => this.disposeChildren());
    if (this.constructionSignal !== undefined) {
      const sig = this.constructionSignal;
      const onAbort = (): void => {
        void this.disposeChildren();
      };
      sig.addEventListener("abort", onAbort, { once: true });
      this.onClose(() => sig.removeEventListener("abort", onAbort));
    }

    // Open-or-rehydrate (ADR 49 §Hydration): when a durable store was
    // injected, load the session's persisted log into the timeline
    // BEFORE first render — the mount's first render must see the
    // resumed conversation, and Class B state reconstructs from it.
    // Without an injected store there is nothing durable to load
    // (the bundled in-memory default is empty per-construction) and
    // the chain is a resolved promise — zero-cost hot path.
    const hydrated: Promise<void> =
      options.timeline?.store !== undefined ? this.bridges.timeline.hydrate() : Promise.resolve();

    // Eagerly mount — the compiler exposes `.ready` for its own
    // inbox registration; our mount is awaited via `_mountReady`. The
    // element type is opaque here — `MountInput.element: unknown` in
    // the spec — and the bound compiler impl interprets it.
    this._mountReady = hydrated
      .then(() =>
        this.compiler.mount({
          mountId: this.mountId,
          sessionId: options.sessionId,
          element: options.agent,
          bridges: this.bridges,
        }),
      )
      .then(() => {});

    // E11 — the session's durable-registry mirror. The record write-through +
    // the metadata notifier the harness used to hand-roll here
    // (`subscribeMetadata → syncSessionRecord → void store.put(...)`, plus the
    // initial construction upsert) now live INSIDE the runtime's single-key
    // `View<SessionRecord>`: `SessionRuntime` seeds + persists the initial
    // record in its constructor, and every `setStatus` / `setMeta` write-through
    // hits the store via `view.write`. Only a status transition (or `setMeta`)
    // persists; `executionCount` / `currentExecutionId` / `usage` ride the next
    // transition — the same upsert-on-transition contract, unchanged. No store
    // injected ⇒ a NULL_STORE no-op (no durable mirror), exactly as before.
  }

  /**
   * Set the app-owned descriptive slots (`title` / `description` / `metadata`)
   * on this session's durable {@link SessionRecord} (E11). These are the
   * **app's** to populate — the framework STORES them and is blind to their
   * semantics (auto-summary, user-edit, the open over-fetch bag). Provided
   * fields overwrite; omitted fields are left as-is. Delegates to the runtime,
   * which re-writes the record through its view (a NULL_STORE no-op — still
   * updating in-memory slots — when no store is injected).
   */
  setMeta(meta: {
    readonly title?: string;
    readonly description?: string;
    readonly metadata?: Record<string, unknown>;
  }): void {
    this.runtime.setMeta(meta);
  }

  /**
   * Resolves once the underlying compiler mount is complete. Most
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
   * `session/respond_to_elicitation` here.
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

  /**
   * `true` while an execution is reserved or in flight — from the moment
   * `send()` takes its synchronous reservation until the result settles
   * and the `.finally` clears it. The App's registry eviction reads this
   * as the in-flight guard: a session with active work is NEVER evicted
   * (PA2/PA3). Widest-safe window — OR of the synchronous reservation
   * (set before the first `await` in `sendBody`) and the persisted
   * in-flight execution id (cleared in the same `.finally`).
   */
  get hasInFlightExecution(): boolean {
    return this._handleReservation !== null || this.runtime.currentExecutionId() !== null;
  }

  /**
   * Resolve once this session has FULLY quiesced — the in-flight execution
   * (if any) has settled AND its post-terminal durability barrier (endTurn +
   * flush) has run AND the reservation has cleared / status returned to idle.
   * Used by SP6 child disposal so a parent-abort teardown closes the child
   * only AFTER its aborting loop has drained its tick-end lifecycle (closing
   * mid-tick would unmount the compiler out from under the loop →
   * `NotMounted`), and by `delivery: "followUp"` sends to wait for the true
   * idle point before starting a fresh execution.
   *
   * Promoted in queue-item 4b from "await the loop terminal" to "await the
   * result `.finally`" (the {@link _settled} signal): the loop terminal
   * (`_currentExecution`) resolves BEFORE endTurn/flush + reservation clear,
   * so awaiting it alone leaves a window where a follow-up would fire against
   * a still-reserved session — the "settled ≠ agent_end" subtlety. The
   * `while` loop reconverges to idle if a fresh execution began while we
   * awaited (stacked follow-ups serialize to true idle). A no-op when idle
   * (`_settled` starts resolved).
   */
  async whenQuiescent(): Promise<void> {
    await this._settled.catch(() => undefined);
    while (this.hasInFlightExecution) {
      await this._settled.catch(() => undefined);
    }
  }

  // ──────── SessionHarnessProtocol ────────

  send<T = unknown>(input: SendInput<P, T>): Promise<SessionExecutionHandle<T>> {
    // The internal pipeline (sendBody, the deferred, the handle) is erased to
    // `unknown` data; the boundary cast narrows what the send path's schema
    // validation guarantees (`data` conforms to `input.output` or `.result`
    // rejects typed) — the same one-boundary cast skills.run makes.
    return runHarnessProtocol(
      this.sessionOp("send", input, (i) =>
        Effect.tryPromise({
          try: () => this.sendBody(i),
          catch: (cause): SessionError => coerceSessionError(cause),
        }),
      ),
    ) as Promise<SessionExecutionHandle<T>>;
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

  /**
   * The session's model selection / swap facade (ADR 89 §2) — NOT a
   * harness, a thin projection of the session-default model the session
   * already owns.
   *
   *   - `session.model.setModel(model)` / `setTarget(target)` — swap the
   *     session-default `RegisteredModel` (journaled + hookable via the
   *     `session:set-model` command). Effective on the NEXT send.
   *   - `session.model.use(...)` / `.guard(...)` — session-scoped
   *     interceptors on the `model:generate[_stream]` commands that
   *     PERSIST across `setModel` swaps (they ride the tier-4 call
   *     middleware seam threaded in {@link sendBody}, not any executor
   *     instance).
   */
  get model(): ModelSelectionHandle {
    return this.modelFacade;
  }

  snapshot(): Promise<SessionSnapshot> {
    // Recovery pass #1 — `session:snapshot` command. `onBeforeSessionSnapshot`
    // (veto) + `onAfterSessionSnapshot` (augment/redact the output — the v1
    // `onPersist` parity) fire around the sync capture.
    return runHarnessProtocol(
      this.sessionOp("snapshot", {} as CaptureSnapshotInput, () =>
        Effect.sync((): SessionSnapshot => this.captureSnapshot()),
      ),
    );
  }

  /**
   * Step 6 (ADR 27) — the generic per-harness fold. Composes the session
   * shape from every {@link SnapshotCapable} bridge's `exportSnapshot()`,
   * feature-detected (no hardcoded slot names), exactly mirroring the
   * channel {@link snapshotProviders} scan and the compiler's
   * `captureBridgeSnapshots`. A new SnapshotCapable extension bridge is
   * picked up automatically — no session change.
   */
  private captureSnapshot(): SessionSnapshot {
    const bridges: Record<string, unknown> = {};
    for (const [name, bridge] of Object.entries(this.bridges)) {
      if (isSnapshotCapable(bridge)) bridges[name] = bridge.exportSnapshot();
    }
    return {
      specVersion: SPEC_VERSION,
      id: this.runtime.id,
      status: this.runtime.status(),
      currentTick: this.runtime.currentTick(),
      bridges,
      usage: this.runtime.usage(),
      ...omitUndefined({ parentSessionId: this.parentSessionId }),
    };
  }

  restore(input: RestoreSnapshotInput): Promise<void> {
    // Recovery pass #1 — `session:restore` command. `onBeforeSessionRestore`
    // + `onAfterSessionRestore` fire around the fan-out; migration runs at
    // the version-check decision point inside the body.
    return runHarnessProtocol(
      this.sessionOp("restore", input, (i) =>
        Effect.tryPromise({
          try: () => this.restoreBody(i),
          catch: (cause): SessionError => coerceSessionError(cause),
        }),
      ),
    );
  }

  /**
   * Restore a {@link SessionSnapshot} into this live session (Step 6
   * symmetric fan-out). Order:
   *   1. migration seam — if `snapshot.specVersion` ≠ `SPEC_VERSION`, run
   *      the construction-bound `migrateSnapshot` callback (or throw
   *      `SnapshotVersionMismatch` when none is set — fail-closed).
   *   2. bridge fan-out — for every entry in `snapshot.bridges`, if the
   *      live bridge by that name is {@link SnapshotCapable}, `importSnapshot`
   *      it. Async-aware (timeline's import is a Promise); awaited together.
   *   3. accounting — restore the execution-local tick + aggregate usage.
   */
  private async restoreBody(input: RestoreSnapshotInput): Promise<void> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "restore" });
    }
    await this._mountReady;

    let snap = input.snapshot;
    if (snap.specVersion !== SPEC_VERSION) {
      if (this.migrateSnapshot === undefined) {
        throw new SnapshotVersionMismatch({ from: snap.specVersion, to: SPEC_VERSION });
      }
      snap = await this.migrateSnapshot(snap, { from: snap.specVersion, to: SPEC_VERSION });
    }

    // Generic fan-out — feature-detected, no hardcoded slot names.
    const bag = this.bridges as unknown as Record<string, unknown>;
    const pending: Promise<unknown>[] = [];
    for (const [name, value] of Object.entries(snap.bridges)) {
      if (value === undefined) continue;
      const bridge = bag[name];
      if (isSnapshotCapable(bridge)) {
        const result = bridge.importSnapshot(value);
        if (result instanceof Promise) pending.push(result);
      }
    }
    if (pending.length > 0) await Promise.all(pending);

    // Accounting — restore tick + usage (the session identity the bridge
    // fold doesn't carry). Status is NOT forced: a restored session resumes
    // under its own lifecycle, not the snapshot's captured phase.
    this.runtime.setTick(snap.currentTick);
    this.runtime.setUsage(snap.usage);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.runtime.setStatus("closed" as never);
    // ADR 89 §4 — unhook the lifecycle forwarders from the (app-shared)
    // loop + tool executor before the mount goes away.
    this.lifecycleProjection?.dispose();
    // Tear down the compiler mount; ignore errors during shutdown.
    try {
      await this.compiler.unmount({ mountId: this.mountId });
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
  // HOOK SCOPE (ADR 83): the `*Fx` twins are what the LOOP composes in-fiber
  // (ADR 77 Stage 3) — deliberately UNWRAPPED, so the loop's hot per-tick result
  // application is not re-wrapped in a `runOperation`. Consequently the
  // `apply-executor-result` / `apply-tool-results` hooks fire on the PUBLIC
  // facade (a direct `session.applyExecutorResult(...)` call), NOT on the loop's
  // internal application. `send` / `append` (user-facing) hooks fire always.
  // Lighting up the loop path would mean wrapping the Fx twins — a follow-up
  // that must preserve the ADR-77 in-fiber composition.
  private applyExecutorResultFx(
    input: ApplyExecutorResultInput,
  ): Effect.Effect<ApplyResult, StateApplyError, never> {
    return Effect.tryPromise({
      try: () => this.applyExecutorResultBody(input),
      catch: (cause): StateApplyError => new TimelineWriteFailed({ cause }),
    });
  }

  applyExecutorResult(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      this.sessionOp("apply-executor-result", input, (i) => this.applyExecutorResultFx(i)),
    );
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
    return runHarnessProtocol(
      this.sessionOp("apply-tool-results", input, (i) => this.applyToolResultsFx(i)),
    );
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      this.sessionOp("append", input, (i) =>
        Effect.tryPromise({
          try: () => this.appendEntryBody(i),
          catch: (cause): StateApplyError => new TimelineWriteFailed({ cause }),
        }),
      ),
    );
  }

  async notifyLifecycle(input: NotifyTickEndInput): Promise<TickEndForwardDecision> {
    // The session's continuation decision (ADR 67). The loop calls this
    // AFTER the compiler tick-end has settled the tree, with the settled
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

    // (b') Drain the per-execution STEER queue (queue-item 4b). Steers
    // enqueued during THIS tick (by a concurrent `send({ delivery: "steer" })`)
    // are appended to the timeline NOW — after the tick's tool results applied
    // (loop `tickBody` step 4) and BEFORE the next render — so the next tick's
    // compile sees them positioned AFTER this tick's assistant output +
    // tool_results, preserving `tool_use`/`tool_result` adjacency. This bumps
    // `inputEntryCount`, so the (c) steering predicate below fires and holds
    // the loop open for another tick to answer the steer.
    await this.drainSteerQueue();

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
    // SP4 — fail closed at the depth ceiling. A session whose lineage is
    // already `maxSpawnDepth` deep cannot spawn a deeper child; this is the
    // guard against an agent recursively spawning itself into a stack blow-up.
    if (this.spawnPath.length >= this.maxSpawnDepth) {
      throw new SpawnDepthExceededError({
        depth: this.spawnPath.length,
        maxDepth: this.maxSpawnDepth,
      }) satisfies SessionError;
    }
    const childInput = {
      parentSessionId: this.runtime.id,
      agent: input.agent,
      // SP5 — extend the lineage: the child's ancestry is ours plus our id.
      spawnPath: [...this.spawnPath, this.runtime.id],
      ...omitUndefined({
        sessionId: input.sessionId,
        metadata: input.metadata,
        initialProps: input.initialProps,
        initialKnobs: input.initialKnobs,
        maxTicks: input.maxTicks,
        // SP6 — fan our construction signal into the child so a parent abort
        // tears down the child's in-flight work (PA1 merge-into-execution).
        signal: this.constructionSignal,
      }),
    };
    const child = await this.spawnContext.createChildSession(childInput);
    // SP6 — track the child so parent close / abort disposes it (see the
    // teardown wired in the constructor). Idempotent on the child id.
    this._children.add(child.id);
    if (input.send !== undefined) {
      return child.send(input.send);
    }
    return child;
  }

  /**
   * SP6 — dispose every child this session spawned, routing through the
   * app's `SpawnContext.disposeChildSession` (registry removal +
   * `session.close()`) so nothing leaks. Best-effort and idempotent: the set
   * is drained first (so a re-entrant close is a no-op), unknown ids are a
   * no-op on the app side, and a failure disposing one child does not block
   * the rest. Children dispose their OWN children transitively, so the whole
   * sub-tree collapses.
   */
  private async disposeChildren(): Promise<void> {
    if (this._children.size === 0 || this.spawnContext === undefined) return;
    const ids = [...this._children];
    this._children.clear();
    const ctx = this.spawnContext;
    await Promise.all(
      ids.map((id) =>
        Promise.resolve(ctx.disposeChildSession(id)).catch(() => {
          // best effort — an already-disposed / unknown child is fine
        }),
      ),
    );
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
      context: { via: "dispatch", sessionId: this.runtime.id },
      ...(options?.task !== undefined ? { task: options.task } : {}),
    });
    return result.content;
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    const fullName = `session:channel:${name}`;
    const sessionId = this.runtime.id;
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
      scope: { sessionId: this.runtime.id },
      payload,
    };
  }

  /**
   * Build (once) the `channel → ChannelSnapshotProvider` index by scanning the
   * session's owned harnesses for one passing {@link isChannelSnapshotProvider}.
   * No hardcoded slot list — any harness that conforms is discovered
   * generically (mirrors the SnapshotCapable feature-detection pattern).
   *
   * The candidate set is every bridge value PLUS `this.toolExecutor`: the tool
   * executor is a session-owned harness held OUTSIDE `bridges` (the `tools`
   * bridge slot is a render-time handler-resolver adapter, not the executor),
   * yet it OWNS the `tool_call` request channel and provides its pending-call
   * snapshot (§6.1). Feature-detection still keeps the scan slot-agnostic — the
   * executor is just another candidate, discovered by shape.
   */
  private snapshotProviders(): Map<string, ChannelSnapshotProvider> {
    if (this._snapshotProviders === null) {
      const map = new Map<string, ChannelSnapshotProvider>();
      const candidates: readonly unknown[] = [...Object.values(this.bridges), this.toolExecutor];
      for (const value of candidates) {
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

  // ADR 51 — session verbs: HOOKABLE, but NON-ADDRESSABLE (resolved).
  //
  //   RESOLVED (this change): the four public session verbs — `send`,
  //   `applyExecutorResult`, `applyToolResults`, `appendEntry` — NOW route
  //   through `runOperation` via `sessionOp`, so the ADR-83 interceptor seam
  //   (guards / `.use()` middleware / command hooks) and the full phase
  //   contract (`requested` → `before` → terminal) fire around each. They are
  //   declared in the `CommandRegistry` augmentation at the top of this file,
  //   minting `onBeforeSessionSend` / `onAfterSessionSend` (etc.). This closes
  //   the "commands don't currently go through runOperation" gap the
  //   base-harness §`use` note flagged for the session surface.
  //
  //   STILL OPEN — wire addressability. These ops remain the in-process door
  //   only: `SendInput` carries non-serializable per-call overrides
  //   (`executor`, `target`, `signal`, tool registrations with LIVE handlers)
  //   which, by ADR 51 §1.2, cannot cross the wire. A wire-addressable
  //   `session:send` needs a DESIGNED serializable input subset (`messages` +
  //   `maxTicks` + `stream` — the porcelain the wire's `session/send` already
  //   carries), the same move as `timeline:compact`'s signal form. That
  //   remains future work; no wire `CommandDescriptor` is declared for these.
  //   `session:dispatch` (name + JSON input) is fully serializable and is the
  //   natural first wire declaration when that pass lands.
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
    // TASK-WAKE — a backgrounded task completed UNOBSERVED and synthesizes a
    // follow-up send into this session (its owning session). Fire-and-forget
    // (tell): the tasks harness `send`s this, does not `ask`.
    if (msg.type === SESSION_TASK_WAKE_MESSAGE_TYPE) {
      return this.handleTaskWake(msg as MessageEnvelope<SessionTaskWakePayload>);
    }
    return Effect.fail(
      new HandlerError({ cause: new Error("session inbox dispatch not yet wired (Phase 4e+)") }),
    );
  }

  /**
   * Turn a task-completion wake into a real execution (TASK-WAKE seam). The
   * wake rides the NORMAL send path — `session.send(...)` — so it is journaled,
   * hooked, and streamed like any turn; nothing bespoke. Queue-vs-run is
   * `send`'s own concern: if an execution is already running, `send` STEERS
   * (appends the wake message to the in-flight turn — no collision); if idle,
   * it starts a fresh execution.
   *
   * Provenance is stamped AUTHORITATIVELY here — `source: "task-wake"` +
   * `taskId` on both the execution-level `metadata` and every wake message's
   * `metadata` — regardless of whether a callable wake policy set it, so
   * timelines/clients always attribute the synthesized turn correctly.
   *
   * Fire-and-forget: we `await send(...)` only to the point the handle is
   * created (queued/started), NOT `.result` — the model reacts on its own
   * timeline. A send failure (e.g. the session is mid-close) surfaces via the
   * inbox tell-error path, not back to the task.
   */
  private handleTaskWake(
    msg: MessageEnvelope<SessionTaskWakePayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        const payload = msg.payload;
        if (payload === undefined) return undefined;
        const { taskId, send } = payload;
        const provenance = { source: TASK_WAKE_SOURCE, taskId };
        const stamped: SendInput<P> = {
          ...(send as SendInput<P>),
          metadata: { ...send.metadata, ...provenance },
          messages: (send.messages ?? []).map((m) => ({
            ...m,
            metadata: { ...m.metadata, ...provenance },
          })),
        };
        await this.send(stamped);
        return undefined;
      },
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
    });
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

  /**
   * Route a session verb's body through {@link BaseHarness.runOperation} so it
   * fires the ADR-83 interceptor seam (guards / `.use()` middleware / command
   * hooks) and the full phase contract (`requested` → `before` → terminal),
   * exactly as every other harness command does. Mints a fresh `opId` per call
   * (`session:<verb>:<ulid>`) — session verbs carry no caller-supplied
   * idempotency key, so no replay: each invocation is its own operation. The
   * op `name` follows the executor's convention (`<surface>:command:<verb>`),
   * which {@link deriveHookNames} strips to the `session:<verb>` CommandRegistry
   * key.
   *
   * The `body` Effect is UNCHANGED from the pre-wrap surface — the same
   * `Effect.tryPromise` over the verb's `*Body` (or its composable `*Fx` twin),
   * with its own error-coercion preserved. Wrapping is purely additive: with no
   * guards/hooks registered, `runOperation` composes to a pass-through around
   * the identical body.
   */
  private sessionOp<I, R, E>(
    verb: string,
    input: I,
    body: (i: I) => Effect.Effect<R, E, never>,
  ): Effect.Effect<R, E | SubstrateError, never> {
    const op: Operation<I, R, E> = {
      opId: `session:${verb}:${ulid()}`,
      surface: "session",
      name: `session:command:${verb}`,
      scope: { sessionId: this.scopeId },
      input,
    };
    return this.runOperation(op, body);
  }

  /**
   * Run the `session:set-model` command (ADR 89 §2) — the journaled +
   * hookable swap of the session-default model. Routes through
   * {@link sessionOp} exactly like `send` / `append`, so
   * `onBeforeSessionSetModel` (policy veto) + journaling fire around it.
   * The body is a pure sync mutation of {@link modelExecutor} /
   * {@link target}; a closed session rejects with `SessionClosedError`
   * (via `Effect.suspend` so the guard is a rejection, not a sync throw).
   */
  private runSetModel(input: SetModelInput): Promise<void> {
    return runHarnessProtocol(
      this.sessionOp("set-model", input, (i) =>
        Effect.suspend((): Effect.Effect<void, SessionError, never> => {
          if (this._closed) {
            return Effect.fail(new SessionClosedError({ attemptedCommand: "set-model" }));
          }
          this.applySetModelBody(i);
          return Effect.void;
        }),
      ),
    );
  }

  /**
   * Apply a `session:set-model` swap to the session default (ADR 89 §2).
   * `setModel` supplies `modelExecutor` + `target`; `setTarget` supplies
   * only `target` (keep the current runner). Effective on the next send —
   * `sendBody` reads `input.modelExecutor ?? this.modelExecutor` fresh.
   */
  private applySetModelBody(input: SetModelInput): void {
    if (input.modelExecutor !== undefined) this.modelExecutor = input.modelExecutor;
    this.target = input.target;
  }

  /**
   * Build the rung-2 per-call telemetry interceptor from `SendInput.telemetry`
   * (functionId + metadata). Composition over rung 3: it is a single
   * {@link spanAttributes} instance stamping `<ns>.function_id` +
   * `<ns>.metadata.<key>` on every op the send touches. Returns `[]` — no
   * interceptor — when telemetry enrichment is off OR the field is absent OR it
   * carries no stampable value, so an un-instrumented send pays nothing.
   * `functionId`'s app-name DEFAULT is supplied by rung 1 (the app enrichment);
   * this stamp, composed innermost, OVERRIDES it when a per-call id is given.
   */
  private buildSendTelemetryMiddleware(
    telemetry: SendTelemetry | undefined,
  ): readonly Middleware<unknown, unknown, unknown>[] {
    if (!this.telemetryEnabled || telemetry === undefined) return [];
    const ns = this.telemetryNamespace;
    const attrs: Record<string, unknown> = {};
    if (telemetry.functionId !== undefined) attrs[`${ns}.function.id`] = telemetry.functionId;
    for (const [k, v] of Object.entries(telemetry.metadata ?? {})) {
      attrs[`${ns}.metadata.${k}`] = v;
    }
    if (Object.keys(attrs).length === 0) return [];
    return [spanAttributes(() => attrs)];
  }

  private async sendBody(input: SendInput<P>): Promise<SessionExecutionHandle> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "send" });
    }
    // Structured final turn (trail-response-format-send) — the declarative,
    // wire-safe `responseFormat` directive. Overlaid onto every tick's
    // compiled config by the loop (explicit-beats-ambient over tree/model
    // config).
    const effectiveResponseFormat: ResponseFormat | undefined = input.responseFormat;

    // Structured final turn — the LIVE-schema `output` sugar (§B2). Derive the
    // OutputSpec (schema RETAINED here for validation at result assembly — the
    // wire never carries it) and thread it to the loop, which resolves the
    // delivery strategy, injects the terminal tool / responseFormat overlay,
    // and captures the RAW answer. `submit_result` is the default terminal
    // name; `"auto"` lets the loop pick tool-vs-responseFormat at tick 1. A
    // tree-level `<Output>` is the fallback (resolved in the loop) — send-level
    // wins here.
    const outputSpec: OutputSpec | undefined =
      input.output !== undefined
        ? { toolName: "submit_result", schema: input.output, strategy: "auto" }
        : undefined;

    // Delivery mode (queue-item 4b). Default `"steer"` = today's ADR 53 §5
    // join behavior; `"followUp"` = wait for the session to fully quiesce,
    // then run a fresh execution (never joins the in-flight turn).
    const delivery = input.delivery ?? "steer";

    if (delivery === "followUp") {
      // FOLLOW-UP: block until the session is truly idle (the in-flight
      // execution AND its durability barrier + reservation clear — the
      // promoted `whenQuiescent`, which reconverges through stacked
      // executions), then fall through to the fresh-execution path below.
      // With no execution running this returns immediately — identical to a
      // normal send. `whenQuiescent` leaves the reservation null, so the STEER
      // join guard below is skipped synchronously (no interleaving window).
      await this.whenQuiescent();
    } else {
      // STEER / JOIN semantics (ADR 53 §5): a send() while an execution is
      // running STEERS the in-flight turn — enqueue the messages onto the
      // per-execution steer queue (drained at the next tick boundary in
      // `notifyLifecycle`, so the model sees them next tick via the
      // continuation predicate + <Timeline/>) and return the in-flight
      // handle. The reservation check is SYNCHRONOUS (before any await) so
      // concurrent fresh sends cannot both pass it; a terminal-window send
      // (loop settled, cleanup pending) is NOT joinable — it waits out the
      // old execution and runs fresh (degrading to a normal send, exactly
      // like a steer with no execution running).
      while (this._handleReservation !== null) {
        if (!this._loopDone) {
          const reservation = this._handleReservation;
          const handle = await reservation.promise;
          // Re-check: the loop may have settled while we awaited the
          // reservation — a dead handle must not be joined.
          if (!this._loopDone) {
            // A JOIN carries ONLY its messages into the in-flight turn — it
            // starts no new execution, so it has no final turn of its own to
            // shape. Reject a structured-output-carrying steer (`responseFormat`
            // OR the live `output` schema) loud rather than silently dropping
            // the directive or auto-upgrading delivery.
            if (input.responseFormat !== undefined || input.output !== undefined) {
              throw new SteerCannotCarryStructuredOutput();
            }
            // ENQUEUE (not append): the steer lands at the next tick boundary,
            // after this tick's tool results, before the next render — the
            // adjacency-safe injection point (queue-item 4b).
            for (const m of input.messages ?? []) this._steerQueue.push(m);
            return handle;
          }
        }
        // Terminal window: wait for the previous execution's cleanup
        // (.finally clears the reservation), then run fresh.
        await (this._currentExecution ?? Promise.resolve()).catch(() => {});
        await Promise.resolve(); // let .finally clear the reservation
        if (this._handleReservation === null) break;
      }
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

    // FULL-quiesce deferred (queue-item 4b). Created SYNCHRONOUSLY with the
    // reservation so `hasInFlightExecution` and `_settled` flip together
    // (no window where the session looks busy but `_settled` is still the
    // prior resolved promise). Resolved in the result `.finally` below, after
    // endTurn/flush + reservation clear — the true idle point a follow-up
    // waits for.
    let settledResolve!: () => void;
    this._settled = new Promise<void>((r) => {
      settledResolve = r;
    });
    // Undrained-steer disposition (queue-item 4b). A steer enqueued in the
    // terminal window (after the final tick-boundary drain, before `_loopDone`
    // latches) is never drained by the loop. Captured at settle: on a NORMAL
    // end it is re-dispatched as a fresh follow-up send (lossless — the caller
    // was told the join succeeded); on abort/cancel/error/close it is dropped
    // (see the settle handlers).
    let redispatchSteers: SendMessageInput[] | null = null;

    await this._mountReady;

    // Input appends the moment it arrives (ADR 53 §2.1) — no queue, no
    // drain. The first tick's render sees it via <Timeline/>.
    for (const m of input.messages ?? []) await this.appendInputMessage(m);

    // ADR 53: the first render will include everything appended so far.
    this._inputEntriesSeen = this.bridges.timeline.inputEntryCount();
    this._executionUsage = undefined;

    const executionId = `exec:${ulid()}`;
    // E11 accounting: bump the execution count + set the in-flight id BEFORE
    // `setStatus("running")`. The count / id updates are cache-only on the
    // runtime's view; the `setStatus` write-through then persists ONE record
    // capturing the full execution-start delta (count + currentExecutionId +
    // running) — the upsert-on-transition contract.
    this.runtime.bumpExecutionCount();
    this.runtime.setCurrentExecutionId(executionId);
    this.runtime.setStatus("running");

    // Per-call overrides — model-executor + target — fall through from
    // SendInput. The app-level model-executor/target is the default;
    // this send swaps in caller-supplied alternatives without changing
    // session state.
    const modelExecutorForCall = input.modelExecutor ?? this.modelExecutor;
    const targetForCall = input.target ?? this.target;

    // Resolve streaming preference. Cascade:
    //   SendInput.stream  >  session-level streaming default
    //                     >  executor capability default
    // The capability default is true when both:
    //   - the executor exposes `executeStream`
    //   - target.capabilities.supportsStreaming is not explicitly false
    // Both slots may be undefined on a model-less session — the loop enforces
    // the presence of a model at the per-tick resolution point (respecting the
    // per-tick `<Model>` cascade), so here we only compute a capability default
    // when a model-executor + target are actually present.
    const capabilityStreamDefault =
      typeof modelExecutorForCall?.executeStream === "function" &&
      (targetForCall?.capabilities?.supportsStreaming ?? true);
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
      this.runtime.setCurrentExecutionId(null);
      this.runtime.setStatus(durabilityFailed ? "failed" : "idle");
      // 4b — the session is now truly idle. Release quiescence waiters
      // (`whenQuiescent` / follow-up sends) AFTER the reservation clears.
      settledResolve();
      // 4b — re-dispatch any undrained steers as a fresh follow-up turn.
      // Deferred to a microtask so the reservation is observably clear
      // before the new send runs (it would otherwise re-enter the join
      // guard against the dying handle). Dropped if the session is closing.
      if (redispatchSteers !== null && !this._closed) {
        const msgs = redispatchSteers;
        redispatchSteers = null;
        queueMicrotask(() => {
          if (this._closed) return;
          void this.send({ messages: msgs, delivery: "followUp" }).catch(() => undefined);
        });
      }
    });
    resultPromise.catch(() => {
      // Prevent unhandled rejections — handle has its own .result.
    });

    const { handle, emit, close } = createSessionExecutionHandle({
      sessionId: this.runtime.id,
      executionId,
      // SP5 — the caller's handle stream carries the lineage too.
      ...(this.spawnPath.length > 0 ? { spawnPath: this.spawnPath } : {}),
      resultPromise,
      abort: async (reason) => {
        await this.loop.abort({ executionId, ...(reason !== undefined ? { reason } : {}) });
      },
    });

    // The run-execution event sink (streaming-up, ADR 51 §2): the session
    // consumes the `loop:run-execution` command's `.fx` sink-fold face. Each
    // `LoopExecutionEvent` chunk maps through `buildOnEvent` (the SAME
    // partial-StreamEvent → handle-queue projection as before) wrapped in an
    // `Effect.sync` so it drains IN the loop's fiber (in-order, no queue). This
    // is the ONE event channel — the retired `RunExecutionInput.onEvent`
    // push-callback is gone.
    const onEvent = this.buildOnEvent(emit);
    const loopSink = (event: LoopExecutionEvent): Effect.Effect<void> =>
      Effect.sync(() => onEvent(event));

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
      //
      // ADR 89 §4 — the `model:generate[_stream]` lifecycle forwarders
      // ride THIS call as tier-4 call-scoped middleware (`withCall
      // Middleware`): the one-fiber spine threads them into every nested
      // `runOperation` the send touches, so the projection reaches
      // WHICHEVER model-executor instance runs a tick — including a
      // per-tick `<Model>`-swapped executor (ADR 56) the session's
      // interceptor tree can't reach structurally. Empty list (no
      // projection target) is a pass-through.
      () =>
        runHarnessProtocol(
          withCallMiddleware(
            // ADR 89 §2 + §4 — two tier-4 seams ride each send: the §4
            // `model:generate[_stream]` lifecycle forwarders (observe) AND
            // the §2 `session.model` interceptors (use/guard). Both reach
            // WHICHEVER executor runs a tick (per-tick `<Model>` swap OR a
            // `setModel` swap) via the one-fiber spine — the §2 interceptors
            // live on the facade, so they persist across `setModel`.
            [
              ...(this.lifecycleProjection?.callMiddleware ?? []),
              ...this.modelFacade.callMiddleware(),
              // ADR 89 §4 (tree-side) — the in-path interceptor forwarder:
              // ONE tier-4 middleware that pulls this mount's tree
              // guards/transforms per op (`ctx.op`) and composes them around
              // the body, so a `<ToolGate>` veto / `useTransformModelInput`
              // injection runs on the model's real tool + generate calls.
              ...(this.treeInterceptorForwarder ? [this.treeInterceptorForwarder] : []),
              // Telemetry rung 1 — the app-level enrichment (span attrs +
              // usage/cost), empty when telemetry is off. Composed over the
              // same one-fiber seam so it reaches every op the send touches.
              ...this.telemetryMiddleware,
              // Telemetry rung 2 — per-call `SendInput.telemetry` (functionId +
              // metadata), stamped INNERMOST so it overrides rung 1's app-name
              // functionId default. Only when enrichment is on (else a stray
              // `telemetry` field registers nothing — zero overhead).
              ...this.buildSendTelemetryMiddleware(input.telemetry),
            ],
            this.loop.fx.runExecution(
              {
                executionId,
                sessionId: this.runtime.id,
                // SP5 — stamp the spawn lineage on the execution scope so every
                // tick / model / tool envelope is attributable to this sub-agent.
                ...(this.spawnPath.length > 0 ? { spawnPath: this.spawnPath } : {}),
                compiler: this.compiler,
                mountId: this.mountId,
                modelExecutor: modelExecutorForCall,
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
                  // Model-less send: no fallback target to project. The tree may
                  // still declare a per-tick `<Model>`, but that resolves
                  // POST-render (chicken-and-egg, see the loop's ADR-56 notes),
                  // so `activeModel`/`contextInfo` are simply absent this render.
                  if (targetForCall === undefined) return {};
                  const contextWindow = effectiveModelInfo(
                    targetForCall,
                    this.models,
                  )?.contextWindow;
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
                // fallback (this.modelExecutor/target via modelExecutorForCall/
                // targetForCall) covers the undeclared case.
                resolveModel: (ref) => this.bridges.models.resolve(ref),
                maxTicks: input.maxTicks ?? this.defaultMaxTicks,
                // Pass B — the model-narration switch gates `_summary` schema
                // injection at the projection site. Session default (from the
                // app-level cascade); the projector defaults ON if unset.
                narrate: this.narrate,
                stream: streamForCall,
                // trail-response-format-send — the send-level structured
                // directive (explicit `responseFormat`, or the normalized live
                // `output` schema). The loop overlays it onto each tick's
                // compiled config, spread LAST (explicit-beats-ambient).
                ...(effectiveResponseFormat !== undefined
                  ? { responseFormat: effectiveResponseFormat }
                  : {}),
                // §B2 — the live-schema `output` sugar. The loop resolves the
                // strategy + injects the terminal tool / responseFormat
                // overlay; the raw capture rides `ExecutionRunResult
                // .terminalCapture`, validated to `data` at result assembly.
                ...(outputSpec !== undefined ? { outputSpec } : {}),
                // Stage 5 — per-send tool concurrency (default "unbounded" in
                // the loop) + optional execution timeout, both opt-in.
                ...omitUndefined({
                  // PA1 — the app-signal cascade. Merge the construction
                  // signal (app / per-session) with this call's signal into
                  // the ONE live execution signal the loop honors. An
                  // already-aborted merge means the loop stops at its tick-top
                  // abort check (no model call); a mid-run abort tears down
                  // the in-flight execution.
                  signal: mergeAbortSignals(this.constructionSignal, input.signal),
                  toolConcurrency: input.toolConcurrency,
                  timeoutMs: input.timeoutMs,
                }),
                // The event sink — the SECOND `fx.runExecution` arg (the
                // `commandStream` `.fx` sink-fold face). Events drain in-fiber,
                // in emission order, on the loop's own fiber.
              },
              loopSink,
            ),
          ),
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
        // 4b — the loop has terminated, so no more tick-boundary drains will
        // run: whatever remains in the steer queue is UNDRAINED. On a normal
        // end (`succeeded` — also covers executor_failed / max_ticks, which
        // still complete a real turn) re-dispatch it as a fresh follow-up
        // (lossless; the joining caller was told delivery succeeded). On
        // cancel / abort / timeout (`outcome !== "succeeded"`) DROP it — an
        // explicit stop voids the steer's premise; resurrecting it as a new
        // turn would contradict the abort.
        if (this._steerQueue.length > 0) {
          const undrained = this._steerQueue;
          this._steerQueue = [];
          if (terminal.outcome === "succeeded") redispatchSteers = undrained;
        }
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
          // 4b — the session diverged from its durable log and lands "failed".
          // Do NOT re-dispatch undrained steers into a failed session.
          redispatchSteers = null;
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
          // §B3 — structured-output `data`. The LOOP is the validation
          // authority (it holds the resolved schema — send-level `input.output`
          // OR a tree-level `<Output>` the session never sees), so it validates
          // the capture / final text and surfaces the VALIDATED value on
          // `result.data`; a schema that isn't met fails the execution with the
          // typed `ResponseValidationError` loop-side (the onRejected branch
          // below rejects `handle.result`). The session lifts `result.data`
          // verbatim — present for BOTH the send-level `output` sugar AND a
          // tree-only `<Output>` (the dedicated-extraction-agent story).
          const sendResult: SendResult = {
            response,
            output: result.output,
            toolResults: result.toolResults,
            usage: result.usage,
            stopReason: result.stopReason,
            ticks: result.ticks,
            executionId,
            ...(result.data !== undefined ? { data: result.data } : {}),
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
        // 4b — the execution errored: drop any undrained steers (there is no
        // successful turn they could have steered, and the caller's `.result`
        // rejects). No re-dispatch.
        this._steerQueue = [];
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
   * Translate a `LoopExecutionEvent` into the public StreamEvent shape
   * and push it onto the handle's iterator queue. The mapping half of the
   * run-execution event sink (`loopSink` in {@link sendBody} wraps this in
   * an `Effect.sync` for the `commandStream` `.fx` face).
   */
  private buildOnEvent(
    emit: (event: SessionEmitInput) => void,
  ): (event: LoopExecutionEvent) => void {
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
    this.runtime.addUsage(input.result.usage);
    this.runtime.bumpTick();
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
   * Drain the per-execution steer queue (queue-item 4b) — append every
   * queued steer message to the timeline, in enqueue order, via the same
   * {@link appendInputMessage} path a fresh send uses (so string/blocks +
   * metadata normalize identically). Swaps the buffer out FIRST so a steer
   * that arrives while we await the appends lands in the next drain, not this
   * one. A no-op when the queue is empty (the hot per-tick path).
   */
  private async drainSteerQueue(): Promise<void> {
    if (this._steerQueue.length === 0) return;
    const pending = this._steerQueue;
    this._steerQueue = [];
    for (const m of pending) await this.appendInputMessage(m);
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

/**
 * Build the ADR 89 §4 tree-side interceptor forwarder — ONE stable tier-4
 * middleware that, at each operation, PULLS this mount's in-tree
 * `guard`/`transform` interceptors (keyed by the ambient op tag `ctx.op`)
 * from the compiler's {@link TreeInterceptionSource}, orders them
 * guards-outermost ({@link orderInterceptors}), and composes them around the
 * op body ({@link composeMiddleware}). Empty pull → straight to `next`
 * (zero overhead for ops the tree doesn't intercept). The PULL-per-op is
 * what makes a mid-execution mount/unmount safe: an unmounted mount yields
 * `[]`, so a torn-down component's interceptor simply stops firing.
 */
function buildTreeInterceptorForwarder(
  source: TreeInterceptionSource,
  mountId: string,
): Middleware<unknown, unknown, unknown> {
  return (input, next) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      const command = ctx.op;
      if (command === undefined) return yield* next(input);
      const collected = source.collectTreeInterceptors({ mountId, command });
      if (collected.length === 0) return yield* next(input);
      const composed = composeMiddleware(orderInterceptors(collected), next);
      return yield* composed(input);
    });
}
