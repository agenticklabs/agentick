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

import type { SessionStatus } from "./hook-bridges.js";
import type { ExecutorProtocol, LanguageModelExecutor } from "./executor.js";
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
   * Close every open session, release shared resources (reconciler
   * mounts, loop-executor in-flight aborts, executor abort signals),
   * and emit `app:lifecycle:closed`. Subsequent calls reject with
   * `AppClosedError`.
   */
  closeApp(): Promise<void>;
}

// Re-export the executor types so consumers of @agentick/spec can
// satisfy AppHarnessOptions without reaching into other entrypoints.
export type { ExecutorProtocol, LanguageModelExecutor };
export type { SendInput, SendResult, SessionExecutionHandle, SessionHarnessProtocol };
