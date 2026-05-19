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
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import {
  ReconcilerHarness,
  type ReconcilerHarnessOptions,
} from "@agentick/reconciler-react";
import {
  SessionHarness,
  type SessionHarnessOptions,
} from "@agentick/session";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
  type ToolExecutorHarnessOptions,
  type ToolHandler,
} from "@agentick/tool-executor";
import { isExecutorFactory } from "@agentick/spec";
import type {
  AppError,
  AppHarnessProtocol,
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
  OperationJournal,
  ProtocolEvent,
  ReconcilerProtocol,
  RunOnceInput,
  RunOnceResult,
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
  ToolExecutorProtocol,
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
  | "sessionId"
  | "agent"
  | "reconciler"
  | "loop"
  | "executor"
  | "toolExecutor"
  | "target"
>;

/**
 * Per-session forwarded `ToolExecutorHarness` options. `handlerResolver`
 * is owned by the App (shared across sessions) and excluded here.
 */
export type ToolExecutorDefaults = Omit<
  ToolExecutorHarnessOptions,
  "handlerResolver"
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
   * Reconciler slot — pass a pre-built `ReconcilerProtocol` impl (e.g.,
   * a future Angular reconciler) OR options to construct the bundled
   * React `ReconcilerHarness` with. Defaults to the bundled React
   * reconciler with empty options.
   */
  readonly reconciler?: ReconcilerProtocol | ReconcilerHarnessOptions;

  /**
   * Loop executor slot — pass a pre-built `LoopExecutorProtocol` impl
   * OR omit to use the bundled `LoopExecutorHarness`. `LoopExecutorHarness`
   * has no construction options today, so options-form is reserved
   * for forward compatibility.
   */
  readonly loop?: LoopExecutorProtocol;

  // ────────── Per-session defaults (constructed per createSession) ──────────

  /**
   * Default `ToolExecutorHarness` options forwarded to every session's
   * tool executor instance. The `handlerResolver` is wired by the App
   * (shared across sessions) and cannot be overridden here.
   *
   * Cascade: per-call `createSession.tools` (when added) > this >
   * convenience `toolHandlers` > defaults.
   */
  readonly tools?: ToolExecutorDefaults;

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
   * App-level tool handlers shared across sessions. Resolver keys are
   * `handlerRef` strings. Each session gets its own
   * `ToolExecutorHarness` instance but they all consult the same
   * resolver.
   */
  readonly toolHandlers?: ReadonlyMap<string, ToolHandler>;

  // ────────── Substrate slots ──────────

  /**
   * Inject a custom journal/bus/inbox. Defaults to in-memory locals.
   * Persistence is currently the `journal` slot — supply a durable
   * `OperationJournal` impl (e.g., SqlitePersistenceJournal once
   * shipped) for operational durability.
   */
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;

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
}

// ============================================================================
// Session registry — in-memory Map
// ============================================================================

