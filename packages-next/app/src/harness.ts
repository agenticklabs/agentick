/**
 * `AppHarness` — reference implementation of `AppHarnessProtocol`.
 *
 * The outermost runtime boundary. Constructs and owns the shared
 * substrate (journal, bus, inbox) and the shared sub-harnesses
 * (compiler, loop executor) used by every session it spawns. Each
 * session gets its own `SessionHarness` instance plus its own per-session
 * tool executor scope (so JSX-declared tools don't bleed between
 * sessions) while sharing the language-model executor (provider clients
 * are session-agnostic).
 *
 * The MVP surface — `createSession`, `runOnce`, `getSession`,
 * `listSessions`, `closeApp` — matches the 4f spec. App-level
 * interceptors / observers (`use()`), cross-session bus subscription
 * (`events()`), persistence and telemetry Layers are deferred to
 * follow-ups.
 *
 * @see docs/proposals/v2/blueprint/09-app-harness.md
 */

import { Effect, ManagedRuntime } from "effect";

import {
  BaseHarness,
  busAsyncIterator,
  type CommandHooks,
  forkBusSubscription,
  type HarnessShell,
  hooksToMiddlewares,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  type TelemetryProvider,
  ulid,
} from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { TasksHarness, InMemoryTaskStore } from "@agentick/tasks-next";
import type { TaskExecutor, TaskStore } from "@agentick/tasks-next";
import type { TaskWakePolicy } from "@agentick/spec-next";
import { ResourcesHarness } from "@agentick/resources-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { isLanguageModelAdapter, type LanguageModelAdapter } from "@agentick/model-next";
import {
  buildTelemetryInterceptors,
  normalizeTelemetry,
  type NormalizedTelemetry,
} from "./telemetry-defaults.js";
import { buildTelemetryExport } from "./telemetry-wiring.js";
import { LanguageModelExecutor as TheLanguageModelExecutor } from "@agentick/model-executor-next";
import {
  SessionHarness,
  InMemorySessionStore,
  type SessionHarnessOptions,
} from "@agentick/session-next";
import type {
  SessionRecord,
  SessionStore,
  SessionStoreQuery,
  SnapshotMigration,
} from "@agentick/spec-next";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
  type ToolExecutorHarnessOptions,
  type ToolHandler,
} from "@agentick/tool-executor-next";
import {
  AppClosedError,
  AppExecutionFailed,
  DEFAULT_JOURNALING_POLICY,
  HandlerError,
  isExecutorFactory,
  isLoopExecutorFactory,
  isCompilerFactory,
  isRunnerBindable,
  isToolExecutorFactory,
  toRegistration,
} from "@agentick/spec-next";
import { mergeLayered, omitUndefined } from "@agentick/utils-next";
import type {
  AppError,
  AppExtension,
  AppHarnessProtocol,
  AppInstaller,
  AppInstallerHost,
  Extension,
  CreateSessionInput,
  EventBus,
  EventQuery,
  SubscribeOptions,
  ExecutionTarget,
  ExecutorFactory,
  HandlerVerdict,
  JournalingPolicy,
  LanguageModelExecutor,
  LoopExecutorProtocol,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
  CompilerProtocol,
  RegisteredModel,
  RunOnceInput,
  RunOnceResult,
  SendInput,
  SendResult,
  SessionSendCapability,
  ServiceRegistry,
  SessionExtension,
  SessionInstaller,
  TelemetrySetting,
  ToolRegistration,
  Validator,
  SessionHarnessProtocol,
  SpawnContext,
  SpawnContextChildInput,
  LoopExecutorFactory,
  CompilerFactory,
  ToolExecutorFactory,
  ToolExecutorProtocol,
  Unsubscribe,
  EventBusFactory,
  MessageInboxFactory,
  OperationJournalFactory,
} from "@agentick/spec-next";

// ADR 82 / ADR 83 amendment — declarative per-session hooks. `CommandHooks` is
// derived from the runtime-augmented `CommandRegistry`, so it lives in
// `@agentick/runtime-next` and cannot be referenced from `@agentick/spec-next`
// (foundation layer — no upward dep). The app OWNS `createSession` and folds the
// hook cascade, so it augments spec's protocol shell here (the same `declare
// module` pattern harness packages use for `HookBridges` / `CommandRegistry`).
// The value is adapted to op-scoped middleware (`hooksToMiddlewares`) and
// appended to the app's resolved interceptor snapshot in `createSessionBody`.
declare module "@agentick/spec-next" {
  // `P` matches the augmented interface's arity (declaration merging requires
  // identical type parameters); it is unused in this augmentation body.
  // eslint-disable-next-line no-unused-vars
  interface CreateSessionInput<P> {
    /**
     * Per-session command lifecycle hooks (ADR 82). Declarative
     * {@link CommandHooks}; folded over the app's resolved layer at
     * `createSession` and threaded into every per-session sub-harness. App
     * hooks compose OUTER (both fire), never override.
     */
    readonly hooks?: CommandHooks;
  }
}

// ADR 80/83 — light up the two app-edge lifecycle verbs. Both already route
// through `runOperation` (see `createSession` / `runOnce`), so typing them here
// mints `onBefore/AfterAppCreateSession` and `onBefore/AfterAppRunOnce` on the
// derived `CommandHooks` surface. `CommandRegistry` carries no type parameter,
// so the generic `P` is pinned to `unknown` at the key (matching how
// `session:send` pins `SendInput<unknown>`). Generics of the `runOperation`
// Operations below.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "app:create-session": {
      input: CreateSessionInput<unknown>;
      output: SessionHarnessProtocol<unknown>;
    };
    "app:run-once": { input: RunOnceInput<unknown>; output: RunOnceResult };
    // `close-app` (ADR 80/83) — a nullary lifecycle op routed through
    // `runOperation` (see `closeApp`). Input/output are both `void` (the
    // Operation's generics). Mints `onBefore/AfterAppCloseApp`.
    "app:close-app": { input: void; output: void };
  }
}

// ============================================================================
// Construction options
//
// Every child slot follows the same shape: either pass a pre-built
// instance (the user took ownership of construction) or pass options
// that get merged with built-in defaults at construction time. The
// cascade — most specific to least specific — is:
//
//   1. per-call override (`createSession({ maxTicks: 3 })`)
//   2. per-app layer-specific (`createApp({ session: { defaultMaxTicks } })`)
//   3. per-app convenience shorthand (`createApp({ defaultMaxTicks })`)
//   4. framework default
//
// Slots in this options bag follow the CSS shorthand-vs-longhand rule:
// the longhand (layer-specific) wins over the shorthand (convenience)
// when both are present.
// ============================================================================

/**
 * Per-session forwarded `SessionHarness` options. `sessionId`, `agent`,
 * and the wired sub-harness references (`compiler`, `loop`, `modelExecutor`,
 * `toolExecutor`, `target`) are owned by the App and excluded here.
 */
export type SessionDefaults<P = unknown> = Omit<
  SessionHarnessOptions<P>,
  | "sessionId"
  | "agent"
  | "compiler"
  | "loop"
  | "modelExecutor"
  | "buildModelExecutor"
  | "toolExecutor"
  | "target"
>;

// App-level substrate slots use the framework's `HarnessShell` parent
// shape — defined on BaseHarness (ADR 31). Lifting the substrate-slot
// resolution into BaseHarness eliminated this file's bespoke
// `AppSubstrateParent` + `resolveSyncSubstrateSlot` plumbing.

/**
 * Per-session forwarded `ToolExecutorHarness` options. `handlerResolver`
 * is owned by the App (shared across sessions); `elicitation` is
 * constructed per-session by the App and threaded into both the tool
 * executor and the session bridges. Both are excluded from the
 * adopter-supplied defaults.
 */
export type ToolExecutorDefaults = Omit<
  ToolExecutorHarnessOptions,
  "handlerResolver" | "elicitation"
>;

export interface AppHarnessOptions<P = unknown> {
  /** Stable app id; defaults to `app:${ulid()}`. */
  readonly appId?: string;
  /**
   * Root agent element passed to every session's compiler mount.
   * Opaque to the app — the compiler impl owns the type contract.
   * For React this is a `React.ReactNode`; for an Angular compiler
   * it'd be the framework's root component reference.
   */
  readonly rootElement: unknown;
  /**
   * The model to call — a `LanguageModelAdapter` from any provider
   * package (`openai("gpt-4o")`, `anthropic(...)`,
   * `google("gemini-2.5-pro")`, `aisdk(model)`). The standard path
   * (ADR 52): the app wraps the adapter in the ONE
   * `LanguageModelExecutor` on the app's substrate, so executor events
   * appear on `app.events(...)` with zero wiring.
   *
   * At MOST one of `model` / `modelExecutor` — passing both throws. Passing
   * NEITHER is legal: a model-less app is fully valid (dispatch,
   * snapshot/restore, and wire plumbing all work without a model). The model
   * requirement is enforced at execution time — a `send` whose effective-model
   * cascade (`per-tick <Model>` > `per-send` > `session default`) is empty
   * fails with `NoModelForExecutionError`. `model` = what to call;
   * `modelExecutor` = how to execute (BYO engine).
   */
  readonly model?: LanguageModelAdapter;
  /**
   * BYO execution engine. Accepts:
   *
   *   - A pre-built `LanguageModelExecutor` instance — the caller
   *     constructed it with its own substrate; the app uses it as-is.
   *   - An `ExecutorFactory` — legacy substrate-deferred construction;
   *     survives only until the last factory producer converts to an
   *     adapter. TODO(#151): drop once anthropic ships adapter-first.
   *
   * Bare adapters go on `model`, not here. The model-executor is
   * self-describing: its `.target` property is read by the app, so the
   * redundant `target` field below is optional.
   */
  readonly modelExecutor?: LanguageModelExecutor | ExecutorFactory;
  /**
   * Optional override of the model-executor's self-described target. When
   * omitted, `modelExecutor.target` is used. Override at this level when a
   * single shared executor should advertise different capabilities or
   * provider options per app.
   */
  readonly target?: ExecutionTarget;
  /**
   * Model registry (#206) — merged over SEED_MODELS and passed to every
   * session for context-window resolution (useContextInfo). Federated:
   * merge adapter fragments (`openaiModels`, …) + your overrides.
   */
  readonly models?: import("@agentick/model-next").ModelRegistry;

  // ────────── Sub-harness slots (shared across sessions) ──────────

  /**
   * Compiler slot. Required — `@agentick/app-next` is compiler-agnostic
   * by design and does NOT default to any specific compiler. Pass:
   *
   *   - A pre-built `CompilerProtocol` instance (e.g., a future
   *     Angular compiler).
   *   - A `CompilerFactory` (produced by `defineCompiler(...)` or
   *     `reactCompiler(...)` etc.). The App calls the factory at
   *     construction with the shared substrate so compiler events
   *     flow through `app.events()`.
   *
   * For the React default, use `createApp` from `@agentick/app-next/react`
   * which defaults `compiler: reactCompiler()` automatically.
   */
  readonly compiler: CompilerProtocol | CompilerFactory;

  /**
   * Loop executor slot. Accepts:
   *
   *   - A pre-built `LoopExecutorProtocol` instance — used as-is.
   *   - A `LoopExecutorFactory` (produced by `defineLoop(...)`) — the
   *     App calls it at construction with the shared substrate so the
   *     loop's events flow through `app.events()`.
   *   - Omit — bundled `LoopExecutorHarness` is constructed with the
   *     shared substrate.
   */
  readonly loop?: LoopExecutorProtocol | LoopExecutorFactory;

  /**
   * Persistent-tasks substrate (ADR 68) — the durable `store` and the
   * execution `executors` registry, both constructed ONCE at app scope
   * and injected into every session's `TasksHarness`.
   *
   * **App-scoped, NOT a cascade.** This is deliberate: `detached` tasks
   * and child-process reattach require SHARED singletons that outlive any
   * one session. A session can't own its own store/executor — a detached
   * task would die with its spawning session. So there is no per-session
   * / per-createSession override; the app owns these for its whole
   * lifetime.
   *
   *   - `store` — defaults to a node-local `InMemoryTaskStore`. Swap a
   *     durable store (`@agentick/tasks-store-postgres-next`, same port) for
   *     survival across app restart.
   *   - `executors` — extra `TaskExecutor` strategies merged over the
   *     bundled in-process default. Pass ONE app-scoped
   *     `ChildProcessTaskExecutor` here so its child map outlives sessions
   *     (detached-survives-close). Tasks select per-submit via
   *     `executorKind`.
   */
  readonly tasks?: {
    readonly store?: TaskStore;
    readonly executors?: readonly TaskExecutor[];
    /**
     * App-wide default {@link TaskWakePolicy} (TASK-WAKE seam) — applied to
     * every task submitted without its own `wake`. `undefined` (default) = no
     * wake unless a task opts in. Set `true` for "wake the model on every
     * backgrounded task completion" (codex-parity); a callback shapes/
     * suppresses per-outcome. Per-task `wake` always overrides.
     */
    readonly defaultWake?: TaskWakePolicy;
  };

