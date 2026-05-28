/**
 * AppHarnessProtocol — the outermost runtime boundary.
 *
 * The app harness owns the **agent definition** (the JSX root element,
 * shared defaults), the **session registry**, and the **shared substrate
 * + shared sub-harnesses** (reconciler, loop executor, language-model
 * executor). Each session it creates is a `SessionHarnessProtocol`
 * instance bound to the same substrate, with its own scopeId.
 *
 * **MVP shape — 4f.** The blueprint specifies a richer protocol
 * (`use()` integrations, `events()` cross-session bus subscription,
 * persistence Layer, telemetry Layer, multi-tenant filtering, cluster
 * mode). Those land in follow-ups without breaking the 4f contract.
 *
 * Methods follow the harness convention: Promise-typed surface at the
 * boundary, Effect-driven internals via `runHarnessProtocol`.
 *
 * `[V1-REPLACED]` — v1's `Agentick` instance + `App` class
 * (`packages/core/src/app/app.ts`, `packages/core/src/agentick-instance.ts`).
 *
 * @see docs/proposals/v2/blueprint/09-app-harness.md
 */

import type { Layer } from "effect";
import type { EventQuery, ProtocolEvent } from "../data/events.js";
import type { SessionStatus } from "./hook-bridges.js";
import type { ExecutorFactory, ExecutorProtocol, LanguageModelExecutor } from "./executor.js";
import type {
  SendInput,
  SendResult,
  SessionExecutionHandle,
  SessionHarnessProtocol,
} from "./session-harness.js";

// ============================================================================
// Command inputs / outputs
// ============================================================================

export interface CreateSessionInput<P = unknown> {
  /**
   * Stable session id. Generated if omitted. Caller-supplied ids must
   * be unique within the app — duplicate ids reject with
   * `SessionAlreadyExistsError`.
   */
  readonly sessionId?: string;
  /** Optional caller metadata stored on the registry entry. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Initial component props injected into the agent root element. */
  readonly initialProps?: P;
  /** Initial knob values copied into the session's knob bridge. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /** Override the app-level default `maxTicks` for this session. */
  readonly maxTicks?: number;
  /**
   * Session-level streaming default. Overridden per-call by
   * `SendInput.stream`. Falls through to the app default + executor
   * capability default when unset.
   */
  readonly streaming?: boolean;
}

export interface RunOnceInput<P = unknown> {
  /** What to send to the ephemeral session. */
  readonly send: SendInput<P>;
  /**
   * Initial component props for the ephemeral session. Merges with
   * (and overrides) the app-level `initialProps`.
   */
  readonly initialProps?: P;
  /** Optional metadata applied to the ephemeral registry entry. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * If supplied, the ephemeral session is registered with this id; the
   * default behavior generates one. Useful when the caller needs to
   * observe events by sessionId before the result resolves.
   */
  readonly sessionId?: string;
  /** Override the app-level default `maxTicks`. */
  readonly maxTicks?: number;
}

export interface RunOnceResult {
  readonly result: SendResult;
  /** The ephemeral session id used for this run. */
  readonly sessionId: string;
}

// ============================================================================
// Session registry types
// ============================================================================

export interface SessionEntry {
  readonly id: string;
  readonly status: SessionStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly lastActiveAt?: number;
}

export type SessionListEntry = SessionEntry;

export interface SessionFilter {
  readonly status?: SessionStatus | ReadonlyArray<SessionStatus>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Telemetry Layer slot (4f.7 placeholder)
// ============================================================================

/**
 * Optional Effect `Layer` provided to `AppHarnessOptions.telemetry`.
 * When set, app-level commands should run inside this Layer's runtime
 * so the substrate's `Effect.withSpan` annotations + future
 * `Effect.Metric` registrations flow to the configured exporter
 * (OpenTelemetry SDK, custom backend, etc.).
 *
 * Slot is defined now so adopters can pass a Layer through a stable
 * API. **Actual Layer-application requires the AppHarness runtime
 * refactor (deferred)** — passing a Layer today is accepted and
 * stored, but its services aren't applied to running commands yet.
 *
 * `[V1-INHERITED]` shape from v1's `AppOptions.telemetry`.
 */
export type TelemetryLayer = Layer.Layer<never, never, never>;

// Persistence: currently expressed via the existing
// `AppHarnessOptions.journal` slot — supply a durable
// `OperationJournal` impl (e.g., `SqlitePersistenceJournal` once
// shipped) and operational state persists. **Session-state
// persistence** (timeline durability, knob restore, hibernate/restore)
// arrives as a separate slot when the SessionStore protocols land.

// ============================================================================
// Errors
// ============================================================================

export type AppError =
  | { readonly _tag: "SessionAlreadyExistsError"; readonly sessionId: string }
  | { readonly _tag: "SessionNotFoundError"; readonly sessionId: string }
  | { readonly _tag: "AppClosedError" }
  | { readonly _tag: "AppExecutionFailed"; readonly cause: unknown };

// ============================================================================
// AppHarnessProtocol
//
// Note: construction options (`AppHarnessOptions`) carry the JSX root
// element and React-specific defaults and live in the implementation
// package (`@agentick/app`). The spec stays React-agnostic.
// ============================================================================

/**
 * The user-facing app surface. Implementations are expected to extend
 * `BaseHarness<"app">` for the substrate phase contract; the methods
 * below are Promise-typed at the boundary and run on the substrate via
 * `runHarnessProtocol`.
 */
export interface AppHarnessProtocol<P = unknown> {
  /**
   * Create a fresh session. The session mounts the configured agent
   * JSX into the shared reconciler, registers itself in the app's
   * session registry, and is ready to accept `send` calls.
   *
   * @throws {AppError} `SessionAlreadyExistsError` if `sessionId`
   *   collides with an existing session; `AppClosedError` if the app
   *   is shutting down.
   */
  createSession(input?: CreateSessionInput<P>): Promise<SessionHarnessProtocol<P>>;

