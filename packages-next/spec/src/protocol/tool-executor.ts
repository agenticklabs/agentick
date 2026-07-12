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

import type { Effect } from "effect";
import type { ContentBlock } from "../data/content-blocks.js";
import type { ToolBinding, ToolDeclaration, ToolExposure } from "../data/declarations.js";
import type { StandardSchemaIssue } from "../data/standard-schema.js";
import type { SubstrateError } from "../data/errors.js";
import type { ToolExecutorErrorChannel } from "../errors/harnesses.js";
import type { PromiseView } from "./promise-view.js";

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
 * ## Two failure channels (ADR 70)
 *
 * HARD failure — the dispatch did not complete — is Promise **rejection**
 * with a `ToolExecutorError`. That stays the canonical "did this fail"
 * signal; a rejected dispatch never produces a `DispatchResult`.
 *
 * SOFT / domain error — the handler ran and produced a usable but
 * error-flavored result ("file not found", "rate-limited") — is
 * `isError: true` on the resolved result. The model reasons about /
 * retries a soft error; a hard failure is an infrastructure fault. This
 * replaces the redundant `succeeded` boolean (MCP collapses "couldn't
 * run" and "ran-with-error" into one `isError` from the model's view, and
 * so do we — the couldn't-run vs ran-with-error nuance lives in the error
 * content, not a second boolean).
 *
 * `structuredContent` is the `outputSchema`-validated typed machine result
 * (distinct from `content`, which is the model/human-readable display).
 * It flows to the MCP wire as `CallToolResult.structuredContent`.
 */
export interface DispatchResult {
  readonly toolCallId: string;
  readonly name: string;
  /**
   * SOFT / domain-error flag. `true` when the handler completed but the
   * result is a domain error the model should reason about; absent /
   * `false` on success. NOT set for HARD failures — those reject. Default
   * (absent) means success. Mirrors MCP `CallToolResult.isError`.
   */
  readonly isError?: boolean;
  readonly content: readonly ContentBlock[];
  /**
   * The tool's typed machine result — validated against the tool's
   * `outputSchema` (when declared) before the dispatch resolves. Distinct
   * from `content` (display): may be identical or a separate typed object.
   * Absent when the handler returned no envelope `structuredContent`.
   * Maps to MCP `CallToolResult.structuredContent`.
   */
  readonly structuredContent?: unknown;
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
/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  ToolAbortedError,
  ToolAlreadyRegistered,
  ToolConfirmationDeniedError,
  ToolConfirmationTimeoutError,
  ToolExecutorError,
  type ToolExecutorErrorChannel,
  ToolHandlerError,
  ToolHandlerMissing,
  ToolNotFoundError,
  ToolPermissionError,
  ToolTaskModeConflictError,
  ToolTimeoutError,
  ToolValidationError,
} from "../errors/harnesses.js";

// ============================================================================
// Inbox messages
// ============================================================================

// The tool executor defines NO custom inbox message type. `abort` is a
// declared command (`tool:abort`, ADR 51) — an external actor cancels an
// in-flight dispatch by `send`-ing the generic command-invocation shape
// (`type: "tool:abort"`, `payload: AbortInput`) to the harness's
// `tool:{scopeId}` address, where `BaseHarness.dispatchMessage`
// auto-routes it through the command registry (validation + origin
// stamping + the same `runOperation` path the public `abort()` method
// uses). Confirmation responses retired from this address too — they
// arrive on the `elicitation:{scopeId}` harness's inbox as the generic
// `request-response` envelope. Unknown message types route to the
// default `HandlerError` path.

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
/**
 * The tool executor's **canonical** composable surface: the Effect twin
 * of `dispatch` (ADR 77, the dual-typed edge). The loop reaches
 * `toolExecutor.fx.dispatch(...)` to compose a tool call into one fiber
 * tree (Stage 3); the plain Promise method on {@link ToolExecutorProtocol}
 * is the derived edge facade ({@link PromiseView} of this),
 * `runHarnessProtocol` at the boundary.
 *
 * Unlike the executor/loop, `dispatch` IS a registry command — so this
 * could be `fxProxy`-derived. But the public facade adds door→origin
 * mapping (`viaToOrigin(context.via)`), which `fxProxy`'s default `"host"`
 * origin would drop; so the twin hand-authors over `commandEffect`,
 * preserving the door provenance. (Sharpens the rule: `fxProxy` is sugar
 * only for BARE command passthroughs — knobs; a facade with logic on top
 * hand-authors.)
 */