  /**
   * Durable session registry (E11) — the {@link SessionStore} holding
   * `sessionId → SessionRecord`, constructed ONCE at app scope and injected
   * into every non-ephemeral session's `SessionHarness`.
   *
   * **App-scoped, NOT a cascade** — mirrors the `tasks` slot. The store is the
   * durable SUPERSET of the app's in-memory live-session registry (every
   * session ever, including closed ones the live registry drops) and the
   * backing for `listSessions` / `getSessionRecord`.
   *
   *   - `store` — defaults to a node-local `InMemorySessionStore`. Swap a
   *     durable store (`@agentick/session-store-postgres-next`, same port) for
   *     survival across app restart — the store's reason to exist as the resume
   *     index.
   *
   * **Bounded live registry (PA2/PA3).** The live `sessionId → SessionHarness`
   * map is otherwise unbounded — a memory leak in long-lived deployments that
   * open sessions and never close them. `maxActive` / `idleTimeout` cap it by
   * PAGING OUT idle sessions:
   *
   *   - `maxActive` — soft LRU cap on LIVE sessions. When a `createSession`
   *     pushes the live count over the cap, the least-recently-active
   *     evictable session is paged out. The cap is SOFT: an in-flight
   *     session is never evicted, so a burst of concurrent work may exceed
   *     it transiently; the bound is restored at the next create / idle sweep.
   *   - `idleTimeout` — ms of inactivity (no send / dispatch / session op)
   *     after which a session is paged out by a background sweep. Requires no
   *     traffic to fire (an unref'd timer runs the sweep), so a quiet-but-
   *     long-lived app still releases memory.
   *
   * **Eviction is paging, NOT deletion.** An evicted session's live harness is
   * torn down (compiler mount + bridges freed) but its durable `SessionRecord`
   * + timeline store survive. The next `createSession(sameId)` transparently
   * reconstructs and rehydrates it via the ADR-49 open-or-rehydrate path — so
   * eviction is invisible to correctness, only to a stale `getSession` handle
   * held across the eviction. Activity = any operation scoped to the session
   * (send, dispatch, snapshot, …). Ephemeral (`runOnce`) sessions are never
   * LRU/idle-evicted (they self-dispose).
   */
  readonly sessions?: {
    readonly store?: SessionStore;
    /** Soft LRU cap on live sessions; over-cap creates page out the LRU evictable session. */
    readonly maxActive?: number;
    /** Idle-eviction threshold in ms; a background sweep pages out sessions idle this long. */
    readonly idleTimeout?: number;
    /**
     * Spawn depth ceiling (SP4). The maximum `spawnPath.length` a session may
     * have and still `spawn()` a child — a session already at this depth
     * throws `SpawnDepthExceededError` (fail-closed), bounding recursive
     * self-spawn. Stamped uniformly onto every session the app constructs.
     * Defaults to 10 (v1 `MAX_SPAWN_DEPTH` parity).
     */
    readonly maxSpawnDepth?: number;
  };

  // ────────── Per-session defaults (constructed per createSession) ──────────

  /**
   * Tool executor slot — configuration for the per-session
   * ToolExecutorHarness. Accepts either:
   *
   *   - `ToolExecutorDefaults` (options) — forwarded to the App's default
   *     `ToolExecutorHarness` instance. The `handlerResolver` is wired
   *     by the App (shared across sessions).
   *   - `ToolExecutorFactory` — produced by `defineToolExecutor(...)`.
   *     The App calls the factory per-session with the shared substrate
   *     so the executor's events flow through `app.events()`.
   *
   * This slot is the EXECUTOR's configuration. For the layered tool
   * DECLARATION list use {@link AppHarnessOptions.tools}.
   */
  readonly toolExecutor?: ToolExecutorDefaults | ToolExecutorFactory;

  /**
   * App-level tool declarations (layered config). Each declaration is
   * bound at app scope and merged into every session's tool registry
   * at session-create time. Precedence (slice 2's `compileForTick`):
   * session > app (this slot) > extension@app > gateway > runtime.
   *
   * Cascade with per-call inputs:
   *   `SendInput.tools` (execution scope)        — highest
   *   `CreateSessionInput.tools` (session scope)
   *   `AppHarnessOptions.tools` (app scope)      — this slot
   *   extensions installed at app level
   *   `inheritedTools` (gateway-propagated)
   *   runtime/programmatic                       — lowest
   *
   * Use this when every session of this app should see the same
   * baseline tool. Per-session overrides flow through
   * `CreateSessionInput.tools`. Adopters needing dynamic per-tick
   * tools should declare via JSX (compiler scope wins everything).
   *
   * @see ToolBinding in `@agentick/spec-next` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<import("@agentick/spec-next").ToolDeclaration>;
  /**
   * Pre-tagged tool registrations propagated from a parent context
   * (today: a `Gateway` hosting this app, slice 7 #141). These
   * registrations carry their OWN binding — they are NOT re-tagged
   * by the AppHarness. The expected shape is
   * `binding: { scope: "gateway" }`, but any binding is structurally
   * valid; the app forwards them verbatim.
   *
   * Distinct from `tools` (declarations the app tags with
   * `{scope:"app", appId}`) and from extension tools (tagged by the
   * extension installer with `{scope:"extension", level:"app"}`).
   *
   * Adopters constructing `AppHarness` directly (no Gateway) ignore
   * this field. The Gateway's `createApp` populates it from
   * `GatewayHarnessOptions.tools`.
   */
  readonly inheritedTools?: ReadonlyArray<import("@agentick/spec-next").ToolRegistration>;

  /**
   * Default `SessionHarness` options forwarded to every session. The
   * fields wired by the App (`compiler`, `loop`, `executor`,
   * `toolExecutor`, `target`, `sessionId`, `agent`) are excluded.
   *
   * Cascade: per-call `createSession` fields > this > convenience
   * shortcuts (`defaultMaxTicks`, `initialProps`, `initialKnobs`).
   */
  readonly session?: SessionDefaults<P>;

  // ────────── Convenience shortcuts (lowest specificity) ──────────

  /** Per-session max tick bound. Equivalent to `session.defaultMaxTicks`. */
  readonly defaultMaxTicks?: number;
  /** Default initial props. Equivalent to `session.props`. */
  readonly initialProps?: P;
  /** Default initial knobs. Equivalent to `session.initialKnobs`. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /**
   * App-level streaming default. Overridden by `CreateSessionInput.streaming`
   * and `SendInput.stream`. When unset, streaming defaults ON when the
   * executor exposes `executeStream` AND `target.capabilities.supportsStreaming`
   * is not explicitly false.
   */
  readonly streaming?: boolean;
  /**
   * App-level model-narration switch (default `true`). When `false`, the
   * reserved `_summary` narration field is NOT injected into any
   * model-facing tool schema — the token-cost off-switch (an extra schema
   * property per tool + an extra model-emitted sentence per call).
   * Overridden by `createSession({ narrate })` / `createApp({ session:
   * { narrate } })`. Equivalent convenience for `session.narrate`.
   */
  readonly narrate?: boolean;
  /**
   * App-wide snapshot-migration seam (recovery pass #1 — schema evolution).
   * Threaded into every session's `migrateSnapshot`, invoked by
   * `session.restore()` when a snapshot's `specVersion` differs from the
   * running `SPEC_VERSION`. Convenience for `session.migrateSnapshot`; also
   * settable via `createApp({ session: { migrateSnapshot } })`. See
   * {@link SnapshotMigration}.
   */
  readonly migrateSnapshot?: SnapshotMigration;

  /**
   * App-level tool handlers shared across sessions. Resolver keys are
   * `handlerRef` strings. Each session gets its own
   * `ToolExecutorHarness` instance but they all consult the same
   * resolver.
   */
  readonly toolHandlers?: ReadonlyMap<string, ToolHandler>;

  // ────────── Substrate slots ──────────

  /**
   * Inject a custom journal/bus/inbox. Defaults to in-memory locals.
   *
   * **Instance or factory.** Pass a pre-built `OperationJournal` /
   * `EventBus` / `MessageInbox` to share across sessions in this app,
   * or pass a factory (`(parent) => R` — typically built via
   * `MemoryJournal.factory(opts)` / `LocalEventBus.factory(opts)` /
   * etc.) to construct fresh for this app with the parent shell.
   *
   * Persistence is currently the `journal` slot — supply a durable
   * `OperationJournal` impl (e.g., SqlitePersistenceJournal once
   * shipped) for operational durability.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly journal?: OperationJournal | OperationJournalFactory<HarnessShell>;
  readonly bus?: EventBus | EventBusFactory<HarnessShell>;
  readonly inbox?: MessageInbox | MessageInboxFactory<HarnessShell>;

  /**
   * App-wide abort signal (PA1). A single `AbortSignal` fanned into every
   * session the app creates (as the session's construction signal). Firing
   * it:
   *   - aborts every active session's in-flight execution — each session's
   *     loop run holds the live merged signal, so the abort tears the work
   *     down immediately (not at the next tick boundary);
   *   - refuses new work — `createSession` / `runOnce` throw `AppClosedError`
   *     once the signal is aborted (admission treats an aborted app like a
   *     closed one), and a `send()` on an already-created session resolves an
   *     `aborted` result without a model call.
   *
   * This is `closeApp()` in abort shape: a cascading cancel rather than a
   * teardown. It does NOT dispose the substrate — call `closeApp()` for that.
   * Reuses the existing per-send / per-session signal plumbing (no bespoke
   * cancellation engine).
   */
  readonly signal?: AbortSignal;
  /**
   * Adopter-defined metadata bag carried on the App harness instance
   * and exposed to substrate factories via `parent.metadata`. Framework
   * defines no keys; adopters stash whatever they want (deployment
   * tags, request shape, routing hints).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /**
   * Logical app name — the agent-identity dimension of telemetry (rung 1).
   * When telemetry enrichment is on, it is stamped as `<ns>.app_name` on every
   * span AND becomes the default `functionId` (a single-purpose app gets
   * meaningful function-level traces with zero per-send config; multi-function
   * apps override per send via `SendInput.telemetry.functionId`). Optional and
   * otherwise inert — no behavior depends on it beyond telemetry.
   */
  readonly name?: string;

  /**
   * Telemetry switch (ADR 78, telemetry rung 1) — STRICTLY OPT-IN. Accepts:
   *
   *   - `true` — turn on the framework's enrichment defaults (polished span
   *     attrs — model/tool/tick/session/app.name — plus token usage + cost on
   *     model-generate terminals). The one switch.
   *   - a `Layer` (Effect) — the adopter's OTel/observability backend (e.g.
   *     `@effect/opentelemetry`'s `NodeSdk`), built into an app-scoped
   *     `ManagedRuntime` so `Effect.withSpan` spans EXPORT. Also turns
   *     enrichment on (you opted in). BYO — the framework bundles no OTel dep.
   *   - a `{ serviceName?, attributes?, layer? }` object — enrichment on, plus
   *     a service name / static attributes / optional exporter Layer.
   *
   * Omitted / `false` → OFF: no runtime, no enrichment interceptors, zero
   * overhead. See "Observability" in `@agentick/runtime-next`'s README for the
   * full model + exporter recipe.
   *
   * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
   */
  readonly telemetry?: TelemetrySetting;

  /**
   * Span-attribute namespace — the prefix on every `<ns>.op_id` / `<ns>.surface`
   * telemetry attribute. Defaults to `"agentick"`. Set it to whitelabel your
   * deployment's traces (e.g. `"acme"`). Capability + overridable default.
   * (Flat for now; group into `telemetry: {…}` only if it grows to 3+ knobs.)
   */
  readonly telemetryNamespace?: string;

  /**
   * App-level command lifecycle hooks (ADR 82 / ADR 83 amendment) — declarative
   * {@link CommandHooks}. Registered ONCE at construction as op-scoped
   * `transform` middleware on the app's OWN `.use` chain (`this.hook(...)`), so
   * they inherit down the scope chain through the SAME `inheritedInterceptors`
   * fold that carries `.use()` / `.guard()`: the app-shared spine (loop /
   * executor) and every per-session sub-harness snapshot it. Hooks COMPOSE
   * across scopes (app-outer, session-inner both fire) — they never override. A
   * before-hook reshapes/vetos the command input; an after-hook the output; the
   * bare `on<Command>` key is the whole middleware.
   * `createApp({ hooks: { onBeforeToolDispatch: (i) => reshaped } })`.
   *
   * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md
   */
  readonly hooks?: CommandHooks;

  /**
   * LIVE interceptor parent (ADR 83 §4 / ADR 84 §3) — the GatewayHarness that
   * created this app. `gateway.createApp` passes `interceptorParent: gateway`
   * so the app registers as a live interceptor child of the gateway: a LATER
   * `gateway.use()` / `gateway.guard()` / `gateway.hook()` reaches this app's
   * ops — and cascades on to its sessions and sub-harnesses — not just the
   * construction snapshot. Forwarded to {@link BaseHarness}. Omitted for a
   * standalone app (`createApp` with no gateway above it).
   *
   * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md
   */
  readonly interceptorParent?: BaseHarness;

  /**
   * Pluggable extensions. Each extension is a `{ name, install }`
   * record produced by an extension package's `withX()` factory.
   * AppHarness invokes `install(installer)` for each extension at
   * construction; the installer exposes methods for registering
   * bridges, contributors, tool handlers, and bus subscriptions.
   *
   * Extensions install in the supplied order; last-writer-wins on
   * slot name collisions. Installer state is owned by the app and
   * teardown happens in `closeApp` (fires registered `onClose` handlers
   * in reverse order).
   *
   * Per ADR 26: extensions are a discriminated union by `target`. The
   * app filters for `target === "app"` and installs those at app
   * construction; `target === "session"` extensions are cached and
   * forwarded to every session at session creation.
   *
   * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
   * @see `@agentick/spec-next` §Extension
   */
  readonly extensions?: readonly Extension[];
}

