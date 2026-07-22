/**
 * Lifecycle-tier error classes — app, gateway, session, state-apply.
 *
 * Migrated from POJO `_tag` unions to the `AgentickError` class
 * hierarchy per ADR 41 (cluster 2). Each tier has an abstract
 * intermediate (`AppError`, `GatewayError`, `SessionError`) plus
 * concrete subclasses. `StateApplyError` is a TYPE union only — its
 * `SessionClosedError` member belongs to the `SessionError` hierarchy,
 * and TS classes can't extend two abstract parents.
 *
 * Naming note: the `SessionError` variant whose wire tag used to be
 * `"TimelineError"` is renamed to `"SessionTimelineError"` to remove
 * a runtime-namespace collision with the planned `TimelineError`
 * abstract class (execution cluster). Pre-1.0 wire change is
 * acceptable; the old tag had no on-wire users.
 */

import { AgentickError } from "./base.js";
import { registerAgentickError } from "./registry.js";

// ============================================================================
// AppError — app-level construction + lifecycle failures
// ============================================================================

export abstract class AppError extends AgentickError {}

// `SessionAlreadyExistsError` was removed with ADR 49's idempotent
// open-or-rehydrate: `createSession({ sessionId })` with a live id
// returns the existing session instead of throwing.

export class SessionNotFoundError extends AppError {
  readonly _tag = "SessionNotFoundError" as const;
  readonly sessionId: string;
  constructor(args: { readonly sessionId: string; readonly cause?: unknown }) {
    super(`session ${args.sessionId} not found`, { cause: args.cause });
    this.sessionId = args.sessionId;
  }
}
registerAgentickError("SessionNotFoundError", SessionNotFoundError);

export class AppClosedError extends AppError {
  readonly _tag = "AppClosedError" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(`app is closed`, { cause: args?.cause });
  }
}
registerAgentickError("AppClosedError", AppClosedError);

export class AppExecutionFailed extends AppError {
  readonly _tag = "AppExecutionFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`app execution failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("AppExecutionFailed", AppExecutionFailed);

export type AppErrorChannel = SessionNotFoundError | AppClosedError | AppExecutionFailed;

// ============================================================================
// GatewayError — gateway-level lifecycle failures
// ============================================================================

export abstract class GatewayError extends AgentickError {}

export class GatewayClosedError extends GatewayError {
  readonly _tag = "GatewayClosedError" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(`gateway is closed`, { cause: args?.cause });
  }
}
registerAgentickError("GatewayClosedError", GatewayClosedError);

/**
 * `createApp` (or any app-hosting call) was reached before the gateway was
 * started. ADR 84 §1 makes `listen()` REQUIRED: the gateway must be started
 * before it hosts apps, so the `gateway:start` seam is guaranteed to fire.
 * Thrown as a pre-gate in `createApp`, BEFORE the `gateway:create-app` op, so
 * `onBeforeGatewayCreateApp` never fires on the not-started path.
 */
export class GatewayNotStartedError extends GatewayError {
  readonly _tag = "GatewayNotStartedError" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super("Gateway not started — call `await gateway.listen()` before createApp().", {
      cause: args?.cause,
    });
  }
}
registerAgentickError("GatewayNotStartedError", GatewayNotStartedError);

export class AppAlreadyExistsError extends GatewayError {
  readonly _tag = "AppAlreadyExistsError" as const;
  readonly appId: string;
  constructor(args: { readonly appId: string; readonly cause?: unknown }) {
    super(`app ${args.appId} already exists`, { cause: args.cause });
    this.appId = args.appId;
  }
}
registerAgentickError("AppAlreadyExistsError", AppAlreadyExistsError);

export class AppNotFoundError extends GatewayError {
  readonly _tag = "AppNotFoundError" as const;
  readonly appId: string;
  constructor(args: { readonly appId: string; readonly cause?: unknown }) {
    super(`app ${args.appId} not found`, { cause: args.cause });
    this.appId = args.appId;
  }
}
registerAgentickError("AppNotFoundError", AppNotFoundError);

