/**
 * `AppHarness` — reference implementation of `AppHarnessProtocol`.
 *
 * The outermost runtime boundary. Constructs and owns the shared
 * substrate (journal, bus, inbox) and the shared sub-harnesses
 * (reconciler, loop executor) used by every session it spawns. Each
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

import { Effect, Fiber, Stream } from "effect";

import {
  BaseHarness,
  busAsyncIterator,
  type HarnessShell,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { TasksHarness } from "@agentick/tasks-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { SessionHarness, type SessionHarnessOptions } from "@agentick/session-next";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
  type ToolExecutorHarnessOptions,
  type ToolHandler,
} from "@agentick/tool-executor-next";
import {
  DEFAULT_JOURNALING_POLICY,
  HandlerError,
  isExecutorFactory,
  isLoopExecutorFactory,
  isReconcilerFactory,
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
  ReconcilerProtocol,
  RunOnceInput,
  RunOnceResult,
  SendInput,
  SendResult,
  ServiceRegistry,
  SessionEntry,
  SessionExtension,
  SessionInstaller,
  TelemetryLayer,
  ToolRegistration,
  Validator,
  SessionFilter,
  SessionHarnessProtocol,
  SessionListEntry,
  SessionStatus,
  SpawnContext,
  SpawnContextChildInput,
  LoopExecutorFactory,
  ReconcilerFactory,
  ToolExecutorFactory,
  ToolExecutorProtocol,
  Unsubscribe,
  EventBusFactory,
  MessageInboxFactory,
  OperationJournalFactory,
} from "@agentick/spec-next";

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
 * and the wired sub-harness references (`reconciler`, `loop`, `executor`,
 * `toolExecutor`, `target`) are owned by the App and excluded here.
 */
