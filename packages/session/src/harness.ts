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
  generateId,
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
} from "@agentick/runtime";
import type {
  CompilerProtocol,
  JournalingPolicy,
  LoopExecutorProtocol,
  ModelInfoResult,
} from "@agentick/spec";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ChannelSnapshotProvider,
  CompactDecisionCtx,
  ContentBlock,
  Cost,
  CostResolver,
  EventEnvelope,
  ElicitationRequest,
  FormElicitationRequest,
  EventBus,
  EventSurface,
  EventBusFactory,
  ExecutionTarget,
  ExecutorProtocol,
  BranchCtx,
  DropCtx,
  HydrateCtx,
  KnobHandle,
  LanguageModelExecutionResult,
  LoopExecutionEvent,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MessageInboxFactory,
  MetricLabels,
  Metrics,
  NotifyTickEndInput,
  Operation,
  OperationCtx,
  OperationJournal,
  OperationJournalFactory,
  PersistCtx,
  ProtocolEvent,
  RegisteredModel,
  OutputSpec,
  RenderContext,
  ResponseFormat,
  SendInput,
  SendMessageInput,
  SendResult,
  SendTelemetry,
  SessionAbortOptions,
  SessionCloseInput,
  SessionCloseReason,
  SessionError,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionRunOutcome,
  SessionStatus,
  SessionStatusFrame,
  SessionStore,
  SessionSubstrateParent,
  ForkInput,
  SpawnContext,
  SpawnInput,
  StoreCtx,
  StateApplyError,
  SubstrateError,
  TickEndForwardDecision,
  TickFailurePolicy,
  TickResult,
  TimelineEntry,
  TokenKind,
  LanguageModelInput,
  RenderedTree,
  ToolDeclaration,
  ToolExecutorProtocol,
  ToolsHandle,
  TreeInterceptionSource,
  Unsubscribe,
  UsageRollup,
  UsageStats,
} from "@agentick/spec";
import {
  channelEventName,
  DEFAULT_JOURNALING_POLICY,
  DEFAULT_TERMINAL_TOOL_NAME,
  ExecutionFailed,
  foldUsageRollup,
  HandlerError,
  isChannelSnapshotProvider,
  isBranchCapable,
  isCheckpointCapable,
  isDropCapable,
  isExecuteError,
  NoModelForExecutionError,
  SESSION_STATUS_CHANNEL,
  SteerCannotCarryStructuredOutput,
  supportsTreeInterception,
  InvalidMediaSource,
  SessionBusyError,
  SessionClosedError,
  SpawnDepthExceededError,
  TimelineWriteFailed,
} from "@agentick/spec";
import { mergeAbortSignals, mergeLayered, omitUndefined } from "@agentick/utils";
import { buildSessionElicit, ELICITATION_ELICIT_COMMAND } from "@agentick/elicitation";
import { withScope, TOOL_CLIENT_CALL_COMMAND } from "@agentick/tool-executor";
import {
  effectiveModelInfo,
  modelFactsOf,
  type LanguageModelAdapter,
  type ModelRegistry,
} from "@agentick/model";
import type { KnobsDefinition, KnobsHandle } from "@agentick/knobs";
import type { GateHandle, GatesHandle } from "@agentick/gates";
import type { StateDefinition, StateHandle } from "@agentick/state";
import type { TimelineDefinition, TimelineHandle } from "@agentick/timeline";

import { buildSessionBridges, type SessionHookBridges } from "./session-bridges.js";
import { wireLifecycleProjection, type LifecycleProjection } from "./lifecycle-projection.js";
import { resolveTickFailurePolicy, type TickFailurePredicate } from "./tick-failure-policy.js";
import {
  SessionModelFacade,
  type ModelSelectionHandle,
  type SetModelInput,
} from "./model-facade.js";
import { SessionRuntime } from "./session-state.js";
import {
  forwardDeltas,
  reflectionData,
  reflectionRequest,
  withInstruction,
  textOf,
  type ReflectInput,
  type ReflectResult,
} from "./reflect.js";
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
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "session:send": { input: SendInput<unknown>; output: SessionExecutionHandle };
    "session:append": { input: AppendEntryInput; output: ApplyResult };
    "session:apply-executor-result": { input: ApplyExecutorResultInput; output: ApplyResult };
    "session:apply-tool-results": { input: ApplyToolResultsInput; output: ApplyResult };
    // ADR 89 §2 — the `session.model.setModel` / `setTarget` swap. Declared
    // as a session command so a model swap is journaled + hookable
    // (`onBeforeSessionSetModel` — "this session may not switch to model X").
    "session:set-model": { input: SetModelInput; output: void };
    // Recovery pass #1 — checkpoint/rehydrate ARE commands. `session:snapshot`
    // mints `onBeforeSessionSnapshot` (veto — the pin seam) +
    // `onAfterSessionSnapshot`; `session:restore` mints
    // `onBeforeSessionRestore` + `onAfterSessionRestore`. Both journal, and
    // both carry NO payload: the data never leaves its harness's own store.
    "session:snapshot": { input: void; output: void };
    "session:restore": { input: void; output: void };
    // ADR 92 Family 2 §5 — teardown is an op, symmetric with `app:close-app` /
    // `gateway:close`. Mints `onBeforeSessionClose` (the hold-for-drain seam)
    // + `onAfterSessionClose`. BUS-ONLY by policy: the body reaches substrate
    // teardown, so a journal write after it could target a closed journal.
    "session:close": { input: SessionCloseInput; output: void };
    // ADR 92 Family 2 §4 — spawning a child session is a state-mutating verb
    // an adopter wants to guard ("this agent may not spawn"). Mints
    // `onBeforeSessionSpawn` / `onAfterSessionSpawn`. Non-addressable like its
    // siblings: `SpawnInput` carries a JSX agent root and the output is a live
    // session, neither of which has a wire form.
    "session:spawn": {
      input: SpawnInput<unknown>;
      output: SessionExecutionHandle | SessionHarnessProtocol<unknown>;
    };
  }
}

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

/**
 * What a dry run produced — the three artifacts a tick makes on its way to the
 * provider. Deliberately the same shape as the request half of a recorded
 * `RoundTrip`, so a debug surface renders a live preview and recorded history
 * through one component.
 */
