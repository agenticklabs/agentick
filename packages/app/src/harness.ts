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
  collectNamespaceSlots,
  namespaceSlotAppScopes,
  namespaceSlotExtensions,
  type CommandGuards,
  type CommandHooks,
  forkBusSubscription,
  type HarnessShell,
  hooksToMiddlewares,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ScopeNodeRegistry,
  type TelemetryProvider,
  generateId,
} from "@agentick/runtime";
import { ElicitationHarness, buildElicitSugar } from "@agentick/elicitation";
import { TasksHarness, InMemoryTaskStore } from "@agentick/tasks";
import type { TaskExecutor, TaskStore } from "@agentick/tasks";
import type { ModelFacts, TaskRecord, TaskWakePolicy } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import {
  isLanguageModelAdapter,
  mergeRegistry,
  modelFactsOf,
  resolveModelInfo,
  SEED_MODELS,
  type LanguageModelAdapter,
} from "@agentick/model";
import {
  buildTelemetryInterceptors,
  normalizeTelemetry,
  type NormalizedTelemetry,
} from "./telemetry-defaults.js";
import { buildTelemetryExport } from "./telemetry-wiring.js";
import { LanguageModelExecutor as TheLanguageModelExecutor } from "@agentick/model-executor";
import {
  SessionHarness,
  InMemorySessionStore,
  type SessionHarnessOptions,
} from "@agentick/session";
import type {
  InstallerInterceptors,
  CursorPage,
  PageRequest,
  OnInterruptedExecution,
  ScopeNodeLease,
  SessionRecord,
  SessionStore,
  SessionStoreQuery,
} from "@agentick/spec";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
  type ToolExecutorHarnessOptions,
  type ToolHandler,
} from "@agentick/tool-executor";
import {
  AppClosedError,
  AppExecutionFailed,
  DEFAULT_JOURNALING_POLICY,
  HandlerError,
  isExecutorFactory,
  isLoopExecutorFactory,
  isCompilerFactory,
  isRunnerBindable,
  isTerminalSessionStatus,
  isTerminalTaskStatus,
  isToolExecutorFactory,
  sessionKeysetPage,
  sortSessionRecords,
  toRegistration,
} from "@agentick/spec";
import { mergeLayered, omitUndefined } from "@agentick/utils";
import type {
  AbortExecutionTreeInput,
  AbortExecutionTreeResult,
  AppError,
  AppExtension,
  AppHarnessProtocol,
  AppInstaller,
  AppInstallerHost,
  CostResolver,
  Extension,
  CreateSessionInput,
  DestroySessionInput,
  DestroySessionResult,
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
  IdentityScopedApp,
  IngressIdentity,
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
  Middleware,
  NamespaceSlots,
  OperationJournalFactory,
} from "@agentick/spec";

