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

import { Effect } from "effect";

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
import type {
  AppError,
  AppHarnessProtocol,
  CreateSessionInput,
  EventBus,
  ExecutionTarget,
  HandlerVerdict,
  LanguageModelExecutor,
  LoopExecutorProtocol,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ReconcilerProtocol,
  RunOnceInput,
  RunOnceResult,
  SendResult,
  SessionEntry,
  SessionFilter,
  SessionHarnessProtocol,
  SessionListEntry,
  SessionStatus,
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
   * Language-model executor shared across sessions. Provider adapters
   * (`OpenAIExecutor`, `AnthropicExecutor`, ...) are session-agnostic
   * by design — they hold a client + abort registry keyed by
   * executionId, not sessionId.
   */
  readonly executor: LanguageModelExecutor;
  /** Default execution target carried to every `loop.runExecution`. */
  readonly target: ExecutionTarget;

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
   */
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
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
  lastActiveAt?: number;
  ephemeral: boolean;
}

// ============================================================================
// AppHarness
// ============================================================================

export class AppHarness<P = unknown>
  extends BaseHarness<"app">
  implements AppHarnessProtocol<P>
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

  constructor(options: AppHarnessOptions<P>) {
    const appId = options.appId ?? `app:${ulid()}`;
    const journal = options.journal ?? new MemoryJournal({ capacity: 10_000 });
    const bus = options.bus ?? new LocalEventBus();
    const inbox = options.inbox ?? new LocalInbox();

    super("app", appId, journal, bus, inbox);

    this.rootElement = options.rootElement;
    this.executor = options.executor;
    this.target = options.target;

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

  closeApp(): Promise<void> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.closeAppBody(),
        catch: (cause): AppError => mapAppError(cause),
      }),
    );
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
  ): Promise<SessionHarnessProtocol<P>> {
    this.assertOpen();
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
      agent: this.rootElement,
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
    };
    this.registry.set(sessionId, entry);
    return session;
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

// Re-export the SessionEntry shape for ergonomic imports.
export type { SessionEntry };