export interface SessionDryRun {
  /** What the components produced, pre-dialect. */
  readonly tree: RenderedTree;
  /** What the MODEL sees — messages, tools, system, post-formatter. */
  readonly input: LanguageModelInput;
  /** What would go on the wire. Absent when the executor has no adapter. */
  readonly request?: unknown;
}

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
   *     serves all sessions, keyed by scope).
   *   - `hydrate` — the GENESIS seam (ADR 93). Defaults to
   *     `hydrateFromStore()` when a store is present (ADR 49
   *     open-or-rehydrate, preserved); `hydrateTail(n)` bounds it.
   *   - `writePolicy` — `"behind"` (default) | `"through"`.
   *   - `compact` — the construction-bound default compaction
   *     (ADR 51 signal form): `timeline.compact()` with no argument —
   *     including a bare `timeline:compact` verb over the inbox/wire —
   *     runs it. Takes the `(entries, ctx)` sugar or a `CompactStrategy`.
   *   - `hooks` / `guards` — namespace-local interceptor bags with
   *     drop-layer keys (`onBeforeAppend`, `guards: { append }`).
   *
   * Flows from the TOP-LEVEL `createApp({ timeline })` slot (ADR 93) via
   * SessionDefaults — `createApp({ session: { timeline } })` is GONE.
   */
  readonly timeline?: TimelineDefinition;
  /**
   * Knob VALUE durability (ADR 93 slot), threaded to the per-session
   * `KnobsHarness`. Flows from the top-level `createApp({ knobs })`, whose
   * default is one app-scoped in-memory store — the lifetime an evict/resume
   * cycle needs (checkpointing §4).
   */
  readonly knobs?: KnobsDefinition;
  /** Adopter-stash durability (ADR 93 slot). Same shape and lifetime as {@link knobs}. */
  readonly state?: StateDefinition;
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
   * Pricing seam (`AppHarnessOptions.costResolver`), threaded straight
   * through to `ExecutionRunInput.costResolver` on every send. The loop
   * consults it per tick at settlement, where it WINS over the resolved
   * target's declared `rates`.
   *
   * @see docs/proposals/v2/usage-cost.md §4.3
   */
  readonly costResolver?: CostResolver;
  /**
   * Adopter-defined metadata bag carried on the session and exposed
   * to substrate factories via `parent.metadata`. Framework defines
   * no keys; adopters stash whatever they want (tenant id, trace id,
   * routing hints).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Construction-bound owning principal (ADR 48) — the identity axis of the
   * session's structural identity. Forwarded to {@link BaseHarness} (so the
   * wire dispatch gate reads `session.principal` for the same-principal rule)
   * and folded into the durable `SessionRecord`. Threaded by the App from
   * `CreateSessionInput.principal`; inherited by spawned / forked children.
   * `undefined` for a principal-less session.
   */
  readonly principal?: string;
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
   * Hard cap on CONSECUTIVE failed ticks (ADR 99 slice 2), sibling of
   * {@link defaultMaxTicks} and threaded onto every execution. Bounds
   * {@link tickFailurePolicy} — raise it before raising a retry budget past
   * it, or the cap silently truncates the budget. Default: 3 (the loop's).
   */
  readonly maxConsecutiveFailedTicks?: number;
  /**
   * Which failed ticks are re-issued (ADR 99 slice 3). Absent, the bundled
   * policy retries a `MalformedModelOutput` once and stops on everything else.
   * Supplying either form — a per-class retry budget or the live predicate —
   * REPLACES that default; both stay bounded by
   * {@link maxConsecutiveFailedTicks} and {@link defaultMaxTicks}.
   */
  readonly tickFailurePolicy?: TickFailurePolicy;
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
   * The parent EXECUTION that spawned this session (EX1) — set by the App's
   * `createChildSession` from the spawn site. Stamped onto the
   * `SessionRecord`, where it is the edge `app.abortExecutionTree` walks.
   */
  readonly originExecutionId?: string;
  /** The parent TOOL CALL that asked for the spawn (EX1), when there was one. */
  readonly originCallId?: string;
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
  readonly toolBridge?: import("@agentick/spec").ToolBridge;
  /**
   * Optional pre-constructed elicitation harness. When supplied,
   * `buildSessionBridges` uses this instance for the `elicitation`
   * slot instead of constructing its own — which lets the AppHarness
   * share the SAME elicitation harness with the per-session
   * `ToolExecutorHarness` (the confirmation gate needs to be paired
   * with the bridges' elicitation so client `respond()` calls reach
   * the registry the tool-executor is waiting on).
   */
  readonly elicitation?: import("@agentick/spec").ElicitationHarnessProtocol;
  /**
   * Optional pre-constructed tasks harness. Same wiring rationale
   * as `elicitation` — the AppHarness shares ONE tasks harness
   * instance between the per-session `ToolExecutorHarness` (so
   * TaskHandle-return detection routes against the right registry)
   * and the session bridges (so JSX `bridges.tasks` consumers see
   * the same in-flight tasks).
   */
  readonly tasks?: import("@agentick/spec").TasksHarnessProtocol;
  /**
   * Optional pre-constructed resources harness (ADR 62). Same wiring
   * rationale as `elicitation` / `tasks` — the AppHarness shares ONE
   * instance between the per-session `ToolExecutorHarness`
   * (`ctx.resource`), the session bridges (`bridges.resources`), and
   * the SessionInstaller (`installer.resources`). When omitted,
   * `buildSessionBridges` constructs a fresh one on the substrate (the
   * standalone / test path).
   */
  readonly resources?: import("@agentick/spec").Resources;
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
  /**
   * Persist the durable `SessionRecord` at genesis rather than on first
   * mutation (E11). Default `false` — a created-but-never-used session stays
   * out of the durable registry until its first status transition / `setMeta`.
   * `true` writes the record immediately (the "show it in the list now" case).
   */
  readonly eager?: boolean;
  /** Owning app id — stamped on the session's `SessionRecord.appId`. */
  readonly appId?: string;
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
   * `@agentick/runtime`'s README.
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
// Tick accounting — the metrics plane (usage-cost §5)
// ============================================================================

/**
 * **Two planes, one stamp.** A tick's `Cost` is computed exactly once, at
 * settlement in the loop. The session projects that single fact twice:
 *
 *  - the **truth plane** — the assistant entry's `SessionMessageMetadata`, the
 *    execution rollup, and the `SessionRecord` aggregate. Durable, complete,
 *    per-model. This is what billing reads.
 *  - the **metrics plane** — the names below, emitted through `ctx.metrics`.
 *    Strictly a MIRROR of the truth plane, for dashboards.
 *
 * The direction is non-negotiable: **money must never live ONLY in metrics.**
 * A metrics pipeline is lossy by design — it samples, aggregates, expires
 * series, and drops labels under cardinality pressure. It is a fine place to
 * WATCH cost and a catastrophic place to SOURCE it. So nothing here is the
 * only writer of a number, and nothing reads any of it back for accounting.
 *
 * `ctx.metrics` prefixes each name with the harness's telemetry namespace, so
 * these land as `agentick.session.tick.*` unless the app whitelabels it.
 */
const TICK_COST_METRIC = "session.tick.cost_micros";
const TICK_TOKENS_METRIC = "session.tick.tokens";
const TICK_UNPRICED_METRIC = "session.tick.unpriced";

/**
 * The token kinds a tick can report, read in the {@link TokenKind} vocabulary
 * the rate cards price in — so the `kind` label on the tokens histogram joins
 * directly to a `RateCard.perMTok` key.
 *
 * **Absent ≠ zero** (usage-cost §2) holds here too: an unreported kind emits
 * NOTHING. A `0` observation claims "this model did no cache writes", which is
 * a different statement from "this provider does not tell us" — and in a
 * histogram the difference is a bucket that drags every percentile down.
 */
const TICK_TOKEN_KINDS: readonly (readonly [TokenKind, (u: UsageStats) => number | undefined])[] = [
  ["input", (u) => u.inputTokens],
  ["output", (u) => u.outputTokens],
  ["cacheRead", (u) => u.cachedInputTokens],
  ["cacheWrite", (u) => u.cacheCreationTokens],
  ["reasoning", (u) => u.reasoningTokens],
];

/**
 * How a settled run ENDED, from its stop reason — the `outcome` that rides the
 * transition ending it. A run refused before it started (`vetoed`) and one that
 * ran out of time are endings a UI reports the same way as an executor failure;
 * every provider stop reason, `max_ticks` included, is a run that finished.
 */
function runOutcomeOf(stopReason: SendResult["stopReason"]): SessionRunOutcome {
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "executor_failed" || stopReason === "timeout" || stopReason === "vetoed") {
    return "failed";
  }
  return "succeeded";
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
  /**
   * The session's OWN agent root (C2). Retained from
   * `SessionHarnessOptions.agent` — the same value forwarded to
   * `compiler.mount` — so `spawn({})` / `fork()` can default a child to a
   * same-image copy of this session. Opaque here (the bound compiler owns the
   * type contract); the session only forwards it.
   */
  private readonly agentRoot: unknown;
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
   * Durable session registry (E11), captured identity (`createdAt` / `appId`),
   * and the app-owned descriptive slots (`title` / `description` /
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
   * in `@agentick/runtime`'s README.
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
  /** See {@link SessionHarnessOptions.maxConsecutiveFailedTicks}. */
  private readonly maxConsecutiveFailedTicks: number | undefined;
  /** The resolved tick-failure predicate (ADR 99 slice 3) — bundled or supplied. */
  private readonly tickFailurePolicy: TickFailurePredicate;
  private readonly defaultStreaming: boolean | undefined;
  /** Model-call narration switch (default `true`). See SessionHarnessOptions.narrate. */
  private readonly narrate: boolean;
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
  /**
   * GENESIS barrier (ADR 93) — resolves once every store-bearing namespace's
   * `hydrate(ctx)` has run (or immediately, when none is configured or this is a
   * fork/spawn-inherit). The App AWAITS this at `createSession`, so a hydrator
   * that throws fails session CREATION with its typed error instead of surfacing
   * later as a mount rejection: landmine 2, "no half-genesis session".
   *
   * Distinct from {@link mountReady} on purpose. Genesis must complete before
   * the first render (the mount chains behind it), but the mount itself stays
   * un-awaited at create — that latency is deliberate.
   */
  private readonly _genesisReady: Promise<void>;
  /** #199 — structural scope ceiling, surfaced for the dispatch gate. */
  readonly requiredScopes?: readonly string[] | undefined;
  /** Injected model registry (#206) — window resolution for useContextInfo. */
  private readonly models: ModelRegistry | undefined;
  /** App-injected pricing seam — forwarded verbatim onto every run input. */
  private readonly costResolver: CostResolver | undefined;
  private _currentExecution: Promise<unknown> | null = null;
  /** In-flight handle — join target for steering sends (ADR 53 §5). */
  private _currentHandle: import("@agentick/spec").SessionExecutionHandle | null = null;
  /**
   * The in-flight handle's emit sink. Held beside {@link _currentHandle} so
   * work that happens DURING an execution but outside the loop's event
   * channel — a `spawn()` from inside a tool handler — can put its boundary
   * events on the caller's stream. Null between executions.
   */
  private _currentEmit: ((event: SessionEmitInput) => void) | null = null;
  /**
   * EX1 — the in-flight execution's DOWNSTREAM teardown signal. Fires when the
   * execution is cancelled (`handle.abort` / `session.abort`, a timeout, an
   * error), never when it succeeds; sessions spawned during the execution take
   * it as their construction signal, so cancelling a turn tears down the
   * sub-agents that turn created.
   *
   * Deliberately NOT merged into the signal handed to the loop: the loop's own
   * abort semantics (which outcome a cancellation reports, and with what
   * reason) are ratified and stay untouched — this controller only fans
   * outward, to work the execution started elsewhere. Null between executions.
   */
  private _currentExecutionAbort: AbortController | null = null;
  /**
   * SYNCHRONOUS send reservation (review finding: two un-awaited fresh
   * sends both passed the null-guard across its awaits). Set before the
   * first await in sendBody; a concurrent send awaits it and JOINS.
   */
  private _handleReservation: {
    promise: Promise<import("@agentick/spec").SessionExecutionHandle>;
    resolve: (h: import("@agentick/spec").SessionExecutionHandle) => void;
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
  /**
   * The running turn's aggregate accounting — flat `usage`, the per-model
   * breakdown, and the cost rollup — folded per tick as
   * `applyExecutorResult` lands. The boundary record's payload.
   *
   * Per-model rather than a flat bag because cost is NOT a function of a bag
   * flattened across models: a turn changes model (a per-tick `<Model>`, a
   * steer, a `setModel`), and the flat total routinely mixes rate tiers.
   */
  private _executionRollup: UsageRollup | undefined;
  /** Input entries the running execution has observed (ADR 53 live check). */
  private _inputEntriesSeen = 0;
  /**
   * A fold ran during this execution and changed nothing (ADR 97).
   *
   * `rollingSummary` returns its input unchanged in three cases — nothing older
   * than the verbatim tail, only summaries left to fold, a truncated summary —
   * and the trigger's own measurement does not move when that happens, so the
   * next tick reads the same over-ceiling number and folds again. A fold is a
   * model call, so that is an execution paying twice per tick to accomplish
   * nothing.
   *
   * Scoped to the EXECUTION rather than to the projection version, which was
   * the first attempt and is nearly useless: an agentic tick appends its tool
   * results, the version bumps, and the stall clears every single time — the
   * loop it was meant to stop is exactly the loop that clears it. A user turn
   * resets this, so a refusal costs at most one wasted fold per turn.
   */
  private _compactRefusedThisExecution = false;
  /**
   * Per-execution STEER queue (ADR 53 §5). A `send({ onBusy: "steer" })`
   * that joins an in-flight execution pushes its messages here instead of
   * appending them to the timeline immediately; the loop drains them at the
   * next tick boundary (in {@link notifyLifecycle}) — after the tick's tool
   * results apply, before the next render — so a steer NEVER lands between an
   * assistant `tool_use` and its `tool_result` (which the immediate-append
   * path could do when the steer raced a mid-tick model call). Logically
   * scoped to the current execution: populated only while one runs, and
   * drained / flushed at every tick boundary + at settle.
   */
  // TODO(client-queue-read): NO CLIENT READ SURFACE. This queue and the
  // `onBusy: "queue"` deferral are both server-private, so a UI cannot show a
  // user what their racing sends are waiting behind, or let them cancel one.
  // The first real consumer hit it immediately: knowify's assistant had a
  // "queued messages" bar over its own client-side queue, and porting to
  // `onBusy` correctly DELETED that queue — which left the bar with nothing to
  // read (nx-knowify k-assistant-v3, documented as a deliberate degrade rather
  // than rebuilt client-side).
  //
  // The shape this wants is the one `timeline:history` established: a declared
  // wire-exposed READ command (`session:queued`), grant-gated, bus-only
  // journaling, plus `added`/`removed` notifications per the
  // enumeration-is-foundational rule so a client can hold a live list rather
  // than poll. A cancel verb pairs with it (`session:dequeue`). Deferred rather
  // than guessed: whether the queue is per-execution (steer) or session-wide
  // (onBusy) in the client's view is a product question, and the two queues
  // above are different things.
  private _steerQueue: SendMessageInput[] = [];
  /**
   * FULL-quiesce signal (queue-item 4b — the "settled ≠ agent_end" fix).
   * Resolves in the current send's result `.finally` — AFTER the ADR-49
   * durability barrier (endTurn + flush) AND after the reservation clears and
   * the status returns to idle — NOT at the loop terminal (which fires
   * earlier, inside `_currentExecution`). `whenQuiescent()` and a
   * `onBusy: "queue"` send await this, so a queued send never fires in the
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
      // The session's own coordinates, DECLARED rather than stamped per-op. Its
      // `scopeId` happens to equal its session id, which is exactly why the old
      // per-op `{ sessionId: this.scopeId }` looked correct here and was wrong in
      // six sub-harnesses whose scopeId is composed. One rule, no exceptions to
      // remember: nobody stamps `sessionId`; everybody declares `parentScope`.
      parentScope: { sessionId: options.sessionId },
      ...omitUndefined({
        // ADR 48 — the construction-bound owning principal. Stamped onto every
        // emitted event scope by BaseHarness.makeEvent AND read by the wire
        // dispatch gate (`session.principal`) for the same-principal rule.
        principal: options.principal,
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
      onStatusTransition: (status, outcome) => this.publishStatusTransition(status, outcome),
      ...omitUndefined({
        appId: options.appId,
        eager: options.eager,
        parentSessionId: options.parentSessionId,
        // ADR 48 — persist ownership on the durable record (resume index).
        principal: options.principal,
        // SP5 — persist the full lineage on the record (omit for a root).
        spawnPath:
          options.spawnPath && options.spawnPath.length > 0 ? options.spawnPath : undefined,
        // EX1 — persist the origin edge (which TURN spawned us, and which call).
        originExecutionId: options.originExecutionId,
        originCallId: options.originCallId,
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
        }),
        // A compaction strategy that needs a model gets THIS session's — the
        // same one the loop uses, over the context the next tick would send.
        // Bound here because only the session sees both; an adopter supplying
        // its own `generate` keeps it.
        timeline: {
          generate: (gen) =>
            this.reflect({
              instructions: gen.instructions,
              ...omitUndefined({ maxOutputTokens: gen.maxOutputTokens, onDelta: gen.onDelta }),
            }),
          ...options.timeline,
        },
        ...omitUndefined({ knobs: options.knobs, state: options.state }),
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
    // Create-call seeds, applied AFTER genesis (see `_genesisReady` below): the
    // hydrate fan-out is store-authoritative and would otherwise wipe them, and
    // a value the caller passed to THIS create outranks what is durable.
    const seedCreateInputValues = (): void => {
      if (options.initialKnobs) {
        this.bridges.knobs.seed(
          options.initialKnobs as Readonly<Record<string, string | number | boolean>>,
        );
      }
      if (options.initialState) {
        this.bridges.state.seed(options.initialState);
      }
    };

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
    this.agentRoot = options.agent;
    this.parentSessionId = options.parentSessionId;
    this.spawnPath = options.spawnPath ?? [];
    // Default 10 — v1 `MAX_SPAWN_DEPTH`.
    this.maxSpawnDepth = options.maxSpawnDepth ?? 10;
    this.telemetryRuntime = options.telemetryRuntime;
    this.telemetryMiddleware = options.telemetryMiddleware ?? [];
    this.telemetryEnabled = this.telemetryMiddleware.length > 0;
    this.defaultMaxTicks = options.defaultMaxTicks ?? 8;
    this.maxConsecutiveFailedTicks = options.maxConsecutiveFailedTicks;
    this.tickFailurePolicy = resolveTickFailurePolicy(options.tickFailurePolicy);
    this.requiredScopes = options.requiredScopes;
    this.models = options.models;
    this.costResolver = options.costResolver;
    this.defaultStreaming = options.defaultStreaming;
    // Narration defaults ON — the token-cost off-switch is opt-out.
    this.narrate = options.narrate ?? true;
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
    this.trackBlockedOnInput();
    if (this.constructionSignal !== undefined) {
      const sig = this.constructionSignal;
      const onAbort = (): void => {
        // Fire-and-forget from an event listener (no consumer possible), but
        // it cannot reject: `disposeChildren` catches EVERY per-child failure
        // individually — see its body.
        void this.disposeChildren();
      };
      sig.addEventListener("abort", onAbort, { once: true });
      this.onClose(() => sig.removeEventListener("abort", onAbort));
    }

    // ─── GENESIS (ADR 93) ────────────────────────────────────────────────
    //
    // Run every store-backed namespace's `hydrate(ctx)` HERE: after identity
    // stamping (the runtime + bridges exist, so `ctx.sessionId`/`principal` are
    // real), before first render (the mount chains behind this promise, so the
    // first render sees the resumed conversation and Class B state reconstructs
    // from it), and before any append.
    //
    // Genesis IS the {@link CheckpointCapable} hydrate fan-out (checkpointing
    // §3.2) — opening on what is durable and resuming on it are one operation,
    // so this is the same fan-out `restore()` runs, over every migrated bridge
    // rather than the timeline alone. Build-then-hydrate is therefore the whole
    // of "resume": evict/restart/crash converge on this line.
    //
    // **Spawn-inherit skips it.** A `spawn()`ed child takes its parent's IMAGE
    // and owns no durable scope of its own yet, so a hydrator would run against
    // a partition nothing wrote. A `fork()` is the exception that proves it —
    // the fork path BRANCHES the parent's scopes onto the child's and then
    // hydrates over the copy (checkpointing §5), which is why the ADR 93 fork
    // law retired with the blob transport. The session's own record hydrates
    // unconditionally: a child's id is new, so its read finds nothing and the
    // step degenerates to the E11 construction upsert.
    const inheritsParentImage =
      options.parentSessionId !== undefined || (options.spawnPath?.length ?? 0) > 0;
    this._genesisReady = Promise.all([
      this.runtime.hydrate(),
      inheritsParentImage
        ? Promise.resolve()
        : this.hydrateCheckpointBridges(this.checkpointCtxFrom(this.storeCtx())),
    ])
      .then(seedCreateInputValues)
      .then(() => {});

    // Eagerly mount — the compiler exposes `.ready` for its own
    // inbox registration; our mount is awaited via `_mountReady`. The
    // element type is opaque here — `MountInput.element: unknown` in
    // the spec — and the bound compiler impl interprets it.
    this._mountReady = this._genesisReady
      .then(() =>
        this.compiler.mount({
          mountId: this.mountId,
          sessionId: options.sessionId,
          element: options.agent,
          bridges: this.bridges,
        }),
      )
      .then(() => {});
    // A failed GENESIS rejects `_genesisReady` (awaited at createSession — the
    // typed failure surfaces THERE) and therefore also rejects this derived
    // chain, which a never-created session will never await. Mark the derived
    // rejection handled so it cannot escape as an unhandled rejection; real
    // consumers (`sendBody` awaiting `_mountReady`) still observe it — `.catch`
    // returns a NEW promise and leaves this one's rejection intact.
    this._mountReady.catch(() => {});

    // E11 — the session's durable-registry mirror. The record write-through +
    // the metadata notifier the harness used to hand-roll here
    // (`subscribeMetadata → syncSessionRecord → void store.put(...)`) live
    // INSIDE the runtime's single-key `View<SessionRecord>`: the genesis
    // `runtime.hydrate()` above performs the construction/resume upsert, and
    // every `setStatus` / `setMeta` write-through hits the store via
    // `view.write`. Only a status transition (or `setMeta`) persists;
    // `executionCount` / `currentExecutionId` / `usage` ride the next
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
   * GENESIS barrier (ADR 93) — resolves once every store-bearing namespace's
   * `hydrate(ctx)` has completed, REJECTING with the namespace's typed error
   * (e.g. `TimelineHydrateFailed`) if a hydrator threw. The App awaits this at
   * `createSession` so a failed genesis fails session creation rather than
   * leaving a half-genesis session that only explodes at the first `send`.
   *
   * Resolves immediately for a fork / spawned child (it inherits its parent's
   * image via `restore`, so genesis must not run) and for a session whose
   * namespaces configure no store and no hydrator.
   */
  get genesisReady(): Promise<void> {
    return this._genesisReady;
  }

  /**
   * The session's elicitation harness — exposed on
   * `SessionHarnessProtocol.elicitation` (slot added by the elicitation
   * package's module augmentation). Gateway routes
   * `session/respond_to_elicitation` here.
   */
  get elicitation(): import("@agentick/spec").ElicitationHarnessProtocol {
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
  get elicit(): import("@agentick/spec").Elicit {
    if (!this._elicit) {
      this._elicit = buildSessionElicit({ harness: this.bridges.elicitation });
    }
    return this._elicit;
  }
  private _elicit?: import("@agentick/spec").Elicit;

  /**
   * Per-session tasks harness — same instance the tool-executor's
   * TaskHandle-return detection routes against (#156) and that
   * `bridges.tasks` exposes. Augmented onto `SessionHarnessProtocol`
   * via the `@agentick/tasks` package's module augmentation.
   */
  get tasks(): import("@agentick/spec").TasksHarnessProtocol {
    return this.bridges.tasks;
  }

  /**
   * Per-session resources harness (ADR 62) — the SAME instance the
   * tool-executor's `ctx.resource` reaches, that `bridges.resources`
   * exposes, and that `withMCP` proxy-registers remote resources into.
   * Augmented onto `SessionHarnessProtocol` via the
   * `@agentick/resources` package's module augmentation. Adopter /
   * server-side code reads resources without a tool ctx:
   * `await session.resources.read(uri)`.
   */
  get resources(): import("@agentick/spec").Resources {
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
   * The in-flight execution's id, or `undefined` when idle — the sync twin of
   * `SessionRecord.currentExecutionId`, without a store read. Lets a caller
   * holding an EXECUTION id (rather than a session id) decide whether this
   * session is still running THAT execution: `app.abortExecutionTree` uses it
   * to tell "the origin turn is still going" from "a later turn is".
   */
  get currentExecutionId(): string | undefined {
    return this.runtime.currentExecutionId() ?? undefined;
  }

  /**
   * Resolve once this session has FULLY quiesced — the in-flight execution
   * (if any) has settled AND its post-terminal durability barrier (endTurn +
   * flush) has run AND the reservation has cleared / status returned to idle.
   * Used by SP6 child disposal so a parent-abort teardown closes the child
   * only AFTER its aborting loop has drained its tick-end lifecycle (closing
   * mid-tick would unmount the compiler out from under the loop →
   * `NotMounted`), and by `onBusy: "queue"` sends to wait for the true
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

  /**
   * Cancel the current execution. Delegates to the live handle's `abort` —
   * the SAME path `handle.abort(reason)` takes (`loop.abort({ executionId,
   * reason })`), so the reason lands on the execution's merged signal and the
   * terminal reports `canceled` with it. No handle in flight ⇒ nothing to
   * cancel; a session that is idle (or whose execution settled while this
   * call was in flight) resolves quietly.
   *
   * Not a session op of its own: the abort it delegates to IS an op
   * (`loop:abort`), so wrapping it here would mint a second envelope for one
   * cancellation. That holds for the cascade too — one `loop:abort` per
   * aborted session, no third op kind. Cascade is SCOPE, not KIND: a guard
   * watching `loop:abort` sees exactly the ops it always saw, more of them.
   *
   * `{ cascade: true }` aborts the live spawn subtree deepest-first (this
   * session last), through the app's registry walk — the same one
   * `destroySession` runs as its first step, and none of the teardown that
   * follows it there. Nothing is disposed, no record is touched, detached
   * tasks keep running; see {@link SessionAbortOptions} for the full ladder.
   * A session with no `spawnContext` cannot have spawned anything, so cascade
   * collapses to the plain self-abort.
   */
  async abort(reason?: string, opts?: SessionAbortOptions): Promise<void> {
    if (opts?.cascade === true && this.spawnContext !== undefined) {
      await this.spawnContext.abortSubtree(this.runtime.id, reason);
      return;
    }
    await this._currentHandle?.abort(reason);
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
   * What this session is doing right now. The live twin of the durable
   * `SessionRecord.status`; `session:channel:status` is the push half.
   */
  get status(): SessionStatus {
    return this.runtime.status();
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
   * The session's tools handle — the curated projection of the tool registry
   * (three-audiences-plan §F). SYNC View reads (`list`/`get`/`has`), the
   * host-door `dispatch(name, input, opts?)` (`via: "dispatch"` — this replaces
   * the removed `session.dispatch`), and the family topology-subscription pair.
   * Reads exactly like `session.knobs` / `session.state`.
   *
   * Built and owned by the tool executor harness (`toolExecutor.tools`), over
   * its own registry — no wrapper. Power users who need the live
   * `ToolDeclaration` (with its Standard-Schema validator) keep the raw
   * `session.toolExecutor`.
   */
  get tools(): ToolsHandle {
    return this.toolExecutor.tools;
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

  /**
   * Compile the current tree WITHOUT sending it — the three artifacts a tick
   * produces on its way to the provider, for inspection.
   *
   * ```ts
   * const { tree, input, request } = await session.dryRun();
   * ```
   *
   * | rung      | artifact              | what it answers                        |
   * | --------- | --------------------- | -------------------------------------- |
   * | `tree`    | `RenderedTree`        | what the components produced (the IR)  |
   * | `input`   | `LanguageModelInput`  | what the MODEL sees, post-formatter    |
   * | `request` | provider-native       | what would go on the wire              |
   *
   * Nothing is sent, no timeline entry is written, and the tick counter does
   * not move. It is NOT free of side effects, and pretending otherwise would
   * mislead: rendering runs the tree, so `useData` fetches, suspense resolves,
   * and any lifecycle hook on the render path fires. For a retrieval-backed
   * agent that means a real query.
   *
   * `request` is `undefined` when the executor has no provider adapter behind
   * it (a fake, a replay double) — see `ExecutorProtocol.prepareRequest`. It is
   * also the request BEFORE `onBeforeModelProviderRequest` hooks run, so a hook
   * that rewrites the native request is not reflected.
   *
   * The individual rungs are available separately ({@link compile},
   * {@link project}, {@link prepareRequest}) for when a later one cannot run —
   * `prepareRequest` needs a resolved model, `compile` does not.
   */
  async dryRun(): Promise<SessionDryRun> {
    const tree = await this.compile();
    const input = await this.project(tree);
    const request = this.prepareRequest(input);
    return omitUndefined({ tree, input, request }) as SessionDryRun;
  }

  /**
   * One more turn of this session, with an extra instruction at the end.
   *
   * Compaction, episodic memory and thread titling are this operation under
   * different instructions. Appending at the END keeps the prefix
   * byte-identical to the next tick's, so the provider reads it from cache
   * rather than charging for it twice — and the model sees the system prompt,
   * the grounding and the whole conversation, because it IS that turn.
   *
   * Nothing is appended to the timeline: a reflection is a question ABOUT the
   * conversation, not a move within it.
   */
  async reflect<T = unknown>(input: ReflectInput<T>): Promise<ReflectResult<T>> {
    const model = this.modelFacade.current;
    if (!model) throw new NoModelForExecutionError();
    const executor = model.modelExecutor;
    const scope = { sessionId: this.id };
    const { spec, tools, parameters } = reflectionRequest(input, model.target);
    // The executor's own three phases, run by hand. `run` projects internally,
    // so it has no seam to append an instruction through — which is the one
    // thing this needs.
    const projected = await this.project(undefined, tools);
    const executeInput = {
      targetInput: withInstruction(projected, input.instructions, parameters),
      target: model.target,
      scope,
      ...omitUndefined({ signal: input.signal }),
    };
    // Streamed only when someone is listening — the deltas exist to move a
    // progress bar, and nothing else here reads them.
    const targetOutput =
      input.onDelta && executor.executeStream
        ? await forwardDeltas(executor.executeStream(executeInput), input.onDelta)
        : await executor.execute(executeInput);
    const result = await executor.normalize({ targetOutput, target: model.target, scope });
    // A cap hit mid-answer is truncation, not a model that declined to answer:
    // validating the fragment would raise `StructuredOutputIncomplete` and throw
    // away the usage the caller is billed for. `truncated` says what happened
    // and `data` stays absent, which is what "should not be persisted" means.
    const truncated = result.stopReason === "max_tokens";
    const data =
      spec !== undefined && !truncated ? ((await reflectionData(spec, result)) as T) : undefined;
    return omitUndefined({
      text: textOf(result.output),
      usage: result.usage,
      truncated,
      data,
    }) as ReflectResult<T>;
  }

  /** Rung 1 — render the tree to IR. Needs no model. */
  async compile(): Promise<RenderedTree> {
    const { tree } = await this.compiler.renderTree({
      mountId: this.mountId,
      sessionId: this.id,
      // Not a tick: this render is a read of current state, and saying so keeps
      // it out of anything that counts ticks or fires tick lifecycle.
      purpose: "free-root",
    });
    return tree;
  }

  /**
   * Rung 2 — IR to the canonical input the model sees. Tools default to the
   * same `compileForTick({ exposure: "model" })` the loop uses, so the
   * projected tool list is the precedence-resolved one, not the compiler slice.
   * Pass `tools` to project a different list — what {@link reflect} does, since
   * a reflection advertises its own (usually none). The parameter is on the
   * class only, deliberately: `SessionProtocol` describes what a session does
   * for a client, and no wire caller supplies a tool list.
   */
  async project(
    tree?: RenderedTree,
    tools?: readonly ToolDeclaration[],
  ): Promise<LanguageModelInput> {
    const model = this.modelFacade.current;
    if (!model) throw new NoModelForExecutionError();
    const compiled = tree ?? (await this.compile());
    return model.modelExecutor.project({
      compiled,
      target: model.target,
      scope: { sessionId: this.id },
      tools: tools ?? (await this.toolExecutor.compileForTick({ exposure: "model" })),
    }) as Promise<LanguageModelInput>;
  }

  /**
   * Rung 3 — the provider-native request. `undefined` when the executor
   * exposes no `prepareRequest` (no adapter behind it).
   */
  prepareRequest(input: LanguageModelInput): unknown {
    const model = this.modelFacade.current;
    if (!model) throw new NoModelForExecutionError();
    const executor = model.modelExecutor;
    return executor.prepareRequest?.({ targetInput: input, target: model.target });
  }

  snapshot(): Promise<void> {
    // Recovery pass #1 — `session:snapshot` command. `onBeforeSessionSnapshot`
    // (the veto a pin rides) + `onAfterSessionSnapshot` fire around the flush
    // barrier. A rejected `persist` rejects the whole operation, so a failed
    // flush is never followed by the caller's unmount (checkpointing §3.2).
    return runHarnessProtocol(
      this.sessionOp("snapshot", undefined, () =>
        Effect.gen(this, function* () {
          const ctx = yield* this.checkpointCtx();
          yield* Effect.tryPromise({
            try: () => this.persistCheckpointBridges(ctx),
            catch: (cause): SessionError => coerceSessionError(cause),
          });
        }),
      ),
    );
  }

  /** The checkpoint contract's ctx over a given store ctx (checkpointing §3.2). */
  private checkpointCtxFrom(storeCtx: StoreCtx): PersistCtx {
    return {
      sessionId: this.runtime.id,
      tick: this.runtime.currentTick(),
      storeCtx,
      ...omitUndefined({ signal: this.constructionSignal }),
    };
  }

  /**
   * The ctx a checkpoint hook running inside a COMMAND receives — built from the
   * ENRICHED store ctx so a durable store sees the live op's `opId` as its
   * idempotency key. Genesis and fork build theirs from the base `storeCtx()`:
   * they carry no live op to enrich from.
   */
  private checkpointCtx(): Effect.Effect<PersistCtx> {
    return Effect.map(this.storeCtxEffect(), (storeCtx) => this.checkpointCtxFrom(storeCtx));
  }

  /** Flush every {@link CheckpointCapable} bridge to its own store, in bag order. */
  private async persistCheckpointBridges(ctx: PersistCtx): Promise<void> {
    for (const bridge of Object.values(this.bridges)) {
      if (isCheckpointCapable(bridge)) await bridge.persist(ctx);
    }
  }

  /**
   * Rehydrate every {@link CheckpointCapable} bridge from its own store — the
   * fan-out genesis and `restore()` share, so a session has ONE store-read path
   * whether it is being opened, resumed after eviction, or restored explicitly.
   *
   * TODO(hydrate-ordering): bag order, no per-harness dependency declaration
   * (checkpointing §8.3). The first harness whose `hydrate` reads a sibling's
   * hydrated state is the trigger to introduce an ordering mechanism.
   */
  private async hydrateCheckpointBridges(ctx: HydrateCtx): Promise<void> {
    for (const bridge of Object.values(this.bridges)) {
      if (isCheckpointCapable(bridge)) await bridge.hydrate(ctx);
    }
  }

  /**
   * Copy `fromSessionId`'s durable scopes onto THIS session's own — the fork
   * transport (checkpointing §5). Each {@link BranchCapable} bridge copies at
   * its own store layer; no value crosses the seam, and the caller hydrates
   * afterwards to open the child on the copy.
   *
   * Called on the CHILD by the parent's {@link fork} (private access across
   * instances of one class), because the scopes being written are the child's.
   */
  private async branchCheckpointBridges(fromSessionId: string): Promise<void> {
    const ctx: BranchCtx = { ...this.checkpointCtxFrom(this.storeCtx()), fromSessionId };
    for (const bridge of Object.values(this.bridges)) {
      if (isBranchCapable(bridge)) await bridge.branch(ctx);
    }
  }

  /**
   * Delete every {@link DropCapable} bridge's durable scope — the destroy
   * transport (checkpointing §6). Irreversible, and the counterpart to the
   * `persist` fan-out: what a checkpoint wrote, this frees.
   *
   * Not a command of its own: `app:command:destroy-session` is the operation
   * (and the guard seam), and this is the teardown step it composes, exactly as
   * eviction composes `snapshot` + `close`. A rejection propagates, so destroy
   * fails loudly rather than reporting a deletion that did not happen.
   */
  /**
   * Drain the record's write-behind (the runtime view's flush) — the ordering
   * barrier the app's resume path takes before writing the record directly
   * (the interruption mark). Public on the concrete class, NOT the protocol —
   * the `dropScopes` precedent: the app constructs every registry entry.
   */
  flushRecordWrites(): Promise<void> {
    return this.runtime.flushRecord();
  }

  async dropScopes(): Promise<void> {
    const ctx: DropCtx = this.checkpointCtxFrom(this.storeCtx());
    for (const bridge of Object.values(this.bridges)) {
      if (isDropCapable(bridge)) await bridge.dropScope(ctx);
    }
  }

  restore(): Promise<void> {
    // Recovery pass #1 — `session:restore` command. `onBeforeSessionRestore` +
    // `onAfterSessionRestore` fire around the hydrate fan-out.
    return runHarnessProtocol(
      this.sessionOp("restore", undefined, () =>
        Effect.gen(this, function* () {
          const ctx = yield* this.checkpointCtx();
          yield* Effect.tryPromise({
            try: () => this.restoreBody(ctx),
            catch: (cause): SessionError => coerceSessionError(cause),
          });
        }),
      ),
    );
  }

  /**
   * Rehydrate this live session: every {@link CheckpointCapable} bridge reads
   * the latest for its own scope from its own store, in bag order. Accounting
   * is NOT restored here — `usage` / `byModel` / `cost` live on the durable
   * `SessionRecord` and are adopted by `SessionRuntime.hydrate()` at genesis,
   * and `currentTick` is execution-local (it resets per execution and never
   * enters the record).
   */
  private async restoreBody(ctx: HydrateCtx): Promise<void> {
    if (this._closed) {
      throw new SessionClosedError({ attemptedCommand: "restore" });
    }
    // Hydrate REPLACES each projection, so restoring under a live execution
    // would swap the timeline out from under a tick that has already read it.
    if (this.hasInFlightExecution) {
      throw new SessionBusyError({ reason: "cannot restore while an execution is in flight" });
    }
    await this._mountReady;
    await this.hydrateCheckpointBridges(ctx);
  }

  /**
   * Shut down — the `session:command:close` OPERATION (ADR 92 Family 2 §5).
   *
   * The asymmetry this closes: `App.closeApp` and `Gateway.close` have been
   * operations since ADR 84, while the session — the thing an adopter most
   * wants a teardown seam on — tore down as a plain method. Now the whole
   * lifecycle is one grammar: create is an op, close is an op, and
   * `onBeforeSessionClose` is the hold-for-drain seam that had no home.
   *
   * BUS-ONLY by policy (set in the constructor, and long anticipated by the
   * `"session:command:close"` override key there): the body reaches
   * `super.close()`, which fires `onClose` handlers that may tear down the very
   * journal a terminal append would target.
   *
   * The eviction sweep routes through HERE with `reason: "evicted"` rather than
   * around it — page-out and hangup are the same teardown, told apart in the
   * record by their provenance, not by taking different code paths.
   */
  async close(opts?: SessionCloseInput): Promise<void> {
    const reason = opts?.reason ?? "closed";
    await runHarnessProtocol(
      this.sessionOp("close", { reason }, () => Effect.promise(() => this.closeBody(reason))),
    );
  }

  /**
   * The `session:command:close` BODY. The session's own teardown lives in
   * {@link teardown}, which `BaseHarness.close` runs with the inbox detach and
   * the `onClose` unwind guaranteed to follow it — so a bridge or a mount that
   * fails to shut down cannot leave this session's substrate addresses claimed
   * and collide with the next create-or-resume of the same id.
   */
  private async closeBody(reason: SessionCloseReason): Promise<void> {
    this.terminalStatus = reason === "evicted" ? "hibernated" : "closed";
    await super.close();
  }

  /**
   * What the durable record says once this session is down — set by
   * {@link closeBody} and read by {@link teardown}, whose signature the base
   * class fixes. A page-out lands on `hibernated`, which is not an ending: the
   * record stays out of the store's prune sweep and a resume can pick it up.
   */
  private terminalStatus: SessionStatus = "closed";

  protected override async teardown(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.runtime.setStatus(this.terminalStatus);
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
  }

  // ── StateApplicator ──────────────────────────────────────────────

  /**
   * The composable `applyExecutorResult` Effect — the state-applicator
   * `fx` twin the loop composes in-fiber (ADR 77). {@link applyExecutorResult}
   * is the facade.
   *
   * The body is Effect-native ALL THE WAY DOWN to the timeline write. It used to
   * be an `async` method reached through `Effect.tryPromise`, which made this
   * twin a fiber-severing root in its first statement — it composed in the
   * loop's fiber and then immediately left it. Ambient `RuntimeContext`
   * (`tickId`) died there, so the timeline append it performs carried no tick.
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
  ): Effect.Effect<ApplyResult, StateApplyError | SubstrateError, never> {
    return Effect.gen(this, function* () {
      // IN-FIBER mint (ADR 91) — the only legal way for the async body to
      // reach `ctx.metrics`, since a synchronous ambient read from a Promise
      // body is the `readContext()` trap. Minted here rather than threaded as
      // a new parameter through the loop's stateApplicator seam: the body has
      // exactly one caller, so the ADR-77 in-fiber composition is untouched.
      // The facets are LAZY getters, so a session with telemetry off pays for
      // a trunk copy and nothing else.
      const ctx = yield* this.currentOperationCtx();
      return yield* this.applyExecutorResultBody(input, ctx);
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
  ): Effect.Effect<ApplyResult, StateApplyError | SubstrateError, never> {
    return this.applyToolResultsBody(input);
  }

  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      this.sessionOp("apply-tool-results", input, (i) => this.applyToolResultsFx(i)),
    );
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return runHarnessProtocol(this.sessionOp("append", input, (i) => this.appendEntryBody(i)));
  }

  /**
   * Effect-canonical, because the LOOP composes it inside its tick fiber and
   * this body appends to the timeline underneath (the steer drain). `tickId` is
   * ambient ON the fiber; an `async` body would run outside it and those
   * appends would carry no tick — the same defect the applicator had.
   *
   * {@link notifyLifecycle} is the Promise facade for a caller not in a fiber.
   */
  notifyLifecycleFx(
    input: NotifyTickEndInput,
  ): Effect.Effect<TickEndForwardDecision, unknown, never> {
    return Effect.gen(this, function* () {
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
        // COMPOSED. The gates controller is not a harness and declares no ops
        // of its own, but its evaluation WRITES — every transition sets the
        // gate's backing knob. Reaching it through the Promise facade started a
        // root fiber and those writes landed outside the tick (measured:
        // `knobs:command:set` tickless on all three phases). The controller's
        // ONE genuine foreign edge — the adopter's `satisfied` predicate — is
        // wrapped inside `evaluate`, where it belongs.
        yield* this.bridges.gates.handleTickEndFx(result);
      }

      // (b) Tree + gate loop-control requests recorded on the live loop
      // bridge across this tick (`useLoopControl().stop/continueAfterTick`
      // from tree effects, plus the gate holds from (a)). Provenance (ADR
      // 51): only trusted tree code ever emits `stop` — gates only ever
      // `continue` — so a drained `stop` is legitimately a tier-1 halt.
      const loopReq = this.bridges.loop.drainLoopRequests();

      // (a') Compaction (ADR 97). Here rather than in the tree because a
      // component cannot measure the tree it is part of: a render-time trigger
      // reads the PREVIOUS request's size, does not see it change when the fold
      // lands, and fires again on the same number. At tick end the measurement
      // describes the request that just went out and arrives exactly once, so
      // acting twice on one reading is not possible — and the fold can be
      // awaited, landing before the next render instead of racing it.
      //
      // Ahead of the steer drain (b') so the fold sees the conversation as the
      // tick left it; a steer appended first would be folded away before the
      // model ever answered it.
      if (result !== undefined) yield* this.compactIfNeededFx(result);

      // (b') Drain the per-execution STEER queue (ADR 53 §5). Steers
      // enqueued during THIS tick (by a concurrent `send({ onBusy: "steer" })`)
      // are appended to the timeline NOW — after the tick's tool results applied
      // (loop `tickBody` step 4) and BEFORE the next render — so the next tick's
      // compile sees them positioned AFTER this tick's assistant output +
      // tool_results, preserving `tool_use`/`tool_result` adjacency. This bumps
      // `inputEntryCount`, so the (c) steering predicate below fires and holds
      // the loop open for another tick to answer the steer.
      yield* this.drainSteerQueueFx();

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
      // (d) Tick-failure policy (ADR 99 slice 3). Last, because it is the
      // weakest claim in the fold: a tree `stop` and a gate hold are both
      // deliberate, while this only answers "was that failure worth
      // re-issuing?". A failed tick's abstain means STOP at the loop, so
      // returning `continue` here IS the retry.
      if (result !== undefined && this.wantsTickRetry(result)) {
        return { kind: "continue" };
      }
      return undefined;
    });
  }

  /** Promise facade over {@link notifyLifecycleFx}, for a caller not in a fiber. */
  notifyLifecycle(input: NotifyTickEndInput): Promise<TickEndForwardDecision> {
    return runHarnessProtocol(this.notifyLifecycleFx(input));
  }

  /**
   * Whether this tick's failure is worth re-issuing (ADR 99 slice 3). Only a
   * `failed` terminal is eligible — the loop never folds `canceled` / `vetoed`.
   *
   * A failure OUTSIDE the `ExecuteError` family (projection, normalization, an
   * unclassified throw) never retries: the policy's vocabulary is the adapter
   * taxonomy, and those describe a deterministic local failure that re-issuing
   * would reproduce exactly.
   */
  private wantsTickRetry(result: TickResult): boolean {
    const terminal = result.executorTerminal;
    if (terminal.outcome !== "failed" || !isExecuteError(terminal.error)) return false;
    return (
      this.tickFailurePolicy(terminal.error, {
        tickIndex: result.tickIndex,
        consecutiveFailures: result.consecutiveFailures,
      }) === "retry"
    );
  }

  /**
   * Ask the timeline whether it wants to fold, and fold if so (ADR 97).
   *
   * The THRESHOLD is not read here. `shouldCompact` is the strategy's own
   * policy, asked through the harness so the number lives in exactly one place
   * — the duplicate constant in a userland trigger component is what this
   * replaces. What the session contributes is the two facts only it holds: the
   * settled measurement of the request that just went out, and the model's
   * window.
   */
  private compactIfNeededFx(result: TickResult): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      const timeline = this.bridges.timeline;
      if (timeline.shouldCompact === undefined) return;

      const terminal = result.executorTerminal;
      if (terminal.outcome !== "succeeded") return;
      const usedTokens = terminal.result.usage?.inputTokens ?? 0;
      const estimate = terminal.result.estimate;
      if (usedTokens === 0 && estimate === undefined) return;

      if (this._compactRefusedThisExecution) return;

      const target = this.modelFacade.current?.target ?? this.target;
      const contextWindow = target
        ? effectiveModelInfo(target, this.models)?.contextWindow
        : undefined;

      if (
        !timeline.shouldCompact(
          omitUndefined({ usedTokens, contextWindow, estimate }) as CompactDecisionCtx,
        )
      ) {
        return;
      }

      // A fold that throws must not fail the tick — the conversation is intact
      // and oversized, which is recoverable; a failed tick is not. A throw is
      // also a refusal: retrying a summarizer that just died costs a second
      // model call to watch it die again.
      const outcome = yield* Effect.promise(() =>
        timeline.compact().then(
          (r) => r,
          () => undefined,
        ),
      );

      // Read the fold's own report, not the projection version — the harness
      // bumps `version` on every compaction including one that changed nothing,
      // so the version says "a fold ran" where this says "a fold helped".
      if (outcome === undefined || outcome.entriesAfter >= outcome.entriesBefore) {
        this._compactRefusedThisExecution = true;
      }
    });
  }

  // ──────── Extended interaction surface (block 5) ────────

  /**
   * Spawn a child session — the `session:command:spawn` OPERATION (ADR 92
   * Family 2 §4).
   *
   * Spawning is a state-mutating verb that creates a whole new session, so it
   * qualifies under the operation law on its own merits. Before the promotion
   * the only policy an adopter could express over it was the framework's own
   * hardcoded `maxSpawnDepth` ceiling; `onBeforeSessionSpawn` / a guard now
   * makes "this agent may not spawn", "not more than N children", and "not this
   * agent image" adopter-expressible, and the fan-out leaves an audit record.
   *
   * The pairing with `app:command:create-child-session` is deliberate and is
   * the ADR's layering principle in miniature — two REAL layers, two linked
   * records. This layer owns the parent-side concerns (depth ceiling, lineage
   * extension, principal descent, child tracking for teardown cascade); the app
   * layer owns construction and registry admission. The link between them is
   * the `parentOpId` this body reads off its own fiber and threads as data (see
   * {@link SpawnContextChildInput.parentOpId} for why it cannot ride the
   * FiberRef).
   *
   * `fork()` inherits the envelope transitively — a fork IS a spawn plus a
   * restore, and each of the three is its own record.
   */
  async spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
    return runHarnessProtocol(
      this.sessionOp("spawn", input, (i) =>
        Effect.gen(this, function* () {
          // Read the trunk INSIDE the op fiber — this is the one place the
          // spawn's own opId is reachable — and hand it to the app layer as
          // data so the child-create record nests under this one.
          const { opId } = yield* getContext;
          return yield* Effect.tryPromise({
            try: () => this.spawnBody(i, opId),
            catch: (cause): SessionError => coerceSessionError(cause),
          });
        }),
      ),
    );
  }

  /** The `session:command:spawn` BODY — the pre-promotion `spawn` verbatim. */
  private async spawnBody(
    input: SpawnInput<P>,
    parentOpId: string | undefined,
  ): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
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
      // C2 — default a child to a same-image copy of this session. The
      // `SpawnContextChildInput.agent` boundary stays REQUIRED; the session
      // resolves the default (own agent root) before crossing it.
      agent: input.agent ?? this.agentRoot,
      // SP5 — extend the lineage: the child's ancestry is ours plus our id.
      spawnPath: [...this.spawnPath, this.runtime.id],
      ...omitUndefined({
        sessionId: input.sessionId,
        metadata: input.metadata,
        // ADR 48 — ownership descends the session tree: the child inherits
        // OUR principal. Not caller-choosable (no SpawnInput override).
        principal: this.principal,
        initialProps: input.initialProps,
        initialKnobs: input.initialKnobs,
        maxTicks: input.maxTicks,
        // SP6 + EX1 — fan our construction signal AND the spawning execution's
        // teardown signal into the child, as one merged construction signal.
        // The first makes a parent abort tear down the child's in-flight work
        // (PA1 merge-into-execution); the second does the same for a cancelled
        // TURN, so a sub-agent never outlives the execution that asked for it.
        // A spawn outside any execution merges to just the construction signal
        // (`mergeAbortSignals` drops the undefined and hands the single signal
        // back untouched), which is the old behavior, listener included.
        //
        // TODO(spawn-signal-listener-lifetime): an IN-EXECUTION spawn does
        // build a composite, which leaves one `abort` listener on the (possibly
        // app-wide, possibly very long-lived) construction signal for each such
        // spawn — `mergeAbortSignals` returns no disposer to unregister with.
        // Bounded by spawn count, and each spawn already allocates a session,
        // so it is a smell rather than a leak; the fix is a disposing merge in
        // `@agentick/utils`, which is a shared-signature change.
        signal: mergeAbortSignals(this.constructionSignal, this._currentExecutionAbort?.signal),
        // EX1 — the origin edge, stamped on the child's registry entry and its
        // durable record. The live signal above covers cancelling a RUNNING
        // execution; this is what still identifies the branch after that
        // execution settled (`app.abortExecutionTree`).
        originExecutionId: this.runtime.currentExecutionId() ?? undefined,
        originCallId: input.originCallId,
        // ADR 92 — the causal link to THIS spawn op (see `spawn`'s docblock).
        parentOpId,
      }),
    };
    const child = await this.spawnContext.createChildSession(childInput);
    // SP6 — track the child so parent close / abort disposes it (see the
    // teardown wired in the constructor). Idempotent on the child id.
    this._children.add(child.id);
    if (input.send === undefined) return child;
    const childHandle = await child.send(input.send);
    // Spawn boundary events (parent stream). ONLY the spawn-and-run form is
    // bracketed: it is the only form with a child execution the parent can
    // name. An unbound spawn hands the child back and the caller drives it —
    // its executions are not this execution's business.
    //
    // `emit` is captured, not re-read at the end: the pair belongs to the
    // execution that ASKED for the spawn, and the child may outlive it (a
    // closed handle drops the late `spawn-end`, which is the honest outcome —
    // the parent's stream is over).
    const emit = this._currentEmit;
    if (emit !== null) {
      const tick = this.runtime.currentTick();
      emit({
        type: "spawn-start",
        tick,
        spawnSessionId: child.id,
        spawnExecutionId: childHandle.executionId,
        ...omitUndefined({ originCallId: input.originCallId }),
      });
      void childHandle.result.then(
        () => emit({ type: "spawn-end", tick, spawnSessionId: child.id, isError: false }),
        () => emit({ type: "spawn-end", tick, spawnSessionId: child.id, isError: true }),
      );
    }
    return childHandle;
  }

  /**
   * The model this session is about to call, and what is known about it.
   *
   * Reads the LIVE target — `modelFacade.current`, not the construction-bound
   * one — so a runtime swap (`session:set-model`, a spawn override) is
   * reflected immediately rather than after the next turn lands its
   * provenance. That is the whole reason this exists alongside the app-scoped
   * lookup: the app knows its default, the session knows what is actually
   * bound.
   *
   * Same fold the render path uses for `contextInfo` — `effectiveModelInfo`
   * against the session's registry — so the number a client sees is the number
   * the tree saw.
   */
  modelInfo(): ModelInfoResult | undefined {
    const target = this.modelFacade.current?.target ?? this.target;
    if (target?.provider === undefined || target.modelId === undefined) return undefined;
    const info = effectiveModelInfo(target, this.models);
    return {
      provider: target.provider,
      modelId: target.modelId,
      info: info ? modelFactsOf(info) : null,
    };
  }

  async fork(input: ForkInput = {}): Promise<SessionHarnessProtocol<P>> {
    // C2 — a fork is spawn(no send, own agent root) + branch + restore.
    // `snapshot()` FIRST, because it is the flush barrier: every store-backed
    // bridge drains to its store, so the scopes the child branches from are
    // complete as of the fork instant (checkpointing §5). `spawn({})` defaults
    // `agent` to `this.agentRoot` (same-image child) and returns the unbound
    // child (no `send`).
    await this.snapshot();
    // C2 — a fork is a same-image copy: the branch fan-out copies every
    // store-backed bridge's scope onto the child, but the record's adopter
    // `metadata` bag rides no harness store. So when the caller does NOT
    // override `metadata`, the fork inherits the PARENT's bag (this session
    // knows its own metadata). An explicit `ForkInput.metadata` wins.
    // (Spawn does NOT auto-inherit metadata — a spawned child is a NEW session;
    // adopter-selective inheritance rides the `onSessionCreate` reshape arm.)
    const parentMeta =
      Object.keys(this.metadata).length > 0
        ? (this.metadata as Readonly<Record<string, unknown>>)
        : undefined;
    const child = (await this.spawn({
      ...omitUndefined({
        sessionId: input.sessionId,
        metadata: input.metadata ?? parentMeta,
        maxTicks: input.maxTicks,
      }),
    })) as SessionHarnessProtocol<P>;
    // Branch THEN restore. The branch copies this session's durable scopes onto
    // the child's at the store layer; the restore's hydrate fan-out opens the
    // child on that copy.
    if (child instanceof SessionHarness) await child.branchCheckpointBridges(this.runtime.id);
    await child.restore();
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

  channel<T = unknown>(name: string): ChannelHandle<T> {
    const fullName = `session:channel:${name}`;
    const sessionId = this.runtime.id;
    const scope = omitUndefined({ sessionId, principal: this.principal });
    const bus = this.bus;
    const inbox = this.inbox;
    const sessionAddress = this.address;
    return {
      name,
      publish: async (payload: T, metadata?: Readonly<Record<string, unknown>>) => {
        const ev: ProtocolEvent = {
          id: generateId(),
          surface: "session",
          name: fullName,
          phase: "delta",
          timestamp: Date.now(),
          scope,
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
                const meta: import("@agentick/spec").ChannelEventMeta = {
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
        listener: (payload: TReq, ctx: import("@agentick/spec").RequestContext<TResp>) => void,
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
                const ctx: import("@agentick/spec").RequestContext<TResp> = {
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
   * A RUNNING session with an outstanding ask is `input_required`; answering the
   * last one resumes it. This is what makes "action required over there" a frame
   * on the status channel rather than something a UI learns only by opening the
   * session. NOT `paused`, which is reserved for an operator stopping a session.
   *
   * TWO kinds of ask block a session, and they are the same blocked state: an
   * elicitation, and a client-handled tool call the browser has not answered
   * yet. Both subscribe to the OPERATION rather than the channel because only
   * the op has both edges — see {@link ELICITATION_ELICIT_COMMAND} and
   * {@link TOOL_CLIENT_CALL_COMMAND}. Op ids from both land in ONE set, so
   * concurrent asks of either kind are one blocked state and a replayed
   * terminal cannot drive the count negative.
   *
   * Both flips are guarded on the current status, which is what enforces the
   * rules: an ask raised outside an execution never blocks an idle session, and
   * an execution that ends with asks still outstanding lands on `idle` — the
   * ending beats the block, and nothing later resurrects `running`.
   */
  private trackBlockedOnInput(): void {
    const outstanding = new Set<string>();
    const fold = (event: ProtocolEvent): void => {
      const opId = (event as { opId?: string }).opId;
      if (opId === undefined) return;
      if (event.phase === "requested") outstanding.add(opId);
      else outstanding.delete(opId);

      const status = this.runtime.status();
      if (outstanding.size > 0 && status === "running") {
        this.runtime.setStatus("input_required");
      } else if (outstanding.size === 0 && status === "input_required") {
        this.runtime.setStatus("running");
      }
    };
    const watch = (surface: EventSurface, name: string): Fiber.RuntimeFiber<void, unknown> =>
      Effect.runFork(
        Stream.runForEach(
          this.bus.subscribe({
            surface,
            name: { exact: name },
            phase: ["requested", "terminal"],
            scope: { sessionId: this.runtime.id },
          }),
          (event) => Effect.sync(() => fold(event)),
        ),
      );
    const fibers = [
      watch("elicitation", ELICITATION_ELICIT_COMMAND),
      watch("tool", TOOL_CLIENT_CALL_COMMAND),
    ];
    this.onClose(() => {
      for (const fiber of fibers) void Effect.runPromise(Fiber.interrupt(fiber));
    });
  }

  /**
   * `session:channel:status` — the NOTIFY half of the pair whose enumerate half
   * is `SessionRecord.status` on every `list_sessions` row.
   *
   * Fire-and-forget by construction: `notifyChannel` swallows a bus-append
   * failure, so a dropped frame can never fail the execution whose start or end
   * produced the transition.
   */
  private publishStatusTransition(status: SessionStatus, outcome?: SessionRunOutcome): void {
    Effect.runFork(
      this.notifyChannel<SessionStatusFrame>(
        SESSION_STATUS_CHANNEL,
        this.statusFrame(status, outcome),
        { scope: omitUndefined({ sessionId: this.runtime.id, principal: this.principal }) },
      ),
    );
  }

  private statusFrame(status: SessionStatus, outcome?: SessionRunOutcome): SessionStatusFrame {
    return omitUndefined({
      sessionId: this.runtime.id,
      status,
      executionId: this.runtime.currentExecutionId() ?? undefined,
      outcome,
    }) as SessionStatusFrame;
  }

  /**
   * The status channel's opening frame — the session's CURRENT status, so a
   * client that reconnects mid-execution renders "running" from frame one
   * instead of looking idle until the next transition.
   */
  private readonly statusSnapshotProvider: ChannelSnapshotProvider = {
    snapshotChannel: SESSION_STATUS_CHANNEL,
    channelSnapshotPayload: () => this.statusFrame(this.runtime.status()),
  };

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
      id: generateId(),
      surface: "session",
      name: channelEventName(channel),
      phase: "delta",
      timestamp: Date.now(),
      scope: omitUndefined({ sessionId: this.runtime.id, principal: this.principal }),
      payload,
    };
  }

  /**
   * Build (once) the `channel → ChannelSnapshotProvider` index by scanning the
   * session's owned harnesses for one passing {@link isChannelSnapshotProvider}.
   * No hardcoded slot list — any harness that conforms is discovered
   * generically (mirrors the checkpoint feature-detection pattern).
   *
   * The candidate set is every bridge value PLUS `this.toolExecutor`: the tool
   * executor is a session-owned harness held OUTSIDE `bridges` (the `tools`
   * bridge slot is a render-time handler-resolver adapter, not the executor),
   * yet it OWNS the `tool_call` request channel and provides its pending-call
   * snapshot (§6.1). Feature-detection still keeps the scan slot-agnostic — the
   * executor and {@link statusSnapshotProvider} are just further candidates,
   * discovered by shape.
   */
  private snapshotProviders(): Map<string, ChannelSnapshotProvider> {
    if (this._snapshotProviders === null) {
      const map = new Map<string, ChannelSnapshotProvider>();
      const candidates: readonly unknown[] = [
        ...Object.values(this.bridges),
        this.toolExecutor,
        this.statusSnapshotProvider,
      ];
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
      //
      // The rejection MUST be marked handled, not merely `void`ed: `set`'s
      // failure channel is `SubstrateError` (a guard veto, a middleware
      // failure, a store write failure all land there), and an un-handled
      // rejection from a fire-and-forget promise nobody can await takes the
      // process down. Swallowing is the contract of a SYNC setter — it has no
      // channel to report on. An adopter who needs the outcome awaits
      // `session.bridges.knobs.set(...)` directly instead of this handle.
      // TODO(phase-3): route the swallowed cause to the harness log surface
      // (`emitLog`) so a rejected knob write is at least observable.
      set: (value: T) => {
        void bridge.set({ id: name, value: value as string | number | boolean }).catch(() => {});
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
   * (`session:<verb>:<id>`) — session verbs carry no caller-supplied
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
      opId: `session:${verb}:${generateId()}`,
      surface: "session",
      name: `session:command:${verb}`,
      scope: {},
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
        ? { toolName: DEFAULT_TERMINAL_TOOL_NAME, schema: input.output, strategy: "auto" }
        : undefined;

    // Busy-send behavior (ADR 53 §5). `"steer"` = join the in-flight turn;
    // `"queue"` = wait for the session to fully quiesce, then run a fresh
    // execution (never joins the in-flight turn). SMART DEFAULT when unset: a
    // send carrying structured output (`output`/`responseFormat`) defaults to
    // `"queue"` — a steer has no final turn of its own to shape — so it never
    // reaches the join-point guard below; a plain send defaults to `"steer"`.
    // Only EXPLICIT `onBusy: "steer"` can carry structured output into the
    // guard.
    const explicitSteer = input.onBusy === "steer";
    const onBusy =
      input.onBusy ??
      (input.output !== undefined || input.responseFormat !== undefined ? "queue" : "steer");

    if (onBusy === "queue") {
      // QUEUE: block until the session is truly idle (the in-flight
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
            // shape. Reject an EXPLICIT `onBusy: "steer"` carrying structured
            // output (`responseFormat` OR the live `output` schema) loud rather
            // than silently dropping the directive or auto-upgrading the mode.
            // An implicit structured send never reaches here — the smart
            // default resolved it to `"queue"` above — so `explicitSteer`
            // guards the throw (a plain steer-default send carries no output).
            if (
              explicitSteer &&
              (input.responseFormat !== undefined || input.output !== undefined)
            ) {
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
    let reserveResolve!: (h: import("@agentick/spec").SessionExecutionHandle) => void;
    let reserveReject!: (e: unknown) => void;
    const reservationPromise = new Promise<import("@agentick/spec").SessionExecutionHandle>(
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

    const executionId = `exec:${generateId()}`;

    // Input appends the moment it arrives (ADR 53 §2.1) — no queue, no
    // drain. The first tick's render sees it via <Timeline/>.
    for (const m of input.messages ?? []) await this.appendInputMessage(m, executionId);

    // ADR 53: the first render will include everything appended so far.
    this._inputEntriesSeen = this.bridges.timeline.inputEntryCount();
    // A new turn is new material — a fold that could not help last turn may be
    // able to now (ADR 97).
    this._compactRefusedThisExecution = false;
    this._executionRollup = undefined;

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
    // EX1 — the execution's downstream teardown signal (see
    // {@link _currentExecutionAbort}). Published on the session BEFORE the loop
    // runs, so a `spawn()` from inside a tool handler fans it into the child.
    const executionAbort = new AbortController();
    this._currentExecutionAbort = executionAbort;
    const resultDeferred = {} as { resolve: (r: SendResult) => void; reject: (e: unknown) => void };
    // How this run ENDED, captured at the settle so the running→idle transition
    // can carry it. An abort RESOLVES with `stopReason: "aborted"` rather than
    // rejecting, so the reject arm is genuine failure only.
    let runOutcome: SessionRunOutcome = "succeeded";
    const resultPromise = new Promise<SendResult>((resolve, reject) => {
      resultDeferred.resolve = (result) => {
        runOutcome = runOutcomeOf(result.stopReason);
        resolve(result);
      };
      resultDeferred.reject = (error) => {
        runOutcome = "failed";
        reject(error);
      };
    }).finally(() => {
      this._currentExecution = null;
      this._currentHandle = null;
      this._currentEmit = null;
      this._currentExecutionAbort = null;
      this._handleReservation = null;
      this.runtime.setCurrentExecutionId(null);
      this.runtime.setStatus(
        durabilityFailed ? "failed" : "idle",
        durabilityFailed ? "failed" : runOutcome,
      );
      // 4b — the session is now truly idle. Release quiescence waiters
      // (`whenQuiescent` / queued sends) AFTER the reservation clears.
      settledResolve();
      // 4b — re-dispatch any undrained steers as a fresh queued turn.
      // Deferred to a microtask so the reservation is observably clear
      // before the new send runs (it would otherwise re-enter the join
      // guard against the dying handle). Dropped if the session is closing.
      if (redispatchSteers !== null && !this._closed) {
        const msgs = redispatchSteers;
        redispatchSteers = null;
        queueMicrotask(() => {
          if (this._closed) return;
          void this.send({ messages: msgs, onBusy: "queue" }).catch(() => undefined);
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
        // EX1 — tear down what this execution spawned FIRST: a child must stop
        // before the parent waiting on it unwinds (the same deepest-first rule
        // destroy's walk follows). Synchronous — firing the signal only
        // schedules the children's teardown; it does not wait on it.
        executionAbort.abort(new Error(reason ?? "origin execution aborted"));
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
                // The tab that asked, carried for the run's life — a tool call
                // relayed on tick 6 still knows where the request came from.
                ...omitUndefined({ connectionId: input.connectionId, clientId: input.clientId }),
                // ADR 48 — the app-level model executor has no principal of its
                // own, so this execution's owner rides the scope it is handed.
                ...omitUndefined({ principal: this.principal }),
                compiler: this.compiler,
                mountId: this.mountId,
                modelExecutor: modelExecutorForCall,
                target: targetForCall,
                // The app-level pricing seam, forwarded verbatim. The loop
                // consults it per tick at settlement, where it beats the
                // resolved target's declared `rates`.
                ...omitUndefined({ costResolver: this.costResolver }),
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
                notifyTickEnd: (i) => this.notifyLifecycleFx(i),
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
                // ADR 99 slice 2 — the hard backstop under `tickFailurePolicy`.
                // Absent, the loop's own default (3) applies.
                ...omitUndefined({ maxConsecutiveFailedTicks: this.maxConsecutiveFailedTicks }),
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
                // C2 — per-execution tool RESTRICTION. The loop filters the
                // merged model-visible list to these canonical names BEFORE
                // terminal-tool injection; dispatch-door tools are unaffected.
                ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
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
    this._currentEmit = emit;
    this._handleReservation?.resolve(handle);
    // Latch loop completion SYNCHRONOUSLY on settle — joins during the
    // terminal window (endTurn/flush/resolve) must be refused. Safe to leave
    // un-`catch`ed: both branches are supplied (so `runPromise`'s rejection is
    // consumed) and neither can throw — the derived promise cannot reject.
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
    const settled = runPromise.then(
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
        // EX1 — the same rule the steer queue just applied, applied to the
        // execution's SPAWNED work: an execution that did not complete
        // (`canceled`, `timeout` — `executor_failed` / `max_ticks` / a veto all
        // report `succeeded`, having completed a real turn) cancels the
        // sub-agents it started. This is the path a TIMEOUT takes, which
        // `handle.abort` never sees. On success the children survive
        // deliberately: that is the case `app.abortExecutionTree` exists for.
        if (terminal.outcome !== "succeeded") {
          executionAbort.abort(
            new Error(`origin execution ${terminal.outcome}: ${terminal.reason ?? ""}`),
          );
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
            // The loop RESOLVES both kinds of refusal — a provider failure and a
            // guard veto arrive as `outcome: "succeeded"` with the stop reason
            // naming what happened. The record must launder NEITHER: this site
            // already caught the provider case, and read a vetoed turn as
            // `succeeded`, which made a refused turn indistinguishable on the
            // timeline from one that answered.
            outcome:
              terminal.outcome === "succeeded"
                ? terminal.result?.stopReason === "executor_failed"
                  ? "failed"
                  : terminal.result?.stopReason === "vetoed"
                    ? "vetoed"
                    : "succeeded"
                : "aborted",
            // The CAUSE rides the record too — the only account a reloaded client
            // can read, since a turn that died before its first tick appended no
            // assistant entry at all.
            ...omitUndefined({
              usage: this._executionRollup?.usage,
              // The turn's per-model breakdown + cost, folded from the same
              // per-tick stream the flat `usage` above comes from — so the
              // three never disagree. `cost` is `partial` when any tick of
              // this turn was unpriced.
              byModel: this._executionRollup?.byModel,
              cost: this._executionRollup?.cost,
              stopCause: terminal.result?.stopCause,
              // The target that ran the turn. A SUCCEEDED boundary is a proof that every
              // entry it carried was projectable — but only for this target, so a reader
              // narrowing suspects to "entries since the last success" can tell a
              // comparable success from one across a failover or a model swap.
              target: boundaryTarget(targetForCall),
            }),
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
        // A CANCELED terminal that carries a result is a real, settled turn —
        // the loop ran it to its abort point and reports what happened
        // (`ticks`, partial `output`, `usage`, and a `stopReason` that already
        // NAMES the cancellation: "aborted" / "timeout"). Resolve it, exactly
        // as a natural end resolves; `SendResult.stopReason` is where a caller
        // reads the cancellation. Only a terminal with NO result (nothing to
        // report) rejects.
        //
        // This is the session-side half of the loop's ratified abort semantics
        // (2026-07-27): the loop reports `canceled` for BOTH entry points (a
        // caller `signal` abort AND `abort()`), so the session must not make the
        // caller's `.result` settle differently depending on which one fired.
        // Before the ruling, a signal abort reached here as `succeeded` (and
        // resolved) while `abort()` reached here as `canceled` (and rejected) —
        // the same divergence, one layer up. Note the ADR 49 boundary record
        // above ALREADY treats this terminal as a settled turn (`outcome:
        // "aborted"`, not a failure); resolving keeps the two in agreement.
        if (result && (terminal.outcome === "succeeded" || terminal.outcome === "canceled")) {
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
            // Lifted from the loop's run result, exactly as the flat `usage`
            // beside them is: the loop is the accounting authority for the
            // run (it sees every tick, including ones that appended no
            // entry). Absent when the run recorded no usage; `cost` is
            // `partial` when any tick was unpriced — never a zero `complete`.
            ...omitUndefined({ byModel: result.byModel, cost: result.cost }),
            stopReason: result.stopReason,
            ticks: result.ticks,
            executionId,
            ...(result.data !== undefined ? { data: result.data } : {}),
            // `executor_failed` and `vetoed` both RESOLVE — so a caller's `.catch`
            // never runs and this is the ONLY place they can read what happened.
            ...(result.stopCause !== undefined ? { stopCause: result.stopCause } : {}),
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
        // EX1 — and cancel what it spawned, for the same reason: there was no
        // turn for those sub-agents to be doing work for.
        executionAbort.abort(err instanceof Error ? err : new Error("origin execution failed"));
        // The execution error wins as the rejection reason; the barrier
        // still runs so a completed-but-unflushed prefix lands in the
        // store (best-effort — a flush failure here latches "failed"
        // status but does not mask the execution error).
        await this.bridges.timeline
          .endTurn({
            executionId,
            outcome: "failed",
            ...omitUndefined({
              usage: this._executionRollup?.usage,
              byModel: this._executionRollup?.byModel,
              cost: this._executionRollup?.cost,
              target: boundaryTarget(targetForCall),
            }),
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
    // Settle-path safety net. The `.then(onSettled, onFailed)` above consumes
    // the loop's own rejection, but the DERIVED promise has no consumer: a
    // throw from INSIDE either handler, before it settles `resultDeferred`,
    // would leave the caller's `.result` pending forever while the throw
    // escaped as an unhandled rejection. Route it to the one place that can
    // still report it. Both calls are idempotent (a settled promise ignores a
    // second settle; `close()` guards on `done`), so a handler that already
    // finished its work is undisturbed.
    void settled.catch((err: unknown) => {
      resultDeferred.reject(err);
      close();
    });

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
          emit({
            type: "tick-start",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            ...omitUndefined({ retryOfTick: loopEvent.retryOfTick }),
          });
          return;
        case "tick-end":
          emit({
            type: "tick-end",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            shouldContinue: loopEvent.shouldContinue,
            // The wire `StreamEvent` types are explicitly-fielded — nothing
            // rides automatically. `omitUndefined` keeps an unpriced tick's
            // payload free of a `cost` key entirely: absent means unpriced,
            // and a serialized `cost: null` would be a different (wrong)
            // claim.
            ...omitUndefined({
              stopReason: loopEvent.stopReason,
              usage: loopEvent.usage,
              cost: loopEvent.cost,
              model: loopEvent.model,
            }),
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
            ...omitUndefined({ cost: loopEvent.cost, model: loopEvent.model }),
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
        case "execution":
          // Run-level summary. `ticks` mirrors the loop's final `tick` — the
          // event fires once, at the terminal, so the two are the same count.
          emit({
            type: "execution",
            tick: loopEvent.tick,
            output: loopEvent.output,
            usage: loopEvent.usage,
            // The run's per-model breakdown + cost. Sourced from the session's
            // own per-tick fold rather than the loop event (which carries only
            // the flat bag), so the wire summary matches the turn-boundary
            // record byte for byte. The summary fires at the terminal, after
            // every tick has been applied.
            ...omitUndefined({
              byModel: this._executionRollup?.byModel,
              cost: this._executionRollup?.cost,
            }),
            stopReason: loopEvent.stopReason,
            ticks: loopEvent.tick,
            durationMs: loopEvent.durationMs,
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
            ...omitUndefined({ presentation: loopEvent.presentation }),
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
            ...omitUndefined({
              executedBy: loopEvent.executedBy,
              isError: loopEvent.isError,
              presentation: loopEvent.presentation,
              metadata: loopEvent.metadata,
            }),
          });
          return;
      }
    };
  }

  private applyExecutorResultBody(
    input: ApplyExecutorResultInput,
    ctx: OperationCtx,
  ): Effect.Effect<ApplyResult, TimelineWriteFailed | SubstrateError, never> {
    return Effect.gen(this, function* () {
      const ids: string[] = [];
      const { usage, cost, model } = input.result;
      if (input.result.output.length > 0) {
        const id = yield* this.appendMessageEntryFx({
          role: "assistant",
          content: input.result.output,
          // ADR 53 §2.2: one tick = one generation = one assistant entry;
          // stamp provenance + the GENERATION's usage on the record — plus the
          // model that produced it and what it cost, computed ONCE at act time.
          // Usage without model identity cannot be priced, and a cost that is
          // recomputed on read reprices history every time a rate changes.
          // Absent `cost` = the tick was UNPRICED, which is a fact, not a zero.
          metadata: {
            executionId: input.executionId,
            tickId: input.tickId,
            ...omitUndefined({ tickIndex: input.tickIndex, usage, cost, model }),
          },
        });
        ids.push(id);
      }
      // Fold the tick into BOTH the turn-level rollup and the session record.
      //
      // NOTE the session record is deliberately NOT a place a SPAWNED child's
      // cost lands: a child folds into its OWN record, and "what did this agent
      // tree cost" is a query over `spawnPath`, never a write-time rollup —
      // write-time double-counts and freezes one scope answer (usage-cost §7.1).
      // Gated on `usage` because "no usage at all" is not an unpriced tick — it
      // is nothing to account for, and folding it would push a `partial` cost
      // onto a turn that never generated. With usage present but no cost, the
      // fold degrades the rollup to `partial` and counts the tick unpriced;
      // it never contributes a zero to a `complete` total.
      if (usage !== undefined) {
        this._executionRollup = foldUsageRollup(this._executionRollup, model, usage, cost);
        this.runtime.addTickAccounting(usage, model, cost);
        // The metrics plane, mirroring what the two folds above just recorded
        // durably. Same stamp, second projection — never a second source.
        this.mirrorTickAccounting(ctx.metrics, usage, model, cost);
      }
      this.runtime.bumpTick();
      return { appendedEntryIds: ids };
    });
  }

  /**
   * Project one settled tick's accounting onto the metrics plane — see the
   * {@link TICK_COST_METRIC} note for why this is a mirror and never a source.
   * Called only when the tick reported usage: a tick that generated nothing is
   * not an unpriced tick, it is nothing to account for.
   *
   * Every `ctx.metrics` call is a no-op against a frozen singleton when no
   * meter is wired, so a telemetry-off session pays for two small label
   * objects per tick and nothing else.
   *
   * **Labels are deliberately bounded**: `provider` / `modelId` (a deployment
   * has a handful), `currency` (ISO-4217, effectively one), `kind` (the five
   * {@link TokenKind}s). NOT `rateRef` — it is adopter-chosen and DATED, so a
   * new time series is minted on every price change, forever. NOT sessionId /
   * executionId / tickId — per-tick identity is the definition of a
   * cardinality explosion; it rides spans and logs, never a metric label.
   */
  private mirrorTickAccounting(
    metrics: Metrics,
    usage: UsageStats,
    model: Pick<ExecutionTarget, "provider" | "modelId"> | undefined,
    cost: Cost | undefined,
  ): void {
    const modelLabels: MetricLabels = {
      ...(model?.provider !== undefined ? { provider: model.provider } : {}),
      ...(model?.modelId !== undefined ? { modelId: model.modelId } : {}),
    };
    // A priced tick contributes its amount. An UNPRICED one contributes to a
    // COUNTER rather than a zero to the histogram — the metrics-plane
    // expression of the honesty rule (usage-cost §6). A dashboard showing
    // spend must also be able to show how much of the spend it could not see;
    // without this counter a consumer reads a total that is confidently,
    // silently low, which is the exact defect this vertical exists to prevent.
    if (cost !== undefined) {
      metrics.record(TICK_COST_METRIC, cost.amountMicros, {
        ...modelLabels,
        currency: cost.currency,
      });
    } else {
      metrics.count(TICK_UNPRICED_METRIC, 1, modelLabels);
    }
    for (const [kind, read] of TICK_TOKEN_KINDS) {
      const tokens = read(usage);
      if (tokens !== undefined) {
        metrics.record(TICK_TOKENS_METRIC, tokens, { ...modelLabels, kind });
      }
    }
  }

  private applyToolResultsBody(
    input: ApplyToolResultsInput,
  ): Effect.Effect<ApplyResult, TimelineWriteFailed | SubstrateError, never> {
    return Effect.gen(this, function* () {
      const ids: string[] = [];
      for (const tr of input.results) {
        const block: ContentBlock = {
          type: "tool_result",
          toolUseId: tr.toolCallId,
          name: tr.toolName,
          content: tr.content,
          ...(tr.succeeded === false ? { isError: true } : {}),
        };
        const id = yield* this.appendMessageEntryFx({
          role: "tool",
          content: [block],
          toolCallId: tr.toolCallId,
          name: tr.toolName,
          metadata: {
            executionId: input.executionId,
            tickId: input.tickId,
            ...omitUndefined({ tickIndex: input.tickIndex }),
          },
        });
        ids.push(id);
      }
      return { appendedEntryIds: ids };
    });
  }

  private appendEntryBody(
    input: AppendEntryInput,
  ): Effect.Effect<ApplyResult, TimelineWriteFailed | SubstrateError, never> {
    return this.appendMessageEntryFx({
      role: input.entry.role,
      content: input.entry.content,
    }).pipe(Effect.map((id) => ({ appendedEntryIds: [id] })));
  }

  /**
   * Drain the per-execution steer queue (queue-item 4b) — append every
   * queued steer message to the timeline, in enqueue order, via the same
   * {@link appendInputMessage} path a fresh send uses (so string/blocks +
   * metadata normalize identically). Swaps the buffer out FIRST so a steer
   * that arrives while we await the appends lands in the next drain, not this
   * one. A no-op when the queue is empty (the hot per-tick path).
   */
  private drainSteerQueueFx(): Effect.Effect<void, TimelineWriteFailed | SubstrateError, never> {
    return Effect.gen(this, function* () {
      if (this._steerQueue.length === 0) return;
      const pending = this._steerQueue;
      this._steerQueue = [];
      const executionId = this.runtime.currentExecutionId() ?? undefined;
      for (const m of pending) yield* this.appendInputMessageFx(m, executionId);
    });
  }

  /**
   * Append a user-input message directly to the timeline (ADR 53 §2.1)
   * — the user's words are a fact the moment they arrive. `executionId` is
   * the execution the input OPENS, stamped in the same metadata slot the
   * assistant / tool entries carry theirs in, so a reader can tell an
   * unanswered turn from a settled one without waiting for a tick.
   */
  private appendInputMessageFx(
    m: SendMessageInput,
    executionId?: string,
  ): Effect.Effect<void, TimelineWriteFailed | SubstrateError | InvalidMediaSource, never> {
    const content =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    // Rejected AT THE DOOR: past it the block is durable and replays into a
    // provider rejection on every later turn of the session.
    for (const [index, block] of content.entries()) {
      const source = (block as { source?: { type?: string; data?: unknown } }).source;
      if (
        source?.type === "base64" &&
        typeof source.data === "string" &&
        source.data.startsWith("data:")
      ) {
        return Effect.fail(new InvalidMediaSource({ blockIndex: index, blockType: block.type }));
      }
    }
    const metadata = { ...m.metadata, ...omitUndefined({ executionId }) };
    return this.appendMessageEntryFx({
      role: m.role,
      content,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }).pipe(Effect.asVoid);
  }

  /**
   * Promise facade over {@link appendInputMessageFx}. Used by `sendBody`, which
   * is still `async` — it sits at the top of the user-facing send path, so it
   * has no ambient fiber to preserve and paying a root here costs nothing. Once
   * `sendBody` is Effect-native it should compose the twin instead.
   */
  private appendInputMessage(m: SendMessageInput, executionId?: string): Promise<void> {
    return runHarnessProtocol(this.appendInputMessageFx(m, executionId));
  }

  /**
   * Internal helper — build a `TimelineEntry` for a message and route
   * the append through the TimelineHarness. Returns the message id so
   * `StateApplicator` callers can include it in their `ApplyResult`.
   */
  /**
   * Append one message entry IN THE CALLER'S FIBER, returning its id.
   *
   * Effect-canonical because `RuntimeContext` — which carries `tickId` — is
   * ambient ON the fiber, and a `runPromise` root severs it. This used to await
   * the timeline's Promise facade, so every `timeline:append` operation the
   * session produced was built with no tick on its scope: the recorder could not
   * join tap ⑤ to its tick, and no timeline envelope on the bus was
   * attributable to the tick that caused it.
   */
  private appendMessageEntryFx(input: {
    readonly role: import("@agentick/spec").SessionMessageRole;
    readonly content: readonly ContentBlock[];
    readonly visibility?: "model" | "observer" | "log";
    readonly toolCallId?: string;
    readonly name?: string;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Effect.Effect<string, TimelineWriteFailed | SubstrateError, never> {
    const messageId = `m_${generateId()}`;
    const message: import("@agentick/spec").SessionMessage = {
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
    return this.bridges.timeline.fx.append([entry]).pipe(Effect.as(messageId));
  }

  /** Promise facade over {@link appendMessageEntryFx}, for callers not in a fiber. */
  private async appendMessageEntry(input: {
    readonly role: import("@agentick/spec").SessionMessageRole;
    readonly content: readonly ContentBlock[];
    readonly visibility?: "model" | "observer" | "log";
    readonly toolCallId?: string;
    readonly name?: string;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    return runHarnessProtocol(this.appendMessageEntryFx(input));
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

/**
 * The identity fields a turn boundary records about the target that ran it.
 *
 * `undefined` when the turn ended before a target resolved, and `undefined` again when
 * neither field is known — an empty object on the record would read as "a target ran this
 * and we know nothing about it", which is a different claim from "no target resolved".
 *
 * Only `provider` + `modelId`: capabilities are large, change with the code rather than
 * with the turn, and would bloat every entry in a durable log to say something a reader
 * can look up. Identity is what a "is this success comparable to that one" question needs.
 */
function boundaryTarget(
  target: ExecutionTarget | undefined,
): { readonly provider?: string; readonly modelId?: string } | undefined {
  if (target === undefined) return undefined;
  const fields = omitUndefined({ provider: target.provider, modelId: target.modelId });
  return Object.keys(fields).length > 0 ? fields : undefined;
}