// ADR 82 / ADR 83 amendment — declarative per-session hooks. `CommandHooks` is
// derived from the runtime-augmented `CommandRegistry`, so it lives in
// `@agentick/runtime` and cannot be referenced from `@agentick/spec`
// (foundation layer — no upward dep). The app OWNS `createSession` and folds the
// hook cascade, so it augments spec's protocol shell here (the same `declare
// module` pattern harness packages use for `HookBridges` / `CommandRegistry`).
// The value is adapted to op-scoped middleware (`hooksToMiddlewares`) and
// appended to the app's resolved interceptor snapshot in `createSessionBody`.
declare module "@agentick/spec" {
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
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "app:create-session": {
      input: CreateSessionInput<unknown>;
      output: SessionHarnessProtocol<unknown>;
    };
    "app:run-once": { input: RunOnceInput<unknown>; output: RunOnceResult };
    // ADR 92 Family 2 §4 — a spawned child is created through its OWN verb,
    // not by reaching past `app:create-session` into the shared body. Mints
    // `onBefore/AfterAppCreateChildSession`, so a guard can say "this agent
    // may not spawn" without also blocking every host-created session — the
    // distinction the shared body made inexpressible.
    //
    // The host/wire `app:create-session` op is unchanged: the two verbs share
    // a BODY, not an envelope.
    "app:create-child-session": {
      input: CreateSessionInput<unknown>;
      output: SessionHarnessProtocol<unknown>;
    };
    // `close-app` (ADR 80/83) — a nullary lifecycle op routed through
    // `runOperation` (see `closeApp`). Input/output are both `void` (the
    // Operation's generics). Mints `onBefore/AfterAppCloseApp`.
    "app:close-app": { input: void; output: void };
    // The strongest-form session removal. Its own verb (not a flag on
    // `close`) precisely so a guard can veto DESTRUCTION without also vetoing
    // hangup — "this principal may end a thread but may not delete it" is the
    // distinction a shared verb makes inexpressible. Mints
    // `onBefore/AfterAppDestroySession`.
    "app:destroy-session": {
      input: { readonly sessionId: string; readonly reason?: string };
      output: DestroySessionResult;
    };
    // The residency verbs (checkpointing §4, execution-resume §3.1) — declared
    // so the operations mint `onBefore/AfterAppEvictSession` and
    // `onBefore/AfterAppResumeSession`. Observability of the residency cycle
    // (WHEN a session left memory, WHEN and how fast it came back) lives on
    // these; VETO of an eviction stays where it was — the `session:close`
    // guard reading `reason === "evicted"` — so pinning policy and residency
    // observation remain distinct seams.
    "app:evict-session": { input: { readonly sessionId: string }; output: void };
    "app:resume-session": {
      input: { readonly sessionId: string };
      output: SessionHarnessProtocol<unknown> | undefined;
    };
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
  // ADR 93 — namespace configuration is a TOP-LEVEL slot
  // (`createApp({ timeline })`), not a nested `session: { timeline }`. The
  // registered slots are folded into this bag by `mergeSessionDefaults`; the
  // adopter-facing longhand is gone (flat-options rule, no shim).
  | keyof NamespaceSlots
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

/**
 * What a session's scope-node path is resolved from (ADR 102). The
 * facts the app holds about a session at construction — the adopter
 * maps them to a path of scope keys.
 */
export interface SessionNodeContext {
  readonly sessionId: string;
  /** The session's owning principal (ADR 48). Absent at the local/no-auth pole. */
  readonly principal?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AppHarnessOptions<P = unknown> extends NamespaceSlots {
  /** Stable app id; defaults to `app:${generateId()}`. */
  readonly appId?: string;
  /**
   * Display label — what a person reads, where `appId` is what a client routes on.
   * Same `id` / `title` / `description` triple a tool or a prompt declares, so an
   * app is not the one entity with a bespoke identity shape.
   *
   * This is also how a client learns WHO answered: a session record carries
   * `appId`, and a UI joins it to this. Not copied onto each session, deliberately
   * — renaming an app should relabel its existing threads, and a denormalized name
   * would freeze them under the old one.
   *
   * Distinct from `name`, which is the telemetry identity dimension: that is a
   * deployment-flavoured value (`"assistant-api-prod"`), and promoting an ops
   * identifier to a user-visible label is easy to add and awkward to remove.
   */
  readonly title?: string;
  /** One line on what this app is, for a picker or a catalog. */
  readonly description?: string;
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
  readonly models?: import("@agentick/model").ModelRegistry;
  /**
   * Pricing seam — consulted per tick at settlement, and it **WINS over
   * the resolved target's declared `rates`** whenever it returns a
   * value. Returning `undefined` falls through to `target.rates`; when
   * neither supplies rates the tick is UNPRICED, which is a recorded
   * fact and never a zero.
   *
   * Two return arms, both real. A `RateCard` says "here are the rates,
   * you do the arithmetic" — per-tenant contracts, volume tiers. A
   * `Cost` says "I did the arithmetic" — a marketplace markup or a
   * credit system, where the number billed is not a function of tokens
   * at all.
   *
   * A callback rather than a config table because pricing policy is
   * unbounded; any enum shipped here would be a guess at which three
   * policies matter. Threaded into EVERY session this app creates —
   * including spawned and forked children, which inherit it through the
   * one session-construction body.
   *
   * ```ts
   * createApp(<Agent />, {
   *   model: anthropic("claude-sonnet-5"),
   *   costResolver: ({ target, sessionId }) =>
   *     tenantRates(sessionId, target.modelId),
   * });
   * ```
   *
   * @see docs/proposals/v2/usage-cost.md §4.3
   */
  readonly costResolver?: CostResolver;

  // ────────── Sub-harness slots (shared across sessions) ──────────

  /**
   * Compiler slot. Required — `@agentick/app` is compiler-agnostic
   * by design and does NOT default to any specific compiler. Pass:
   *
   *   - A pre-built `CompilerProtocol` instance (e.g., a future
   *     Angular compiler).
   *   - A `CompilerFactory` (produced by `defineCompiler(...)` or
   *     `reactCompiler(...)` etc.). The App calls the factory at
   *     construction with the shared substrate so compiler events
   *     flow through `app.events()`.
   *
   * For the React default, use `createApp` from `@agentick/app/react`
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
   *     durable store (`@agentick/tasks-store-postgres`, same port) for
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
   *     durable store (`@agentick/session-store-postgres`, same port) for
   *     survival across app restart — the store's reason to exist as the resume
   *     index.
   *
   * **Bounded live registry (PA2/PA3).** The live `sessionId → SessionHarness`
   * map is otherwise unbounded — a memory leak in long-lived deployments that
   * open sessions and never close them. `maxActive` / `idleTimeout` cap it by
   * EVICTING idle sessions:
   *
   *   - `maxActive` — soft LRU cap on LIVE sessions. When a `createSession`
   *     pushes the live count over the cap, the least-recently-active
   *     evictable session is evicted. The cap is SOFT: an in-flight
   *     session is never evicted, so a burst of concurrent work may exceed
   *     it transiently; the bound is restored at the next create / idle sweep.
   *   - `idleTimeout` — ms of inactivity (no send / dispatch / session op)
   *     after which a session is evicted by a background sweep. Requires no
   *     traffic to fire (an unref'd timer runs the sweep), so a quiet-but-
   *     long-lived app still releases memory.
   *
   * These configure the AUTOMATIC callers only; `evictSession(id)` is the same
   * operation invoked by hand (checkpointing §4 "triggers are callers").
   *
   * **Eviction is a checkpoint, NOT deletion.** An evicted session flushes each
   * harness to its own store and is then torn down entirely — the app keeps no
   * copy. Its durable `SessionRecord` + those stores are what remain, and the
   * next `createSession(sameId)` rebuilds and rehydrates from them by the SAME
   * path a restart takes. So eviction is invisible to correctness, only to a
   * stale `getSession` handle held across it — and what survives is what the
   * configured stores hold: with the zero-config in-memory defaults, a process
   * restart is where the data ends. Activity = any operation scoped to the
   * session (send, dispatch, snapshot, …). Ephemeral (`runOnce`) sessions are
   * never LRU/idle-evicted (they self-dispose).
   */
  readonly sessions?: {
    readonly store?: SessionStore;
    /** Soft LRU cap on live sessions; over-cap creates evict the LRU evictable session. */
    readonly maxActive?: number;
    /** Idle-eviction threshold in ms; a background sweep evicts sessions idle this long. */
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

  /**
   * Policy for an execution a restart found crashed mid-turn (execution-resume.md
   * §3.2). When a resumed/opened session's durable record is still `running`, the
   * app reconciles it to `interrupted` (always) and, on the resume/create path,
   * invokes this callback ONCE to decide re-drive vs. leave-as-history. Absent =
   * the default `drop`: the crash is recorded honestly, nothing re-drives. This is
   * where crash-loop budgeting and multi-node ownership live.
   */
  readonly onInterruptedExecution?: OnInterruptedExecution;

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
   * @see ToolBinding in `@agentick/spec` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<import("@agentick/spec").ToolDeclaration>;
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
  readonly inheritedTools?: ReadonlyArray<import("@agentick/spec").ToolRegistration>;

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
  /**
   * Which failed ticks are re-issued (ADR 99). Equivalent to
   * `session.tickFailurePolicy`.
   */
  readonly tickFailurePolicy?: import("@agentick/spec").TickFailurePolicy;
  /**
   * Hard cap on consecutive failed ticks (ADR 99). Equivalent to
   * `session.maxConsecutiveFailedTicks`.
   */
  readonly maxConsecutiveFailedTicks?: number;
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
   * Where a session's events land in the scope-node tree (ADR 102).
   * Returning `["tenant:acme", "user:ryan"]` puts every session of that
   * user on the user node, which fans in to the tenant node and on to
   * the app's own bus — so an attachment at any of those paths sees
   * exactly its subtree, with no per-event identity check anywhere.
   *
   * Omitted (the default) the app is topology-free: sessions share the
   * app's bus, as they always have. An explicit per-session `bus`
   * (`createSession({ bus })` / `session.bus` defaults) wins over this.
   */
  readonly sessionNode?: (ctx: SessionNodeContext) => readonly string[];
  /**
   * The node tree {@link sessionNode} paths resolve against. Supply one
   * to share a tree across several apps (a gateway hosting many);
   * omitted, the app builds a private registry rooted at its own bus.
   */
  readonly scopeNodes?: ScopeNodeRegistry;

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
   * overhead. See "Observability" in `@agentick/runtime`'s README for the
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
   * App-level GUARDS (ADR 93) — the sibling bag of {@link hooks}, keyed by the
   * DISCRIMINATED command (`{ timelineAppend, toolDispatch }`) and valued with a
   * decider returning a `HandlerVerdict` (`veto` / `replace` / `defer` /
   * `proceed`). A distinct KIND from hooks, never folded into them: the runner
   * floats every guard OUTERMOST, so an app guard decides before any transform
   * — and before any narrower guard (a `defineX({ guards })` bag) — runs.
   * Governance outranks local policy.
   *
   * Registered on the app's own chain at construction and inherited by every
   * session and per-session sub-harness through the same ONE
   * `inheritedInterceptors` value that carries hooks and `.use` transforms.
   */
  readonly guards?: CommandGuards;

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
   * @see `@agentick/spec` §Extension
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
  /**
   * EX1 — the parent EXECUTION that spawned this session (`parentSessionId`
   * names which session did; this names which of its turns). The live half of
   * the same edge the durable `SessionRecord` carries, and the key
   * {@link AppHarness.abortExecutionTree} walks.
   */
  readonly originExecutionId?: string;
  /** EX1 — the parent TOOL CALL that asked for the spawn, when there was one. */
  readonly originCallId?: string;
  lastActiveAt?: number;
  ephemeral: boolean;
}

/** Construction facts the spawn flow supplies out of band — see `buildSession`. */
interface SessionBuildOverrides {
  readonly agent?: unknown;
  readonly parentSessionId?: string;
  /** SP5 — the child's spawn lineage, forwarded onto the session. */
  readonly spawnPath?: readonly string[];
  /** SP6 — the parent's construction signal, fanned into the child. */
  readonly signal?: AbortSignal;
  /** EX1 — the origin edge: which execution (and call) spawned the child. */
  readonly originExecutionId?: string;
  readonly originCallId?: string;
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

  /** @see AppHarnessOptions.title */
  readonly title: string | undefined;
  /** @see AppHarnessOptions.description */
  readonly description: string | undefined;

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
  private readonly models: import("@agentick/model").ModelRegistry | undefined;
  /**
   * App-level pricing seam, passed to every session (and thence to the loop's
   * per-tick settlement, where it beats the target's declared `rates`).
   */
  private readonly costResolver: CostResolver | undefined;
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

  /**
   * ADR 102 — the scope-node seam. Both are set together or not at all:
   * without a `sessionNode` resolver the app has no topology and every
   * session runs on the app's own bus.
   */
  private readonly sessionNode: ((ctx: SessionNodeContext) => readonly string[]) | undefined;
  private readonly scopeNodes: ScopeNodeRegistry | undefined;

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
  /**
   * In-flight disposals, by session id. {@link disposeSession} deletes the
   * registry entry SYNCHRONOUSLY but releases each sub-harness inbox address only
   * inside an awaited `close()`; a create-or-resume of the same id racing that
   * window would rebuild and collide (`address already registered:
   * <surface>:<id>:<…>`). The barrier in {@link buildSession} waits this out.
   */
  private readonly disposing = new Map<string, Promise<void>>();
  /**
   * In-flight construction single-flight, by session id. Two concurrent
   * same-id `createSession` calls after an eviction would otherwise both
   * construct and collide on the shared inbox addresses. The first build
   * publishes its promise here; a concurrent same-id call awaits and returns
   * the SAME session instead of constructing a second. Mirrors {@link disposing}.
   */
  private readonly building = new Map<string, Promise<SessionHarnessProtocol<P>>>();
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

  /** Adopter policy for a crashed execution found at boot (execution-resume.md §3.2). */
  private readonly onInterruptedExecution?: OnInterruptedExecution;

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
  private readonly telemetryMiddleware: readonly import("@agentick/spec").Middleware<
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
  private readonly toolBridge!: import("@agentick/spec").ToolBridge;

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
    ) => Promise<{ readonly kind: "veto"; readonly reason?: string } | CreateSessionInput<P> | void>
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
    const appId = options.appId ?? `app:${generateId()}`;

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
    // ADR 93 — the app's declarative GUARD bag, on the same own-chain as the
    // hooks above. Guard-kind, so `orderInterceptors` floats these ahead of
    // every transform (and ahead of any narrower guard, since the sort is stable
    // and the app layer seeds a child's inherited layer first).
    if (options.guards !== undefined) this.guard(options.guards);
    // Local aliases for convenience in the rest of the constructor.
    const journal = this.journal;
    const bus = this.bus;
    const inbox = this.inbox;

    // ADR 102 — a topology exists only when the adopter names one. An
    // app-owned registry is rooted at the app's bus, so whatever a
    // session publishes still fans in here.
    this.sessionNode = options.sessionNode;
    if (options.sessionNode === undefined) {
      this.scopeNodes = undefined;
    } else if (options.scopeNodes !== undefined) {
      this.scopeNodes = options.scopeNodes;
    } else {
      const owned = new ScopeNodeRegistry({ root: bus });
      this.scopeNodes = owned;
      this.onClose(() => owned.close());
    }

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
                // Same cascade the adapter path gets. A factory-built executor
                // used to receive NO app hooks, guards, or telemetry — silently,
                // because it still ran. The factory spreads this into its
                // harness options via `inheritedFrom(deps)`.
                interceptors: {
                  inheritedInterceptors: this.resolvedInterceptors(),
                  interceptorParent: this,
                },
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
              `${appId}:executor:${generateId()}`,
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
    this.onInterruptedExecution = options.onInterruptedExecution;

    // Cascade: longhand (`options.session.*`) wins over shorthand
    // (`options.defaultMaxTicks` / `options.initialProps` /
    // `options.initialKnobs`). Per-call `createSession.*` wins over both
    // and applies at session construction.
    // `namespaceSlotAppScopes()` runs ONCE, here: each store-backed namespace
    // builds the app-scoped defaults its sessions share (checkpointing §4).
    this.sessionDefaults = mergeSessionDefaults(options, namespaceSlotAppScopes());
    this.models = options.models;
    this.costResolver = options.costResolver;
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
    // The compiler is a sibling of the model + timeline under a tick, and its
    // `compiler:render-tree` command is the ⓪ tap the round-trip recorder needs,
    // so it takes the same cascade every other app-constructed harness does.
    this.compiler = resolveCompiler(options.compiler, appId, journal, bus, inbox, {
      inheritedInterceptors: this.resolvedInterceptors(),
      interceptorParent: this,
    });

    // Loop slot: factory → call with shared substrate; instance → use
    // as-is; undefined → bundled default with shared substrate.
    this.loop = isLoopExecutorFactory(options.loop)
      ? options.loop({
          scopeId: appId,
          journal,
          bus,
          inbox,
          // The same cascade the bundled default gets below — a factory-built
          // loop is not a second-class citizen.
          interceptors: {
            inheritedInterceptors: this.resolvedInterceptors(),
            interceptorParent: this,
          },
        })
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
    this.title = options.title;
    this.description = options.description;
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
      // Sweep cadence is DECOUPLED from the window: at interval === window,
      // eviction latency is [window, 2x window) — observed in production as
      // "7-8 minutes on a 5-minute timeout". Capping the interval at 60s
      // tightens latency to window + <=60s; an unref'd timer scanning a Map
      // once a minute is free.
      this.idleSweepTimer = setInterval(
        () => {
          void this.sweepIdle(idle);
        },
        Math.min(idle, 60_000),
      );
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
    //
    // ADR 93: extension-installed namespace slots
    // (`createApp({ skills, prompts })`) mint their own installs via the
    // registry's `toExtension` arms. An adopter extension carrying the SAME
    // NAME suppresses the slot's mint — the escape hatch outranks the sugar.
    // Suppression (not ordering) is the mechanism: a namespace install
    // registers an inbox address, and a second install for the same namespace
    // is a LOUD address collision by design, so "install both, last wins"
    // cannot exist. The arm mints through the package's own `withX`, so the
    // two carry the same extension name whenever they mean the same
    // namespace. Host-constructed slots (timeline) have no arm and ride
    // `collectNamespaceSlots` instead.
    const adopterExtensions = options.extensions ?? [];
    const adopterExtensionNames = new Set(adopterExtensions.map((e) => e.name));
    const slotExtensions = (
      namespaceSlotExtensions(options as never) as readonly Extension[]
    ).filter((e) => !adopterExtensionNames.has(e.name));
    const allExtensions = [...slotExtensions, ...adopterExtensions];
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
   * the optional `@agentick/telemetry-otlp` package. The resolved provider
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
      // ADR 93 landmine 11 — the interceptor cascade is TOTAL: an
      // extension-installed harness spreads `inheritedFrom(installer)` and
      // inherits `app.use()` / `app.guard()` / `createApp({ hooks, guards })`
      // exactly like an app-constructed sub-harness. `interceptorParent: this`
      // keeps it LIVE (a later registration still reaches it).
      interceptors: {
        inheritedInterceptors: this.resolvedInterceptors(),
        interceptorParent: this,
      },
      hook(hooks): Unsubscribe {
        return self.hook(hooks as CommandHooks);
      },
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
    /**
     * ADR 93 landmine 11 — the per-session interceptor snapshot (app layer +
     * this session's declarative hooks), exposed to extensions so an
     * extension-installed harness joins the SAME cascade.
     */
    inheritedInterceptors: readonly Middleware<unknown, unknown, unknown>[],
    /** ADR 48 — the session's owning principal, exposed to extensions at install. */
    principal?: string,
    /** The session's adopter metadata bag, exposed to extensions at install. */
    metadata?: Readonly<Record<string, unknown>>,
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
      // ADR 93 landmine 11 — the per-session interceptor cascade (app layer +
      // this session's declarative `createSession({ hooks })`), handed to every
      // extension-installed namespace via `inheritedFrom(installer)`. This is
      // what closes the escape that let a subscription fire, a credentials
      // mutation, or a timeline append run outside `app.guard()`.
      interceptors: { inheritedInterceptors, interceptorParent: this },
      // Registers on the APP cascade (the session harness does not exist yet at
      // install time); auto-detached when this session closes so a per-session
      // extension's hooks do not outlive it.
      hook(hooks): Unsubscribe {
        const unsub = self.hook(hooks as CommandHooks);
        closeHandlers.push(unsub);
        return unsub;
      },
      // ADR 48 — the session's identity at install time, so an extension can
      // construct per-session, tier-scoped backing stores keyed by principal /
      // adopter routing metadata. Omitted keys stay absent (principal-less /
      // no-metadata session).
      ...omitUndefined({ principal, metadata }),
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
    return this.runCreateSessionOp(input);
  }

  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult> {
    return this.runRunOnceOp(input);
  }