export interface ToolExecutorFx {
  /**
   * The canonical command — validate input, run interceptors + the
   * confirmation flow if required, invoke the handler, and emit the
   * full lifecycle event sequence on the bus. Rejects (via the `E`
   * channel) only with `ToolExecutorError`; handler throws become a
   * `DispatchResult` with `isError`.
   */
  dispatch(
    input: DispatchInput,
  ): Effect.Effect<DispatchResult, ToolExecutorErrorChannel | SubstrateError, never>;

  /**
   * Atomically replace the reconciler-bound slice of the registry for
   * `input.mountId` (remove every `binding.scope === "reconciler" &&
   * binding.mountId === mountId` row, then add the supplied
   * registrations). The loop calls this after each `renderTree()` so the
   * reconciler slice mirrors the just-rendered tree — composed in the
   * loop's fiber via this twin so the mutation's span nests under the
   * tick. A binding mismatch surfaces as a `ToolValidationError` on the
   * `E` channel (catchable — not a fiber-crashing defect).
   */
  replaceReconcilerTools(
    input: ReplaceReconcilerToolsInput,
  ): Effect.Effect<void, ToolExecutorErrorChannel | SubstrateError, never>;

  /**
   * Per-tick compile — the **precedence-resolved** model-visible tool set
   * (see {@link ToolExecutorProtocol.compileForTick} for the resolution
   * rules). A PURE registry read: no `runOperation`, no journal/bus
   * envelope, `E = never`. The twin exists so the loop composes it
   * uniformly (`yield* toolExecutor.fx.compileForTick(...)`) in-fiber; the
   * facade stays a bare `async` read (no `runHarnessProtocol` spin-up on
   * this hot path).
   */
  compileForTick(filter?: ToolListFilter): Effect.Effect<readonly ToolDeclaration[], never, never>;
}

export interface ToolExecutorProtocol extends PromiseView<ToolExecutorFx> {
  /**
   * The Effect-canonical composable surface (ADR 77) — `fx.dispatch` for
   * in-fiber composition by the loop. On the protocol so a protocol-typed
   * ref (the loop's `RunExecutionInput.toolExecutor`) composes without
   * severing the fiber at the Promise facade.
   */
  readonly fx: ToolExecutorFx;

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

  // `dispatch` is derived from `PromiseView<ToolExecutorFx>` — the Promise
  // facade of the Effect-canonical {@link ToolExecutorFx.dispatch} twin.
  // The concrete harness exposes the Effect surface as `toolExecutor.fx`.

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

  // `replaceReconcilerTools` and `compileForTick` are derived from
  // `PromiseView<ToolExecutorFx>` — the Promise facades of the
  // Effect-canonical twins ({@link ToolExecutorFx.replaceReconcilerTools} /
  // {@link ToolExecutorFx.compileForTick}). The concrete harness exposes
  // the Effect surface as `toolExecutor.fx`.
  //
  // `compileForTick` resolution rules (unchanged; documented on the twin):
  // filter every registration by the supplied {@link ToolListFilter}
  // (`{ exposure: "model" }` for the model's list), then dedup by
  // `declaration.name` — on collision the most-specific binding wins
  // (`runtime < gateway < {app, extension@app} < {session,
  // extension@session} < execution < reconciler`). Canonical source for
  // projection — the loop passes the result as `ProjectInput.tools`.
}

/**
 * Adopter-facing alias for the tool-executor protocol. Use `Tools` in
 * public APIs and `withX` slot signatures; reserve
 * `ToolExecutorProtocol` for internal/framework code that wants to
 * speak in spec-vocabulary. The two are structurally identical —
 * `Tools` is the noun-form chosen for ergonomics per ADR 42 (the
 * `Harness`-word stays out of adopter surfaces).
 *
 * Example — adopter-facing slot:
 *
 * ```ts
 * import type { Tools } from "@agentick/spec-next";
 *
 * export interface McpServerToolsConfig {
 *   readonly use?: Tools;
 *   // ...
 * }
 * ```
 */
export type Tools = ToolExecutorProtocol;

/**
 * Structural type guard for a `Tools` instance. Discriminates the
 * trichotomic adopter slot pattern (array | instance | config object)
 * by checking for the live `ToolExecutorProtocol` method surface.
 *
 * A `Tools` instance has all of `register`, `unregister`, `dispatch`,
 * `list`, `compileForTick` — none of which appear on a `CreatedTool[]`
 * shorthand or a plain config object. Order matters in the discriminator:
 * test for arrays first (form A), then `isToolsInstance` (form B), then
 * fall through to form C (config object).
 */
export function isToolsInstance(v: unknown): v is Tools {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.register === "function" &&
    typeof obj.unregister === "function" &&
    typeof obj.dispatch === "function" &&
    typeof obj.list === "function" &&
    typeof obj.compileForTick === "function"
  );
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
