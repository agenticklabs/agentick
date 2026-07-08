/**
 * Final cluster of error classes — the ones that lived outside the
 * main spec union surface:
 *
 *   - `UnknownTaskError`         (tasks-harness; single-tag)
 *   - `ChannelPublishError`      (channels; 2 concretes)
 *   - `SandboxError`             (sandbox; 8 concretes — these classes
 *                                 mirror what previously lived in
 *                                 `@agentick/sandbox-next/errors`)
 *   - `McpClientError`           (mcp client; 2 concretes — these
 *                                 mirror what previously lived in
 *                                 `@agentick/mcp-next/client/harness`)
 *   - `McpRemoteTaskNonCompletedError` (mcp integration; single-tag)
 *
 * Co-located here (rather than in their host packages) so the
 * `AgentickError` registry stays the single source of truth for every
 * typed error in v2. The host packages re-export.
 */

import { AgentickError } from "./base.js";
import { registerAgentickError } from "./registry.js";

// ============================================================================
// UnknownTaskError — TasksHarness "task not found by id"
// ============================================================================

export class UnknownTaskError extends AgentickError {
  readonly _tag = "UnknownTaskError" as const;
  readonly taskId: string;
  constructor(args: { readonly taskId: string; readonly cause?: unknown }) {
    super(`unknown task: ${args.taskId}`, { cause: args.cause });
    this.taskId = args.taskId;
  }
}
registerAgentickError("UnknownTaskError", UnknownTaskError);

// ============================================================================
// UnknownTaskExecutorError — submit named an unregistered executor kind
// ============================================================================

/**
 * Thrown by `TasksHarness.submit` when `opts.executorKind` names a
 * {@link TaskExecutor} that isn't in this harness's registry (ADR 68
 * Build B). Mirrors {@link UnknownTaskError} — developer misuse (typo,
 * or an executor the app didn't inject), not a task outcome. Also the
 * signal at hydration that a stored record's `executorKind` isn't loaded
 * in this process (that path treats the record as non-reattachable →
 * `interrupted` rather than throwing).
 */
export class UnknownTaskExecutorError extends AgentickError {
  readonly _tag = "UnknownTaskExecutorError" as const;
  readonly kind: string;
  constructor(args: { readonly kind: string; readonly cause?: unknown }) {
    super(`unknown task executor: ${args.kind}`, { cause: args.cause });
    this.kind = args.kind;
  }
}
registerAgentickError("UnknownTaskExecutorError", UnknownTaskExecutorError);

// ============================================================================
// TaskHandlerRefRequiredError — by-ref executor submit without a handlerRef
// ============================================================================

/**
 * Thrown by `TasksHarness.submit` when a task is routed to a by-ref
 * executor (`TaskExecutor.byRef === true`, e.g. `"child-process"`) but no
 * `handlerRef` was supplied (ADR 68 Build B). A by-ref executor resolves
 * the work from a handler registry on the far side — a closure can't
 * cross the process boundary — so the reference is mandatory. Developer
 * misuse, caught at `submit` before anything is persisted / forked.
 */
export class TaskHandlerRefRequiredError extends AgentickError {
  readonly _tag = "TaskHandlerRefRequiredError" as const;
  readonly kind: string;
  constructor(args: { readonly kind: string; readonly cause?: unknown }) {
    super(`task executor "${args.kind}" is by-ref and requires a handlerRef`, {
      cause: args.cause,
    });
    this.kind = args.kind;
  }
}
registerAgentickError("TaskHandlerRefRequiredError", TaskHandlerRefRequiredError);

// ============================================================================
// ChannelPublishError — channel publisher failures
// ============================================================================

export abstract class ChannelPublishError extends AgentickError {
  abstract override readonly _tag: "ChannelPublisherClosed" | "ChannelSequenceOverflow";
}

export class ChannelPublisherClosed extends ChannelPublishError {
  readonly _tag = "ChannelPublisherClosed" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(`channel publisher closed`, { cause: args?.cause });
  }
}
registerAgentickError("ChannelPublisherClosed", ChannelPublisherClosed);

export class ChannelSequenceOverflow extends ChannelPublishError {
  readonly _tag = "ChannelSequenceOverflow" as const;
  readonly channel: string;
  constructor(args: { readonly channel: string; readonly cause?: unknown }) {
    super(`channel ${args.channel} sequence overflow`, { cause: args.cause });
    this.channel = args.channel;
  }
}
registerAgentickError("ChannelSequenceOverflow", ChannelSequenceOverflow);