  /**
   * Convenience: create an ephemeral session, run one `send`, and close
   * the session when the result resolves. Returns the final
   * `SendResult` along with the (now-closed) session id.
   *
   * The session is registered for the duration of the call; observers
   * subscribed to `app.events({ scope: { sessionId } })` see its
   * envelopes. After `runOnce` resolves, the registry entry is removed.
   */
  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult>;

  /**
   * Look up a session by id. Returns `undefined` if no session with
   * that id is currently registered (includes closed-and-removed
   * sessions).
   */
  getSession(sessionId: string): SessionHarnessProtocol<P> | undefined;

  /**
   * Enumerate the session registry. Filters apply in-process (no
   * substrate round-trip).
   */
  listSessions(filter?: SessionFilter): readonly SessionListEntry[];

  /**
   * Cross-session event subscription. Returns an `AsyncIterable` over
   * `ProtocolEvent` envelopes matching the filter. Every event from
   * every session, sub-harness, and the app itself flows through —
   * filter via the `EventQuery` (by surface, name prefix, phase,
   * outcome, or scope.sessionId).
   *
   * The iterable is *live* — it yields envelopes published AFTER the
   * subscription opens. Use the journal (or future replay APIs) for
   * historical reads.
   *
   * Multiple subscribers are independent (the substrate bus is
   * multi-subscriber by design). Breaking out of the `for await`
   * cleanly unsubscribes.
   */
  events(filter?: EventQuery): AsyncIterable<ProtocolEvent>;

  /**
   * Close every open session, release shared resources (reconciler
   * mounts, loop-executor in-flight aborts, executor abort signals),
   * and emit `app:lifecycle:closed`. Subsequent calls reject with
   * `AppClosedError`.
   */
  closeApp(): Promise<void>;

  // ──────────────────────────────────────────────────────────────────
  // App-level extensibility (block 5 — α design)
  //
  // - `app.use(middleware)` is inherited from BaseHarness. Wraps app
  //   commands that go through `runOperation`. Note: createSession /
  //   runOnce / closeApp do NOT route through runOperation today, so
  //   middleware on those is registered but silently no-op until those
  //   commands are refactored. Lifecycle hooks below are functional.
  // - `app.events(filter)` (already on the protocol) is the observer
  //   surface — async-iterable subscription. No separate observers
  //   namespace; use `app.events()` directly.
  // - `app.services` is a simple key/value registry for app-level
  //   singletons (renderer registries, telemetry exporters, custom
  //   integrations). Sessions and tools look them up by token.
  // - Lifecycle hooks (`onSessionCreate` / `onSessionClose` /
  //   `onAppClose`) attach handlers that fire at the named boundary.
  //   Handlers can return `HandlerVerdict` (veto/replace/defer/proceed)
  //   to influence behavior.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Service registry — store and retrieve app-level singletons by
   * string token. Sessions and tools can read these as ambient
   * capabilities (telemetry exporters, custom registries, etc.).
   */
  readonly services: ServiceRegistry;

  /**
   * Register a handler that fires before a new session is created.
   * Handler can return a `HandlerVerdict` to veto (refuse the session)
   * or replace (substitute a pre-built session). Multiple handlers
   * compose per `mergeVerdict`.
   */
  onSessionCreate(
    handler: (
      input: CreateSessionInput<P>,
    ) => Promise<{ readonly kind: "veto"; readonly reason?: string } | void>,
  ): () => void;

  /**
   * Register a handler that fires when a session closes (via
   * `closeApp` or auto-dispose from `runOnce`). Handler is informational
   * — return value is ignored. Use for cleanup / analytics flush.
   */
  onSessionClose(
    handler: (info: {
      readonly sessionId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void> | void,
  ): () => void;

  /**
   * Register a handler that fires when `closeApp` is called, before
   * sessions are torn down. Informational — return value is ignored.
   */
  onAppClose(handler: () => Promise<void> | void): () => void;
}

/**
 * Key/value service registry. Type-safe via the caller's annotation
 * at lookup time — `app.services.get<MyService>("token")`.
 */
export interface ServiceRegistry {
  register<T>(token: string, instance: T): () => void;
  get<T>(token: string): T | undefined;
  has(token: string): boolean;
}

// Re-export the executor types so consumers of @agentick/spec can
// satisfy AppHarnessOptions without reaching into other entrypoints.
export type { ExecutorFactory, ExecutorProtocol, LanguageModelExecutor };
export type { SendInput, SendResult, SessionExecutionHandle, SessionHarnessProtocol };
