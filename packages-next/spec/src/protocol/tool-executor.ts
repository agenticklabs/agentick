/**
 * ToolExecutorProtocol — the contract every tool executor harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/tool-executor-next` (Phase 4a),
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
 * `ToolDeclaration.exposure` (from `@agentick/spec-next/data/declarations`)
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
import type { ToolBinding, ToolDeclaration, ToolExposure } from "../data/declarations.js";
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
  /**
   * Pattern selector for tools that may produce a `TaskHandle`
   * (`annotations.taskSupport === "supported" | "required"`).
   *
   *   - `"auto"` (default) — `via: "model"` + `taskSupport: "required"`
   *     yields Pattern B (returns a `session_task_ref` block); every
   *     other combination yields Pattern A (awaits the handle's
   *     `result` and returns its blocks). The model-tick path relies on
   *     this default to keep `required` tools async across ticks;
   *     host-side dispatch gets Pattern A blocks transparently.
   *   - `"ref"` — force Pattern B. Rejects with `ToolTaskModeConflictError`
   *     when the tool's `taskSupport === "unsupported"` (the handler is
   *     not expected to produce a handle).
   *   - `"inline"` — force Pattern A. Rejects with
   *     `ToolTaskModeConflictError` when the tool's
   *     `taskSupport === "required"` (the handler contract requires
   *     ref-mode; awaiting would defeat the purpose).
   *
   * The matrix is resolved inside the harness; callers do not have to
   * inspect the declaration. Phase C (#174) refines the "supported"
   * branch with capability negotiation.
   */
  readonly task?: "auto" | "ref" | "inline";
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
   * `@agentick/spec-next/data/content-blocks`.
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
  /**
   * **Provenance.** Which declaration seam contributed this
   * registration. Drives precedence resolution in
   * {@link ToolExecutorProtocol.compileForTick} and lifecycle cleanup
   * (e.g., scope=session entries are removed when their session
   * closes). Internal to the registry; never exposed on the wire or
   * to model providers.
   *
   * @see ToolBinding for the layered config seams.
   */
  readonly binding: ToolBinding;
}

/**
 * Wrap a {@link ToolDeclaration} into a {@link ToolRegistration}
 * tagged with the given binding. The canonical adapter every layer
 * (gateway/app/session/execution/reconciler/extension) uses when it
 * turns adopter-supplied declarations into binding-tagged
 * registrations.
 *
 * `handlerRef` falls back to `decl.id` when the declaration doesn't
 * supply one — matches the reconciler's default resolution
 * (resolver looks up by both `name` and `id` aliases). Callers
 * needing a custom `handlerRef` or `useDeps` build the registration
 * literal directly.
 */
export function toRegistration(
  declaration: ToolDeclaration,
  binding: ToolBinding,
): ToolRegistration {
  return {
    declaration,
    handlerRef: declaration.handlerRef ?? declaration.id,
    binding,
  };
}

export interface RegisterToolInput {
  readonly registration: ToolRegistration;
  readonly opId?: string;
}

export interface UnregisterToolInput {
  readonly name: string;
  readonly opId?: string;
}

/**
 * Input for {@link ToolExecutorProtocol.removeBoundTools}. Removes
 * every registration whose binding key matches the supplied
 * `binding`. Used by the session/execution lifecycle to clean up
 * scope-bound tools when their scope closes:
 *
 *   - Execution ends → `removeBoundTools({ binding: { scope: "execution", executionId }})`
 *   - Session ends → `removeBoundTools({ binding: { scope: "session", sessionId }})`
 *
 * Equality is by `sameBindingKey` (the identity-defining fields per
 * variant — see {@link ToolBinding}). Other binding slices are
 * untouched.
 */
export interface RemoveBoundToolsInput {
  readonly binding: import("../data/declarations.js").ToolBinding;
  readonly opId?: string;
}

/**
 * Input for {@link ToolExecutorProtocol.replaceReconcilerTools}.
 * Atomically swaps the reconciler-bound slice of the registry for a
 * single `mountId`.
 *
 * The loop calls this after each `renderTree()` so the registry's
 * reconciler slice mirrors the just-rendered tree's tool
 * declarations. Registrations passed here MUST carry
 * `binding.scope === "reconciler"` with
 * `binding.mountId === input.mountId`.
 *
 * The "reconciler" slot is reconciler-agnostic — any harness that
 * produces a valid `RenderedTree` (React/JSX, programmatic builder,
 * template-based) contributes through this slot.
 */
