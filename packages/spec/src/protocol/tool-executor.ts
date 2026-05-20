/**
 * ToolExecutorProtocol — the contract every tool executor harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/tool-executor` (Phase 4a),
 * which materializes a tool registry from `ToolDeclaration[]` produced
 * by the reconciler harness and invokes handlers resolved via the
 * runtime's handler registry (the spec firewall forbids carrying live
 * function references across protocol boundaries).
 *
 * ## The two doors
 *
 * One harness boundary; two callers. The loop executor (model door)
 * sends `dispatch({ via: "model" })` when the model emits a `tool_use`
 * block. The session harness (host door) sends
 * `dispatch({ via: "dispatch" })` when the host calls
 * `session.dispatch(name, input)`. Same validation, same confirmation,
 * same interceptors — by construction. `via` is observable to
 * middleware so policies can differ if needed.
 *
 * ## Exposure model
 *
 * `ToolDeclaration.exposure` (from `@agentick/spec/data/declarations`)
 * decides which door the tool is reachable from:
 *
 * - `"model"`     reachable when the model emits `tool_use`.
 * - `"dispatch"`  reachable from `session.dispatch(name, input)`.
 * - `"runtime"`   internal use only; not reachable by either door.
 *
 * The harness enforces exposure at dispatch time (the wrong door for a
 * tool throws `ToolPermissionError`).
 *
 * ## Async return discipline
 *
 * Spec uses `Promise<T>` for async return; errors are rejections with
 * values matching `ToolExecutorError`. Implementations using Effect
 * bridge at their protocol boundary.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { ContentBlock } from "../data/content-blocks.js";
import type { ToolDeclaration, ToolExposure } from "../data/declarations.js";
import type { StandardSchemaIssue } from "../data/standard-schema.js";

// ============================================================================
// Common input fragments
// ============================================================================

/**
 * Identity fields shared by every dispatch-scoped operation. `toolCallId`
 * is the stable address of the call (provider's id for the model door, a
 * generated id for the host door); `opId` is caller-supplied idempotency.
 */
export interface ToolCallScopedInput {
  readonly toolCallId: string;
  readonly opId?: string;
  readonly correlationId?: string;
  readonly parentOpId?: string;
}

// ============================================================================
// Dispatch context + I/O
// ============================================================================

/**
 * Routing + caller context attached to every dispatch.
 *
 * `via` is observable to middleware so policy can branch on door without
 * looking at headers / private fields. `use` carries values captured at
 * React render time by the reconciler (see `createTool({ use: () => …})`);
 * the harness simply forwards them to the handler.
 */
export interface DispatchContext {
  /** Which door produced this dispatch. */
  readonly via: "model" | "dispatch";
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  /** Caller-supplied request context (user, requestId, traceparent, …). */
  readonly request?: Readonly<Record<string, unknown>>;
  /**
   * Render-time deps captured by the reconciler harness when the tool
   * was declared via `<Tool use={() => ({…})}>`. Opaque to the harness;
   * passed through to the handler as `deps.use`.
   */
  readonly use?: Readonly<Record<string, unknown>>;
}

export interface DispatchInput extends ToolCallScopedInput {
  /** Tool name (or alias resolved by the registry). */
  readonly name: string;
  /** Validated against the tool's `inputSchema` before the handler runs. */
  readonly input: unknown;
  readonly context: DispatchContext;
  /**
   * Optional client-side cancellation. The harness ALSO honors inbox
   * `abort` messages — `signal` is the in-process shortcut.
   */
  readonly signal?: AbortSignal;
  /**
   * Per-call timeout override (milliseconds). Falls back to
   * `tool.annotations.timeout` if not supplied.
   */
  readonly timeoutMs?: number;
  /**
   * Per-call confirmation-wait timeout override (milliseconds). Only
   * meaningful when the dispatched tool has
   * `annotations.requiresConfirmation === true`. Falls back to
   * `annotations.confirmationTimeoutMs` then to the harness's
   * `defaultConfirmationTimeoutMs` (which defaults to "wait forever").
   */
  readonly confirmationTimeoutMs?: number;
}

/**
 * Successful or vetoed dispatch outcome. Both doors return the same
 * shape — the loop executor wraps into a `ToolResultBlock` for the
 * model; the session host door returns `content` directly.
 *
 * Failed dispatches reject with `ToolExecutorError` (NOT a result with
 * `succeeded: false`). The `succeeded` field is informational for
 * middleware (e.g., metrics that bucket by outcome): the canonical
 * "did this fail" signal is whether the Promise rejected.
 */