export type SessionDefaults<P = unknown> = Omit<
  SessionHarnessOptions<P>,
  "sessionId" | "agent" | "reconciler" | "loop" | "executor" | "toolExecutor" | "target"
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
   * Root agent element passed to every session's reconciler mount.
   * Opaque to the app — the reconciler impl owns the type contract.
   * For React this is a `React.ReactNode`; for an Angular reconciler
   * it'd be the framework's root component reference.
   */
  readonly rootElement: unknown;
  /**
   * Language-model executor shared across sessions. Accepts either:
   *
   *   - A pre-built `LanguageModelExecutor` instance — the caller
   *     constructed it with its own substrate; the app uses it as-is.
   *   - An `ExecutorFactory` (e.g., from `openai(modelId, opts)`) — the
   *     app calls it at construction with the app's substrate, so the
   *     executor's events appear on `app.events(...)` without manual
   *     wiring.
   *
   * The executor is self-describing: its `.target` property is read by
   * the app, so the redundant `target` field below is optional.
   */
  readonly executor: LanguageModelExecutor | ExecutorFactory;
  /**
   * Optional override of the executor's self-described target. When
   * omitted, `executor.target` is used. Override at this level when a
   * single shared executor should advertise different capabilities or
   * provider options per app.
   */
  readonly target?: ExecutionTarget;

  // ────────── Sub-harness slots (shared across sessions) ──────────

  /**
   * Reconciler slot. Required — `@agentick/app-next` is reconciler-agnostic
   * by design and does NOT default to any specific reconciler. Pass:
   *
   *   - A pre-built `ReconcilerProtocol` instance (e.g., a future
   *     Angular reconciler).
   *   - A `ReconcilerFactory` (produced by `defineReconciler(...)` or
   *     `reactReconciler(...)` etc.). The App calls the factory at
   *     construction with the shared substrate so reconciler events
   *     flow through `app.events()`.
   *
   * For the React default, use `createApp` from `@agentick/app-next/react`
   * which defaults `reconciler: reactReconciler()` automatically.
   */
  readonly reconciler: ReconcilerProtocol | ReconcilerFactory;

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
   * tools should declare via JSX (reconciler scope wins everything).
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
   * fields wired by the App (`reconciler`, `loop`, `executor`,
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
   * Adopter-defined metadata bag carried on the App harness instance
   * and exposed to substrate factories via `parent.metadata`. Framework
   * defines no keys; adopters stash whatever they want (deployment
   * tags, request shape, routing hints).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /**
   * Telemetry `Layer` (Effect). Placeholder slot — defined for forward
   * compat with OTel/observability backends. The MVP impl accepts and
   * stores it but does NOT yet apply the Layer to running commands
   * (requires a runtime refactor in `runHarnessProtocol`). Adopters
   * relying on it today should set up their OTel SDK out-of-band.
   *
   * @see docs/proposals/v2/blueprint/09-app-harness.md §Telemetry
   */
  readonly telemetry?: TelemetryLayer;

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
  private readonly executor: LanguageModelExecutor;
  private readonly target: ExecutionTarget;

  // Per-session defaults resolved from the cascade
  // (session-longhand > shorthand > built-in).
  private readonly sessionDefaults: SessionDefaults<P>;
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
  private readonly reconciler: ReconcilerProtocol;
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
   * Stored `TelemetryLayer` (4f.7 placeholder slot). Accepted for
   * forward compat; not yet applied to command execution.
   */
  private readonly telemetryLayer: import("@agentick/spec-next").TelemetryLayer | undefined;

  /**
   * Tool bridge surfaced to each session's HookBridges. Wraps the
   * shared HandlerResolver so reconciler-side tools (React
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
        ...omitUndefined({ journal: options.journal, bus: options.bus, inbox: options.inbox }),
        policy: mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, {
          override: { "app:command:close-app": "bus-only" },
        }),
      },
    );
    // Local aliases for convenience in the rest of the constructor.
    const journal = this.journal;
    const bus = this.bus;
    const inbox = this.inbox;

    this.rootElement = options.rootElement;
    // Executor slot: factory → construct with the app's substrate so
    // executor events flow through app.events(). Instance → use as-is
    // (caller owns substrate).
    this.executor = isExecutorFactory(options.executor)
      ? options.executor({
          scopeId: `${appId}:executor`,
          journal,
          bus,
          inbox,
        })
      : options.executor;
    // Resolve target: caller override > executor.target.
    this.target = options.target ?? this.executor.target;
    this.telemetryLayer = options.telemetry;

    // Cascade: longhand (`options.session.*`) wins over shorthand
    // (`options.defaultMaxTicks` / `options.initialProps` /
    // `options.initialKnobs`). Per-call `createSession.*` wins over both
    // and applies at session construction.
    this.sessionDefaults = mergeSessionDefaults(options);
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

    // Reconciler slot — instance or options.
    this.reconciler = resolveReconciler(options.reconciler, appId, journal, bus, inbox);

    // Loop slot: factory → call with shared substrate; instance → use
    // as-is; undefined → bundled default with shared substrate.
    this.loop = isLoopExecutorFactory(options.loop)
      ? options.loop({ scopeId: appId, journal, bus, inbox })
      : (options.loop ?? new LoopExecutorHarness(appId, journal, bus, inbox));

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
        // The reconciler harness exposes `registerContributor` on
        // ReconcilerHarness specifically. Duck-type — external
        // reconciler impls without the method silently drop.
        const r = self.reconciler as {
          registerContributor?: (c: unknown) => void;
        };
        if (typeof r.registerContributor === "function") {
          r.registerContributor(contributor);
        }
        // No unregister surface today; reconciler registry is
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
        // Subscribe via the app's bus Stream + `Stream.runForEach`,
        // forked as a fiber so unsubscribe is a single `Fiber.interrupt`
        // call. The previous AsyncIterable + `aborted` boolean pattern
        // had a microtask leak: between an in-flight `await listener(...)`
        // and the outer `aborted = true` flip, `iter.next()` could
        // already be pending and yield one more value AFTER the
        // unsubscribe call returned. `Fiber.interrupt` is atomic —
        // upon return, the fiber is guaranteed to receive no further
        // values.
        const fiber = Effect.runFork(
          Stream.runForEach(self.bus.subscribe(filter), (env) =>
            Effect.tryPromise({
              // Swallow listener errors so one extension can't kill the
              // bus subscription.
              try: () => Promise.resolve(listener(env)),
              catch: () => undefined,
            }).pipe(Effect.catchAll(() => Effect.void)),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
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
        // Mirror AppInstaller's pattern — Stream.runForEach in a
        // forked fiber; unsubscribe via Fiber.interrupt for atomic
        // teardown with no microtask leak.
        const fiber = Effect.runFork(
          Stream.runForEach(self.bus.subscribe(filter), (env) =>
            Effect.tryPromise({
              try: () => Promise.resolve(listener(env)),
              catch: () => undefined,
            }).pipe(Effect.catchAll(() => Effect.void)),
          ),
        );
        const unreg = (): void => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
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
    const reconcilerReady = readyOf(this.reconciler);
    const loopReady = readyOf(this.loop);
    return Promise.all([this.ready, reconcilerReady, loopReady, this.extensionsReady]).then(
      () => {},
    );
  }

  // ──────── AppHarnessProtocol ────────

  createSession(input: CreateSessionInput<P> = {}): Promise<SessionHarnessProtocol<P>> {
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

  listSessions(filter?: SessionFilter): readonly SessionListEntry[] {
    const out: SessionListEntry[] = [];
    for (const entry of this.registry.values()) {
      if (entry.ephemeral) continue;
      const status = entry.session.snapshot().status as SessionStatus;
      if (!matchesFilter(status, entry.metadata, filter)) continue;
      const listing: SessionListEntry = {
        id: entry.id,
        status,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        ...omitUndefined({ lastActiveAt: entry.lastActiveAt }),
      };
      out.push(listing);
    }
    return out;
  }

  events(filter: EventQuery = {}, options: SubscribeOptions = {}): AsyncIterable<ProtocolEvent> {
    const bus = this.bus;
    return {
      [Symbol.asyncIterator]: () => busAsyncIterator(bus, filter, options),
    };
  }

  closeApp(): Promise<void> {
    const op: Operation<void, void> = {
      opId: `app:close-app:${ulid()}`,
      surface: "app",
      name: "app:command:close-app",
      scope: {},
      input: undefined,
    };
    return this.runWithTelemetry(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.closeAppBody(),
          catch: (cause): AppError => mapAppError(cause),
        }),
      ),
    );
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
    if (this.telemetryLayer === undefined) return runHarnessProtocol(eff);
    const provided = Effect.provide(eff, this.telemetryLayer) as Effect.Effect<R, unknown, never>;
    return runHarnessProtocol(provided);
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
    } = {},
  ): Promise<SessionHarnessProtocol<P>> {
    this.assertOpen();

    // Run `onSessionCreate` handlers — first veto wins. Replace and
    // defer verdicts aren't supported for session creation (no
    // meaningful semantics here yet); we recognize only veto/proceed.
    for (const h of this.sessionCreateHandlers) {
      const verdict = await h(input);
      if (verdict && verdict.kind === "veto") {
        throw {
          _tag: "AppExecutionFailed",
          cause: new Error(
            verdict.reason ? `session create vetoed: ${verdict.reason}` : "session create vetoed",
          ),
        } as AppError;
      }
    }

    const sessionId = input.sessionId ?? `session:${ulid()}`;
    if (this.registry.has(sessionId)) {
      throw { _tag: "SessionAlreadyExistsError", sessionId } as AppError;
    }

    // Per-session elicitation harness. Owns the request/response
    // correlation engine for tool confirmation, MCP elicitation, and
    // any other "ask user X" step. The same instance is threaded into
    // BOTH the tool executor (for the confirmation gate) AND the
    // session bridges (so React-side `bridges.elicitation` and
    // server-side `bridges.elicitation.respond(...)` from clients
    // reach the same registry the tool executor is awaiting).
    const elicitation = new ElicitationHarness(
      `${sessionId}:elicitation`,
      this.journal,
      this.bus,
      this.inbox,
      { parentScope: { sessionId } },
    );

    // Per-session tasks harness — substrate-level long-running tool
    // registry. Surfaced on `ctx.tasks` for handlers, on
    // `bridges.tasks` for JSX, and routed through the ToolExecutor's
    // `tasks` slot so handlers returning a TaskHandle branch on the
    // tool's `taskSupport` annotation (#156).
    const tasks = new TasksHarness(`${sessionId}:tasks`, this.journal, this.bus, this.inbox, {
      parentScope: { sessionId },
    });

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
      reconciler: this.reconciler,
      loop: this.loop,
      executor: this.executor,
      toolExecutor: tools,
      elicitation,
      tasks,
      target: this.target,
      defaultMaxTicks: input.maxTicks ?? this.sessionDefaults.defaultMaxTicks ?? 8,
      // Streaming cascade: per-session input.streaming > app-level
      // streamingDefault (sessionDefaults.defaultStreaming) > undefined
      // (executor-capability default resolved per-send in SessionHarness).
      ...(input.streaming !== undefined
        ? { defaultStreaming: input.streaming }
        : this.sessionDefaults.defaultStreaming !== undefined
          ? { defaultStreaming: this.sessionDefaults.defaultStreaming }
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
      // reconciler-side tools register handlers at render time.
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
    });

    // `ready` / `close` aren't on `ToolExecutorProtocol` — duck-type
    // through `readyOf` / `closeOf` so both the reference harness AND
    // factory-produced impls work transparently.
    await Promise.all([readyOf(tools), session.ready]);
    await session.mountReady;

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
    });
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

    // Close every registered session. Order isn't load-bearing — each
    // session unmounts independently.
    const sessionIds = Array.from(this.registry.keys());
    for (const id of sessionIds) {
      await this.disposeSession(id);
    }

    // Tear down shared sub-harnesses last so their inboxes are still
    // alive while sessions detach. `close()` may not exist on
    // user-supplied impls — guard it.
    await Promise.allSettled([closeOf(this.reconciler), closeOf(this.loop)]);
    // `super.close()` fires substrate-close handlers registered via
    // factories' `parent.onClose(h)`. Safe to run here because
    // `app:command:close-app` is policy-marked `"bus-only"` in the
    // constructor — the Operation framework writes no envelopes to
    // the journal for this op, so a handler closing the journal
    // doesn't break the framework's terminal append.
    await super.close();
  }

  private async disposeSession(sessionId: string): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
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

  private assertOpen(): void {
    if (this._closed) throw { _tag: "AppClosedError" } as AppError;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function matchesFilter(
  status: SessionStatus,
  metadata: Readonly<Record<string, unknown>>,
  filter?: SessionFilter,
): boolean {
  if (!filter) return true;
  if (filter.status !== undefined) {
    const allowed = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!allowed.includes(status)) return false;
  }
  if (filter.metadata !== undefined) {
    for (const [k, v] of Object.entries(filter.metadata)) {
      if (metadata[k] !== v) return false;
    }
  }
  return true;
}

function mapAppError(cause: unknown): AppError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as AppError;
  }
  return { _tag: "AppExecutionFailed", cause };
}

// ─────────────────────────────────────────────────────────────────────
// Slot resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * `ReconcilerProtocol` instances expose a `mount()` method; factories
 * carry the `reconcilerFactory: true` marker. Duck-type to discriminate.
 */
function isReconcilerInstance(v: unknown): v is ReconcilerProtocol {
  return (
    typeof v === "object" && v !== null && typeof (v as { mount?: unknown }).mount === "function"
  );
}

function resolveReconciler(
  slot: ReconcilerProtocol | ReconcilerFactory | undefined,
  scopeId: string,
  journal: OperationJournal,
  bus: EventBus,
  inbox: MessageInbox,
): ReconcilerProtocol {
  if (slot === undefined) {
    throw new Error(
      "createApp: `reconciler` is required. Import createApp from " +
        '"@agentick/app-next/react" for the React default, or pass a ' +
        "`ReconcilerFactory` (e.g., `reactReconciler()` from " +
        '"@agentick/reconciler-react-next").',
    );
  }
  if (isReconcilerFactory(slot)) {
    return slot({ scopeId, journal, bus, inbox });
  }
  if (isReconcilerInstance(slot)) return slot;
  throw new Error(
    "createApp: `reconciler` must be a `ReconcilerProtocol` instance " +
      "or a `ReconcilerFactory` (produced by `defineReconciler(...)` " +
      "or `reactReconciler(...)` etc.).",
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

// Re-export the SessionEntry shape for ergonomic imports.
export type { SessionEntry };