export interface ReplaceReconcilerToolsInput {
  readonly mountId: string;
  readonly registrations: readonly ToolRegistration[];
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
 * Telemetry shape — describes a confirmation request the harness is
 * about to send for a tool annotated `requiresConfirmation`. Surfaced
 * on the {@link ToolConfirmationRequested} lifecycle event for
 * observability + audit. NOT a wire payload anymore: the actual wire
 * format is an elicitation request on `session:channel:elicitation`
 * (carrying `hints.kind === "tool_confirmation"` and these fields
 * inside `metadata`).
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
 * Telemetry shape — describes a host's response to a confirmation
 * request. Surfaced on the {@link ToolConfirmationResolved} lifecycle
 * event. `always: true` is a session-scoped allow-list the harness
 * remembers; `modifiedArguments` triggers a re-validation pass before
 * the handler runs. NOT a wire payload: the actual wire format is an
 * `ElicitationResponse` carrying these fields inside `value`.
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
  | { readonly _tag: "ToolHandlerMissing"; readonly toolName: string; readonly handlerRef: string }
  | {
      /**
       * The caller's `task` option conflicts with the tool's
       * `taskSupport` annotation. Emitted by the executor BEFORE the
       * handler runs:
       *
       *   - `task: "ref"` + `taskSupport: "unsupported"` — the tool
       *     never produces a handle; there's no ref to return.
       *   - `task: "inline"` + `taskSupport: "required"` — the tool
       *     contract requires async-ref semantics; awaiting it inline
       *     defeats the point.
       */
      readonly _tag: "ToolTaskModeConflictError";
      readonly toolName: string;
      readonly requestedTaskMode: "ref" | "inline";
      readonly supportMode: "unsupported" | "supported" | "required";
    };

// ============================================================================
// Inbox messages
// ============================================================================

/**
 * Canonical inbox message types the tool executor harness accepts at
 * its `tool:{sessionId}` address.
 *
 * - `abort`  cancels an in-flight dispatch.
 *
 * Confirmation responses retired from this address — they now arrive
 * on the `elicitation:{scopeId}` harness's inbox as the generic
 * `request-response` envelope, where `BaseHarness.dispatchMessage`
 * auto-routes them through the elicitation registry. The tool
 * executor never sees them.
 *
 * Additional message types MAY be defined as the harness evolves —
 * unknown types route to the default `HandlerError` path.
 */
export type ToolExecutorInboxMessage = {
  readonly type: "abort";
  readonly toolCallId: string;
  readonly reason?: string;
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
   *
   * Returns one entry per registered name **per binding slice** — i.e.
   * if the same name is registered under multiple bindings (e.g., once
   * at session scope and once by the reconciler), `list` returns both.
   * For the precedence-resolved set the model should see at a given
   * tick, use {@link compileForTick}.
   *
   * Suitable for diagnostics, devtools, and audit. Not for projection.
   */
  list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]>;

  /**
   * Bulk-remove every registration whose binding-key equals the
   * supplied `binding`. Used by scope lifecycle hooks (execution
   * close, session close). Returns the count of removed entries.
   *
   * Distinct from {@link unregister}, which removes every binding
   * slot for a given name (cross-scope). `removeBoundTools` removes
   * one scope across all names.
   */
  removeBoundTools(input: RemoveBoundToolsInput): Promise<void>;

  /**
   * Atomically replace the reconciler-bound slice of the registry for
   * the given `mountId`. Every existing registration with
   * `binding.scope === "reconciler" && binding.mountId === input.mountId`
   * is removed first; then the supplied registrations are added. Other
   * binding slices (gateway/app/session/execution/extension/runtime)
   * are untouched.
   *
   * The loop executor calls this immediately after each successful
   * `renderTree()` so the reconciler slice mirrors the just-rendered
   * tree. Reconciler-agnostic — any harness that produces a valid
   * `RenderedTree` flows through this slot.
   */
  replaceReconcilerTools(input: ReplaceReconcilerToolsInput): Promise<void>;

  /**
   * Per-tick compile — returns the **precedence-resolved** set of tool
   * declarations visible at this tick.
   *
   * Resolution rules:
   * 1. Filter every registration by the supplied {@link ToolListFilter}
   *    (the common case: `{ exposure: "model" }` for the model's tool
   *    list).
   * 2. Dedup by `declaration.name`. On collision, the most-specific
   *    binding wins. Precedence (low → high):
   *    `runtime < gateway < \{app, extension@app\} < \{session,
   *    extension@session\} < execution < reconciler`.
   *
   * This is the canonical source for projection — the loop passes the
   * result as `ProjectInput.tools`.
   */
  compileForTick(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]>;
}

// ============================================================================
// ToolExecutorFactory — deferred construction with shared substrate
// ============================================================================

/**
 * Substrate dependencies a `ToolExecutorProtocol` is constructed with.
 * Mirrors `ExecutorFactoryDeps` — same shape, different slot.
 */
export interface ToolExecutorFactoryDeps {
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `ToolExecutorProtocol`. Parent harnesses
 * (`SessionHarness` / `AppHarness`) call this factory with their own
 * substrate so the executor's events flow through the shared bus/journal
 * without manual wiring.
 *
 * Marker symbol `toolExecutorFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface ToolExecutorFactory {
  readonly toolExecutorFactory: true;
  (deps: ToolExecutorFactoryDeps): ToolExecutorProtocol;
}

/** Type guard. */
export function isToolExecutorFactory(v: unknown): v is ToolExecutorFactory {
  return (
    typeof v === "function" && (v as { toolExecutorFactory?: unknown }).toolExecutorFactory === true
  );
}