interface InternalSessionEntry<P> {
  readonly id: string;
  readonly session: SessionHarness<P>;
  readonly tools: ToolExecutorHarness;
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
  private readonly toolDefaults: ToolExecutorDefaults;

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
    (input: CreateSessionInput<P>) => Promise<
      { readonly kind: "veto"; readonly reason?: string } | void
    >
  > = [];
  private readonly sessionCloseHandlers: Array<
    (info: {
      readonly sessionId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void> | void
  > = [];
  private readonly appCloseHandlers: Array<() => Promise<void> | void> = [];

  constructor(options: AppHarnessOptions<P>) {
    const appId = options.appId ?? `app:${ulid()}`;
    const journal = options.journal ?? new MemoryJournal({ capacity: 10_000 });
    const bus = options.bus ?? new LocalEventBus();
    const inbox = options.inbox ?? new LocalInbox();

    super("app", appId, journal, bus, inbox);

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
    this.toolDefaults = options.tools ?? {};

    // Reconciler slot — instance or options.
    this.reconciler = resolveReconciler(
      options.reconciler,
      appId,
      journal,
      bus,
      inbox,
    );

    // Loop slot — instance only today (no options on
    // LoopExecutorHarness yet); falls back to bundled default.
    this.loop =
      options.loop ?? new LoopExecutorHarness(appId, journal, bus, inbox);

    this.handlerResolver = new InMemoryHandlerResolver();
    if (options.toolHandlers) {
      for (const [ref, handler] of options.toolHandlers) {
        this.handlerResolver.register(ref, handler);
      }
    }
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
    return Promise.all([this.ready, reconcilerReady, loopReady]).then(() => {});
  }

  // ──────── AppHarnessProtocol ────────

  createSession(
    input: CreateSessionInput<P> = {},
  ): Promise<SessionHarnessProtocol<P>> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.createSessionBody(input, /* ephemeral */ false),
        catch: (cause): AppError => mapAppError(cause),
      }),
    );
  }

  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.runOnceBody(input),
        catch: (cause): AppError => mapAppError(cause),
      }),
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
        ...(entry.lastActiveAt !== undefined
          ? { lastActiveAt: entry.lastActiveAt }
          : {}),
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
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.closeAppBody(),
        catch: (cause): AppError => mapAppError(cause),
      }),
    );
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
            verdict.reason
              ? `session create vetoed: ${verdict.reason}`
              : "session create vetoed",
          ),
        } as AppError;
      }
    }

    const sessionId = input.sessionId ?? `session:${ulid()}`;
    if (this.registry.has(sessionId)) {
      throw { _tag: "SessionAlreadyExistsError", sessionId } as AppError;
    }

    // Per-session tool executor. The `handlerResolver` is owned by the
    // App (shared); the rest of the options cascade from per-app
    // `tools` defaults. (Per-call tools overrides arrive in a follow-up
    // when `CreateSessionInput` grows a `tools` slot.)
    const tools = new ToolExecutorHarness(
      sessionId,
      this.journal,
      this.bus,
      this.inbox,
      {
        ...this.toolDefaults,
        handlerResolver: this.handlerResolver,
      },
    );

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
      defaultMaxTicks:
        input.maxTicks ?? this.sessionDefaults.defaultMaxTicks ?? 8,
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
      ...(overrides.parentSessionId !== undefined
        ? { parentSessionId: overrides.parentSessionId }
        : {}),
    });

    await Promise.all([tools.ready, session.ready]);
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
  async createChildSession(
    input: SpawnContextChildInput<P>,
  ): Promise<SessionHarnessProtocol<P>> {
    const createInput: CreateSessionInput<P> = {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.initialProps !== undefined
        ? { initialProps: input.initialProps }
        : {}),
      ...(input.initialKnobs !== undefined
        ? { initialKnobs: input.initialKnobs }
        : {}),
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
      ...(input.initialProps !== undefined
        ? { initialProps: input.initialProps }
        : {}),
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
    await Promise.allSettled([
      closeOf(this.reconciler),
      closeOf(this.loop),
    ]);
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
      await entry.tools.close();
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
function makeBusAsyncIterator(
  bus: EventBus,
  query: EventQuery,
): AsyncIterator<ProtocolEvent> {
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
 * `ReconcilerProtocol` instances expose a `mount()` method;
 * `ReconcilerHarnessOptions` is a plain options object that doesn't.
 * Duck-type to discriminate.
 */
function isReconcilerInstance(v: unknown): v is ReconcilerProtocol {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { mount?: unknown }).mount === "function"
  );
}

function resolveReconciler(
  slot: ReconcilerProtocol | ReconcilerHarnessOptions | undefined,
  scopeId: string,
  journal: OperationJournal,
  bus: EventBus,
  inbox: MessageInbox,
): ReconcilerProtocol {
  if (slot && isReconcilerInstance(slot)) return slot;
  const opts = (slot as ReconcilerHarnessOptions | undefined) ?? {};
  return new ReconcilerHarness(scopeId, journal, bus, inbox, opts);
}

/**
 * Collapse the App-level session-defaults cascade into a single
 * `SessionDefaults`. Longhand (`options.session.*`) wins over the
 * top-level convenience shortcuts; conflicts resolve like CSS
 * shorthand-vs-longhand.
 */
function mergeSessionDefaults<P>(
  options: AppHarnessOptions<P>,
): SessionDefaults<P> {
  const fromLong = options.session ?? {};
  const merged: Record<string, unknown> = { ...fromLong };
  if (
    fromLong.defaultMaxTicks === undefined &&
    options.defaultMaxTicks !== undefined
  ) {
    merged.defaultMaxTicks = options.defaultMaxTicks;
  }
  if (
    fromLong.props === undefined &&
    options.initialProps !== undefined
  ) {
    merged.props = options.initialProps;
  }
  if (
    fromLong.initialKnobs === undefined &&
    options.initialKnobs !== undefined
  ) {
    merged.initialKnobs = options.initialKnobs;
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