export interface DispatchResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly succeeded: boolean;
  readonly content: readonly ContentBlock[];
  /**
   * Who actually ran the handler. Open string — see `ToolExecutor` in
   * `@agentick/spec/data/content-blocks`.
   */
  readonly executedBy?: string;
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly cacheHit?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Abort
// ============================================================================

export interface AbortInput {
  readonly toolCallId: string;
  readonly reason?: string;
}

// ============================================================================
// Registry I/O
// ============================================================================

/**
 * One entry in the tool executor's registry. The actual handler lives
 * in the runtime's handler registry, keyed by `handlerRef` (the spec
 * firewall forbids carrying executable code across protocol
 * boundaries).
 *
 * `useDeps` captures values bound at React render time
 * (`<Tool use={() => …}>`). They are JSON-opaque to the spec — the
 * harness forwards them to the handler as `deps.use` at dispatch time.
 */
export interface ToolRegistration {
  readonly declaration: ToolDeclaration;
  /**
   * Identifier resolved by the runtime to the concrete handler. The
   * spec firewall forbids the spec from carrying executable code.
   */
  readonly handlerRef: string;
  /**
   * Render-time `use:` deps. Opaque values forwarded to the handler.
   */
  readonly useDeps?: Readonly<Record<string, unknown>>;
}

export interface RegisterToolInput {
  readonly registration: ToolRegistration;
  readonly opId?: string;
}

export interface UnregisterToolInput {
  readonly name: string;
  readonly opId?: string;
}

export interface ToolListFilter {
  readonly exposure?: ToolExposure;
  readonly intent?: "render" | "action" | "compute";
  readonly nameMatches?: string;
}

// ============================================================================
// Confirmation flow
// ============================================================================

/**
 * `[V1-INHERITED]` Outbound confirmation request emitted by the harness
 * when a tool with `annotations.requiresConfirmation` is about to run.
 * Delivered to the host via the framework channel
 * `session:tool_confirmation`; the host's response is routed back
 * through the harness's inbox.
 */