// ============================================================================
// Session registry — in-memory Map
// ============================================================================

interface InternalSessionEntry<P> {
  readonly id: string;
  readonly session: SessionHarness<P>;
  /**
   * The session's tool executor — `ToolExecutorHarness` (reference impl)
   * when the App constructed it from options, or a user-supplied
   * `ToolExecutorProtocol` produced by `defineToolExecutor()` when the
   * `tools` slot received a factory.
   */
  readonly tools: ToolExecutorProtocol;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly parentSessionId?: string;
  lastActiveAt?: number;
  ephemeral: boolean;
}

// ============================================================================
// AppHarness
// ============================================================================

export class AppHarness<P = unknown>
  extends BaseHarness<"app">
  implements AppHarnessProtocol<P>, SpawnContext<P>
{
  get id(): string {
    return this.scopeId;
  }

  private readonly rootElement: unknown;
  /**
   * The app-default model-executor, or `undefined` for a model-less app (no
   * `model` / `modelExecutor` at construction). Model-less apps are legal —
   * dispatch, snapshot/restore, and all wire plumbing work without a model; the
   * requirement is enforced at execution time (the loop's per-tick resolution),
   * not construction. A `send` that resolves no model fails with
   * `NoModelForExecutionError`.
   */
  private readonly modelExecutor: LanguageModelExecutor | undefined;
  private readonly target: ExecutionTarget | undefined;
  /**
   * Adapter→executor builder threaded into every session (ADR 89 §2 ergonomic
   * parity), so `session.model.setModel(openai("gpt-4o"))` wraps the adapter in
   * the ONE `LanguageModelExecutor` on the app substrate — the runtime twin of
   * the construction-time `model` slot. `undefined` for a BYO-executor app
   * (constructed with `modelExecutor`, not `model`): that app opted out of the
   * app's adapter-wrapping machinery, so a runtime adapter swap has no builder
   * and the facade throws `ModelExecutorBuilderMissingError`.
   */
  private readonly buildModelExecutor:
    | ((adapter: LanguageModelAdapter) => RegisteredModel)
    | undefined;

  // Per-session defaults resolved from the cascade
  // (session-longhand > shorthand > built-in).
  private readonly sessionDefaults: SessionDefaults<P>;
  /** App-level model registry (#206), merged over SEED_MODELS, passed to every session. */
  private readonly models: import("@agentick/model-next").ModelRegistry | undefined;
  /**
   * Options forwarded to the default `ToolExecutorHarness` constructed
   * per-session. Undefined when the caller supplied a
   * `ToolExecutorFactory` at the `toolExecutor` slot — `toolFactory`
   * carries the factory in that case.
   */
  private readonly toolDefaults: ToolExecutorDefaults;
  /**
   * Caller-supplied factory at the `toolExecutor` slot. When set, each
   * session's tool executor is produced by invoking this factory with
   * the shared substrate; `toolDefaults` is ignored.
   */
  private readonly toolFactory: ToolExecutorFactory | undefined;
  /**
   * App-level tool declarations from `AppHarnessOptions.tools`. Wrapped
   * into `ToolRegistration[]` with `binding: { scope: "app", appId }`
   * once at construction; merged into every session's initial registry.
   */
  private readonly appLevelTools: readonly ToolRegistration[];
  /**
   * Pre-tagged tool registrations from `AppHarnessOptions.inheritedTools`.
   * Today: gateway-propagated tools (binding `{scope:"gateway"}`).
   * Captured verbatim — the app does NOT re-tag these.
   */
  private readonly inheritedTools: readonly ToolRegistration[];

  // Shared sub-harnesses (one per app, used by every session).
  private readonly compiler: CompilerProtocol;
  private readonly loop: LoopExecutorProtocol;
  private readonly handlerResolver: InMemoryHandlerResolver;
  // Tools contributed by extensions at install time. Appended to
  // every session's `ToolExecutor.initialTools` when the session is
  // constructed. Last-writer-wins on name collision; adopter-supplied
  // tools take precedence (the extension list installs FIRST, then
  // adopter `toolDefaults.initialTools` overlays).
  private readonly extensionTools: ToolRegistration[] = [];

  private readonly registry = new Map<string, InternalSessionEntry<P>>();
  private _closed = false;

  /**
   * App-wide abort signal (PA1). Fanned into every session as its
   * construction signal; also gates new-work admission (`assertOpen`).
   * `undefined` when no signal was supplied.
   */
  private readonly appSignal: AbortSignal | undefined;
  /**
   * Soft LRU cap on live sessions (PA2). `undefined` → unbounded (legacy
   * behavior). See {@link AppHarnessOptions.sessions}.
   */
  private readonly maxActive: number | undefined;
  /** Idle-eviction threshold in ms (PA3). `undefined` → no idle sweep. */
  private readonly idleTimeout: number | undefined;
  /**
   * Spawn depth ceiling (SP4), stamped onto every session. Default 10 (v1
   * `MAX_SPAWN_DEPTH`). See {@link AppHarnessOptions.sessions}.
   */
  private readonly maxSpawnDepth: number;
  /**
   * Background idle-sweep handle (PA3). Present only when `idleTimeout` is
   * set; unref'd so it never keeps the process alive; cleared in `closeApp`.
   */
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Activity subscription teardown (PA2/PA3). Present only when eviction is
   * configured — the app subscribes to `requested`-phase envelopes and
   * refreshes `lastActiveAt` for the scoped session. Torn down in `closeApp`.
   */
  private activityUnsub: Unsubscribe | undefined;

  /**
   * App/gateway-scoped {@link TaskStore} (ADR 68). Constructed ONCE (from
   * `options.tasks.store`, else a node-local `InMemoryTaskStore`) and
   * injected into every session's `TasksHarness` so `detached` task
   * records survive their spawning session's `close()` (the store
   * outlives the per-session harness). A durable store (pg) swapped in
   * here — same port — adds survival across app restart.
   */
  private readonly taskStore: TaskStore;
  /**
   * App/gateway-scoped {@link TaskExecutor} strategies (ADR 68 Build B),
   * from `options.tasks.executors`. Constructed ONCE and injected into
   * every session's `TasksHarness` (merged over its bundled in-process
   * default). App-scoped so a child-process executor's child map outlives
   * sessions (detached-survives-close). Empty by default (in-process
   * only).
   */
  private readonly taskExecutors: readonly TaskExecutor[];
  /**
   * App-wide default {@link TaskWakePolicy} (TASK-WAKE seam), from
   * `options.tasks.defaultWake`. Injected into every session's `TasksHarness`
   * as its `defaultWake`; a per-submit `wake` overrides it. `undefined` = no
   * default wake.
   */
  private readonly taskDefaultWake: TaskWakePolicy | undefined;

  /**
   * App-scoped durable session registry (E11). Constructed ONCE (from
   * `options.sessions.store`, else a node-local `InMemorySessionStore`) and
   * injected into every NON-ephemeral session's `SessionHarness`, which mirrors
   * its metadata in off the critical path. The durable SUPERSET of the live
   * `registry` map: `listSessions` / `getSessionRecord` read it, so a closed /
   * historical session (dropped from the live map) still resolves. A durable
   * store swapped in here — same port — adds survival across app restart.
   */
  private readonly sessionStore: SessionStore;

  /**
   * App-scoped telemetry runtime (ADR 78). Built ONCE in {@link initTelemetryExport}
   * from the adopter's `telemetry` (explicit Effect Layer + de-Effected
   * `spanProcessor`s, via `@effect/opentelemetry`) — NOT a per-call
   * `Effect.provide`, which would rebuild the Layer (and its exporter) on every
   * command. App-edge operations run on it so the substrate's `Effect.withSpan`
   * annotations flow to the configured tracer; disposed in `closeApp` (flushing
   * pending spans). `undefined` when no span export is wired. Set async (before
   * `appReady`), hence not `readonly`.
   */
  private telemetryRuntime: ManagedRuntime.ManagedRuntime<never, never> | undefined;
  /**
   * Releases this app's hold on the SHARED metrics `MeterProvider` backing
   * {@link telemetryProvider}'s meter. Called once in `closeApp`. Refcounted at
   * the wiring layer — the provider is materialized once per reader set and
   * shared across apps inheriting the same gateway `telemetry` setting (an OTel
   * `MetricReader` binds to exactly one `MeterProvider`); the LAST app to
   * release `shutdown()`s it. `undefined` when no metric export is wired.
   */
  private telemetryReleaseMeter: (() => Promise<void>) | undefined;
  // NOTE: `telemetryProvider` (ADR 64/78) is the inherited mutable BaseHarness
  // slot — presence flips `ctx.trace` / `ctx.metrics` ON in tool handlers AND on
  // this app's own interceptor ctx; its `meter` drives `ctx.metrics.*` export.
  // The app resolves it async in
  // {@link initTelemetryExport} (before `appReady`) and assigns the inherited
  // field, so a single source feeds both the tool-executor threading and
  // `BaseHarness.buildInterceptorCtx`. `undefined` when telemetry is OFF.
  /**
   * Resolves when the async telemetry export build (autodiscovery + runtime +
   * meter) completes. Awaited by {@link appReady}, so no session sees a
   * half-built provider.
   */
  private readonly telemetryReady: Promise<void>;

  /**
   * Telemetry enrichment interceptors (rung 1) — built ONCE from
   * `options.telemetry` when the switch is on (`buildTelemetryInterceptors`),
   * forwarded to every session so they ride the tier-4 `withCallMiddleware`
   * send seam (the ONE path reaching model/tool/tick ops uniformly, incl. a BYO
   * or per-tick-swapped executor). `[]` when telemetry is off → zero overhead.
   */
  private readonly telemetryMiddleware: readonly import("@agentick/spec-next").Middleware<
    unknown,
    unknown,
    unknown
  >[];
  /** Logical app name (telemetry agent-identity dimension). See {@link AppHarnessOptions.name}. */
  private readonly appName: string | undefined;

  /**
   * Tool bridge surfaced to each session's HookBridges. Wraps the
   * shared HandlerResolver so compiler-side tools (React
   * `createTool` with `use()`) can register handlers at render time
   * keyed by `handlerRef`. Constructed in the constructor.
   */
  private readonly toolBridge!: import("@agentick/spec-next").ToolBridge;

  /**
   * App-level service registry. Integrations + sessions read from
   * here. Simple key/value; no token branding (callers annotate the
   * type at the get site).
   */
  readonly services: ServiceRegistry = new InMemoryServiceRegistry();

  /**
   * Lifecycle hook chains keyed by phase. Invoked manually at the
   * named boundary (createSessionBody / disposeSession / closeAppBody).
   * Not routed through `runOperation` today — see the protocol doc
   * note on the deferred command-refactor.
   */
  private readonly sessionCreateHandlers: Array<
    (
      input: CreateSessionInput<P>,
    ) => Promise<{ readonly kind: "veto"; readonly reason?: string } | void>
  > = [];
  private readonly sessionCloseHandlers: Array<
    (info: {
      readonly sessionId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void> | void
  > = [];
  private readonly appCloseHandlers: Array<() => Promise<void> | void> = [];

  // ──────── Extension state ────────
  /** Harnesses merged into every session's HookBridges by slot name. */
  private readonly extensionBridges = new Map<string, unknown>();
  /**
   * `target === "session"` extensions cached at app construction and
   * forwarded to every session the app creates. Installed per-session at
   * the SessionHarness's own install pass (which lands in ADR 26 Step 8).
   * For Step 1 we hold them but don't yet wire them through.
   */
  private readonly sessionExtensions: readonly Extension[] = [];
  /**
   * Close handlers registered by extensions via `installer.onClose(...)`.
   * Fired in reverse order during `closeApp`.
   */
  private readonly extensionCloseHandlers: Array<() => void | Promise<void>> = [];

  /**
   * Register a close handler that fires during {@link closeApp},
   * AFTER session disposal and BEFORE extension close handlers.
   *
   * Internal slot used by `createApp` to wire substrate-level
   * lifecycle (e.g., closing a `cluster` that wrapped the local
   * bus/inbox/journal). Adopters should NOT call this directly —
   * use extensions (`installer.onClose(...)`) for ordinary
   * lifecycle hooks.
   *
   * Handler errors are swallowed (best-effort teardown).
   */
  addInternalCloseHandler(handler: () => void | Promise<void>): void {
    this.extensionCloseHandlers.push(handler);
  }
  /** Pending install promise resolved once all app-targeted extensions complete `install()`. */
  private readonly extensionsReady: Promise<void>;

  constructor(options: AppHarnessOptions<P>) {
    const appId = options.appId ?? `app:${ulid()}`;

    // Substrate slot resolution is owned by BaseHarness (ADR 31). The
    // positional substrate args below are the App's DEFAULTS — used
    // when `options.{bus,inbox,journal}` is omitted. Factories in
    // those slots get a HarnessShell whose .bus/.inbox/.journal point
    // at these defaults (an adopter who passes `LocalEventBus.factory()`
    // gets a fresh bus wrapping the default — leaf at the app level
    // since the default has no upstream, but pre-wired for the
    // hierarchy nonetheless).
    //
    // Close-Operation envelopes for `app:command:close-app` are routed
    // bus-only via policy override — substrate-close handlers fire
    // inside `super.close()` without crashing the framework (ADR 31
    // Option G).
    super(
      "app",
      appId,
      new MemoryJournal({ capacity: 10_000 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        metadata: options.metadata,
        ...omitUndefined({
          journal: options.journal,
          bus: options.bus,
          inbox: options.inbox,
          telemetryNamespace: options.telemetryNamespace,
          // ADR 84 §3 — live interceptor link to the gateway that created this
          // app. A gateway hook registered LATER folds down through this app.
          interceptorParent: options.interceptorParent,
        }),
        policy: mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, {
          override: { "app:command:close-app": "bus-only" },
        }),
      },
    );
    // ADR 83 amendment — register the app's declarative hooks as op-scoped
    // middleware on the app's OWN `.use` chain, ONCE at the construction
    // boundary and BEFORE the shared spine (executor/loop) is built, so their
    // `inheritedInterceptors: this.resolvedInterceptors()` snapshot (below)
    // picks them up. `createSessionBody` folds the app's resolved layer per
    // session. This is the app's cascade base (was `this.hookLayer`).
    this.hook(options.hooks ?? {});
    // Local aliases for convenience in the rest of the constructor.
    const journal = this.journal;
    const bus = this.bus;
    const inbox = this.inbox;

    this.rootElement = options.rootElement;
    // Model/executor slots (ADR 52): `model` takes an adapter — the
    // app wraps it in the ONE LanguageModelExecutor on the app's
    // substrate. `modelExecutor` takes a BYO engine (instance or legacy
    // factory). At MOST one of the two — but NEITHER is legal: a model-less
    // app is fully valid (dispatch, snapshot/restore, wire plumbing all work
    // without a model). The model requirement is enforced at execution time
    // (the loop's per-tick resolution → `NoModelForExecutionError`), not here.
    if (options.model !== undefined && options.modelExecutor !== undefined) {
      throw new Error(
        "createApp: pass either `model` (a LanguageModelAdapter) or " +
          "`modelExecutor` (a LanguageModelExecutor / factory), not both.",
      );
    }
    if (options.modelExecutor !== undefined && isLanguageModelAdapter(options.modelExecutor)) {
      throw new Error(
        "createApp: a bare LanguageModelAdapter goes on the `model` slot, not `modelExecutor`.",
      );
    }
    this.modelExecutor =
      options.model !== undefined
        ? new TheLanguageModelExecutor(`${appId}:executor`, journal, bus, inbox, {
            adapter: options.model,
            // ADR 76/83 — app-shared spine folds the APP's resolved interceptor
            // snapshot (incl. the app's declarative hooks registered just above;
            // no `app.use()` has run yet at construction, so this equals the old
            // app-hook-only layer). Session hooks never reach shared harnesses.
            // ADR 83 §4 — `interceptorParent: this` keeps the relation LIVE, so a
            // LATER `app.use()` / `app.guard()` / `app.hook()` reaches the
            // executor too (not just the construction snapshot).
            inheritedInterceptors: this.resolvedInterceptors(),
            interceptorParent: this,
          })
        : options.modelExecutor === undefined
          ? undefined // model-less app — no default executor
          : isExecutorFactory(options.modelExecutor)
            ? options.modelExecutor({
                scopeId: `${appId}:executor`,
                journal,
                bus,
                inbox,
              })
            : options.modelExecutor;
    // Resolve target: caller override > modelExecutor.target (undefined when
    // model-less and no explicit target).
    this.target = options.target ?? this.modelExecutor?.target;
    // ADR 89 §2 — the adapter→executor builder threaded into every session so
    // `session.model.setModel(adapter)` matches construction's `model` sugar.
    // Injected UNLESS the app supplied a BYO `modelExecutor` (that app opted out
    // of the adapter-wrapping machinery — the facade throws on an adapter
    // overload). A model-less app STILL gets the builder, so
    // `setModel(openai("gpt-4o"))` on a model-less app works. Mirrors the
    // construction wrap above: one executor on the app substrate, target read
    // from the executor.
    this.buildModelExecutor =
      options.modelExecutor === undefined
        ? (adapter: LanguageModelAdapter): RegisteredModel => {
            const modelExecutor = new TheLanguageModelExecutor(
              `${appId}:executor:${ulid()}`,
              this.journal,
              this.bus,
              this.inbox,
              {
                adapter,
                // Live app-resolved interceptor snapshot at swap time + a LIVE
                // parent link, exactly like the construction-time executor —
                // so app/gateway hooks reach the swapped-in executor too.
                inheritedInterceptors: this.resolvedInterceptors(),
                interceptorParent: this,
              },
            );
            // ADR 64/78 — a `setModel` swap happens at RUNTIME, after telemetry
            // resolved, so bind the resolved provider onto the freshly-minted
            // executor immediately (the ctor-time spine late-bind already ran and
            // won't see this one). `undefined` when telemetry is off — no-op.
            modelExecutor.adoptTelemetry(
              this.telemetryProvider,
              this.appName !== undefined ? { app: this.appName } : undefined,
            );
            return { modelExecutor, target: modelExecutor.target };
          }
        : undefined;
    // Telemetry switch (rung 1) — STRICTLY OPT-IN. Normalize the three forms
    // (`true` | Layer | `{ serviceName?, attributes?, layer? }`) into: an
    // exporter runtime (built ONCE from the Layer, when present) and the
    // enrichment interceptor list (built when the switch is truthy). `false` /
    // omitted → neither (zero overhead). A raw Layer counts as opt-in, so it
    // gets enrichment too; the config object's `layer` is the exporter for the
    // `{…}` form.
    this.appName = options.name;
    const telemetry = normalizeTelemetry(options.telemetry);
    this.telemetryMiddleware = telemetry.enabled
      ? buildTelemetryInterceptors(this.telemetryNamespace, {
          ...(this.appName !== undefined ? { appName: this.appName } : {}),
          ...(telemetry.serviceName !== undefined ? { serviceName: telemetry.serviceName } : {}),
          ...(telemetry.attributes !== undefined ? { attributes: telemetry.attributes } : {}),
        })
      : [];
    // Export path (tracer runtime + metrics meter) is built ASYNC — env-driven
    // OTLP autodiscovery lazily imports the optional sink package. Sessions are
    // only created after `appReady`, which awaits `telemetryReady`, so
    // `telemetryRuntime` / `telemetryProvider` are always set before the first
    // session reads them.
    this.telemetryReady = this.initTelemetryExport(telemetry);

    // Cascade: longhand (`options.session.*`) wins over shorthand
    // (`options.defaultMaxTicks` / `options.initialProps` /
    // `options.initialKnobs`). Per-call `createSession.*` wins over both
    // and applies at session construction.
    this.sessionDefaults = mergeSessionDefaults(options);
    this.models = options.models;
    // Tool executor slot: factory → defer construction to per-session
    // via `toolFactory`; options/undefined → forward to the bundled
    // `ToolExecutorHarness` via `toolDefaults`.
    if (isToolExecutorFactory(options.toolExecutor)) {
      this.toolFactory = options.toolExecutor;
      this.toolDefaults = {};
    } else {
      this.toolFactory = undefined;
      this.toolDefaults = options.toolExecutor ?? {};
    }
    // App-level tools (layered config). Bound once at construction.
    this.appLevelTools = (options.tools ?? []).map((decl) =>
      toRegistration(decl, { scope: "app", appId }),
    );
    // Gateway-propagated tools — pre-tagged, captured verbatim.
    this.inheritedTools = options.inheritedTools ?? [];

    // Compiler slot — instance or options.
    this.compiler = resolveCompiler(options.compiler, appId, journal, bus, inbox);

    // Loop slot: factory → call with shared substrate; instance → use
    // as-is; undefined → bundled default with shared substrate.
    this.loop = isLoopExecutorFactory(options.loop)
      ? options.loop({ scopeId: appId, journal, bus, inbox })
      : (options.loop ??
        // ADR 76/83 — app-shared spine folds the APP's resolved interceptor
        // snapshot (incl. the app's declarative hooks registered above). ADR 83
        // §4 — `interceptorParent: this` keeps the relation LIVE (a later
        // `app.use()`/`app.guard()`/`app.hook()` reaches the loop too).
        new LoopExecutorHarness(appId, journal, bus, inbox, {
          inheritedInterceptors: this.resolvedInterceptors(),
          interceptorParent: this,
        }));

    // Persistent-tasks substrate (ADR 68) — app-scoped store + executor
    // registry, constructed ONCE (NOT a cascade — detached tasks +
    // child-process reattach need shared singletons that outlive any one
    // session). Injected into every session's TasksHarness below.
    this.taskStore = options.tasks?.store ?? new InMemoryTaskStore();
    this.taskExecutors = options.tasks?.executors ?? [];
    this.taskDefaultWake = options.tasks?.defaultWake;
    this.sessionStore = options.sessions?.store ?? new InMemorySessionStore();

    // PA1/PA2/PA3 — app-signal cascade + bounded live registry.
    this.appSignal = options.signal;
    this.maxActive = options.sessions?.maxActive;
    this.idleTimeout = options.sessions?.idleTimeout;
    this.maxSpawnDepth = options.sessions?.maxSpawnDepth ?? 10;
    // Activity tracking + idle sweep are wired ONLY when eviction is
    // configured — zero overhead for the unbounded default. Activity =
    // any `requested`-phase envelope scoped to a live session (send /
    // dispatch / snapshot / …), refreshing its `lastActiveAt` for LRU +
    // idle ordering. The session emits on the app-shared bus by default;
    // a session with its OWN bus factory won't be tracked this way (a
    // multi-tenant-isolation combo — documented in the README).
    if (this.maxActive !== undefined || this.idleTimeout !== undefined) {
      this.activityUnsub = forkBusSubscription(bus, { phase: "requested" }, (event) => {
        const sid = event.scope.sessionId;
        if (sid !== undefined) this.touchActivity(sid);
      });
    }
    if (this.idleTimeout !== undefined) {
      const idle = this.idleTimeout;
      this.idleSweepTimer = setInterval(() => {
        void this.sweepIdle(idle);
      }, idle);
      // Never hold the event loop open for the sweep (Node-only API; guard
      // for non-Node runtimes without `unref`).
      this.idleSweepTimer.unref?.();
    }

    this.handlerResolver = new InMemoryHandlerResolver();
    if (options.toolHandlers) {
      for (const [ref, handler] of options.toolHandlers) {
        this.handlerResolver.register(ref, handler);
      }
    }
    this.toolBridge = {
      register: (handlerRef, handler, validator) => {
        this.handlerResolver.register(handlerRef, handler, validator);
        return () => this.handlerResolver.unregister(handlerRef);
      },
      unregister: (handlerRef) => this.handlerResolver.unregister(handlerRef),
    };

    // Per ADR 26: extensions are a discriminated union by `target`.
    // App filters for `target === "app"` and installs immediately;
    // session-targeted ones are cached for forwarding at session
    // creation.
    const allExtensions = options.extensions ?? [];
    const appExtensions: AppExtension[] = [];
    const sessionExtensions: Extension[] = [];
    for (const ext of allExtensions) {
      if (ext.target === "app") appExtensions.push(ext);
      else sessionExtensions.push(ext);
    }
    // Mutable assignment to the readonly field — set once at
    // construction.
    (this as unknown as { sessionExtensions: readonly Extension[] }).sessionExtensions =
      sessionExtensions;

    // Drive app-targeted extensions. Each runs against a shared
    // installer that routes registrations into our internal maps +
    // sub-harnesses. Extensions run sequentially in supplied order.
    this.extensionsReady = (async () => {
      const installer = this.makeInstaller();
      for (const ext of appExtensions) {
        await ext.install(installer);
      }
    })();
  }

  /**
   * Build the telemetry EXPORT surface (tracer runtime + metrics meter) from the
   * normalized switch. Async because env-driven OTLP autodiscovery lazily imports
   * the optional `@agentick/telemetry-otlp-next` package. The resolved provider
   * flips `ctx.trace` / `ctx.metrics` ON in tool handlers (threaded to every
   * session's tool executor); the runtime routes the session's `Effect.withSpan`
   * tree to the tracer. OFF (`!enabled`) → all three stay `undefined` (zero
   * overhead). Awaited by {@link appReady}.
   */
  private async initTelemetryExport(n: NormalizedTelemetry): Promise<void> {
    const built = await buildTelemetryExport(n);
    this.telemetryRuntime = built.runtime;
    this.telemetryReleaseMeter = built.releaseMeter;
    // Enabled → hand a provider to the ctx assemblers even when no meter is
    // wired (enrichment-on-no-export still lights `ctx.trace` on the captured
    // op runtime — a no-op tracer annotates but does not export). OFF → no
    // provider (the tool executor takes the shared off-path singletons).
    this.telemetryProvider = n.enabled ? omitUndefined({ meter: built.meter }) : undefined;
    // ADR 64/78 — late-bind the resolved provider into the APP-SHARED SPINE
    // harnesses (loop / model executor / compiler). They were constructed in
    // the app ctor, BEFORE this async switch resolved, so they missed the
    // construction-time threading a per-session harness (tool executor,
    // session) gets. `adoptTelemetry` lights `ctx.metrics` on THEIR interceptor
    // ctx with the same app-identity label. Feature-detected — a BYO
    // loop/compiler that isn't a `BaseHarness` silently opts out. Skipped when
    // telemetry is off (nothing to bind). Swapped-in executors (`setModel`) are
    // bound at build time in `buildModelExecutor`.
    if (this.telemetryProvider !== undefined) this.adoptSpineTelemetry();
  }

  /**
   * Fan the resolved {@link telemetryProvider} + app-identity metric label into
   * the shared spine harnesses via {@link BaseHarness.adoptTelemetry}. Called
   * once telemetry resolves ({@link initTelemetryExport}). Duck-typed so an
   * external loop/compiler impl that isn't a `BaseHarness` is a no-op.
   */
  private adoptSpineTelemetry(): void {
    const label = this.appName !== undefined ? { app: this.appName } : undefined;
    for (const h of [this.loop, this.modelExecutor, this.compiler]) {
      const adopter = h as {
        adoptTelemetry?: (
          provider: TelemetryProvider | undefined,
          defaultLabels?: Readonly<Record<string, string>>,
        ) => void;
      };
      if (typeof adopter?.adoptTelemetry === "function") {
        adopter.adoptTelemetry(this.telemetryProvider, label);
      }
    }
  }

  private makeInstaller(): AppInstaller {
    const self = this;
    const installerHost: AppInstallerHost = {
      appId: this.scopeId,
      metadata: {},
      getSession: (sessionId) => self.getSession(sessionId),
    };
    return {
      kind: "app",
      hostId: this.scopeId,
      registerNamespace(name, harness): Unsubscribe {
        const prior = self.extensionBridges.get(name);
        self.extensionBridges.set(name, harness);
        return () => {
          if (self.extensionBridges.get(name) === harness) {
            if (prior !== undefined) self.extensionBridges.set(name, prior);
            else self.extensionBridges.delete(name);
          }
        };
      },
      getNamespace<T>(name: string): T | undefined {
        return self.extensionBridges.get(name) as T | undefined;
      },
      onClose(handler): void {
        self.extensionCloseHandlers.push(handler);
      },
      registerContributor(contributor): Unsubscribe {
        // The compiler harness exposes `registerContributor` on
        // CompilerHarness specifically. Duck-type — external
        // compiler impls without the method silently drop.
        const r = self.compiler as {
          registerContributor?: (c: unknown) => void;
        };
        if (typeof r.registerContributor === "function") {
          r.registerContributor(contributor);
        }
        // No unregister surface today; compiler registry is
        // append-only. Future work if extensions need hot-swap.
        return () => {};
      },
      registerToolHandler(handlerRef, handler, validator): Unsubscribe {
        self.handlerResolver.register(handlerRef, handler, validator);
        return () => self.handlerResolver.unregister(handlerRef);
      },
      registerExtensionTool(registration): Unsubscribe {
        self.extensionTools.push(registration);
        return () => {
          const idx = self.extensionTools.indexOf(registration);
          if (idx >= 0) self.extensionTools.splice(idx, 1);
        };
      },
      subscribeBus(filter, listener): Unsubscribe {
        // Per-event error isolation + atomic Fiber.interrupt teardown —
        // see forkBusSubscription (single source of truth for the
        // fork-a-bus-subscription dance across all installers).
        return forkBusSubscription(self.bus, filter, listener);
      },
      substrate: {
        journal: self.journal,
        bus: self.bus,
        inbox: self.inbox,
      },
      app: installerHost,
    };
  }

  /**
   * Build a {@link SessionInstaller} bound to a specific session's
   * id. The installer writes session-scoped registrations into the
   * supplied mutable buffers, which `createSessionBody` drains into
   * the session's tool executor + bridges + close handlers AFTER all
   * session-target extensions complete `install(...)`.
   *
   * Mutable-buffer pattern (rather than an immutable build-then-
   * consume pattern) because extensions may reach into peer slots via
   * `installer.getNamespace(...)` mid-install — a single shared map
   * keeps the registration order observable to subsequent extensions
   * in the same install pass.
   *
   * Tool handlers + bus subscriptions register on the SHARED
   * resolvers / bus today; the returned unsubscribers run at
   * session.close so the registrations don't outlive the session.
   * (Per-session HandlerResolver is a #151+ cleanup — handler-ref
   * collisions across sessions are avoided by construction via
   * unique-per-session ref strings.)
   */
  private makeSessionInstaller(
    sessionId: string,
    elicitation: ElicitationHarness,
    tasks: TasksHarness,
    resources: ResourcesHarness,
    bridges: Map<string, unknown>,
    extensionTools: ToolRegistration[],
    closeHandlers: Array<() => void | Promise<void>>,
    toolHandlerUnregs: Array<() => void>,
    busUnregs: Array<() => void>,
  ): SessionInstaller {
    const self = this;
    const installerHost: AppInstallerHost = {
      appId: this.scopeId,
      metadata: {},
      getSession: (id) => self.getSession(id),
    };
    return {
      kind: "session",
      hostId: sessionId,
      sessionId,
      elicitation,
      tasks,
      resources,
      registerNamespace(name, harness): Unsubscribe {
        const prior = bridges.get(name);
        bridges.set(name, harness);
        return () => {
          if (bridges.get(name) === harness) {
            if (prior !== undefined) bridges.set(name, prior);
            else bridges.delete(name);
          }
        };
      },
      getNamespace<T>(name: string): T | undefined {
        return bridges.get(name) as T | undefined;
      },
      onClose(handler): void {
        closeHandlers.push(handler);
      },
      registerToolHandler(
        handlerRef: string,
        handler: ToolHandler,
        validator?: Validator,
      ): Unsubscribe {
        self.handlerResolver.register(handlerRef, handler, validator);
        const unreg = (): void => self.handlerResolver.unregister(handlerRef);
        toolHandlerUnregs.push(unreg);
        return () => {
          const idx = toolHandlerUnregs.indexOf(unreg);
          if (idx >= 0) toolHandlerUnregs.splice(idx, 1);
          unreg();
        };
      },
      registerExtensionTool(registration): Unsubscribe {
        extensionTools.push(registration);
        return () => {
          const idx = extensionTools.indexOf(registration);
          if (idx >= 0) extensionTools.splice(idx, 1);
        };
      },
      subscribeBus(filter, listener): Unsubscribe {
        // forkBusSubscription = shared fork/interrupt semantics; the
        // busUnregs tracking (session-close teardown for subscriptions
        // the extension never unsubscribed) stays a session concern.
        const unreg = forkBusSubscription(self.bus, filter, listener);
        busUnregs.push(unreg);
        return () => {
          const idx = busUnregs.indexOf(unreg);
          if (idx >= 0) busUnregs.splice(idx, 1);
          unreg();
        };
      },
      substrate: {
        journal: self.journal,
        bus: self.bus,
        inbox: self.inbox,
      },
      app: installerHost,
    };
  }

  /**
   * Resolves once the app's own sub-harness inbox registrations have
   * settled. The caller-supplied `executor` is expected to be already
   * ready (constructed and its `.ready` awaited) when passed in.
   */
  get appReady(): Promise<void> {
    // Sub-harnesses expose `ready` via `BaseHarness` — the bundled
    // defaults implement it; user-supplied instances are expected to
    // already be ready. Probe duck-typed so external impls without a
    // `ready` getter still work.
    const compilerReady = readyOf(this.compiler);
    const loopReady = readyOf(this.loop);
    return Promise.all([
      this.ready,
      compilerReady,
      loopReady,
      this.extensionsReady,
      this.telemetryReady,
    ]).then(() => {});
  }

  // ──────── AppHarnessProtocol ────────

  createSession(input: CreateSessionInput<P> = {}): Promise<SessionHarnessProtocol<P>> {
    // ADR 51 classification: createSession/runOnce inputs may carry a
    // JSX rootElement + live extension objects — in-process-only by
    // doctrine (§1.2). The wire reaches these via the app/* porcelain
    // methods. close-app is serializable (no input) and is a declared-
    // command candidate; its exposure is a verb-matrix decision
    // (remote shutdown is powerful) — deferred with slice 5.
    const op: Operation<CreateSessionInput<P>, SessionHarnessProtocol<P>> = {
      opId: `app:create-session:${ulid()}`,
      surface: "app",
      name: "app:command:create-session",
      scope: {
        ...omitUndefined({ sessionId: input.sessionId }),
      },
      input,
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.createSessionBody(i, /* ephemeral */ false),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
  }

  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult> {
    const op: Operation<RunOnceInput<P>, RunOnceResult> = {
      opId: `app:run-once:${ulid()}`,
      surface: "app",
      name: "app:command:run-once",
      scope: {
        ...omitUndefined({ sessionId: input.sessionId }),
      },
      input,
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.runOnceBody(i),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
  }

  getSession(sessionId: string): SessionHarnessProtocol<P> | undefined {
    return this.registry.get(sessionId)?.session;
  }

  /**
   * Enumerate the durable session registry — the {@link SessionStore} (E11).
   * Returns {@link SessionRecord}s (the superset: every non-ephemeral session
   * ever, including closed ones the live `registry` dropped), filtered by app /
   * status / parent / recency. This — NOT the live registry — backs every
   * "list / resume my sessions" surface. See {@link getSession} for the live
   * routing half of the E11 split.
   */
  listSessions(query?: SessionStoreQuery): Promise<readonly SessionRecord[]> {
    return this.sessionStore.list(query, this.storeCtx());
  }

  /**
   * Read one durable {@link SessionRecord} by id from the {@link SessionStore}
   * (E11). Resolves even for a closed / historical session the live registry
   * has dropped. `undefined` when unknown.
   */
  getSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessionStore.get(sessionId, this.storeCtx());
  }

  /**
   * Set the app-owned descriptive slots on a session's durable
   * {@link SessionRecord} (E11) — the app's to populate (auto-summary,
   * user-edit, the open bag); the framework STORES them, blind to semantics.
   * Routed through the LIVE session so its own record writes stay the single
   * writer (last-writer-wins is otherwise racy). No-op when the session is not
   * live.
   *
   * TODO(store-phase-4): editing meta on a CLOSED session (absent from the live
   * registry) needs a store read-modify-write path; deferred with the manifest
   * sweep.
   */
  async setSessionMeta(
    sessionId: string,
    meta: {
      readonly title?: string;
      readonly description?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const session = this.registry.get(sessionId)?.session;
    session?.setMeta(meta);
    await Promise.resolve();
  }

  events(filter: EventQuery = {}, options: SubscribeOptions = {}): AsyncIterable<ProtocolEvent> {
    const bus = this.bus;
    return {
      [Symbol.asyncIterator]: () => busAsyncIterator(bus, filter, options),
    };
  }

  async closeApp(): Promise<void> {
    const op: Operation<void, void> = {
      opId: `app:close-app:${ulid()}`,
      surface: "app",
      name: "app:command:close-app",
      scope: {},
      input: undefined,
    };
    await this.runWithTelemetry(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.closeAppBody(),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
    // Dispose the telemetry runtime AFTER the close operation ran on it, so its
    // own spans are captured and the exporter flushes pending spans (ADR 78).
    if (this.telemetryRuntime !== undefined) await this.telemetryRuntime.dispose();
    // Release this app's hold on the shared metrics MeterProvider (the last
    // holder flushes + shuts it down; a sibling app sharing the readers keeps
    // exporting). Best-effort — a failing exporter must not block app close.
    if (this.telemetryReleaseMeter !== undefined) {
      try {
        await this.telemetryReleaseMeter();
      } catch {
        // best-effort metrics flush — teardown errors don't block app close
      }
    }
  }

  /**
   * Alias for {@link closeApp}. Ergonomic — reads naturally as
   * `await app.close()` alongside `await session.close()` /
   * `await harness.close()`.
   */
  close(): Promise<void> {
    return this.closeApp();
  }

  /**
   * Ergonomic shortcut over {@link runOnce}: send a user message or a
   * pre-built `SendInput` through a one-shot ephemeral session and
   * return the result directly (no `RunOnceResult` wrapper).
   *
   * @example
   *   const result = await app.send("What's 47 * 23?");
   *   console.log(result.response);
   *
   * @example
   *   const result = await app.send({
   *     messages: [{ role: "user", content: "Hello" }],
   *     metadata: { trace: "demo" },
   *   });
   *
   * Adopters who need the ephemeral `sessionId` for telemetry / event
   * subscription should use {@link runOnce} directly.
   */
  async send(input: string | SendInput<P>): Promise<SendResult> {
    const sendInput: SendInput<P> =
      typeof input === "string"
        ? ({ messages: [{ role: "user", content: input }] } as SendInput<P>)
        : input;
    const { result } = await this.runOnce({ send: sendInput });
    return result;
  }

  /**
   * Wrap an Effect with the optional `telemetry` Layer (4f.7) before
   * handing to `runHarnessProtocol`. When no Layer is set, this is a
   * pass-through. When set, the Layer provides services
   * (e.g., OTel Tracer) to the Effect's runtime context so the
   * substrate's `Effect.withSpan` annotations flow to the configured
   * exporter.
   */
  private runWithTelemetry<R>(eff: Effect.Effect<R, unknown, never>): Promise<R> {
    // Run on the app's ManagedRuntime (built once from the telemetry Layer) so
    // `Effect.withSpan` annotations reach the configured tracer. Falls through
    // to the default runtime when no telemetry Layer was supplied — identical
    // to the prior behavior. Error normalization is preserved (both paths go
    // through `runHarnessProtocol`'s Exit unwrap).
    return runHarnessProtocol(eff, this.telemetryRuntime);
  }

  // ──────── lifecycle hooks (block 5 — α design) ────────

  onSessionCreate(
    handler: (
      input: CreateSessionInput<P>,
    ) => Promise<{ readonly kind: "veto"; readonly reason?: string } | void>,
  ): () => void {
    this.sessionCreateHandlers.push(handler);
    return () => {
      const i = this.sessionCreateHandlers.indexOf(handler);
      if (i >= 0) this.sessionCreateHandlers.splice(i, 1);
    };
  }

  onSessionClose(
    handler: (info: {
      readonly sessionId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void> | void,
  ): () => void {
    this.sessionCloseHandlers.push(handler);
    return () => {
      const i = this.sessionCloseHandlers.indexOf(handler);
      if (i >= 0) this.sessionCloseHandlers.splice(i, 1);
    };
  }

  onAppClose(handler: () => Promise<void> | void): () => void {
    this.appCloseHandlers.push(handler);
    return () => {
      const i = this.appCloseHandlers.indexOf(handler);
      if (i >= 0) this.appCloseHandlers.splice(i, 1);
    };
  }

  // ──────── inbox dispatch (deferred to 4f+) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<HandlerVerdict | void, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({ cause: new Error("app inbox dispatch not yet wired (Phase 4f minimum)") }),
    );
  }

  // ──────── internals ────────

  private async createSessionBody(
    input: CreateSessionInput<P>,
    ephemeral: boolean,
    overrides: {
      readonly agent?: unknown;
      readonly parentSessionId?: string;
      /** SP5 — the child's spawn lineage, forwarded onto the session. */
      readonly spawnPath?: readonly string[];
      /** SP6 — the parent's construction signal, fanned into the child. */
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<SessionHarnessProtocol<P>> {
    this.assertOpen();

    // Run `onSessionCreate` handlers — first veto wins. Replace and
    // defer verdicts aren't supported for session creation (no
    // meaningful semantics here yet); we recognize only veto/proceed.
    for (const h of this.sessionCreateHandlers) {
      const verdict = await h(input);
      if (verdict && verdict.kind === "veto") {
        throw new AppExecutionFailed({
          cause: new Error(
            verdict.reason ? `session create vetoed: ${verdict.reason}` : "session create vetoed",
          ),
        });
      }
    }

    const sessionId = input.sessionId ?? `session:${ulid()}`;
    // Idempotent open-or-rehydrate (ADR 49 §Hydration): createSession
    // with an id that's already live returns the existing session — the
    // same call is create AND resume, which is what stateless-replica
    // deployments need (any node, any time). The open call's other
    // options are ignored for an existing session (its construction is
    // done). Cross-restart resume — id NOT in the registry, durable
    // store holds entries — is the fresh-construction path below, which
    // hydrates via `session.timeline` options.
    const existing = this.registry.get(sessionId);
    if (existing !== undefined) {
      // A repeat open is activity — keep it warm against LRU / idle eviction.
      this.touchActivity(sessionId);
      return existing.session as SessionHarnessProtocol<P>;
    }

    // ADR 76 tier 3 + ADR 83 amendment — ONE construction-fold value. Snapshot
    // the app's RESOLVED interceptors NOW (captures boot-time `app.use()` /
    // `app.guard()` AND the app's declarative hooks, registered in the app ctor)
    // then APPEND the session's own declarative `createSession({ hooks })`
    // adapted to op-scoped middleware. Guards, `.use` transforms, AND the
    // app+session command hooks now ride this SINGLE value (was two: a separate
    // `sessionHooks` layer + `inheritedInterceptors`). Threaded into the
    // SessionHarness AND every per-session sub-harness below. App-outer,
    // session-inner: the app interceptors precede the session-hook middleware in
    // registration order.
    //
    // ADR 83 §4 — this is the ONE-TIME construction snapshot (pull-seed). The
    // relation is kept LIVE by `interceptorParent: this` on each child below: the
    // session AND every per-session sub-harness (elicitation / tasks / resources
    // / tool-executor) register as live children of THIS app, so a LATER
    // `app.use()` / `app.guard()` / `app.hook()` — including a gateway hook that
    // folded into the app — reaches them all (the gateway→app→session
    // requirement). Parenting to the app (not the session) is correct: the app
    // constructs these before the session exists and seeds them from
    // `app.resolvedInterceptors()`. The session→bridges(knobs) edge is parented
    // to the session (in SessionHarness). Each per-session child is closed on
    // session teardown, which detaches it from this app's children set.
    const inheritedInterceptors = [
      ...this.resolvedInterceptors(),
      ...hooksToMiddlewares(input.hooks ?? {}),
    ];
    // TODO(adr-84): the ONLY remaining live-inheritance gap is the gateway→app
    // edge — the gateway does not link to apps at all yet (no `interceptorParent`
    // on `createApp`). Once it does, a gateway hook folds through the app and
    // cascades down these already-live app→session→sub edges unchanged.

    // Per-session elicitation harness. Owns the request/response
    // correlation engine for tool confirmation, MCP elicitation, and
    // any other "ask user X" step. The same instance is threaded into
    // BOTH the tool executor (for the confirmation gate) AND the
    // session bridges (so React-side `bridges.elicitation` and
    // server-side `bridges.elicitation.respond(...)` from clients
    // reach the same registry the tool executor is awaiting).
    // ADR 76 + ADR 83 amendment — the interception cascade reaches these
    // per-session sub-harnesses via the ONE `inheritedInterceptors` VALUE
    // (folded above): `app.use()` / `app.guard()` MIDDLEWARE, guards, AND the
    // app+session command hooks (as op-scoped middleware) all inherit through
    // this single fold. No parent pointer, one threaded value (was two).
    const elicitation = new ElicitationHarness(
      `${sessionId}:elicitation`,
      this.journal,
      this.bus,
      this.inbox,
      { parentScope: { sessionId }, inheritedInterceptors, interceptorParent: this },
    );

    // Per-session tasks harness — substrate-level long-running tool
    // registry. Surfaced on `ctx.tasks` for handlers, on
    // `bridges.tasks` for JSX, and routed through the ToolExecutor's
    // `tasks` slot so handlers returning a TaskHandle branch on the
    // tool's `taskSupport` annotation (#156).
    const tasks = new TasksHarness(`${sessionId}:tasks`, this.journal, this.bus, this.inbox, {
      parentScope: { sessionId },
      // ADR 68 — the shared app-scoped store + executor registry, so
      // detached tasks outlive the per-session harness and child-process
      // reattach finds its still-live children. Scope-filtered by
      // `{ sessionId }` above.
      store: this.taskStore,
      executors: this.taskExecutors,
      // TASK-WAKE — app-wide default wake policy (per-submit `wake` overrides).
      ...(this.taskDefaultWake !== undefined ? { defaultWake: this.taskDefaultWake } : {}),
      // ADR 76/83 — the app's resolved interceptor snapshot incl. the app+session
      // command hooks as op-scoped middleware. Live via `interceptorParent`.
      inheritedInterceptors,
      interceptorParent: this,
    });

    // Per-session resources harness (ADR 62) — the application-controlled
    // read-projection seam. Constructed at the single site symmetrically
    // with elicitation + tasks (#159). The SAME instance is threaded into
    // the ToolExecutor's `ctx.resource`, the session bridges
    // (`bridges.resources`), and the SessionInstaller (`installer.resources`)
    // so `withResources` (model tools) and `withMCP` (remote-resource
    // proxy-registration) all reach one registry. Lifecycle owned here.
    const resources = new ResourcesHarness(
      `${sessionId}:resources`,
      this.journal,
      this.bus,
      this.inbox,
      // ADR 76/83 — the app's resolved interceptor snapshot incl. the app+session
      // command hooks as op-scoped middleware. Live via `interceptorParent`.
      { inheritedInterceptors, interceptorParent: this },
    );

    // ── Session extension lifecycle (#150) ────────────────────────
    //
    // Run cached session-target extensions BEFORE constructing the
    // ToolExecutor so extension-contributed tools land in
    // initialTools (binding tagged `scope: extension` /
    // `level: session`). Bridges registered via `installer.
    // registerNamespace` overlay the app-level extension bridges.
    // Close-handlers fire on session.close.
    const sessionExtensionBridges = new Map<string, unknown>(this.extensionBridges);
    const sessionExtensionTools: ToolRegistration[] = [];
    const sessionCloseHandlers: Array<() => void | Promise<void>> = [];
    const sessionToolHandlerUnregs: Array<() => void> = [];
    const sessionBusUnregs: Array<() => void> = [];
    if (this.sessionExtensions.length > 0) {
      const installer = this.makeSessionInstaller(
        sessionId,
        elicitation,
        tasks,
        resources,
        sessionExtensionBridges,
        sessionExtensionTools,
        sessionCloseHandlers,
        sessionToolHandlerUnregs,
        sessionBusUnregs,
      );
      for (const ext of this.sessionExtensions) {
        // Type guarantee: `sessionExtensions` was filtered to
        // `target !== "app"` at app construction (line ~606). The
        // remaining union is `SessionExtension`; cast for the
        // narrowing the runtime guarantees.
        await (ext as SessionExtension).install(installer);
      }
    }

    // Per-session tool executor. Two paths:
    //   - `toolFactory` set → invoke it with the shared substrate; the
    //     resulting `ToolExecutorProtocol` is opaque to the App.
    //   - Otherwise → construct the bundled `ToolExecutorHarness` from
    //     `toolDefaults` + the shared `handlerResolver` + the
    //     per-session elicitation harness.
    // Merge tools from six sources into the per-session executor's
    // initial registry:
    //   1. `inheritedTools` — pre-tagged registrations propagated from
    //      a parent context (gateway, slice 7 #141). Already carry
    //      their own binding (typically `{scope:"gateway"}`).
    //   2. extension-contributed tools at app level (e.g. withSandbox) —
    //      already carry `binding: { scope: "extension", level: "app" }`
    //   3. extension-contributed tools at session level (#150) — carry
    //      `binding: { scope: "extension", level: "session" }`. Rank
    //      above app-extension tools per the precedence ladder.
    //   4. `appLevelTools` — adopter-supplied via `createApp({ tools })`,
    //      tagged at App construction with
    //      `binding: { scope: "app", appId }` (slice 6 #140)
    //   5. `toolDefaults.initialTools` — adopter-supplied executor
    //      configuration; carries whatever binding the adopter set
    //      (defaults to runtime)
    //   6. `CreateSessionInput.tools` — adopter-supplied per-session,
    //      tagged HERE with `binding: { scope: "session", sessionId }`
    //
    // Precedence at compile-time (slice 2's `compileForTick`):
    // session > execution-via-send > {app, extension@app} > gateway >
    // runtime. Insertion order below is irrelevant — the registry
    // resolves by binding rank, not insertion.
    const sessionScopedTools: readonly ToolRegistration[] = (input.tools ?? []).map((decl) =>
      toRegistration(decl, { scope: "session", sessionId }),
    );
    const mergedInitialTools: readonly ToolRegistration[] | undefined =
      this.inheritedTools.length > 0 ||
      this.extensionTools.length > 0 ||
      sessionExtensionTools.length > 0 ||
      this.appLevelTools.length > 0 ||
      (this.toolDefaults.initialTools !== undefined && this.toolDefaults.initialTools.length > 0) ||
      sessionScopedTools.length > 0
        ? [
            ...this.inheritedTools,
            ...this.extensionTools,
            ...sessionExtensionTools,
            ...this.appLevelTools,
            ...(this.toolDefaults.initialTools ?? []),
            ...sessionScopedTools,
          ]
        : undefined;

    // ADR 66 — dispatch-resolved `ctx` extensions. The AppHarness is the
    // single construction site that fills the values: it resolves the
    // registered "sandbox" namespace GENERICALLY (an opaque value pulled
    // from the same bridges bag `bridges.sandbox` reads from) and threads
    // it as `ctxExtensions: { sandbox }`. No sandbox import — the value is
    // handled as an opaque `unknown`; its TYPE (`ctx.sandbox`) is
    // contributed by the `@agentick/sandbox-next` augmentation on the far
    // side, and the tool executor spreads the record onto every ctx
    // without inspecting it. Omitted entirely when sandbox isn't mounted.
    // Each optional harness that ships model tools contributes its ctx
    // slot here: the namespace it registered on the session bridge bag is
    // threaded onto `ctx.<slot>` (typed by that package's
    // `ToolHandlerCtxExtensions` augmentation), resolved at dispatch. Add
    // one line per tool-shipping harness — a curated projection, NOT the
    // whole session (three-audiences-plan §D). `skills` rides this because
    // `withSkills` registers its harness under the `skills` namespace
    // BEFORE this site runs; `knobs` does NOT (delta 3) — its bridge is a
    // core session bridge born later, inside `buildSessionBridges`.
    const ctxExtensionEntries: Record<string, unknown> = {};
    const sandboxNamespace = sessionExtensionBridges.get("sandbox");
    if (sandboxNamespace !== undefined) ctxExtensionEntries.sandbox = sandboxNamespace;
    const skillsNamespace = sessionExtensionBridges.get("skills");
    if (skillsNamespace !== undefined) ctxExtensionEntries.skills = skillsNamespace;
    const ctxExtensions: Readonly<Record<string, unknown>> | undefined =
      Object.keys(ctxExtensionEntries).length > 0 ? ctxExtensionEntries : undefined;

    const tools: ToolExecutorProtocol = this.toolFactory
      ? this.toolFactory({
          scopeId: sessionId,
          journal: this.journal,
          bus: this.bus,
          inbox: this.inbox,
        })
      : new ToolExecutorHarness(sessionId, this.journal, this.bus, this.inbox, {
          ...this.toolDefaults,
          ...omitUndefined({ initialTools: mergedInitialTools }),
          handlerResolver: this.handlerResolver,
          elicitation,
          tasks,
          resources,
          ...omitUndefined({ ctxExtensions }),
          // ADR 64/78 — the resolved telemetry provider. Presence lights
          // `ctx.trace` / `ctx.metrics` in this session's tool handlers; its
          // `meter` exports metrics. Undefined when telemetry is OFF (the tool
          // executor takes the shared off-path singletons). Set before appReady,
          // and sessions are only created after appReady.
          ...omitUndefined({ telemetryProvider: this.telemetryProvider }),
          // App-identity ambient metric label — distinguishes this app's
          // `ctx.metrics.*` from a sibling app sharing the same MeterProvider
          // (gateway multi-app inheritance). Low-cardinality (few apps); omitted
          // when the app is unnamed.
          ...omitUndefined({
            defaultMetricLabels: this.appName !== undefined ? { app: this.appName } : undefined,
          }),
          // ADR 76/83 — the ONE resolved interceptor snapshot: `app.use()` /
          // `app.guard()` AND the app+session `onBefore/After/AroundToolDispatch`
          // hooks (as op-scoped middleware) all wrap `tool:dispatch`, which
          // routes through `runOperation`. LIVE via `interceptorParent` (ADR 83
          // §4) — a LATER app/gateway hook reaches `tool:dispatch` too.
          inheritedInterceptors,
          interceptorParent: this,
        });

    // Cascade: per-call `createSession.*` > per-app `session.*` >
    // shorthand (`defaultMaxTicks`/`initialProps`/`initialKnobs`).
    // sessionDefaults already collapsed (longhand vs shorthand).
    const session = new SessionHarness<P>(this.journal, this.bus, this.inbox, {
      ...this.sessionDefaults,
      sessionId,
      // Agent cascade: spawn-supplied (overrides.agent) > per-call
      // input.rootElement > app's rootElement.
      agent: overrides.agent ?? input.rootElement ?? this.rootElement,
      compiler: this.compiler,
      loop: this.loop,
      modelExecutor: this.modelExecutor,
      // ADR 89 §2 — adapter→executor builder for `session.model.setModel(adapter)`.
      // Present only for adapter-constructed apps (undefined → BYO-executor).
      ...(this.buildModelExecutor !== undefined
        ? { buildModelExecutor: this.buildModelExecutor }
        : {}),
      toolExecutor: tools,
      elicitation,
      tasks,
      resources,
      target: this.target,
      // ADR 77 Stage 4 — forward the app-scoped telemetry runtime + the
      // whitelabel namespace so the session runs its composed execution on
      // the tracer runtime (nested spans).
      // TODO(stage-4: fiber-context-namespace) — this whitelabels only
      // SESSION-owned spans. The spine harnesses (loop/executor/tool/
      // compiler) carry their own `telemetryNamespace` (default
      // "agentick") and their constructors don't accept an override, so a
      // WHOLE-SPINE whitelabel needs the namespace read from fiber context
      // (ADR 78 brick #2), not per-harness fields. Nesting is unaffected.
      telemetryNamespace: this.telemetryNamespace,
      ...(this.telemetryRuntime !== undefined ? { telemetryRuntime: this.telemetryRuntime } : {}),
      // ADR 64/78 — the resolved provider's `meter` lights `ctx.metrics` on the
      // session's interceptor ctx (a session/app hook or guard reaching
      // metrics). App-identity ambient label keeps multi-app sinks distinct.
      // The shared spine harnesses (loop/model/compiler) get the SAME provider
      // late-bound via `adoptSpineTelemetry` (they predate the async telemetry
      // switch), so their interceptor ctx metrics are live too.
      ...omitUndefined({ telemetryProvider: this.telemetryProvider }),
      ...omitUndefined({
        defaultMetricLabels: this.appName !== undefined ? { app: this.appName } : undefined,
      }),
      // Telemetry rung 1 — the app's enrichment interceptors ride every send's
      // tier-4 seam (reaching model/tool/tick ops uniformly). `[]` when off.
      telemetryMiddleware: this.telemetryMiddleware,
      // ADR 76/83 — the ONE resolved interceptor snapshot: `app.use(...)` /
      // `app.guard(...)` AND the app+session command hooks (as op-scoped
      // middleware) wrap every session op, folded in at construction. The
      // SessionHarness re-folds this onto its own per-session bridges. LIVE via
      // `interceptorParent` (ADR 83 §4) — a LATER app/gateway hook reaches this
      // session (and, through its bridges edge, the knobs harness) too.
      inheritedInterceptors,
      interceptorParent: this,
      defaultMaxTicks: input.maxTicks ?? this.sessionDefaults.defaultMaxTicks ?? 8,
      // PA1 — fan the app-wide signal into the session as its construction
      // signal. Per-session `CreateSessionInput.signal` overrides it (a
      // caller who wires their own signal owns that session's cancel). The
      // session merges this with each `SendInput.signal` on every send.
      // SP6 — a spawned child's `overrides.signal` (its parent's construction
      // signal) takes precedence, so a parent abort cascades into the child.
      ...omitUndefined({ signal: overrides.signal ?? input.signal ?? this.appSignal }),
      // SP4/SP5 — spawn lineage + depth ceiling. `spawnPath` is set only for a
      // spawned child (via `createChildSession`); `maxSpawnDepth` is stamped
      // app-uniformly on every session so the SP4 guard reads a consistent cap.
      ...omitUndefined({ spawnPath: overrides.spawnPath }),
      maxSpawnDepth: this.maxSpawnDepth,
      ...(input.requiredScopes !== undefined ? { requiredScopes: input.requiredScopes } : {}),
      ...(this.models !== undefined ? { models: this.models } : {}),
      // Streaming cascade: per-session input.streaming > app-level
      // streamingDefault (sessionDefaults.defaultStreaming) > undefined
      // (executor-capability default resolved per-send in SessionHarness).
      ...(input.streaming !== undefined
        ? { defaultStreaming: input.streaming }
        : this.sessionDefaults.defaultStreaming !== undefined
          ? { defaultStreaming: this.sessionDefaults.defaultStreaming }
          : {}),
      // Narration cascade (Pass B): per-session input.narrate > app-level
      // sessionDefaults.narrate > undefined (SessionHarness defaults ON).
      ...(input.narrate !== undefined
        ? { narrate: input.narrate }
        : this.sessionDefaults.narrate !== undefined
          ? { narrate: this.sessionDefaults.narrate }
          : {}),
      ...(input.initialProps !== undefined
        ? { props: input.initialProps }
        : this.sessionDefaults.props !== undefined
          ? { props: this.sessionDefaults.props }
          : {}),
      ...(input.initialKnobs !== undefined
        ? { initialKnobs: input.initialKnobs }
        : this.sessionDefaults.initialKnobs !== undefined
          ? { initialKnobs: this.sessionDefaults.initialKnobs }
          : {}),
      // Initial session-state cascade.
      ...(input.initialState !== undefined
        ? { initialState: input.initialState }
        : this.sessionDefaults.initialState !== undefined
          ? { initialState: this.sessionDefaults.initialState }
          : {}),
      // Per-session substrate overrides (ADR 31 Phase 3). Cascade:
      // per-call input > app-level session defaults. Omitted → session
      // inherits the app's substrate directly.
      ...(input.bus !== undefined
        ? { bus: input.bus }
        : this.sessionDefaults.bus !== undefined
          ? { bus: this.sessionDefaults.bus }
          : {}),
      ...(input.inbox !== undefined
        ? { inbox: input.inbox }
        : this.sessionDefaults.inbox !== undefined
          ? { inbox: this.sessionDefaults.inbox }
          : {}),
      ...(input.journal !== undefined
        ? { journal: input.journal }
        : this.sessionDefaults.journal !== undefined
          ? { journal: this.sessionDefaults.journal }
          : {}),
      // Adopter metadata flows through to session.metadata + to
      // session-level substrate factories via `parent.metadata`.
      ...omitUndefined({ metadata: input.metadata }),
      // Inject self as SpawnContext so the child can spawn grandchildren.
      spawnContext: this,
      // Surface the shared handler resolver as a ToolBridge so
      // compiler-side tools register handlers at render time.
      toolBridge: this.toolBridge,
      // Extension-provided bridges. App-level bridges are merged in
      // at `sessionExtensionBridges` construction (above); session-
      // extensions overlay them via `installer.registerNamespace`.
      ...(sessionExtensionBridges.size > 0 ? { extensionBridges: sessionExtensionBridges } : {}),
      // ParentSessionId cascade: spawn-supplied (overrides) wins; adopter
      // can also wire a non-spawn parent linkage via input.parentSessionId.
      ...(overrides.parentSessionId !== undefined
        ? { parentSessionId: overrides.parentSessionId }
        : input.parentSessionId !== undefined
          ? { parentSessionId: input.parentSessionId }
          : {}),
      // E11 — the durable session registry. Injected app-singleton (mirrors
      // `taskStore`), so the session mirrors its metadata into the store off
      // the critical path. Ephemeral (`runOnce`) sessions get NO store — they
      // are throwaway and must not pollute the durable "list my sessions"
      // superset (parity with the old registry-listing's `ephemeral` skip).
      ...(ephemeral ? {} : { sessionStore: this.sessionStore }),
      appId: this.id,
      // App-owned descriptive slots seeded at construction (E11) — the
      // framework stores, never populates. `metadata` already flows above.
      ...omitUndefined({
        title: input.title,
        description: input.description,
        agentId: input.agentId,
      }),
    });

    // `ready` / `close` aren't on `ToolExecutorProtocol` — duck-type
    // through `readyOf` / `closeOf` so both the reference harness AND
    // factory-produced impls work transparently.
    await Promise.all([readyOf(tools), session.ready]);
    await session.mountReady;

    // C-core (three-audiences-plan §C) — late-bind the session's `send` into
    // any session-extension bridge that runs sends on the adopter's behalf but
    // was constructed WITHOUT session access (`RunnerBindable` — the skills
    // harness today, for `session.skills.run`). Generic feature-detect over the
    // extension bridge bag, no hardcoded slot names (ADR 27, uniform with the
    // `SnapshotCapable` fold). Bound AFTER `mountReady` so the first run reaches
    // a fully-wired session; the harness gets ONLY the send capability, never
    // the session itself.
    if (sessionExtensionBridges.size > 0) {
      const sendCapability: SessionSendCapability = (sendInput) =>
        session.send(sendInput as SendInput<P>);
      // C2 (three-audiences-plan §C split, item 3) — the ISOLATED send
      // capability. Each run forks the session (`session.fork()` — a same-image
      // child with a full copied-state snapshot) and runs the composed send on
      // that fresh child, so nothing from the isolated run touches THIS
      // session's timeline/state. The child is disposed after the handle
      // settles (registry removal + `session.close()` via `disposeChildSession`,
      // which awaits the child's own quiescence). Disposal rides OFF the
      // critical path: its errors are swallowed and never mask the run result.
      const isolationCapability: SessionSendCapability = async (sendInput) => {
        const child = await session.fork();
        const handle = await child.send(sendInput as SendInput<P>);
        void handle.result
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            void this.disposeChildSession(child.id).catch(() => {});
          });
        return handle;
      };
      for (const bridge of sessionExtensionBridges.values()) {
        if (isRunnerBindable(bridge)) {
          bridge.bindRunner(sendCapability);
          // Optional sibling — present only on harnesses that opt into
          // isolation (skills). Absent ⇒ the harness keeps its pre-C2 behavior.
          bridge.bindIsolationRunner?.(isolationCapability);
        }
      }
    }

    // Wire session-extension teardown: handlers registered via the
    // SessionInstaller's `onClose` AND any tool-handler / bus
    // unsubscribers the installer accumulated. Fired LIFO at
    // session.close (BaseHarness's `onClose` semantics — registration
    // order reversed; errors swallowed per handler).
    if (
      sessionCloseHandlers.length > 0 ||
      sessionToolHandlerUnregs.length > 0 ||
      sessionBusUnregs.length > 0
    ) {
      const sessionAsHarness = session as unknown as {
        onClose: (h: () => void | Promise<void>) => void;
      };
      // Bus subs first to unregister (innermost), then tool-handler
      // unregs, then user-supplied onClose handlers reversed. Stacked
      // pushes give LIFO firing at close time.
      for (const unreg of sessionBusUnregs) sessionAsHarness.onClose(unreg);
      for (const unreg of sessionToolHandlerUnregs) sessionAsHarness.onClose(unreg);
      for (const h of sessionCloseHandlers) sessionAsHarness.onClose(h);
    }

    const entry: InternalSessionEntry<P> = {
      id: sessionId,
      session,
      tools,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      ephemeral,
      ...omitUndefined({ parentSessionId: overrides.parentSessionId }),
    };
    this.registry.set(sessionId, entry);
    // PA2 — enforce the LRU cap AFTER registering the newcomer. Ephemeral
    // (`runOnce`) sessions are self-disposing and exempt (see `enforceMaxActive`).
    if (!ephemeral) await this.enforceMaxActive(sessionId);
    return session;
  }

  /**
   * `SpawnContext` impl — invoked by a parent SessionHarness when its
   * `spawn()` method is called. Creates a child session linked to the
   * parent in the registry.
   */
  async createChildSession(input: SpawnContextChildInput<P>): Promise<SessionHarnessProtocol<P>> {
    const createInput: CreateSessionInput<P> = {
      ...omitUndefined({
        sessionId: input.sessionId,
        metadata: input.metadata,
        initialProps: input.initialProps,
        initialKnobs: input.initialKnobs,
        maxTicks: input.maxTicks,
      }),
    };
    return this.createSessionBody(createInput, /* ephemeral */ false, {
      agent: input.agent,
      parentSessionId: input.parentSessionId,
      // SP5/SP6 — forward the child's lineage + the parent's construction
      // signal so the session stamps envelopes and cascades teardown.
      ...omitUndefined({ spawnPath: input.spawnPath, signal: input.signal }),
    });
  }

  /**
   * `SpawnContext.disposeChildSession` (SP6) — tear down a spawned child on
   * behalf of its parent. Routes through the same registry-aware
   * `disposeSession("close")` a genuine session end uses, so the child is
   * removed from the live registry, its harness is closed, and the app-level
   * `onSessionClose` fires. Idempotent — an unknown / already-disposed id is a
   * no-op (`disposeSession` early-returns on a registry miss).
   */
  async disposeChildSession(sessionId: string): Promise<void> {
    // A parent-abort cascade can fire WHILE the child's execution is still
    // draining (the same signal is tearing that execution down). Wait for the
    // child to go quiescent before closing — closing mid-tick would unmount
    // the child's compiler out from under its loop (→ `NotMounted`). The
    // construction-signal merge guarantees the execution is already aborting,
    // so this settles promptly.
    const entry = this.registry.get(sessionId);
    const session = entry?.session as { whenQuiescent?: () => Promise<void> } | undefined;
    if (session?.whenQuiescent !== undefined) {
      await session.whenQuiescent().catch(() => undefined);
    }
    await this.disposeSession(sessionId, "close");
  }

  private async runOnceBody(input: RunOnceInput<P>): Promise<RunOnceResult> {
    this.assertOpen();
    const sessionId = input.sessionId ?? `runonce:${ulid()}`;
    const createInput: CreateSessionInput<P> = {
      sessionId,
      ...omitUndefined({
        metadata: input.metadata,
        initialProps: input.initialProps,
        maxTicks: input.maxTicks,
      }),
    };
    const session = (await this.createSessionBody(
      createInput,
      /* ephemeral */ true,
    )) as SessionHarness<P>;

    try {
      const handle = await session.send(input.send);
      const result: SendResult = await handle.result;
      this.touchActivity(sessionId);
      return { result, sessionId };
    } finally {
      await this.disposeSession(sessionId);
    }
  }

  private async closeAppBody(): Promise<void> {
    if (this._closed) return;

    // Fire onAppClose handlers FIRST so they can observe pre-shutdown
    // state. Errors swallowed.
    for (const h of this.appCloseHandlers) {
      try {
        await h();
      } catch {
        // best effort
      }
    }

    // Fire extension close handlers in reverse registration order.
    // Errors swallowed so one misbehaving extension can't block
    // teardown of others. (ADR 26: `installer.onClose(handler)`
    // replaces the old `AppExtension.uninstall` lifecycle.)
    for (const handler of this.extensionCloseHandlers.slice().reverse()) {
      try {
        await handler();
      } catch {
        // best effort
      }
    }

    this._closed = true;

    // PA2/PA3 — stop the idle sweep + activity subscription before draining
    // the registry (no sweep races the teardown; no dangling bus fiber).
    if (this.idleSweepTimer !== undefined) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
    if (this.activityUnsub !== undefined) {
      this.activityUnsub();
      this.activityUnsub = undefined;
    }

    // Close every registered session. Order isn't load-bearing — each
    // session unmounts independently.
    const sessionIds = Array.from(this.registry.keys());
    for (const id of sessionIds) {
      await this.disposeSession(id);
    }

    // Tear down shared sub-harnesses last so their inboxes are still
    // alive while sessions detach. `close()` may not exist on
    // user-supplied impls — guard it.
    await Promise.allSettled([closeOf(this.compiler), closeOf(this.loop)]);
    // `super.close()` fires substrate-close handlers registered via
    // factories' `parent.onClose(h)`. Safe to run here because
    // `app:command:close-app` is policy-marked `"bus-only"` in the
    // constructor — the Operation framework writes no envelopes to
    // the journal for this op, so a handler closing the journal
    // doesn't break the framework's terminal append.
    await super.close();
  }

  /**
   * Tear down a live session and drop it from the live registry.
   *
   * `reason: "close"` (default) is a genuine session end — `closeApp`,
   * `runOnce` auto-dispose, or explicit teardown — and fires the app-level
   * `onSessionClose` handlers ("session ended" analytics / cleanup).
   *
   * `reason: "evict"` (PA2/PA3) is transparent PAGING: the live harness is
   * closed to free memory, but the durable `SessionRecord` + timeline store
   * survive and the app-level `onSessionClose` handlers do NOT fire — the
   * session is not ending, only paging out until its next open reconstructs
   * it. The session's OWN close handlers (bridge / extension teardown) run
   * either way, since `session.close()` is called both times.
   */
  private async disposeSession(
    sessionId: string,
    reason: "close" | "evict" = "close",
  ): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    // TOCTOU re-guard (eviction only): the sweep/LRU selected this victim
    // BEFORE awaiting prior disposals — a send may have landed since. No
    // await sits between this check and the registry delete, so the guard
    // is atomic in single-threaded JS: an in-flight session is never
    // evicted mid-send.
    if (reason === "evict" && !this.isEvictable(entry)) return;
    this.registry.delete(sessionId);
    try {
      await entry.session.close();
    } catch {
      // best effort — already-closed sessions throw; ignore
    }
    try {
      await closeOf(entry.tools);
    } catch {
      // best effort
    }
    // Eviction is paging, not a lifecycle end — suppress the app-level
    // "session closed" notification (PA2/PA3). A genuine close fires it.
    if (reason === "evict") return;
    // Fire onSessionClose handlers (informational, return value
    // ignored). Errors swallowed — handlers don't block teardown.
    for (const h of this.sessionCloseHandlers) {
      try {
        await h({ sessionId: entry.id, metadata: entry.metadata });
      } catch {
        // best effort
      }
    }
  }

  private touchActivity(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (entry) entry.lastActiveAt = Date.now();
  }

  /**
   * Can this live session be paged out? Evictable = a durable, quiescent
   * session: NOT ephemeral (`runOnce` sessions self-dispose and carry no
   * durable record) and NOT in-flight (never interrupt active work — the
   * hard eviction invariant). The `hasInFlightExecution` read is the
   * session's own synchronous truth (reservation ∪ persisted execution id).
   */
  private isEvictable(entry: InternalSessionEntry<P>): boolean {
    return !entry.ephemeral && !entry.session.hasInFlightExecution;
  }

  /**
   * PA2 — enforce the soft LRU `maxActive` cap. Counts durable live sessions
   * (ephemeral excluded — they don't consume the cap) and, while over the cap,
   * pages out the least-recently-active EVICTABLE session other than the
   * just-created `keepId`. Soft: if every over-cap session is in-flight, the
   * live count stays above the cap until work settles (safety over bound).
   */
  private async enforceMaxActive(keepId: string): Promise<void> {
    const cap = this.maxActive;
    if (cap === undefined) return;
    // Guard against unbounded churn: at most one eviction is needed per
    // create, but loop defensively in case the cap was lowered at runtime
    // (not currently possible) or prior in-flight sessions since settled.
    for (;;) {
      const durable = [...this.registry.values()].filter((e) => !e.ephemeral);
      if (durable.length <= cap) return;
      const victim = durable
        .filter((e) => e.id !== keepId && this.isEvictable(e))
        .sort((a, b) => (a.lastActiveAt ?? a.createdAt) - (b.lastActiveAt ?? b.createdAt))[0];
      if (victim === undefined) return; // nothing evictable — soft cap holds
      await this.disposeSession(victim.id, "evict");
    }
  }

  /**
   * PA3 — the idle sweep. Pages out every EVICTABLE session whose last
   * activity is older than `idleMs`. Runs on the unref'd background timer, so
   * a quiet app still releases memory. Best-effort: a mid-sweep failure on one
   * session does not block the rest.
   */
  private async sweepIdle(idleMs: number): Promise<void> {
    if (this._closed) return;
    const cutoff = Date.now() - idleMs;
    const stale = [...this.registry.values()].filter(
      (e) => this.isEvictable(e) && (e.lastActiveAt ?? e.createdAt) <= cutoff,
    );
    for (const entry of stale) {
      await this.disposeSession(entry.id, "evict");
    }
  }

  private assertOpen(): void {
    // PA1 — an aborted app signal refuses new work, exactly like a closed
    // app ("closeApp in abort shape"). In-flight executions are torn down
    // separately by the cascaded per-session signal.
    if (this._closed || this.appSignal?.aborted) throw new AppClosedError() as AppError;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function mapAppError(cause: unknown): AppError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as AppError;
  }
  return new AppExecutionFailed({ cause });
}

// ─────────────────────────────────────────────────────────────────────
// Slot resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * `CompilerProtocol` instances expose a `mount()` method; factories
 * carry the `compilerFactory: true` marker. Duck-type to discriminate.
 */
function isCompilerInstance(v: unknown): v is CompilerProtocol {
  return (
    typeof v === "object" && v !== null && typeof (v as { mount?: unknown }).mount === "function"
  );
}

function resolveCompiler(
  slot: CompilerProtocol | CompilerFactory | undefined,
  scopeId: string,
  journal: OperationJournal,
  bus: EventBus,
  inbox: MessageInbox,
): CompilerProtocol {
  if (slot === undefined) {
    throw new Error(
      "createApp: `compiler` is required. Import createApp from " +
        '"@agentick/app-next/react" for the React default, or pass a ' +
        "`CompilerFactory` (e.g., `reactCompiler()` from " +
        '"@agentick/compiler-react-next").',
    );
  }
  if (isCompilerFactory(slot)) {
    return slot({ scopeId, journal, bus, inbox });
  }
  if (isCompilerInstance(slot)) return slot;
  throw new Error(
    "createApp: `compiler` must be a `CompilerProtocol` instance " +
      "or a `CompilerFactory` (produced by `defineCompiler(...)` " +
      "or `reactCompiler(...)` etc.).",
  );
}

/**
 * Collapse the App-level session-defaults cascade into a single
 * `SessionDefaults`. Longhand (`options.session.*`) wins over the
 * top-level convenience shortcuts; conflicts resolve like CSS
 * shorthand-vs-longhand.
 */
function mergeSessionDefaults<P>(options: AppHarnessOptions<P>): SessionDefaults<P> {
  const fromLong = options.session ?? {};
  const merged: Record<string, unknown> = { ...fromLong };
  if (fromLong.defaultMaxTicks === undefined && options.defaultMaxTicks !== undefined) {
    merged.defaultMaxTicks = options.defaultMaxTicks;
  }
  if (fromLong.props === undefined && options.initialProps !== undefined) {
    merged.props = options.initialProps;
  }
  if (fromLong.initialKnobs === undefined && options.initialKnobs !== undefined) {
    merged.initialKnobs = options.initialKnobs;
  }
  if (fromLong.defaultStreaming === undefined && options.streaming !== undefined) {
    merged.defaultStreaming = options.streaming;
  }
  if (fromLong.narrate === undefined && options.narrate !== undefined) {
    merged.narrate = options.narrate;
  }
  if (fromLong.migrateSnapshot === undefined && options.migrateSnapshot !== undefined) {
    merged.migrateSnapshot = options.migrateSnapshot;
  }
  return merged as SessionDefaults<P>;
}

/** Probe an optional async `ready` getter on duck-typed harnesses. */
function readyOf(v: unknown): Promise<void> {
  if (
    typeof v === "object" &&
    v !== null &&
    "ready" in v &&
    (v as { ready: unknown }).ready &&
    typeof (v as { ready: { then?: unknown } }).ready.then === "function"
  ) {
    return (v as { ready: Promise<void> }).ready.then(() => {});
  }
  return Promise.resolve();
}

/** Probe an optional `close()` method on duck-typed harnesses. */
function closeOf(v: unknown): Promise<void> {
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { close?: unknown }).close === "function"
  ) {
    return (v as { close: () => Promise<void> }).close();
  }
  return Promise.resolve();
}

/**
 * In-memory `ServiceRegistry`. Simple Map-backed key/value with
 * unsubscribe on register.
 */
class InMemoryServiceRegistry implements ServiceRegistry {
  private readonly store = new Map<string, unknown>();

  register<T>(token: string, instance: T): () => void {
    this.store.set(token, instance);
    return () => {
      // Only delete if it's still the same instance — prevents
      // unsubscribing from a later registration.
      if (this.store.get(token) === instance) this.store.delete(token);
    };
  }

  get<T>(token: string): T | undefined {
    return this.store.get(token) as T | undefined;
  }

  has(token: string): boolean {
    return this.store.has(token);
  }
}
