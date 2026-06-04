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

import { Effect, Fiber, Layer, Stream } from "effect";

import {
  BaseHarness,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { SessionHarness, type SessionHarnessOptions } from "@agentick/session";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
  type ToolExecutorHarnessOptions,
  type ToolHandler,
} from "@agentick/tool-executor";
import {
  isExecutorFactory,
  isLoopExecutorFactory,
  isReconcilerFactory,
  isToolExecutorFactory,
} from "@agentick/spec";
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
  ExecutionTarget,
  ExecutorFactory,
  HandlerVerdict,
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
  TelemetryLayer,
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
} from "@agentick/spec";

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

/**
 * Forward-reference shell handed to App-level substrate factories. The
 * App's BaseHarness fields aren't wired yet at substrate-resolution
 * time (chicken-and-egg — substrate IS what's being constructed), so
 * factories see a thin shell exposing only what's safe at this phase:
 * adopter metadata + a buffered `onClose` registration that gets
 * replayed onto the real harness once construction finishes.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Two-phase construction
 */
export interface AppSubstrateParent {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** No parent substrate at app level (Gateway is Phase 4). */
  readonly bus?: undefined;
  readonly inbox?: undefined;
  readonly journal?: undefined;
  onClose(handler: () => void | Promise<void>): void;
}

/**
 * Resolve an `instance | factory | undefined` slot to a concrete
 * instance. Factory discrimination is `typeof slot === "function"` —
 * substrate primitives are object-shaped, so any function is a factory.
 *
 * The `parent` argument is passed explicitly so the resolver makes the
 * parent-child relationship visible at the call site, rather than
 * implicitly via `this`.
 *
 * **App-level substrate factories MUST be synchronous.** `super()`
 * needs the substrate before any async work can run. Async factories
 * (returning Promise / Effect) are supported at session level
 * (ADR 31 Phase 3, where createSession is itself async). At app level
 * we throw if a factory returns a non-sync value.
 */
function resolveSyncSubstrateSlot<R, P, F extends (parent: P) => unknown>(
  slot: R | F | undefined,
  parent: P,
  defaultFn: () => R,
  slotName: string,
): R {
  if (slot === undefined) return defaultFn();
  if (typeof slot === "function") {
    const result = (slot as F)(parent);
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new Error(
        `AppHarness '${slotName}' factory returned a Promise — app-level ` +
          `substrate factories must be synchronous. Use a pre-constructed ` +
          `instance for the slot, or move async construction to session level.`,
      );
    }
    // Effect values are objects with `_op_layer`/internal symbols, not
    // Promises. We treat any non-instance return as a programmer error
    // narrow to R via cast — runtime check above protected us.
    return result as R;
  }
  return slot;
}

/**
 * Per-session forwarded `ToolExecutorHarness` options. `handlerResolver`
 * is owned by the App (shared across sessions) and excluded here.
 */