export interface ToolConfirmationRequest {
  readonly toolUseId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly message?: string;
  /** May carry `DiffPreviewMetadata` and similar UI hints. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * `[V1-INHERITED]` Inbound response from the host resolving a pending
 * confirmation. `always: true` is a session-scoped allow-list the
 * harness remembers; `modifiedArguments` triggers a re-validation pass
 * before the handler runs.
 */
export interface ToolConfirmationResponse {
  readonly toolUseId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly always?: boolean;
  readonly modifiedArguments?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Lifecycle events
// ============================================================================

/**
 * Tagged-union of lifecycle events the tool executor dispatches.
 *
 * **Open-ended.** New kinds may be added without changing the protocol
 * method count. Implementations dispatch on `event.kind`; unknown kinds
 * SHOULD be forwarded to any `LifecycleCustom`-style handler registered
 * for them and otherwise produce an `info`-severity diagnostic.
 */
export type ToolLifecycleEvent =
  | ToolDispatchRequested
  | ToolValidationFailed
  | ToolConfirmationRequested
  | ToolConfirmationResolved
  | ToolHandlerStarted
  | ToolHandlerCompleted
  | ToolHandlerErrored
  | ToolDispatchTerminal
  | ToolDispatchAborted;

export interface ToolDispatchRequested {
  readonly kind: "tool-dispatch-requested";
  readonly toolCallId: string;
  readonly name: string;
  readonly via: DispatchContext["via"];
  readonly executionId?: string;
  readonly tickId?: string;
}

export interface ToolValidationFailed {
  readonly kind: "tool-validation-failed";
  readonly toolCallId: string;
  readonly name: string;
  readonly issues: readonly StandardSchemaIssue[];
}

export interface ToolConfirmationRequested {
  readonly kind: "tool-confirmation-requested";
  readonly toolCallId: string;
  readonly request: ToolConfirmationRequest;
}

export interface ToolConfirmationResolved {
  readonly kind: "tool-confirmation-resolved";
  readonly toolCallId: string;
  readonly response: ToolConfirmationResponse;
}

export interface ToolHandlerStarted {
  readonly kind: "tool-handler-started";
  readonly toolCallId: string;
  readonly name: string;
}

export interface ToolHandlerCompleted {
  readonly kind: "tool-handler-completed";
  readonly toolCallId: string;
  readonly name: string;
  readonly durationMs: number;
}

export interface ToolHandlerErrored {
  readonly kind: "tool-handler-errored";
  readonly toolCallId: string;
  readonly name: string;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface ToolDispatchTerminal {
  readonly kind: "tool-dispatch-terminal";
  readonly toolCallId: string;
  readonly name: string;
  readonly outcome: "succeeded" | "failed" | "vetoed" | "aborted";
  readonly durationMs: number;
}

export interface ToolDispatchAborted {
  readonly kind: "tool-dispatch-aborted";
  readonly toolCallId: string;
  readonly reason?: string;
}

// ============================================================================
// Error taxonomy
// ============================================================================

/**
 * Tagged-union errors emitted by the tool executor harness. Carried as
 * rejection values; the `BaseHarness` wraps these into the
 * `terminal:failed` envelope.
 */
export type ToolExecutorError =
  | {
      readonly _tag: "ToolNotFoundError";
      readonly name: string;
      readonly registered: readonly string[];
    }
  | {
      readonly _tag: "ToolValidationError";
      readonly toolName: string;
      readonly issues: readonly StandardSchemaIssue[];
    }
  | { readonly _tag: "ToolHandlerError"; readonly toolName: string; readonly cause: unknown }
  | {
      readonly _tag: "ToolPermissionError";
      readonly toolName: string;
      readonly via: DispatchContext["via"];
      readonly reason?: string;
    }
  | { readonly _tag: "ToolTimeoutError"; readonly toolName: string; readonly ms: number }
  | {
      readonly _tag: "ToolConfirmationDeniedError";
      readonly toolName: string;
      readonly reason?: string;
    }
  | {
      readonly _tag: "ToolConfirmationTimeoutError";
      readonly toolName: string;
      readonly ms: number;
    }
  | { readonly _tag: "ToolAbortedError"; readonly toolCallId: string; readonly reason?: string }
  | { readonly _tag: "ToolAlreadyRegistered"; readonly name: string }
  | { readonly _tag: "ToolHandlerMissing"; readonly toolName: string; readonly handlerRef: string };

// ============================================================================
// Inbox messages
// ============================================================================

/**
 * Canonical inbox message types the tool executor harness accepts at
 * its `tool:{sessionId}` address.
 *
 * - `abort`                  cancels an in-flight dispatch.
 * - `confirmation-response`  resolves a pending confirmation prompt.
 *
 * Additional message types MAY be defined as the harness evolves —
 * unknown types route to the default `HandlerError` path.
 */
export type ToolExecutorInboxMessage =
  | {
      readonly type: "abort";
      readonly toolCallId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "confirmation-response";
      readonly response: ToolConfirmationResponse;
    };

// ============================================================================
// The protocol
// ============================================================================

/**
 * Methods every tool executor harness implementation MUST provide. All
 * methods reject with values matching `ToolExecutorError` (wrapped in a
 * tagged-union shape) and emit envelopes on `surface: "tool"`.
 *
 * Registration is part of the protocol so that the runtime can mutate
 * the registry at well-defined operation boundaries (recorded in the
 * journal, observable on the bus). Implementations MAY also accept
 * direct in-process registration outside the protocol — but
 * conformance only exercises the protocol surface.
 */
export interface ToolExecutorProtocol {
  /**
   * Add a tool to the registry. Idempotent on `registration.declaration.name`
   * when the declaration + handlerRef are identical; throws
   * `ToolAlreadyRegistered` when re-registering with a different shape.
   */
  register(input: RegisterToolInput): Promise<void>;

  /**
   * Remove a tool from the registry. No-op for unknown names.
   */
  unregister(input: UnregisterToolInput): Promise<void>;

  /**
   * The canonical command — validate input, run interceptors + the
   * confirmation flow if required, invoke the handler, and emit the
   * full lifecycle event sequence on the bus.
   */
  dispatch(input: DispatchInput): Promise<DispatchResult>;

  /**
   * Cancel an in-flight dispatch. Best-effort — the handler may have
   * already produced side effects.
   */
  abort(input: AbortInput): Promise<void>;

  /**
   * List currently-registered tool declarations, optionally filtered.
   */
  list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]>;
}