  as(identity: IngressIdentity): IdentityScopedApp<P> {
    // The stamp clobbers whatever the input claims, exactly the wire rule
    // (`app/create_session` spreads `ctx.principal` OVER params): the identity
    // is the authority, the input is not. An identity with no `principal`
    // stamps nothing — mirroring the wire handler's conditional — rather than
    // erasing a caller-supplied value with `undefined`.
    const stamp = <I extends { readonly principal?: string }>(input: I): I => ({
      ...input,
      ...(identity.principal !== undefined ? { principal: identity.principal } : {}),
    });
    return {
      identity,
      createSession: (input: CreateSessionInput<P> = {}) =>
        this.runCreateSessionOp(stamp(input), identity),
      runOnce: (input: RunOnceInput<P>) => this.runRunOnceOp(stamp(input), identity),
    };
  }

  /**
   * The one create-session op both doors run. `identity` present (the `as()`
   * door) rides the op scope — the same axis a wire dispatch threads it on —
   * so op-scoped hooks read WHO is acting either way; absent (the bare local
   * pole) the scope stays clean and nothing is second-guessed.
   */
  private runCreateSessionOp(
    input: CreateSessionInput<P>,
    identity?: IngressIdentity,
  ): Promise<SessionHarnessProtocol<P>> {
    const op: Operation<CreateSessionInput<P>, SessionHarnessProtocol<P>> = {
      opId: `app:create-session:${generateId()}`,
      surface: "app",
      name: "app:command:create-session",
      scope: this.identityScope({ ...omitUndefined({ sessionId: input.sessionId }) }, identity),
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

  private runRunOnceOp(input: RunOnceInput<P>, identity?: IngressIdentity): Promise<RunOnceResult> {
    const op: Operation<RunOnceInput<P>, RunOnceResult> = {
      opId: `app:run-once:${generateId()}`,
      surface: "app",
      name: "app:command:run-once",
      scope: this.identityScope({ ...omitUndefined({ sessionId: input.sessionId }) }, identity),
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
   * Check a live session out of memory — see
   * {@link AppHarnessProtocol.evictSession}. Triggers are callers, not
   * mechanisms (checkpointing §4): this, the idle sweep and the LRU all run the
   * same composed operation, and only the automatic two are configured.
   *
   * Its own op (`app:command:evict-session`) for the reason resume has one: a
   * guard should be able to refuse "take this session's memory back" — pinning
   * a session a host wants kept warm — without refusing to close sessions.
   */
  evictSession(sessionId: string): Promise<void> {
    const op: Operation<{ sessionId: string }, void> = {
      opId: `app:evict-session:${generateId()}`,
      surface: "app",
      name: "app:command:evict-session",
      scope: { sessionId },
      input: { sessionId },
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.disposeSession(i.sessionId, "evict"),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
  }

  /**
   * Bring an evicted or persisted session back — see
   * {@link AppHarnessProtocol.resumeSession}.
   *
   * Its own op (`app:command:resume-session`) rather than a flag on create, for
   * the reason destroy has one: a guard should be able to refuse "rehydrate this
   * session" — the expensive, memory-shaped decision the reaper exists to
   * control — without refusing to open new sessions.
   */
  resumeSession(sessionId: string): Promise<SessionHarnessProtocol<P> | undefined> {
    const op: Operation<{ sessionId: string }, SessionHarnessProtocol<P> | undefined> = {
      opId: `app:resume-session:${generateId()}`,
      surface: "app",
      name: "app:command:resume-session",
      scope: { sessionId },
      input: { sessionId },
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.resumeSessionBody(i.sessionId),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
  }

  /**
   * Live, else rebuild — the ONE recovery path (checkpointing §4). Evicted,
   * restarted and crashed sessions are indistinguishable here: each is an id
   * with a non-terminal {@link SessionRecord} and durable per-harness stores, so
   * each is answered by building from the app recipe (ADR 30) and letting
   * genesis fan `hydrate` out over the bridges.
   *
   * Construction runs through the same {@link createSessionBody} every other
   * door takes, so the resumed session gets the registry entry, the LRU
   * accounting, and the single-flight that collapses two concurrent resumes of
   * one id onto one build.
   */
  private async resumeSessionBody(
    sessionId: string,
  ): Promise<SessionHarnessProtocol<P> | undefined> {
    const live = this.registry.get(sessionId);
    if (live !== undefined) {
      this.touchActivity(sessionId);
      return live.session;
    }
    const record = await this.sessionStore.get(sessionId, this.storeCtx());
    if (record === undefined || isTerminalSessionStatus(record.status)) return undefined;

    // Two-signal detection (execution-resume.md §1): the record's `running` is
    // the write-behind CANDIDATE (signal 1, captured by rebuildFromRecord before
    // construction erases it); the timeline's turn boundary is AUTHORITATIVE
    // (signal 2, readable only once the timeline is hydrated). Fires ONCE — on
    // the actual crash detection, never on a lingering `interruptedExecutionId`.
    // Gated to THIS path (resume/create), never a destroy-rebuild.
    const { session, crashedExecutionId } = await this.rebuildFromRecord(record);
    if (crashedExecutionId !== undefined) {
      const cursor = session.timeline.executionCursor(crashedExecutionId);
      if (cursor?.boundary === undefined) {
        // No boundary = the turn never finished — a real interruption. This
        // includes `cursor === undefined`: an execution that crashed before
        // committing ANY entry exists only on the record, and is an
        // interruption-with-nothing-committed (a re-drive starts from tick 0),
        // NOT a nothing-to-do. Mark from the PRE-construction record (the
        // hydrate merge already neutralized the durable FSM; this adds the
        // crash history + per-execution budget on top).
        //
        // ORDERING BARRIER (F1): construction's hydrate write-back is
        // fire-and-forget through the runtime view; on an async store it can
        // complete AFTER the direct put below and clobber the mark. Drain it
        // first — cheap, boot-only, deterministic on every store.
        await this.registry.get(record.id)?.session.flushRecordWrites();
        const marked = markInterruptedRecord(record, crashedExecutionId);
        await this.sessionStore.put(marked, this.storeCtx());
        if (this.onInterruptedExecution) {
          // A THROWING policy rejects the resume — deliberate and loud (§3.2),
          // the same posture as a rejected persist aborting an evict:
          // swallowing an adopter bug to "drop" would hide it.
          const decision = await this.onInterruptedExecution({
            session: marked,
            executionId: crashedExecutionId,
            attempt: marked.resumeAttempts ?? 1,
          });
          if (decision === "resume") {
            await this.resumeInterruptedExecution(session, crashedExecutionId);
          }
          // "drop" (and the absent-callback default) leave
          // `interruptedExecutionId` as honest history — it cannot re-fire
          // (nothing durable says `running` any more) and a support tool or a
          // manual resume can still act on it.
        }
      }
      // Boundary present = the turn FINISHED and only the record's idle-write
      // was lost (the don't-run-twice guard). Construction's hydrate write-back
      // already made the record honest — no mark, no callback, no re-drive.
    }
    return session;
  }

  /**
   * Re-drive an interrupted execution (execution-resume.md §3.4) — reached when the
   * adopter's `onInterruptedExecution` returns `"resume"`. SLICE 3 fills this.
   *
   * NON-BLOCKING CONTRACT (shape it now so the stub does not calcify): this awaits
   * only ACCEPTANCE — the stripped send's handle creation — then DETACHES the
   * completion (the re-driven turn announces through the normal handle/bus
   * machinery). `resumeSession` must never block on a whole model turn (§3.4). The
   * re-drive is a stripped send that adopts `executionId` and seeds `currentTick`
   * from the timeline HARNESS's committed-cursor surface — never a direct store read
   * (the framework owns hooks/boundaries, not a harness's retention).
   */
  private async resumeInterruptedExecution(
    session: SessionHarnessProtocol<P>,
    executionId: string,
  ): Promise<void> {
    // Acceptance only (execution-resume.md §3.4): `resumeExecution` resolves at
    // handle creation — the stripped send is running, announced through the
    // normal handle/bus machinery — and the TURN is deliberately detached:
    // `resumeSession` must never block on a whole model call. The re-driven
    // turn's failure lands where every turn's does (the handle's `.result`,
    // the boundary record, the status transition), not here.
    const entry = this.registry.get(session.id);
    if (entry === undefined) return;
    const handle = await entry.session.resumeExecution(executionId);
    void handle.result.catch(() => undefined);
  }

  /**
   * Build a session back from the durable record alone — the recovery
   * construction {@link resumeSessionBody} and destroy's scope-drop share. The
   * record is all that is left, so the session is rebuilt from this app's recipe
   * with the serializable half of its original create call read back off the
   * record (checkpointing §4). The scope ceiling is NOT part of that half: it is
   * construction-bound and nothing persists it (see `findRecordPrincipal` in the
   * wire dispatch gate, which authorizes off the record's principal rather than
   * the rebuilt harness's).
   */
  private async rebuildFromRecord(record: SessionRecord): Promise<{
    readonly session: SessionHarnessProtocol<P>;
    readonly record: SessionRecord;
    readonly crashedExecutionId: string | undefined;
  }> {
    // Crash detection, signal 1 of 2 (execution-resume.md §3.1): a record still
    // `running` at rebuild time can only be a crash — eviction refuses in-flight
    // sessions, so nothing else leaves `running` behind. Detection is `running`
    // ONLY, deliberately: `paused`, `input_required`, and `hibernated` are
    // legitimate persisted waits, not crashes — do not "complete the matrix".
    // CAPTURED here because construction erases the evidence: the hydrate merge
    // writes back fresh `idle` status and wipes `currentExecutionId`. Signal 2
    // (the timeline boundary — authoritative "did the turn actually finish")
    // needs the HYDRATED timeline, so the verdict + mark belong to the caller,
    // after this returns. Destroy ignores the capture: its record is about to
    // be deleted, and a stale `running` it leaves behind self-heals on the next
    // resume.
    const crashedExecutionId = record.status === "running" ? record.currentExecutionId : undefined;
    const session = await this.createSessionBody(
      omitUndefined({
        sessionId: record.id,
        principal: record.principal,
        metadata: record.metadata,
      }) as CreateSessionInput<P>,
      false,
    );
    return { session, record, crashedExecutionId };
  }

  /**
   * End a session through the app door — see
   * {@link AppHarnessProtocol.closeSession}. Live sessions take the shared
   * {@link disposeSession} teardown (registry removal + `onSessionClose`); a
   * session that is not live is ended in the durable record, since there is no
   * harness left to tear down and bringing one back to close it would be work
   * in service of a no-op.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (this.registry.has(sessionId)) {
      await this.disposeSession(sessionId, "close");
      return;
    }
    const storeCtx = this.storeCtx();
    const record = await this.sessionStore.get(sessionId, storeCtx);
    if (record === undefined || isTerminalSessionStatus(record.status)) return;
    await this.sessionStore.put({ ...record, status: "closed", updatedAt: Date.now() }, storeCtx);
  }

  /**
   * Strongest-form, transitive session removal. See
   * {@link AppHarnessProtocol.destroySession} for the contract; the ordering
   * rationale lives on {@link destroySessionBody}.
   *
   * Its own op (`app:command:destroy-session`) rather than a flag on close —
   * so a guard can veto deletion without also vetoing hangup.
   */
  destroySession(sessionId: string, opts?: DestroySessionInput): Promise<DestroySessionResult> {
    const input = { sessionId, ...omitUndefined({ reason: opts?.reason }) };
    const op: Operation<typeof input, DestroySessionResult> = {
      opId: `app:destroy-session:${generateId()}`,
      surface: "app",
      name: "app:command:destroy-session",
      scope: { sessionId },
      input,
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.destroySessionBody(i.sessionId, i.reason ?? "destroyed"),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
  }

  /**
   * Cancel one execution's fan-out — see
   * {@link AppHarnessProtocol.abortExecutionTree} for the contract.
   *
   * Its own op (`app:command:abort-execution-tree`) for the same reason destroy
   * has one: a guard should be able to refuse "cancel this turn's sub-agents"
   * without refusing every abort in the app. The aborts it issues are still
   * ordinary `loop:abort` ops underneath — this op is the ENVELOPE around the
   * walk, not a new kind of cancellation.
   *
   * TODO(abort-execution-tree-wire): no wire verb yet. The client-facing
   * cancellation is session-addressed (`session/abort` + `cascade`); an
   * execution-addressed verb needs the ownership question answered first — the
   * dispatch gate resolves a target from a `sessionId`, and an execution id
   * names no session the gate can read.
   */
  abortExecutionTree(
    executionId: string,
    opts?: AbortExecutionTreeInput,
  ): Promise<AbortExecutionTreeResult> {
    const input = { executionId, ...omitUndefined({ reason: opts?.reason }) };
    const op: Operation<typeof input, AbortExecutionTreeResult> = {
      opId: `app:abort-execution-tree:${generateId()}`,
      surface: "app",
      name: "app:command:abort-execution-tree",
      scope: { executionId },
      input,
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () =>
            this.abortExecutionTreeBody(i.executionId, i.reason ?? "origin execution aborted"),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
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
   * One page of the durable registry — see
   * {@link AppHarnessProtocol.pageSessions}.
   *
   * Two paths, chosen by capability rather than configuration. A store that
   * implements the optional cursored read owns its own paging AND its own
   * cursor, so this hands the token straight through; the bundled in-memory
   * store does, so the common path is the same one a durable adapter takes. A
   * store without it gets the framework's default keyset over a snapshot of the
   * query — correct, and the reason `page` exists at all: the fallback reads
   * every matching record to serve fifty of them.
   */
  async pageSessions(
    query?: SessionStoreQuery,
    page: PageRequest = {},
  ): Promise<CursorPage<SessionRecord>> {
    const store = this.sessionStore;
    if (store.page !== undefined) return store.page(query, page, this.storeCtx());
    const snapshot = await store.list(query, this.storeCtx());
    return sessionKeysetPage(sortSessionRecords(snapshot), page);
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
   * What this app knows about a model — the adopter's `models` registry folded
   * over the seed catalog. `undefined` when no layer describes it; the catalog
   * never fabricates, so "unknown" is an answer rather than a zero.
   *
   * SYNCHRONOUS and pure: the registry is in memory and the fold is a
   * longest-prefix match. Projected to clients as `app/model_info`, whose one
   * real consumer today is a context-window gauge — it has the numerator
   * (`metadata.usage`, stamped on every assistant entry) and needs the
   * denominator.
   *
   * Resolves WITHOUT a target, so the middle precedence tier — the adapter's
   * self-description — is not consulted. In practice the two agree: an adapter
   * that reports a window reads it from this same catalog
   * (`google-adapter.ts` does exactly that). A caller holding a live target
   * wants `effectiveModelInfo(target, registry)` instead.
   */
  modelInfo(provider: string, modelId: string): ModelFacts | undefined {
    const info = resolveModelInfo(
      { provider, modelId },
      this.models ? mergeRegistry(SEED_MODELS, this.models) : SEED_MODELS,
    );
    return info ? modelFactsOf(info) : undefined;
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
      opId: `app:close-app:${generateId()}`,
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
    ) => Promise<
      { readonly kind: "veto"; readonly reason?: string } | CreateSessionInput<P> | void
    >,
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

  /**
   * `createSession` with construction failure made NON-permanent.
   *
   * The per-session sub-harnesses each claim an inbox address in their
   * constructor, and construction runs a long way — extension installs,
   * genesis hydration, the mount — before {@link buildSession} reaches
   * `registry.set`. A failure in between left those harnesses live, addressed,
   * and unreachable: nothing held a reference, so nothing could ever close
   * them. Every later create-or-resume of that session id then failed to
   * register with `address already registered: <surface>:<sessionId>:<…>`,
   * reporting the collision instead of the real fault — forever.
   *
   * So construction records what it claims, and an abort releases it. The
   * adopter gets the error that actually happened, and a retry is a retry.
   */
  private async createSessionBody(
    input: CreateSessionInput<P>,
    ephemeral: boolean,
    overrides: SessionBuildOverrides = {},
  ): Promise<SessionHarnessProtocol<P>> {
    // Construction single-flight for durable, explicitly-id'd sessions: a
    // concurrent same-id reopen collapses onto the first build rather than
    // double-constructing and colliding on the shared inbox addresses.
    // Generated ids never collide; ephemeral (`runOnce`) sessions are throwaway.
    const singleFlightId =
      !ephemeral && input.sessionId !== undefined ? input.sessionId : undefined;
    if (singleFlightId !== undefined) {
      const inFlight = this.building.get(singleFlightId);
      if (inFlight !== undefined) return inFlight;
    }

    const build = (async (): Promise<SessionHarnessProtocol<P>> => {
      const claimed: unknown[] = [];
      try {
        return await this.buildSession(input, ephemeral, overrides, claimed);
      } catch (err) {
        // LIFO, best-effort, and never masking the real error: a cleanup that
        // itself fails must not become the exception the adopter sees.
        for (const built of claimed.reverse()) {
          try {
            await closeOf(built);
          } catch {
            // best effort
          }
        }
        throw err;
      }
    })();

    if (singleFlightId === undefined) return build;

    this.building.set(singleFlightId, build);
    const clear = (): void => {
      if (this.building.get(singleFlightId) === build) this.building.delete(singleFlightId);
    };
    void build.then(clear, clear);
    return build;
  }

  /**
   * The create-session body proper. Pushes every substrate-claiming harness it
   * constructs onto `claimed` so {@link createSessionBody} can release them if
   * construction does not reach the registry.
   */
  private async buildSession(
    input: CreateSessionInput<P>,
    ephemeral: boolean,
    overrides: SessionBuildOverrides,
    claimed: unknown[],
  ): Promise<SessionHarnessProtocol<P>> {
    this.assertOpen();

    // Fold the spawn-supplied `parentSessionId` (which the spawn flow threads
    // via `overrides`, not `input`) INTO the input the hooks see, so the
    // `onSessionCreate` reshape arm can read it — the selective-inheritance
    // seam is "read `input.parentSessionId` → look up the parent record →
    // inject chosen metadata keys." The later parentSessionId cascade
    // (overrides-wins) is unaffected.
    if (overrides.parentSessionId !== undefined && input.parentSessionId === undefined) {
      input = { ...input, parentSessionId: overrides.parentSessionId };
    }

    // Run `onSessionCreate` handlers — the house before-hook grammar, three
    // arms: veto (`{ kind: "veto" }`, first wins → throw), reshape (a returned
    // `CreateSessionInput` REPLACES the input the rest of construction + later
    // handlers observe — the adopter seam for selective spawn inheritance), or
    // pass (`void`). Veto is recognized BEFORE the reshape arm so a verdict is
    // never mistaken for an input value.
    for (const h of this.sessionCreateHandlers) {
      const verdict = await h(input);
      if (verdict === undefined) continue;
      if ("kind" in verdict) {
        // Verdict arm — only `veto` is defined here (first veto wins → throw).
        if (verdict.kind === "veto") {
          throw new AppExecutionFailed({
            cause: new Error(
              verdict.reason ? `session create vetoed: ${verdict.reason}` : "session create vetoed",
            ),
          });
        }
        continue;
      }
      // Reshape arm — fold the returned input forward (later handlers + the
      // session build both observe the reshaped value).
      input = verdict;
    }

    const sessionId = input.sessionId ?? `session:${generateId()}`;
    // Disposal barrier: a same-id disposal in flight has deleted its registry
    // entry but not yet released its sub-harness inbox addresses (that happens
    // inside its awaited `close()`). Rebuilding now would collide, so wait it out
    // first; the registry re-read below then reflects the settled state.
    const inFlightDisposal = this.disposing.get(sessionId);
    if (inFlightDisposal !== undefined) await inFlightDisposal;
    // Idempotent open-or-rehydrate (ADR 49 §Hydration): createSession
    // with an id that's already live returns the existing session — the
    // same call is create AND resume, which is what stateless-replica
    // deployments need (any node, any time). The open call's other
    // options are ignored for an existing session (its construction is
    // done). Cross-restart resume — id NOT in the registry, durable
    // store holds entries — is the fresh-construction path below, which
    // hydrates via `session.timeline` options.
    const existing = this.registry.get(sessionId);
    if (existing !== undefined && existing.session.status !== "closed") {
      // A repeat open is activity — keep it warm against LRU / idle eviction.
      this.touchActivity(sessionId);
      return existing.session as SessionHarnessProtocol<P>;
    }
    // A registered but CLOSED entry is a corpse: someone called `session.close()`
    // on the harness directly, which ends the session without telling the app.
    // Reopening the id must not hand that back, so the entry is disposed (a
    // second close is a no-op; the registry drop is the point) and construction
    // continues into a live replacement.
    if (existing !== undefined) await this.disposeSession(sessionId, "close");

    // ADR 102 — the session's node in the scope tree, held for as long as
    // the session lives. Unconfigured (or when the adopter wired an
    // explicit per-session bus), this is the app's own bus and every
    // construction below is byte-for-byte what it was.
    const nodeLease = this.resolveSessionNode(sessionId, input);
    const sessionBus = nodeLease?.bus ?? this.bus;
    if (nodeLease !== undefined) claimed.push({ close: () => nodeLease.release() });

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
      sessionBus,
      this.inbox,
      { parentScope: { sessionId }, inheritedInterceptors, interceptorParent: this },
    );
    claimed.push(elicitation);

    // Per-session tasks harness — substrate-level long-running tool
    // registry. Surfaced on `ctx.tasks` for handlers, on
    // `bridges.tasks` for JSX, and routed through the ToolExecutor's
    // `tasks` slot so handlers returning a TaskHandle branch on the
    // tool's `taskSupport` annotation (#156).
    const tasks = new TasksHarness(`${sessionId}:tasks`, this.journal, sessionBus, this.inbox, {
      parentScope: { sessionId },
      // ADR 68 — the shared app-scoped store + executor registry, so
      // detached tasks outlive the per-session harness and child-process
      // reattach finds its still-live children. Scope-filtered by
      // `{ sessionId }` above.
      store: this.taskStore,
      executors: this.taskExecutors,
      // TASK-WAKE — app-wide default wake policy (per-submit `wake` overrides).
      ...(this.taskDefaultWake !== undefined ? { defaultWake: this.taskDefaultWake } : {}),
      // ADR 69 — task `ctx.elicit` escalation. Inject the elicit-sugar factory
      // so a task's `ctx.elicit.*` escalates to its owning session
      // (`record.scope.sessionId`, stamped from `parentScope` above) via
      // `inbox.ask` and resolves with the client's response. Without it every
      // `ctx.elicit.*` throws "not configured" (tasks/task-elicit.ts) — this is
      // THE construction site for app-composed sessions, so it must be here.
      // `@agentick/tasks` stays elicitation-free; the sugar is injected.
      buildElicit: buildElicitSugar,
      // ADR 76/83 — the app's resolved interceptor snapshot incl. the app+session
      // command hooks as op-scoped middleware. Live via `interceptorParent`.
      inheritedInterceptors,
      interceptorParent: this,
    });
    claimed.push(tasks);

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
      sessionBus,
      this.inbox,
      // ADR 76/83 — the app's resolved interceptor snapshot incl. the app+session
      // command hooks as op-scoped middleware. Live via `interceptorParent`.
      { inheritedInterceptors, interceptorParent: this },
    );
    claimed.push(resources);

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
        // ADR 93 landmine 11 — the same ONE fold every per-session sub-harness
        // gets, now also reachable by extension-installed namespaces.
        inheritedInterceptors,
        // ADR 48 — the session's identity, resolved for install-time reads.
        input.principal,
        input.metadata,
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
    // contributed by the `@agentick/sandbox` augmentation on the far
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
    // `completions` rides for the same reason `skills` does — `withCompletions`
    // registers under the `completions` namespace before this site runs. A tool
    // handler reaches `ctx.completions?.resolve(name, { value })` when it wants
    // candidates for something it is about to ask a human about.
    const completionsNamespace = sessionExtensionBridges.get("completions");
    if (completionsNamespace !== undefined) ctxExtensionEntries.completions = completionsNamespace;
    // `code` rides for the same reason: a code-mode tool handler runs
    // model-authored source through `ctx.code`, so the program lands on the
    // journaled, guardable `code:execute` operation instead of an ad-hoc eval
    // inside the handler.
    const codeNamespace = sessionExtensionBridges.get("code");
    if (codeNamespace !== undefined) ctxExtensionEntries.code = codeNamespace;
    const ctxExtensions: Readonly<Record<string, unknown>> | undefined =
      Object.keys(ctxExtensionEntries).length > 0 ? ctxExtensionEntries : undefined;

    const tools: ToolExecutorProtocol = this.toolFactory
      ? this.toolFactory({
          scopeId: sessionId,
          journal: this.journal,
          bus: sessionBus,
          inbox: this.inbox,
          // The same cascade the bundled `ToolExecutorHarness` gets below.
          interceptors: { inheritedInterceptors, interceptorParent: this },
        })
      : new ToolExecutorHarness(sessionId, this.journal, sessionBus, this.inbox, {
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
    claimed.push(tools);

    // Cascade: per-call `createSession.*` > per-app `session.*` >
    // shorthand (`defaultMaxTicks`/`initialProps`/`initialKnobs`).
    // sessionDefaults already collapsed (longhand vs shorthand).
    const session = new SessionHarness<P>(this.journal, sessionBus, this.inbox, {
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
      // EX1 — the origin edge, onto the harness so it reaches the durable
      // record. Set only for a child spawned from inside an execution.
      ...omitUndefined({
        originExecutionId: overrides.originExecutionId,
        originCallId: overrides.originCallId,
      }),
      maxSpawnDepth: this.maxSpawnDepth,
      // ADR 48 — the construction-bound owning principal. Set host-door via
      // `createSession({ principal })`, from the wire caller's identity by the
      // `app/create_session` method, or inherited from a parent by the spawn
      // flow. Stamped onto the harness (read by the wire dispatch gate) + the
      // durable `SessionRecord`.
      ...omitUndefined({ principal: input.principal }),
      ...(input.requiredScopes !== undefined ? { requiredScopes: input.requiredScopes } : {}),
      ...(this.models !== undefined ? { models: this.models } : {}),
      // The pricing seam rides the SAME one construction body every session
      // takes — host-created, spawned (`createChildSession`), and forked (a
      // fork is a spawn) — so a child inherits it without a second cascade.
      ...(this.costResolver !== undefined ? { costResolver: this.costResolver } : {}),
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
        // E11 — genesis persistence is lazy by default (first mutation writes);
        // `eager` forces the write at construction.
        eager: input.eager,
      }),
    });
    claimed.push(session);
    // The node outlives the session only if something else still holds it —
    // the last session on a principal's node takes the node down with it.
    if (nodeLease !== undefined) session.onClose(() => nodeLease.release());

    // ── The namespace map's ORDERING CONTRACT (#257) ─────────────────────
    //
    // `sessionExtensionBridges` is the SAME map object the SessionInstaller's
    // `getNamespace` closes over, so a write here is visible to every extension
    // that installed above. That is the only way a host-constructed bridge can
    // ever reach an extension: sessions are constructed AFTER their extensions
    // install, so at install time `getNamespace("timeline")` is structurally
    // undefined and no amount of ordering fixes it.
    //
    // The contract, therefore: an extension that needs a HOST bridge must
    // LATE-BIND (hold a provider, read it when it uses the value), never resolve
    // at install. `@agentick/prompts` does exactly this — an eager read left
    // `PromptsHarness.timeline` undefined in every default deployment and
    // `invoke()` rendered into the void.
    //
    // Guarded, never an overwrite: `withTimeline(...)` (definition or live
    // instance) claims the name at install and MUST keep it — and when it does,
    // `session.timeline` already IS that instance, because `buildSessionBridges`
    // spreads the extension map over its own bundle. This write only fills a name
    // nobody claimed. It happens after the bridges bundle is built, so it can
    // never feed back into it.
    //
    // TODO(#257 follow-up): only what has a CONSUMER is published. The other
    // host-constructed bridges (`knobs`, `state`, `gates`) are equally invisible
    // to `getNamespace`; publish them here the moment an extension needs one,
    // rather than inventing a second seam.
    if (!sessionExtensionBridges.has("timeline")) {
      sessionExtensionBridges.set("timeline", session.timeline);
    }
    // `elicit` — the session's `Elicit` sugar, consumed by `@agentick/prompts`
    // as the `ctx.elicit` a declaration's `render(args, ctx)` asks through.
    //
    // The BUILT sugar, not the `elicitation` harness under it, and deliberately:
    // `Elicit` is a spec type, so a consumer types the facet without taking a
    // runtime dependency on `@agentick/elicitation` to build the sugar itself.
    // This app already holds both. Same guard as `timeline` — an extension that
    // claimed the name at install keeps it.
    if (!sessionExtensionBridges.has("elicit")) {
      sessionExtensionBridges.set("elicit", session.elicit);
    }

    // `ready` / `close` aren't on `ToolExecutorProtocol` — duck-type
    // through `readyOf` / `closeOf` so both the reference harness AND
    // factory-produced impls work transparently.
    // ADR 93 landmine 2 — AWAIT GENESIS at create. A hydrator that throws must
    // fail session CREATION with its typed error (`TimelineHydrateFailed`, …),
    // not surface later as a mount rejection on the first `send`. The compiler
    // MOUNT stays deliberately un-awaited here (that latency is by design);
    // genesis is the one pre-render step creation is answerable for.
    await Promise.all([
      readyOf(tools),
      session.ready,
      (session as unknown as { genesisReady?: Promise<void> }).genesisReady,
    ]);
    await session.mountReady;

    // C-core (three-audiences-plan §C) — late-bind the session's `send` into
    // any session-extension bridge that runs sends on the adopter's behalf but
    // was constructed WITHOUT session access (`RunnerBindable` — the skills
    // harness today, for `session.skills.run`). Generic feature-detect over the
    // extension bridge bag, no hardcoded slot names (ADR 27, uniform with the
    // checkpoint fold). Bound AFTER `mountReady` so the first run reaches
    // a fully-wired session; the harness gets ONLY the send capability, never
    // the session itself.
    if (sessionExtensionBridges.size > 0) {
      const sendCapability: SessionSendCapability = (sendInput) =>
        session.send(sendInput as SendInput<P>);
      // C2 (three-audiences-plan §C split, item 3) — the ISOLATED send
      // capability. Each run forks the session (`session.fork()` — a same-image
      // child over a branched copy of its scopes) and runs the composed send on
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
      // The RESHAPED input — what actually built this session, so a resume
      // replays the same construction rather than the caller's first draft.
      ...omitUndefined({
        parentSessionId: overrides.parentSessionId,
        // EX1 — the live half of the origin edge. Held on the entry so the
        // execution-tree walk is a registry scan, not a store round-trip.
        originExecutionId: overrides.originExecutionId,
        originCallId: overrides.originCallId,
      }),
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
    // The child's id is minted HERE rather than inside `createSessionBody`, so
    // the operation scope below can name the session it is about. Same shape
    // and same fallback the body would have applied — it sees a concrete id and
    // takes its normal path.
    const sessionId = input.sessionId ?? `session:${generateId()}`;
    const createInput: CreateSessionInput<P> = {
      sessionId,
      // A spawned / forked child persists its record at genesis: unlike a
      // top-level "new chat", the record encodes the lineage edge
      // (parentSessionId / spawnPath / originExecutionId) that abort-tree walks
      // and lineage listings read, and that edge exists at creation — it is not
      // speculative garbage waiting on a first message.
      eager: true,
      ...omitUndefined({
        metadata: input.metadata,
        // ADR 48 — thread the inherited principal (the parent's own, set by
        // `session.spawn()`) so the child's harness + record carry ownership.
        principal: input.principal,
        initialProps: input.initialProps,
        initialKnobs: input.initialKnobs,
        maxTicks: input.maxTicks,
      }),
    };
    const op: Operation<CreateSessionInput<P>, SessionHarnessProtocol<P>> = {
      opId: `app:create-child-session:${generateId()}`,
      surface: "app",
      name: "app:command:create-child-session",
      // The lineage IS the scope: the child (`sessionId`), its parent
      // (`parentSessionId`), and the whole ancestry (`spawnPath`). An auditor
      // reconstructs the spawn tree from these records alone.
      scope: {
        sessionId,
        parentSessionId: input.parentSessionId,
        ...omitUndefined({ spawnPath: input.spawnPath }),
      },
      // ADR 92 Slice B — the causal link to the invoking `session:command:spawn`,
      // threaded as DATA by `session.spawn()`. The runtime's ambient
      // `parentOpId` auto-derivation cannot reach across the Promise boundary
      // between the parent's op fiber and this call (see `runtime-context.ts`
      // — a Promise continuation is outside the fiber, FiberRef is invisible
      // there), so the parent's opId travels explicitly. Ambient derivation
      // still applies when this IS invoked in-fiber; the explicit value wins.
      ...omitUndefined({ parentOpId: input.parentOpId }),
      input: createInput,
    };
    return this.runWithTelemetry(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () =>
            this.createSessionBody(i, /* ephemeral */ false, {
              agent: input.agent,
              parentSessionId: input.parentSessionId,
              // SP5/SP6 — forward the child's lineage + the parent's
              // construction signal so the session stamps envelopes and
              // cascades teardown. EX1 — plus the origin edge (which of the
              // parent's turns, and which tool call, asked for this child).
              ...omitUndefined({
                spawnPath: input.spawnPath,
                signal: input.signal,
                originExecutionId: input.originExecutionId,
                originCallId: input.originCallId,
              }),
            }),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
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
    const sessionId = input.sessionId ?? `runonce:${generateId()}`;
    const createInput: CreateSessionInput<P> = {
      sessionId,
      ...omitUndefined({
        metadata: input.metadata,
        initialProps: input.initialProps,
        maxTicks: input.maxTicks,
        // ADR 48 — an ephemeral session is still a session; the stamp rides
        // the same construction path as a durable one.
        principal: input.principal,
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
   * The `app:command:destroy-session` BODY — strongest-form, transitive removal.
   *
   * The ORDER is the whole design, and each step exists because the step before
   * it cannot do its job:
   *
   *   1. **Abort in-flight executions across the subtree.** `session.abort()`
   *      reaches only that session's own current handle; a spawned child feels
   *      the parent's construction signal (which makes its NEXT send resolve
   *      `aborted`) but its RUNNING execution is not itself cancelled by it. So
   *      every live descendant is aborted explicitly, deepest-first — a child
   *      must stop before the parent that is waiting on it unwinds.
   *   2. **Cancel detached tasks** — this must happen while the sessions are
   *      still LIVE, because a detached task's only in-process handle is its
   *      owning session's task harness, and step 3 closes that harness.
   *   3. **Drop every harness's store scope** — the timeline log, the knob and
   *      state partitions. A `DropCapable` bridge deletes its OWN scope in its
   *      OWN store, so this must run while the bridges are still mounted, which
   *      is why it precedes disposal. Without it the durable record goes and the
   *      conversation stays, and the next session to reuse the id hydrates it
   *      back (checkpointing §6).
   *   4. **Dispose the subtree** through the same `disposeSession("close")` a
   *      genuine session end uses (registry removal, `onSessionClose`, bridge
   *      teardown) — promoted, not duplicated.
   *   5. **Delete the durable record** — the target's and every descendant's.
   *
   * A target that is not live has no bridges to drop from, so it is rebuilt
   * first through the shared {@link rebuildFromRecord} — one recovery path,
   * teardown included (checkpointing §4). Rebuilding to destroy costs a remount
   * and is the only way the scopes get named at all.
   *
   * Idempotent: an unknown id rebuilds nothing, walks an empty subtree, disposes
   * nothing, and deletes a record that isn't there — reporting all of it as
   * facts rather than raising. Destroy deliberately does NOT `assertOpen()`:
   * refusing to clean up because the app is already shutting down would be
   * exactly backwards.
   */
  private async destroySessionBody(
    sessionId: string,
    reason: string,
  ): Promise<DestroySessionResult> {
    // `found` reports the pre-state, so it is read before the resume below can
    // make a checked-out session live again.
    const found = this.registry.has(sessionId);
    if (!found) {
      // Rebuilt even from a TERMINAL record, which is where this parts company
      // with resume: a hung-up session's stores are exactly the ones destroy
      // exists to free.
      const record = await this.sessionStore.get(sessionId, this.storeCtx());
      if (record !== undefined) await this.rebuildFromRecord(record);
    }

    // Snapshot the subtree BEFORE any teardown — disposal mutates the registry,
    // so its shape can only be read honestly up front.
    const subtree = this.liveSubtree(sessionId);
    const descendants = subtree.filter((entry) => entry.id !== sessionId);

    // (1) Transitive abort, deepest-first — the shared walk, which
    // `session.abort({ cascade: true })` reaches through the SpawnContext door.
    const abortedExecutions = (await this.abortEach(subtree, reason)).length;

    // (2) Reap detached tasks — precisely the ones `close()` abandons.
    const cancelledDetachedTasks = await this.cancelDetachedTasks(subtree, reason);

    // (3) Free the durable scopes across the whole subtree, while the bridges
    // that own them are still mounted. A rejection propagates: destroy fails
    // loudly rather than reporting a deletion that did not happen.
    for (const entry of subtree) await entry.session.dropScopes();

    // (4) Dispose. The target's own close cascades to the children it spawned
    // (SP6 `disposeChildren`), so the second pass is a no-op for those; it
    // exists for a descendant the registry links to this subtree but the live
    // `_children` chain does not (an intermediate session evicted / already
    // closed leaves its children parented to a gone session).
    await this.disposeSession(sessionId, "close");
    for (const entry of descendants) await this.disposeSession(entry.id, "close");

    // (5) Delete the durable records. `existed` is read first because
    // `SessionStore.delete` returns void — what deletion MEANS (soft flag, hard
    // removal, cascade) is the store impl's contract, so the only durable fact
    // this result can assert is whether there was a record to act on. The delete
    // itself is unconditional: a record written between the read and the delete
    // must not survive destroy. Descendants go too — they were torn down with
    // the target, so leaving their rows behind would strand them.
    const storeCtx = this.storeCtx();
    const existed = (await this.sessionStore.get(sessionId, storeCtx)) !== undefined;
    await this.sessionStore.delete(sessionId, storeCtx);
    for (const entry of descendants) await this.sessionStore.delete(entry.id, storeCtx);

    return {
      sessionId,
      live: {
        found,
        abortedExecutions,
        disposedDescendants: descendants.length,
        cancelledDetachedTasks,
      },
      record: { existed },
    };
  }

  /**
   * The `app:command:abort-execution-tree` BODY.
   *
   * Two passes, in the deepest-first order every cascade in this file uses:
   *
   *   1. **The fan-out.** Live sessions stamped with this `originExecutionId`
   *      are the execution's direct children; each one's WHOLE live subtree
   *      goes with it, because once a branch belongs to the cancelled turn so
   *      does everything under it — including work a lineage session started
   *      from a later execution of its own. Seeds are siblings under one parent
   *      session, so their subtrees are disjoint; the map dedupes anyway.
   *   2. **The origin itself**, and only if it is STILL that execution: a
   *      session that has moved on to a later turn must not have that turn
   *      cancelled by an id referring to a settled one. `currentExecutionId` is
   *      the session's own synchronous truth, so the comparison is exact.
   *
   * Idempotent and quiet: an unknown or fully-settled execution matches
   * nothing, aborts nothing, and reports empty. Nothing here disposes or
   * deletes — this is `abort({ cascade: true })` keyed by execution.
   *
   * TODO(abort-execution-tree-evicted): the walk reads the LIVE registry, so
   * a descendant of the cancelled turn that has been evicted is out of reach
   * — it has no in-process handle to abort, the same limitation destroy's walk
   * has. The durable `originExecutionId` would support a store-side query
   * (`SessionStoreQuery`) if resuming-to-cancel ever becomes a real need.
   */
  private async abortExecutionTreeBody(
    executionId: string,
    reason: string,
  ): Promise<AbortExecutionTreeResult> {
    const targets = new Map<string, InternalSessionEntry<P>>();
    for (const entry of this.registry.values()) {
      if (entry.originExecutionId !== executionId) continue;
      for (const inBranch of this.liveSubtree(entry.id)) targets.set(inBranch.id, inBranch);
    }
    const sessionIds = await this.abortEach([...targets.values()], reason);

    const origin = [...this.registry.values()].find(
      (entry) => entry.session.currentExecutionId === executionId,
    );
    if (origin !== undefined) {
      try {
        await origin.session.abort(reason);
      } catch {
        // best effort — an execution that settled mid-abort is a success
      }
    }
    return { executionId, sessionIds, originAborted: origin !== undefined };
  }

  /**
   * `SpawnContext.abortSubtree` — abort every live execution in the spawn
   * subtree rooted at `sessionId` (that session INCLUDED), deepest-first.
   *
   * The `session.abort({ cascade: true })` door: a session knows its children's
   * ids, but only this registry holds their harnesses, so the walk lives here.
   * Destroy's step 1 is this same pass over a subtree it already snapshotted
   * (see {@link abortEach}) — one implementation, two callers, and destroy
   * keeps its single snapshot.
   *
   * Abort-strength only: nothing is disposed, no record is touched, detached
   * tasks keep running. Returns how many sessions were actually aborted.
   */
  async abortSubtree(sessionId: string, reason?: string): Promise<number> {
    const aborted = await this.abortEach(this.liveSubtree(sessionId), reason ?? "aborted");
    return aborted.length;
  }

  /**
   * Abort the current execution of each entry, DEEPEST-FIRST — the caller
   * passes a subtree in the breadth-first order {@link liveSubtree} returns and
   * this reverses it, because a child must stop before the parent that is
   * waiting on it unwinds.
   *
   * `hasInFlightExecution` is the session's own synchronous truth, read
   * immediately before the abort — the only honest input to the count. Failures
   * are swallowed per session: an execution that settled mid-abort got what the
   * caller wanted.
   */
  private async abortEach(
    subtree: readonly InternalSessionEntry<P>[],
    reason: string,
  ): Promise<readonly string[]> {
    const aborted: string[] = [];
    for (const entry of [...subtree].reverse()) {
      if (!entry.session.hasInFlightExecution) continue;
      aborted.push(entry.id);
      try {
        await entry.session.abort(reason);
      } catch {
        // best effort — an execution that settled mid-abort is a success
      }
    }
    return aborted;
  }

  /**
   * `AppHarnessProtocol.executionTreeContains` — the membership
   * {@link abortExecutionTreeBody} fans out over, answered bottom-up for ONE
   * session. See the protocol doc-block for why the direction differs (a live
   * event stream hands you one session id at a time; a snapshot walk does not).
   *
   * Climb the `parentSessionId` chain from `sessionId` — that session included
   * — and stop at the first entry stamped with this `originExecutionId`.
   * Equivalent to "is `sessionId` in the live subtree of some entry seeded by
   * `executionId`", which is exactly what the top-down walk collects. Pure
   * registry reads, no store, no cache: the live registry IS the truth, and a
   * cache would answer a question about a tree that changes on every spawn.
   *
   * `seen` guards a corrupt parent cycle rather than trusting the tree to be
   * one; the loop must terminate even then, because a subscriber calls this per
   * event.
   */
  executionTreeContains(executionId: string, sessionId: string): boolean {
    const seen = new Set<string>();
    let cursor = this.registry.get(sessionId);
    while (cursor !== undefined && !seen.has(cursor.id)) {
      if (cursor.originExecutionId === executionId) return true;
      seen.add(cursor.id);
      cursor =
        cursor.parentSessionId !== undefined
          ? this.registry.get(cursor.parentSessionId)
          : undefined;
    }
    return false;
  }

  /**
   * `AppHarnessProtocol.sessionTreeContains` — the same climb
   * {@link executionTreeContains} makes, terminating on the ROOT SESSION rather
   * than on an origin execution. See the protocol doc-block for why the root is
   * a member of its own tree while an origin session is not a member of its
   * turn's: a session id names the session, an execution id names a turn it
   * moves past.
   *
   * `seen` guards a corrupt parent cycle, exactly as the execution walk does —
   * a subscriber calls this per event.
   */
  sessionTreeContains(rootSessionId: string, sessionId: string): boolean {
    const seen = new Set<string>();
    let cursor = this.registry.get(sessionId);
    while (cursor !== undefined && !seen.has(cursor.id)) {
      if (cursor.id === rootSessionId) return true;
      seen.add(cursor.id);
      cursor =
        cursor.parentSessionId !== undefined
          ? this.registry.get(cursor.parentSessionId)
          : undefined;
    }
    return false;
  }

  /**
   * `AppHarnessProtocol.sessionTree` — the id projection of {@link liveSubtree},
   * which already returns root-first-then-breadth-first. The public door exists
   * because a subscriber outside this package needs the membership list once,
   * at subscribe time, and has no other way to read the live registry's spawn
   * edge.
   */
  sessionTree(rootSessionId: string): readonly string[] {
    return this.liveSubtree(rootSessionId).map((entry) => entry.id);
  }

  /**
   * The live spawn subtree rooted at `sessionId` — the target's own registry
   * entry (when live) followed by every live descendant, breadth-first, so
   * reversing the list walks deepest-first.
   *
   * Read off the registry's `parentSessionId` edge rather than
   * `SessionHarness._children` (private) — the same edge from the other end, and
   * the one that still finds a descendant whose intermediate ancestor has since
   * been evicted. A target that is not itself live still yields its live
   * descendants.
   */
  private liveSubtree(sessionId: string): InternalSessionEntry<P>[] {
    const out: InternalSessionEntry<P>[] = [];
    const self = this.registry.get(sessionId);
    if (self) out.push(self);
    const seen = new Set<string>([sessionId]);
    const frontier: string[] = [sessionId];
    while (frontier.length > 0) {
      const parentId = frontier.shift() as string;
      for (const entry of this.registry.values()) {
        if (entry.parentSessionId !== parentId || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
        frontier.push(entry.id);
      }
    }
    return out;
  }

  /**
   * Cancel every still-running DETACHED task owned by a session in `subtree`.
   *
   * Detached is the only interesting case: `close()` already cancels the rest as
   * its harness shuts down, and it deliberately ABANDONS the detached ones (ADR
   * 68 — they outlive the session that spawned them). Destroy is the stronger
   * verb, so it reaps them.
   *
   * Reached through the owning session's LIVE task harness, not by writing the
   * store directly: cancellation has to abort the executor, and the executor is
   * an in-process handle only that harness holds. Consequently a detached task
   * whose owning session was already closed is NOT reachable — its record stays
   * `working` until store hydration marks it `interrupted`.
   *
   * TODO(tasks-detached-orphans): give the app a door to the executors of
   * detached tasks whose owning session is gone, so destroy (and app close) can
   * reap them too. Today the only handle dies with the session's harness.
   */
  private async cancelDetachedTasks(
    subtree: readonly InternalSessionEntry<P>[],
    reason: string,
  ): Promise<number> {
    let cancelled = 0;
    const storeCtx = this.storeCtx();
    for (const entry of subtree) {
      let records: readonly TaskRecord[];
      try {
        records = await this.taskStore.list({ scope: { sessionId: entry.id } }, storeCtx);
      } catch {
        continue; // a store read failure must not block the teardown
      }
      for (const record of records) {
        if (!record.detached || isTerminalTaskStatus(record.status)) continue;
        try {
          await entry.session.tasks.cancel(record.taskId, reason);
          cancelled++;
        } catch {
          // unknown to this harness, or terminal since the read — best effort
        }
      }
    }
    return cancelled;
  }

  /**
   * Tear down a live session and drop it from the live registry.
   *
   * `reason: "close"` (default) is a genuine session end — `closeApp`,
   * `runOnce` auto-dispose, or explicit teardown — and fires the app-level
   * `onSessionClose` handlers ("session ended" analytics / cleanup).
   *
   * `reason: "evict"` is a CHECKPOINT: `session:snapshot` (which fans `persist`
   * out over every store-backed bridge — the flush barrier) followed by
   * `session:close({ reason: "evicted" })` and the unmount. The app retains
   * NOTHING; what makes the session resumable is its durable `SessionRecord`
   * plus the per-harness stores it just flushed to (checkpointing §4). The
   * app-level `onSessionClose` handlers do NOT fire — the session is not
   * ending, only leaving memory until its next open rebuilds it. The session's
   * OWN close handlers (bridge / extension teardown) run either way, since
   * `session.close()` is called both times.
   *
   * A rejected flush ABORTS the eviction and rejects to the caller: the session
   * stays live rather than unmounting behind an un-flushed tail. Automatic
   * callers (the sweep, the LRU) absorb that rejection; `evictSession` surfaces
   * it to whoever asked.
   */
  private async disposeSession(
    sessionId: string,
    reason: "close" | "evict" = "close",
  ): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) {
      // No live entry — either never opened, or a disposal is already in flight
      // for this id. Join it, so a caller awaiting dispose truly waits for the
      // inbox addresses to be released rather than returning while they are held.
      await this.disposing.get(sessionId);
      return;
    }
    if (reason === "evict") {
      if (!this.isEvictable(entry)) return;
      // The flush barrier, BEFORE the registry drop — an aborted eviction must
      // leave the session exactly as it found it. An already-closed session is a
      // CORPSE being collected, not a live one being checkpointed: the sweep may
      // reach one whose harness was closed directly, and flushing it would only
      // throw.
      if (entry.session.status !== "closed") await entry.session.snapshot();
      // TOCTOU re-guard: the flush awaited, so a send may have landed since.
      // No await sits between this check and the registry delete, so the guard
      // is atomic in single-threaded JS — an in-flight session is never evicted
      // mid-send, and the entry we drop is the one we flushed.
      if (this.registry.get(sessionId) !== entry || !this.isEvictable(entry)) return;
    }
    this.registry.delete(sessionId);

    // The teardown that actually RELEASES the inbox addresses (session.close →
    // BaseHarness unregister). Published on `disposing` — with no await between
    // the registry delete and the publish, so it is atomic in single-threaded
    // JS — so `buildSession`'s barrier can wait it out before a same-id resume
    // rebuilds and collides on those addresses.
    const teardown = (async (): Promise<void> => {
      try {
        // ADR 92 Family 2 §5 — eviction routes THROUGH `session:command:close`,
        // not around it. Page-out and hangup are the same teardown; the audit
        // record tells them apart by provenance, not by code path.
        await entry.session.close({ reason: reason === "evict" ? "evicted" : "closed" });
      } catch {
        // best effort — already-closed sessions throw; ignore
      }
      try {
        await closeOf(entry.tools);
      } catch {
        // best effort
      }
      // Eviction is a checkpoint, not a lifecycle end — suppress the app-level
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
    })();
    this.disposing.set(sessionId, teardown);
    try {
      await teardown;
    } finally {
      // Clear only if still ours — a fresh dispose of the same id must not wipe it.
      if (this.disposing.get(sessionId) === teardown) this.disposing.delete(sessionId);
    }
  }

  /**
   * ADR 102 — resolve and hold this session's scope node, or `undefined`
   * when the app has no topology. An adopter-supplied per-session bus
   * (per-call or app default) owns the session's wiring outright, so the
   * seam stands aside rather than competing with it.
   */
  private resolveSessionNode(
    sessionId: string,
    input: CreateSessionInput<P>,
  ): ScopeNodeLease | undefined {
    if (this.sessionNode === undefined || this.scopeNodes === undefined) return undefined;
    if (input.bus !== undefined || this.sessionDefaults.bus !== undefined) return undefined;
    return this.scopeNodes.node(
      this.sessionNode({
        sessionId,
        metadata: input.metadata ?? {},
        ...omitUndefined({ principal: input.principal }),
      }),
    );
  }

  private touchActivity(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (entry) entry.lastActiveAt = Date.now();
  }

  /**
   * Can this live session be checkpointed out of memory? Evictable = a durable,
   * quiescent session: NOT ephemeral (`runOnce` sessions self-dispose and carry
   * no durable record) and NOT in-flight (never interrupt active work — the
   * hard eviction invariant). The `hasInFlightExecution` read is the
   * session's own synchronous truth (reservation ∪ persisted execution id).
   *
   * TODO(eviction-victim-policy): the rule is hardcoded, as is the LRU choice
   * of victim. Weighted / adopter-supplied victim selection starts here.
   */
  private isEvictable(entry: InternalSessionEntry<P>): boolean {
    return !entry.ephemeral && !entry.session.hasInFlightExecution;
  }

  /**
   * PA2 — enforce the soft LRU `maxActive` cap. Counts durable live sessions
   * (ephemeral excluded — they don't consume the cap) and, while over the cap,
   * evicts the least-recently-active EVICTABLE session other than the
   * just-created `keepId`. Soft: if every over-cap session is in-flight, the
   * live count stays above the cap until work settles (safety over bound); a
   * victim whose flush FAILS is treated the same way — the cap yields rather
   * than failing the create that triggered it.
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
      try {
        // Through the OPERATION, not the body — triggers are callers of the
        // same composed op (checkpointing §4), so the LRU's evictions fire the
        // minted hooks and honor evict-op guards exactly as the manual verb's.
        await this.evictSession(victim.id);
      } catch {
        return;
      }
    }
  }

  /**
   * PA3 — the idle sweep. Evicts every EVICTABLE session whose last activity is
   * older than `idleMs`. Runs on the unref'd background timer, so a quiet app
   * still releases memory. Best-effort: a mid-sweep failure on one session (an
   * aborted eviction, which leaves that session live) does not block the rest.
   */
  private async sweepIdle(idleMs: number): Promise<void> {
    if (this._closed) return;
    const cutoff = Date.now() - idleMs;
    const stale = [...this.registry.values()].filter(
      (e) => this.isEvictable(e) && (e.lastActiveAt ?? e.createdAt) <= cutoff,
    );
    for (const entry of stale) {
      try {
        // Through the OPERATION — same reason as the LRU path above: the
        // sweep's evictions must be observable (minted hooks) and guardable,
        // or "triggers are callers" is a doc claim the automatic callers break.
        await this.evictSession(entry.id);
      } catch {
        // the session stays live; the next sweep tries again
      }
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
  interceptors: InstallerInterceptors,
): CompilerProtocol {
  if (slot === undefined) {
    throw new Error(
      "createApp: `compiler` is required. Import createApp from " +
        '"@agentick/app/react" for the React default, or pass a ' +
        "`CompilerFactory` (e.g., `reactCompiler()` from " +
        '"@agentick/compiler-react").',
    );
  }
  if (isCompilerFactory(slot)) {
    return slot({ scopeId, journal, bus, inbox, interceptors });
  }
  if (isCompilerInstance(slot)) return slot;
  throw new Error(
    "createApp: `compiler` must be a `CompilerProtocol` instance " +
      "or a `CompilerFactory` (produced by `defineCompiler(...)` " +
      "or `reactCompiler(...)` etc.).",
  );
}

/**
 * The interruption mark (execution-resume.md §3.1). Applied AFTER the two-signal
 * detection said "crashed": construction itself has already neutralized the
 * record's FSM (the hydrate merge writes back fresh `idle` status and wipes
 * `currentExecutionId`), so this records the crash ADDITIVELY on top —
 * `interruptedExecutionId` + the per-execution budget. Pure; derive from the
 * PRE-construction record so the prior budget is read before the merge could
 * touch it.
 */
export function markInterruptedRecord(record: SessionRecord, executionId: string): SessionRecord {
  // Per-EXECUTION crash-loop budget: `resumeAttempts` counts CONSECUTIVE
  // interruptions of the SAME execution. A resume keeps the execution id, so a
  // re-crash increments; a different execution resets to 1, so B never inherits
  // A's crash count. Completion clears both (slice 3).
  const consecutive = record.interruptedExecutionId === executionId;
  return {
    ...record,
    status: "idle",
    currentExecutionId: undefined,
    interruptedExecutionId: executionId,
    resumeAttempts: consecutive ? (record.resumeAttempts ?? 0) + 1 : 1,
    updatedAt: Date.now(),
  };
}

/**
 * Collapse the App-level session-defaults cascade into a single
 * `SessionDefaults`. Longhand (`options.session.*`) wins over the
 * top-level convenience shortcuts; conflicts resolve like CSS
 * shorthand-vs-longhand.
 */
function mergeSessionDefaults<P>(
  options: AppHarnessOptions<P>,
  appScopes: Readonly<Record<string, (slotValue: unknown) => unknown>>,
): SessionDefaults<P> {
  const fromLong = options.session ?? {};
  const merged: Record<string, unknown> = { ...fromLong };
  if (fromLong.defaultMaxTicks === undefined && options.defaultMaxTicks !== undefined) {
    merged.defaultMaxTicks = options.defaultMaxTicks;
  }
  if (fromLong.tickFailurePolicy === undefined && options.tickFailurePolicy !== undefined) {
    merged.tickFailurePolicy = options.tickFailurePolicy;
  }
  if (
    fromLong.maxConsecutiveFailedTicks === undefined &&
    options.maxConsecutiveFailedTicks !== undefined
  ) {
    merged.maxConsecutiveFailedTicks = options.maxConsecutiveFailedTicks;
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
  // ADR 93 §"Top-level slots for every namespace" — fold the registered
  // NAMESPACE slots (`createApp({ timeline })`) into the per-session defaults.
  //
  // The app names no namespace: `collectNamespaceSlots` reads the slot registry
  // that each namespace package populated by side effect (`registerNamespaceSlot`),
  // so the value passes through as `unknown` and the layer that OWNS that
  // namespace (session-bridges for the eager built-ins) types it. That is what
  // keeps ADR 27 intact — the metapackage bundles the built-ins, it does not
  // privilege them, and nothing in this file mentions `timeline`.
  //
  // `appScopes` folds each namespace's APP-SCOPED defaults under the adopter's
  // slot value, so the default stores outlive the sessions that use them —
  // without which an evicted session hydrates from a store its own harness took
  // to the grave (checkpointing §4).
  Object.assign(
    merged,
    collectNamespaceSlots(options as unknown as Readonly<Record<string, unknown>>, appScopes),
  );
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