export type ToolExecutorDefaults = Omit<ToolExecutorHarnessOptions, "handlerResolver">;

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
   * Reconciler slot. Required — `@agentick/app` is reconciler-agnostic
   * by design and does NOT default to any specific reconciler. Pass:
   *
   *   - A pre-built `ReconcilerProtocol` instance (e.g., a future
   *     Angular reconciler).
   *   - A `ReconcilerFactory` (produced by `defineReconciler(...)` or
   *     `reactReconciler(...)` etc.). The App calls the factory at
   *     construction with the shared substrate so reconciler events
   *     flow through `app.events()`.
   *
   * For the React default, use `createApp` from `@agentick/app/react`
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
   * Tool executor slot. Accepts either:
   *
   *   - `ToolExecutorDefaults` (options) — forwarded to the App's default
   *     `ToolExecutorHarness` instance. The `handlerResolver` is wired
   *     by the App (shared across sessions).
   *   - `ToolExecutorFactory` — produced by `defineToolExecutor(...)`.
   *     The App calls the factory per-session with the shared substrate
   *     so the executor's events flow through `app.events()`.
   *
   * Cascade: per-call `createSession.tools` (when added) > this >
   * convenience `toolHandlers` > defaults.
   */
  readonly tools?: ToolExecutorDefaults | ToolExecutorFactory;

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
  readonly journal?: OperationJournal | OperationJournalFactory<AppSubstrateParent>;
  readonly bus?: EventBus | EventBusFactory<AppSubstrateParent>;
  readonly inbox?: MessageInbox | MessageInboxFactory<AppSubstrateParent>;

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
  private readonly rootElement: unknown;
  private readonly executor: LanguageModelExecutor;
  private readonly target: ExecutionTarget;

  // Per-session defaults resolved from the cascade
  // (session-longhand > shorthand > built-in).
  private readonly sessionDefaults: SessionDefaults<P>;
  /**
   * Options forwarded to the default `ToolExecutorHarness` constructed
   * per-session. Undefined when the caller supplied a
   * `ToolExecutorFactory` at the `tools` slot — `toolFactory` carries
   * the factory in that case.
   */
  private readonly toolDefaults: ToolExecutorDefaults;
  /**
   * Caller-supplied factory at the `tools` slot. When set, each session's
   * tool executor is produced by invoking this factory with the shared
   * substrate; `toolDefaults` is ignored.
   */
  private readonly toolFactory: ToolExecutorFactory | undefined;

  // Shared sub-harnesses (one per app, used by every session).
  private readonly reconciler: ReconcilerProtocol;
  private readonly loop: LoopExecutorProtocol;
  private readonly handlerResolver: InMemoryHandlerResolver;

  private readonly registry = new Map<string, InternalSessionEntry<P>>();
  private _closed = false;

  /**
   * Stored `TelemetryLayer` (4f.7 placeholder slot). Accepted for
   * forward compat; not yet applied to command execution.
   */
  private readonly telemetryLayer: import("@agentick/spec").TelemetryLayer | undefined;

  /**
   * Tool bridge surfaced to each session's HookBridges. Wraps the
   * shared HandlerResolver so reconciler-side tools (React
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
  /** Pending install promise resolved once all app-targeted extensions complete `install()`. */
  private readonly extensionsReady: Promise<void>;

  constructor(options: AppHarnessOptions<P>) {
    const appId = options.appId ?? `app:${ulid()}`;

    // Resolve substrate via the explicit-parent slot pattern (ADR 31).
    //
    // The App's BaseHarness fields aren't wired yet — substrate IS
    // what's being constructed — so factories see a `parent` shell
    // that buffers `onClose` registrations for replay onto the real
    // harness after super() finishes.
    const pendingCloseHandlers: Array<() => void | Promise<void>> = [];
    const parent: AppSubstrateParent = {
      id: appId,
      metadata: Object.freeze({ ...(options.metadata ?? {}) }),
      onClose: (h) => pendingCloseHandlers.push(h),
    };
    const journal: OperationJournal = resolveSyncSubstrateSlot<
      OperationJournal,
      AppSubstrateParent,
      OperationJournalFactory<AppSubstrateParent>
    >(
      options.journal,
      parent,
      () => new MemoryJournal({ capacity: 10_000 }),
      "journal",
    );
    const bus: EventBus = resolveSyncSubstrateSlot<
      EventBus,
      AppSubstrateParent,
      EventBusFactory<AppSubstrateParent>
    >(options.bus, parent, () => new LocalEventBus(), "bus");
    const inbox: MessageInbox = resolveSyncSubstrateSlot<
      MessageInbox,
      AppSubstrateParent,
      MessageInboxFactory<AppSubstrateParent>
    >(options.inbox, parent, () => new LocalInbox(), "inbox");

    super("app", appId, journal, bus, inbox, {
      metadata: options.metadata,
    });
    // Replay any close handlers the substrate factories registered
    // against the shell onto the now-real harness.
    for (const h of pendingCloseHandlers) this.onClose(h);

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
    // Tool slot: factory → defer construction to per-session via
    // `toolFactory`; options/undefined → forward to the bundled
    // `ToolExecutorHarness` via `toolDefaults`.
    if (isToolExecutorFactory(options.tools)) {
      this.toolFactory = options.tools;
      this.toolDefaults = {};
    } else {
      this.toolFactory = undefined;
      this.toolDefaults = options.tools ?? {};
    }

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
      subscribeBus(filter, listener): Unsubscribe {
        // Use the app's bus directly. We need a fiber-like handle to
        // unsubscribe; the simplest path is Stream.runForEach with a
        // Fiber.interrupt on cleanup, but our app surface already
        // exposes `app.events(filter)` as an AsyncIterable — extensions
        // typically don't need fiber-level granularity. We provide the
        // simple-bus subscription here; advanced flow uses app.events().
        const iter = self.events(filter)[Symbol.asyncIterator]();
        let aborted = false;
        (async () => {
          while (!aborted) {
            const next = await iter.next();
            if (next.done || aborted) break;
            try {
              await listener(next.value);
            } catch {
              // Swallow listener errors so one extension can't kill the bus.
            }
          }
          await iter.return?.();
        })();
        return () => {
          aborted = true;
          iter.return?.();
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
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
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
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
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
        ...(entry.lastActiveAt !== undefined ? { lastActiveAt: entry.lastActiveAt } : {}),
      };
      out.push(listing);
    }
    return out;
  }

  events(filter: EventQuery = {}): AsyncIterable<ProtocolEvent> {
    const bus = this.bus;
    return {
      [Symbol.asyncIterator]: () => makeBusAsyncIterator(bus, filter),
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
    ).then(async () => {
      // Run adopter-registered close handlers AFTER the close-app
      // operation's terminal envelope has been appended to the journal.
      // If handlers close the journal (the common case via the
      // `journal: factory` slot), doing this inside the Operation
      // would close the journal before the terminal envelope writes.
      await this.runCloseHandlersPostOp();
    });
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
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("app inbox dispatch not yet wired (Phase 4f minimum)"),
    });
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

    // Per-session tool executor. Two paths:
    //   - `toolFactory` set → invoke it with the shared substrate; the
    //     resulting `ToolExecutorProtocol` is opaque to the App.
    //   - Otherwise → construct the bundled `ToolExecutorHarness` from
    //     `toolDefaults` + the shared `handlerResolver`.
    const tools: ToolExecutorProtocol = this.toolFactory
      ? this.toolFactory({
          scopeId: sessionId,
          journal: this.journal,
          bus: this.bus,
          inbox: this.inbox,
        })
      : new ToolExecutorHarness(sessionId, this.journal, this.bus, this.inbox, {
          ...this.toolDefaults,
          handlerResolver: this.handlerResolver,
        });

    // Cascade: per-call `createSession.*` > per-app `session.*` >
    // shorthand (`defaultMaxTicks`/`initialProps`/`initialKnobs`).
    // sessionDefaults already collapsed (longhand vs shorthand).
    const session = new SessionHarness<P>(this.journal, this.bus, this.inbox, {
      ...this.sessionDefaults,
      sessionId,
      agent: overrides.agent ?? this.rootElement,
      reconciler: this.reconciler,
      loop: this.loop,
      executor: this.executor,
      toolExecutor: tools,
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
      // Inject self as SpawnContext so the child can spawn grandchildren.
      spawnContext: this,
      // Surface the shared handler resolver as a ToolBridge so
      // reconciler-side tools register handlers at render time.
      toolBridge: this.toolBridge,
      // Extension-provided bridges (installed by extension packages via
      // `AppHarnessOptions.extensions`) flow into every session.
      ...(this.extensionBridges.size > 0 ? { extensionBridges: this.extensionBridges } : {}),
      ...(overrides.parentSessionId !== undefined
        ? { parentSessionId: overrides.parentSessionId }
        : {}),
    });

    // `ready` / `close` aren't on `ToolExecutorProtocol` — duck-type
    // through `readyOf` / `closeOf` so both the reference harness AND
    // factory-produced impls work transparently.
    await Promise.all([readyOf(tools), session.ready]);
    await session.mountReady;

    const entry: InternalSessionEntry<P> = {
      id: sessionId,
      session,
      tools,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      ephemeral,
      ...(overrides.parentSessionId !== undefined
        ? { parentSessionId: overrides.parentSessionId }
        : {}),
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
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.initialProps !== undefined ? { initialProps: input.initialProps } : {}),
      ...(input.initialKnobs !== undefined ? { initialKnobs: input.initialKnobs } : {}),
      ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
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
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.initialProps !== undefined ? { initialProps: input.initialProps } : {}),
      ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
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
    // Only the inbox unsubscribe runs INSIDE the close Operation.
    // Substrate teardown (journal/bus/inbox `close()`) registered by
    // factories via `parent.onClose(h)` runs AFTER the Operation
    // completes — see `runCloseHandlersPostOp` below.
    await this.closeInternal();
  }

  /**
   * Run adopter-registered `onClose` handlers after the close-app
   * Operation's terminal envelope has been appended to the journal.
   * Substrate factories that registered `() => journal.close()` etc.
   * fire here, not inside `closeAppBody` — otherwise they'd close the
   * journal before the Operation framework writes its terminal.
   */
  private async runCloseHandlersPostOp(): Promise<void> {
    await this.runCloseHandlers();
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
// Bus → AsyncIterable adapter
// ─────────────────────────────────────────────────────────────────────

/**
 * Adapt a `bus.subscribe(...)` `Stream` into a per-iterator
 * `AsyncIterator<ProtocolEvent>`. Mirrors the pattern used by
 * `SessionExecutionHandle` but without a terminal sentinel — the
 * stream lives until the consumer breaks out (`return()` triggers
 * Fiber.interrupt) or the bus closes (stream completes naturally).
 *
 * Each `for await` creates its own subscription; the substrate bus is
 * multi-subscriber by design.
 */
function makeBusAsyncIterator(bus: EventBus, query: EventQuery): AsyncIterator<ProtocolEvent> {
  const stream = bus.subscribe(query);
  const queue: ProtocolEvent[] = [];
  const resolvers: Array<(r: IteratorResult<ProtocolEvent>) => void> = [];
  let done = false;
  let error: unknown = null;

  const fiber = Effect.runFork(
    Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        if (done) return;
        const r = resolvers.shift();
        if (r) r({ value: event, done: false });
        else queue.push(event);
      }),
    ).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          error = e;
          done = true;
          for (const r of resolvers.splice(0)) {
            r({ value: undefined as unknown as ProtocolEvent, done: true });
          }
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          done = true;
          for (const r of resolvers.splice(0)) {
            r({ value: undefined as unknown as ProtocolEvent, done: true });
          }
        }),
      ),
    ),
  );

  return {
    async next() {
      if (queue.length > 0) return { value: queue.shift()!, done: false };
      if (done) {
        if (error) throw error;
        return { value: undefined as unknown as ProtocolEvent, done: true };
      }
      return new Promise<IteratorResult<ProtocolEvent>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    async return() {
      done = true;
      await Effect.runPromise(Fiber.interrupt(fiber));
      for (const r of resolvers.splice(0)) {
        r({ value: undefined as unknown as ProtocolEvent, done: true });
      }
      return { value: undefined as unknown as ProtocolEvent, done: true };
    },
  };
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
        '"@agentick/app/react" for the React default, or pass a ' +
        "`ReconcilerFactory` (e.g., `reactReconciler()` from " +
        '"@agentick/reconciler-react").',
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
