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

/**
 * ADR 100 — genesis received `from.entryId` that does not exist in the source
 * session's timeline. Branch genesis fails rather than guessing an anchor.
 */
export class BranchSourceEntryNotFoundError extends AppError {
  readonly _tag = "BranchSourceEntryNotFoundError" as const;
  readonly sessionId: string;
  readonly entryId: string;
  constructor(args: { readonly sessionId: string; readonly entryId: string }) {
    super(`branch source entry ${args.entryId} not found in session ${args.sessionId}`);
    this.sessionId = args.sessionId;
    this.entryId = args.entryId;
  }
}
registerAgentickError("BranchSourceEntryNotFoundError", BranchSourceEntryNotFoundError);

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

/**
 * A verb that had to CREATE a session (the send-on-miss door, session-doors.md
 * §7) could not tell which app should host it: no `appId` was named and the
 * gateway holds anything other than exactly one app. Loud, never a guess — the
 * app decides the recipe, the stores, and the principal rules the session gets.
 */
export class AppAmbiguousError extends GatewayError {
  readonly _tag = "AppAmbiguousError" as const;
  readonly appIds: readonly string[];
  constructor(args: { readonly appIds: readonly string[]; readonly cause?: unknown }) {
    super(
      `cannot resolve an app implicitly — the gateway holds ${args.appIds.length} ` +
        `(${args.appIds.join(", ") || "none"}); name one with \`appId\`.`,
      { cause: args.cause },
    );
    this.appIds = args.appIds;
  }
}
registerAgentickError("AppAmbiguousError", AppAmbiguousError);

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
  | AppAmbiguousError
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

/**
 * A media source that cannot reach any provider — today: a `base64` source
 * whose `data` is a `data:` URI rather than the raw payload. Raised at the
 * SEND door, because past it the block lands on the durable timeline and
 * replays into a provider rejection on every later turn.
 */
export class InvalidMediaSource extends SessionError {
  readonly _tag = "InvalidMediaSource" as const;
  readonly blockIndex: number;
  readonly blockType: string;
  constructor(args: { readonly blockIndex: number; readonly blockType: string }) {
    super(
      `content[${args.blockIndex}] (${args.blockType}): base64 source carries a data: URI — ` +
        `strip the prefix; \`data\` is the raw base64 payload`,
    );
    this.blockIndex = args.blockIndex;
    this.blockType = args.blockType;
  }
}
registerAgentickError("InvalidMediaSource", InvalidMediaSource);

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
 * An execution reached the model-call boundary with NO model resolved. Model
 * apps and sessions are fully legal to construct WITHOUT a model — dispatch,
 * snapshot/restore, and all wire plumbing work model-less. The requirement is
 * enforced at the ONLY place it matters: execution time. When the loop resolves
 * the effective model for a tick — the cascade `per-tick <Model>` > `per-send
 * override` > `session default` — and every tier is empty, THAT execution fails
 * with this error; the app and session stay valid (a later `send` that supplies
 * a model succeeds).
 *
 * Raised by the loop at the per-tick resolution point and surfaced unwrapped to
 * the failing `send`/`run` — it is a member of {@link SessionErrorChannel}.
 */
export class NoModelForExecutionError extends SessionError {
  readonly _tag = "NoModelForExecutionError" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(
      "no model is configured for this execution — the session default, the " +
        "per-send override, and the rendered tree (`<Model>`) all resolved to " +
        "none. Supply a model one of these ways: `createApp({ model })` / " +
        "`createSession({ model })` (or `modelExecutor` for a BYO engine), " +
        "`session.model.setModel(...)`, a per-send `send({ modelExecutor })`, " +
        "or a per-tick `<Model>` in the agent tree.",
      { cause: args?.cause },
    );
  }
}
registerAgentickError("NoModelForExecutionError", NoModelForExecutionError);

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

/**
 * `session.spawn(...)` was refused because the parent's spawn lineage is
 * already at the configured depth ceiling (`createApp({ sessions: {
 * maxSpawnDepth } })`, default 10 — v1 `MAX_SPAWN_DEPTH` parity). A session
 * whose `spawnPath.length` has reached `maxDepth` cannot spawn a deeper
 * child; the bound fails CLOSED, so an agent that recursively spawns itself
 * crashes with a typed error instead of exhausting the stack (SP4).
 *
 * Thrown synchronously by `spawn()` BEFORE the child is constructed — like
 * {@link ModelExecutorBuilderMissingError}, it never reaches an Effect
 * command channel, so it is NOT a member of {@link SessionErrorChannel}.
 */
export class SpawnDepthExceededError extends SessionError {
  readonly _tag = "SpawnDepthExceededError" as const;
  /** The parent's current spawn depth (`spawnPath.length`) — equals `maxDepth`. */
  readonly depth: number;
  /** The configured ceiling (`sessions.maxSpawnDepth`). */
  readonly maxDepth: number;
  constructor(args: {
    readonly depth: number;
    readonly maxDepth: number;
    readonly cause?: unknown;
  }) {
    super(
      `session.spawn: maximum spawn depth (${args.maxDepth}) reached — a session at ` +
        `depth ${args.depth} cannot spawn a deeper child. Raise it via ` +
        `createApp({ sessions: { maxSpawnDepth } }).`,
      { cause: args.cause },
    );
    this.depth = args.depth;
    this.maxDepth = args.maxDepth;
  }
}
registerAgentickError("SpawnDepthExceededError", SpawnDepthExceededError);

export type SessionErrorChannel =
  | SessionClosedError
  | SessionBusyError
  | SessionTimelineError
  | KnobError
  | ChannelError
  | ExecutionFailed
  | NoModelForExecutionError
  | BranchSourceEntryNotFoundError;

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