export type ChannelPublishErrorChannel = ChannelPublisherClosed | ChannelSequenceOverflow;

// ============================================================================
// SandboxError — sandbox harness failures
// ============================================================================

export abstract class SandboxError extends AgentickError {
  abstract override readonly _tag:
    | "SandboxExecError"
    | "SandboxIoError"
    | "SandboxMountError"
    | "SandboxEscapeError"
    | "SandboxResourceLimitError"
    | "SandboxPermissionDeniedError"
    | "SandboxConnectionError"
    | "SandboxUnsupportedError";
}

export class SandboxExecError extends SandboxError {
  readonly _tag = "SandboxExecError" as const;
  readonly command: string;
  readonly exitCode: number;
  readonly signal?: string;
  readonly stderr?: string;
  override readonly cause?: unknown;
  constructor(args: {
    readonly command: string;
    readonly exitCode: number;
    readonly signal?: string;
    readonly stderr?: string;
    readonly cause?: unknown;
  }) {
    super(`sandbox exec failed: ${args.command} (exit=${args.exitCode})`, { cause: args.cause });
    this.command = args.command;
    this.exitCode = args.exitCode;
    if (args.signal !== undefined) this.signal = args.signal;
    if (args.stderr !== undefined) this.stderr = args.stderr;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxExecError", SandboxExecError);

export class SandboxIoError extends SandboxError {
  readonly _tag = "SandboxIoError" as const;
  readonly path: string;
  readonly op: "read" | "write" | "edit";
  readonly reason: string;
  override readonly cause?: unknown;
  constructor(args: {
    readonly path: string;
    readonly op: "read" | "write" | "edit";
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`sandbox ${args.op} failed at ${args.path}: ${args.reason}`, { cause: args.cause });
    this.path = args.path;
    this.op = args.op;
    this.reason = args.reason;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxIoError", SandboxIoError);

export class SandboxMountError extends SandboxError {
  readonly _tag = "SandboxMountError" as const;
  readonly hostPath?: string;
  readonly sandboxPath?: string;
  readonly reason: string;
  override readonly cause?: unknown;
  constructor(args: {
    readonly hostPath?: string;
    readonly sandboxPath?: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`sandbox mount failed: ${args.reason}`, { cause: args.cause });
    if (args.hostPath !== undefined) this.hostPath = args.hostPath;
    if (args.sandboxPath !== undefined) this.sandboxPath = args.sandboxPath;
    this.reason = args.reason;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxMountError", SandboxMountError);

export class SandboxEscapeError extends SandboxError {
  readonly _tag = "SandboxEscapeError" as const;
  readonly kind: "path-traversal" | "mount-escape" | "command-injection" | (string & {});
  readonly target: string;
  readonly detail?: string;
  constructor(args: {
    readonly kind: "path-traversal" | "mount-escape" | "command-injection" | (string & {});
    readonly target: string;
    readonly detail?: string;
    readonly cause?: unknown;
  }) {
    super(`sandbox escape attempt (${args.kind}): ${args.target}`, { cause: args.cause });
    this.kind = args.kind;
    this.target = args.target;
    if (args.detail !== undefined) this.detail = args.detail;
  }
}
registerAgentickError("SandboxEscapeError", SandboxEscapeError);

export class SandboxResourceLimitError extends SandboxError {
  readonly _tag = "SandboxResourceLimitError" as const;
  readonly kind: "memory" | "cpu" | "disk" | "wallclock" | (string & {});
  readonly observedValue: number;
  readonly limit: number;
  constructor(args: {
    readonly kind: "memory" | "cpu" | "disk" | "wallclock" | (string & {});
    readonly observedValue: number;
    readonly limit: number;
    readonly cause?: unknown;
  }) {
    super(`sandbox ${args.kind} limit exceeded: ${args.observedValue} > ${args.limit}`, {
      cause: args.cause,
    });
    this.kind = args.kind;
    this.observedValue = args.observedValue;
    this.limit = args.limit;
  }
}
registerAgentickError("SandboxResourceLimitError", SandboxResourceLimitError);

export class SandboxPermissionDeniedError extends SandboxError {
  readonly _tag = "SandboxPermissionDeniedError" as const;
  readonly kind: "read" | "write" | "exec" | "mount";
  readonly target: string;
  override readonly cause?: "policy" | "user-denied" | "timeout" | (string & {});
  constructor(args: {
    readonly kind: "read" | "write" | "exec" | "mount";
    readonly target: string;
    readonly cause?: "policy" | "user-denied" | "timeout" | (string & {});
  }) {
    super(
      `sandbox ${args.kind} denied on ${args.target}${args.cause ? `: ${args.cause}` : ""}`,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.kind = args.kind;
    this.target = args.target;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxPermissionDeniedError", SandboxPermissionDeniedError);

export class SandboxConnectionError extends SandboxError {
  readonly _tag = "SandboxConnectionError" as const;
  readonly reason: string;
  override readonly cause?: unknown;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`sandbox connection error: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxConnectionError", SandboxConnectionError);

/**
 * A capability-tiered handle method the provider does not support
 * (e.g. runtime `addMount` on a docker container that can't remount a
 * running container). Providers throw this instead of faking — a
 * fabricated success is worse than an honest "unsupported" (ADR 59).
 */
export class SandboxUnsupportedError extends SandboxError {
  readonly _tag = "SandboxUnsupportedError" as const;
  readonly capability: string;
  override readonly cause?: unknown;
  constructor(args: { readonly capability: string; readonly cause?: unknown }) {
    super(`sandbox capability not supported by provider: ${args.capability}`, {
      cause: args.cause,
    });
    this.capability = args.capability;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("SandboxUnsupportedError", SandboxUnsupportedError);

export type SandboxErrorChannel =
  | SandboxExecError
  | SandboxIoError
  | SandboxMountError
  | SandboxEscapeError
  | SandboxResourceLimitError
  | SandboxPermissionDeniedError
  | SandboxConnectionError
  | SandboxUnsupportedError;

// ============================================================================
// IngressAuthError — trust-boundary authentication failures (ADR 61)
// ============================================================================

/**
 * Authentication failures at the ingress edge (ADR 61). An `AuthSource`
 * throws one of these to REJECT a crossing; the transport edge maps the
 * rejection to its native failure (WS/HTTP 401, connector drop) and
 * NEVER falls through to the local pole (fail-closed invariant).
 */
export abstract class IngressAuthError extends AgentickError {
  abstract override readonly _tag:
    | "IngressAuthRequired"
    | "IngressAuthFailed"
    | "IngressCredentialUnsupported";
}

/** No credential was presented and the AuthSource does not admit anonymous. */
export class IngressAuthRequired extends IngressAuthError {
  readonly _tag = "IngressAuthRequired" as const;
  readonly backend: string;
  constructor(args: { readonly backend: string; readonly cause?: unknown }) {
    super("authentication required: no credential presented", { cause: args.cause });
    this.backend = args.backend;
  }
}
registerAgentickError("IngressAuthRequired", IngressAuthRequired);

/** A credential was presented but the AuthSource rejected it. */
export class IngressAuthFailed extends IngressAuthError {
  readonly _tag = "IngressAuthFailed" as const;
  readonly backend: string;
  /** Machine-readable reason. Never surfaced verbatim to the client. */
  readonly reason: string;
  constructor(args: {
    readonly backend: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`authentication failed: ${args.reason}`, { cause: args.cause });
    this.backend = args.backend;
    this.reason = args.reason;
  }
}
registerAgentickError("IngressAuthFailed", IngressAuthFailed);

/**
 * The AuthSource does not support the presented credential shape — e.g.
 * a `platform` credential handed to the static-token source (that is the
 * federated connector path, ADR 61 slice 2). Fail-closed, not a silent
 * pass-through.
 */
export class IngressCredentialUnsupported extends IngressAuthError {
  readonly _tag = "IngressCredentialUnsupported" as const;
  readonly backend: string;
  readonly credentialKind: string;
  constructor(args: {
    readonly backend: string;
    readonly credentialKind: string;
    readonly cause?: unknown;
  }) {
    super(
      `authentication source "${args.backend}" does not support credential kind "${args.credentialKind}"`,
      { cause: args.cause },
    );
    this.backend = args.backend;
    this.credentialKind = args.credentialKind;
  }
}
registerAgentickError("IngressCredentialUnsupported", IngressCredentialUnsupported);

export type IngressAuthErrorChannel =
  | IngressAuthRequired
  | IngressAuthFailed
  | IngressCredentialUnsupported;

// ============================================================================
// McpClientError — MCP client harness failures
// ============================================================================

export abstract class McpClientError extends AgentickError {
  abstract override readonly _tag:
    | "McpClientNotReadyError"
    | "McpTransportError"
    | "McpCredentialsRequiredError";
}

export class McpClientNotReadyError extends McpClientError {
  readonly _tag = "McpClientNotReadyError" as const;
  readonly state: string;
  readonly serverId: string;
  constructor(args: {
    readonly state: string;
    readonly serverId: string;
    readonly cause?: unknown;
  }) {
    super(`mcp client ${args.serverId} not ready (state=${args.state})`, { cause: args.cause });
    this.state = args.state;
    this.serverId = args.serverId;
  }
}
registerAgentickError("McpClientNotReadyError", McpClientNotReadyError);

export class McpTransportError extends McpClientError {
  readonly _tag = "McpTransportError" as const;
  readonly serverId: string;
  override readonly cause: unknown;
  constructor(args: { readonly serverId: string; readonly cause: unknown }) {
    super(`mcp transport error for ${args.serverId}: ${String(args.cause)}`, { cause: args.cause });
    this.serverId = args.serverId;
    this.cause = args.cause;
  }
}
registerAgentickError("McpTransportError", McpTransportError);

/**
 * Raised when the MCP client needs credentials to connect but the
 * caller opted out of interactive auth (e.g. optimistic `connect()`
 * or `reconnect()` on a server that has no stored tokens or whose
 * tokens have expired and can't be silently refreshed). The harness
 * classifier maps the error's `kind` to a `credentials-missing` /
 * `credentials-expired` connection status.
 *
 * Only `reauthenticate()` connects with the interactive flag, which
 * is the single caller-side path that opens the OAuth dance.
 */
export class McpCredentialsRequiredError extends McpClientError {
  readonly _tag = "McpCredentialsRequiredError" as const;
  readonly serverId: string;
  readonly kind: "missing" | "expired";
  constructor(args: {
    readonly serverId: string;
    readonly kind: "missing" | "expired";
    readonly cause?: unknown;
  }) {
    super(`mcp credentials ${args.kind} for ${args.serverId}`, { cause: args.cause });
    this.serverId = args.serverId;
    this.kind = args.kind;
  }
}
registerAgentickError("McpCredentialsRequiredError", McpCredentialsRequiredError);

export type McpClientErrorChannel =
  | McpClientNotReadyError
  | McpTransportError
  | McpCredentialsRequiredError;

// ============================================================================
// McpRemoteTaskNonCompletedError — task bridge surface
// ============================================================================

/**
 * Raised by the MCP task bridge when a remote task settles in a
 * non-completed status (`failed`/`canceled`/`rejected`). Single-tag —
 * concrete class directly under `AgentickError`.
 */
export class McpRemoteTaskNonCompletedError extends AgentickError {
  readonly _tag = "McpRemoteTaskNonCompletedError" as const;
  readonly taskId: string;
  readonly status: "failed" | "cancelled";
  readonly statusMessage?: string;
  constructor(args: {
    readonly taskId: string;
    readonly status: "failed" | "cancelled";
    readonly statusMessage?: string;
    readonly cause?: unknown;
  }) {
    super(
      `remote mcp task ${args.taskId} settled ${args.status}${args.statusMessage ? `: ${args.statusMessage}` : ""}`,
      { cause: args.cause },
    );
    this.taskId = args.taskId;
    this.status = args.status;
    if (args.statusMessage !== undefined) this.statusMessage = args.statusMessage;
  }
}
registerAgentickError("McpRemoteTaskNonCompletedError", McpRemoteTaskNonCompletedError);

// ============================================================================
// WireExtensionDefinitionError — wire extension validation failures
// ============================================================================

/**
 * Thrown by `defineWireExtension` when the declared extension violates
 * an invariant — namespace mismatch, missing prefix, auth/clusterRoute
 * referencing undeclared methods, etc. Caught at definition time, well
 * before the gateway tries to register the broken extension.
 *
 * Single-tag — concrete class directly under `AgentickError`.
 */
export class WireExtensionDefinitionError extends AgentickError {
  readonly _tag = "WireExtensionDefinitionError" as const;
  readonly extensionName: string;
  constructor(args: { readonly extensionName: string; readonly reason: string }) {
    super(`WireExtension "${args.extensionName}": ${args.reason}`);
    this.extensionName = args.extensionName;
  }
}
registerAgentickError("WireExtensionDefinitionError", WireExtensionDefinitionError);