export class GatewayLifecycleError extends GatewayError {
  readonly _tag = "GatewayLifecycleError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`gateway lifecycle error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("GatewayLifecycleError", GatewayLifecycleError);

/**
 * A gateway extension tried to claim a `GatewayBridges` namespace already
 * held by another (ADR 50). Gateway bridges are hard singletons — no outer
 * scope to override, so a duplicate is a collision, not a last-writer-wins
 * override (contrast the app-side `extensionBridges`). Thrown from
 * `GatewayInstaller.registerNamespace`; propagates through `gatewayReady`.
 */
export class GatewayBridgeSlotOccupied extends GatewayError {
  readonly _tag = "GatewayBridgeSlotOccupied" as const;
  readonly slot: string;
  constructor(args: { readonly slot: string; readonly cause?: unknown }) {
    super(
      `GatewayBridges slot "${args.slot}" already occupied — gateway namespaces are hard singletons (ADR 50).`,
      { cause: args.cause },
    );
    this.slot = args.slot;
  }
}
registerAgentickError("GatewayBridgeSlotOccupied", GatewayBridgeSlotOccupied);

export type GatewayErrorChannel =
  | GatewayClosedError
  | GatewayNotStartedError
  | AppAlreadyExistsError
  | AppNotFoundError
  | GatewayLifecycleError
  | GatewayBridgeSlotOccupied;

// ============================================================================
// SessionError — session-level command + state failures
// ============================================================================

export abstract class SessionError extends AgentickError {}

export class SessionClosedError extends SessionError {
  readonly _tag = "SessionClosedError" as const;
  readonly attemptedCommand: string;
  constructor(args: { readonly attemptedCommand: string; readonly cause?: unknown }) {
    super(`session closed; cannot ${args.attemptedCommand}`, { cause: args.cause });
    this.attemptedCommand = args.attemptedCommand;
  }
}
registerAgentickError("SessionClosedError", SessionClosedError);

export class SessionBusyError extends SessionError {
  readonly _tag = "SessionBusyError" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`session busy: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("SessionBusyError", SessionBusyError);

/**
 * Wire tag renamed from `"TimelineError"` → `"SessionTimelineError"`
 * to remove a namespace collision with the `TimelineError` abstract
 * class from the execution cluster. Pre-1.0; no on-wire consumers.
 */
export class SessionTimelineError extends SessionError {
  readonly _tag = "SessionTimelineError" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`session timeline error: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("SessionTimelineError", SessionTimelineError);

export class KnobError extends SessionError {
  readonly _tag = "KnobError" as const;
  readonly knob: string;
  readonly reason: string;
  constructor(args: { readonly knob: string; readonly reason: string; readonly cause?: unknown }) {
    super(`knob ${args.knob}: ${args.reason}`, { cause: args.cause });
    this.knob = args.knob;
    this.reason = args.reason;
  }
}
registerAgentickError("KnobError", KnobError);

export class ChannelError extends SessionError {
  readonly _tag = "ChannelError" as const;
  readonly channel: string;
  readonly reason: string;
  constructor(args: {
    readonly channel: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`channel ${args.channel}: ${args.reason}`, { cause: args.cause });
    this.channel = args.channel;
    this.reason = args.reason;
  }
}
registerAgentickError("ChannelError", ChannelError);

export class ExecutionFailed extends SessionError {
  readonly _tag = "ExecutionFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`session execution failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("ExecutionFailed", ExecutionFailed);

/**
 * `session.model.setModel` received a bare `LanguageModelAdapter`, but the
 * session was constructed WITHOUT a `buildModelExecutor` closure — so it has
 * no way to wrap the adapter in an executor (the adapter→executor build needs
 * the app's substrate, which the adapter-agnostic session never imports). This
 * is the BYO-executor path: an app that supplied its own `modelExecutor`
 * (rather than a `model` adapter) injects no builder, so a runtime adapter swap
 * has nothing to build with. Pass a `RegisteredModel` (`{ modelExecutor,
 * target }`) instead.
 *
 * Thrown synchronously by the facade BEFORE the `session:set-model` command —
 * it never reaches the command's Effect channel, so it is not a member of
 * {@link SessionErrorChannel}.
 */
export class ModelExecutorBuilderMissingError extends SessionError {
  readonly _tag = "ModelExecutorBuilderMissingError" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(
      "session.model.setModel: a LanguageModelAdapter was passed, but this " +
        "session has no injected model-executor builder (BYO-executor app). " +
        "Pass a RegisteredModel ({ modelExecutor, target }) instead.",
      { cause: args?.cause },
    );
  }
}
registerAgentickError("ModelExecutorBuilderMissingError", ModelExecutorBuilderMissingError);

export type SessionErrorChannel =
  | SessionClosedError
  | SessionBusyError
  | SessionTimelineError
  | KnobError
  | ChannelError
  | ExecutionFailed;

// ============================================================================
// StateApplyError — state-restore failures (composite union)
// ============================================================================

/**
 * `StateApplyError` is a TYPE union over classes from multiple
 * hierarchies (`TimelineWriteFailed` is its own concrete; the
 * `SessionClosedError` variant is shared with `SessionError`). No
 * abstract class — TS can't extend two abstract parents, and the
 * shared `SessionClosedError` belongs naturally to `SessionError`.
 */
export class TimelineWriteFailed extends AgentickError {
  readonly _tag = "TimelineWriteFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`timeline write failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("TimelineWriteFailed", TimelineWriteFailed);

export type StateApplyError = TimelineWriteFailed | SessionClosedError;
export type StateApplyErrorChannel = StateApplyError;
