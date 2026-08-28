/**
 * ToolExecutorProtocol — the contract every tool executor harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/tool-executor` (Phase 4a),
 * which materializes a tool registry from `ToolDeclaration[]` produced
 * by the compiler harness and invokes handlers resolved via the
 * runtime's handler registry (the spec firewall forbids carrying live
 * function references across protocol boundaries).
 *
 * ## The two doors
 *
 * One harness boundary; two callers. The loop executor (model door)
 * sends `dispatch({ via: "model" })` when the model emits a `tool_use`
 * block. The session harness (host door) sends
 * `dispatch({ via: "dispatch" })` when the host calls
 * `session.tools.dispatch(name, input)`. Same validation, same confirmation,
 * same interceptors — by construction. `via` is observable to
 * middleware so policies can differ if needed.
 *
 * ## Exposure model
 *
 * `ToolDeclaration.exposure` (from `@agentick/spec/data/declarations`)
 * decides which door the tool is reachable from:
 *
 * - `"model"`     reachable when the model emits `tool_use`.
 * - `"dispatch"`  reachable from `session.tools.dispatch(name, input)`.
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

import type { InstallerInterceptors } from "./app-extension.js";
import type { HarnessFx } from "./middleware.js";
import type { Effect } from "effect";
import type { ContentBlock } from "../data/content-blocks.js";
import type {
  ClientToolAnnotations,
  ClientToolDeclaration,
  ToolAnnotations,
  ToolBinding,
  ToolDeclaration,
  ToolExposure,
  ToolPresentation,
} from "../data/declarations.js";
import type { Unsubscribe } from "./inbox.js";
import type { ToolResultInput } from "../data/tool-result.js";
import type { StandardSchemaIssue } from "../data/standard-schema.js";
import { jsonSchema } from "../data/standard-schema.js";
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
 * React render time by the compiler (see `createTool({ use: () => …})`);
 * the harness simply forwards them to the handler.
 */
export interface DispatchContext {
  /** Which door produced this dispatch. */
  readonly via: "model" | "dispatch";
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  /**
   * The client connection this execution serves. A client-handled tool relays
   * it as `target`, so an attached client can tell a call meant for it from one
   * meant for another tab.
   */
  readonly connectionId?: string;
  /**
   * The client this execution serves. A client-handled tool relays it as
   * `target`, and each attached client compares it against its own id.
   */
  readonly clientId?: string;
  /**
   * The output shape the CURRENT execution is bound to
   * (`SendInput.responseFormat`), absent when the send carried none. Set by
   * the loop on the model door; the host door carries whatever the caller
   * supplies. Surfaced to handlers as `ctx.responseFormat` — an EXPOSURE the
   * framework never validates against. Render-side twin:
   * {@link import("./render-context.js").RenderContext.responseFormat}.
   */
  readonly responseFormat?: import("../data/rendered-tree.js").ResponseFormat;
  /** Caller-supplied request context (user, requestId, traceparent, …). */
  readonly request?: Readonly<Record<string, unknown>>;
  /**
   * Render-time deps captured by the compiler harness when the tool
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
   * Per-call wait bound (ms) for a CLIENT-HANDLED tool's relayed result
   * (the tool has no `handlerRef` and `annotations.requiresResponse ===
   * true`). `annotations.responseTimeoutMs` takes precedence; both
   * unset means wait forever. On timeout the executor falls back to
   * `annotations.defaultResult` when set, else fails
   * `ToolCallTimeoutError`.
   */
  readonly responseTimeoutMs?: number;
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
   * `@agentick/spec/data/content-blocks`.
   */
  readonly executedBy?: string;
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly cacheHit?: boolean;
  /**
   * Resolved tool-call presentation — the "what is this call doing?"
   * answer as FOUR DISTINCT fields (`name`, `title`, `summary`,
   * `narration`), never collapsed into a precedence chain (see
   * {@link ToolPresentation}; the client composes precedence). Computed by
   * the executor at dispatch (the single resolution site — it holds the
   * stripped model narration, the tool annotations, and the validated
   * input). The loop surfaces it on the tool lifecycle path. Presentation
   * only; never sent to the model. Absent for dispatches that short-circuit
   * before the resolution point (e.g. a confirmation denial).
   */
  readonly presentation?: ToolPresentation;
  /**
   * How the confirmation gate settled, when the gate asked at all. Absent
   * for a dispatch nobody was asked about. The framework publishes the
   * decision and forgets it — an interceptor reading this is how a `reply.
   * always` grant becomes durable (see {@link ToolConfirmationResolution}).
   * A `timeout` rejects instead, carrying the same record on the error.
   */
  readonly confirmation?: ToolConfirmationResolution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Host handle projection — `session.tools` (three-audiences-plan §F)
// ============================================================================

/**
 * Options for a host-door dispatch (`session.tools.dispatch` /
 * `ToolHandle.dispatch`). Selects the task pattern for tools that may produce a
 * `TaskHandle` — see the `task` field on {@link DispatchInput} for the full
 * matrix. Formerly on `SessionHarnessProtocol.dispatch`; moved here with the
 * removal of `session.dispatch` (the handle is the one dispatch door now).
 */
export interface DispatchOptions {
  readonly task?: "auto" | "ref" | "inline";
  /**
   * The door this dispatch claims — checked against the declaration's
   * {@link ToolExposure} exactly like any other dispatch. Default `"dispatch"`
   * (the host door). Pass `"model"` when the call is model-originated in
   * substance but reaches the executor through the host door — the paradigm
   * case is a search-and-dispatch tool relaying a call the model asked for.
   *
   * `via` is PROVENANCE, not an authenticated boundary: everything holding
   * this handle runs in-process and is equally trusted; the exposure check
   * exists to keep doors honest, not to keep callers out.
   */
  readonly via?: "model" | "dispatch";
  /**
   * Resolve with the full {@link DispatchResult} instead of content blocks
   * alone. Off by default — blocks are the curated currency; the envelope is
   * for callers composing on TYPED outputs (`structuredContent` against the
   * tool's `outputSchema`) or branching on the domain-error flag, which the
   * blocks-only shape silently drops.
   */
  readonly envelope?: boolean;
}

/**
 * **Wire-safe projection** of a registered tool's declaration — the row
 * `session.tools.list()` returns and the client `ToolsClientHandle`
 * enumerates. A serializable subset of {@link ToolDeclaration}: it deliberately
 * OMITS the live `inputSchema` (a `StandardSchemaV1` validator — a function,
 * uncrossable) and surfaces only `hasInputSchema`. Power users who need the
 * validator itself keep the raw `session.toolExecutor`.
 */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  /** One sentence: what the tool does. See {@link ToolDeclaration.summary}. */
  readonly summary?: string;
  /** Capability-tree path. See {@link ToolDeclaration.group}. */
  readonly group?: readonly string[];
  /** Which doors the tool is reachable from (`"model"` / `"dispatch"` / `"runtime"`). */
  readonly exposure: readonly ToolExposure[];
  /** Alternate dispatch names (declaration-level, not annotations). */
  readonly aliases?: readonly string[];
  readonly annotations?: ToolAnnotations;
  /** True when the tool declares an `inputSchema`. The schema itself never crosses. */
  readonly hasInputSchema: boolean;
  /**
   * Which layer bound the tool (the registration's {@link ToolBinding}) —
   * lets a reader tell a statically-composed app tool from one a client
   * declared for THIS session (`client`) or a send scoped to THIS execution
   * (`execution`). Plain data, wire-safe. Absent only when the projection had
   * no registration in reach.
   */
  readonly binding?: ToolBinding;
}

/**
 * Per-tool handle — the {@link ToolInfo} projection plus a name-bound
 * {@link DispatchOptions}-aware dispatch. Handed back by
 * {@link ToolsHandle.get}. Dispatch flows the host door (`via: "dispatch"`).
 */
export interface ToolHandle {
  readonly name: string;
  readonly info: ToolInfo;
  dispatch(
    input: unknown,
    opts: DispatchOptions & { readonly envelope: true },
  ): Promise<DispatchResult>;
  dispatch(
    input: unknown,
    opts?: DispatchOptions & { readonly envelope?: false },
  ): Promise<readonly ContentBlock[]>;
}

/**
 * `session.tools` — the missing sibling handle (three-audiences-plan §F). Tools
 * were the one session collection without a curated handle: the raw
 * `session.toolExecutor` plus the removed `session.dispatch` sugar. This reads
 * exactly like `session.knobs` / `session.state`: SYNC View reads
 * (`list`/`get`/`has` — an in-memory registry with a sync read surface holds a
 * View, per the data-layer rule), an ASYNC `dispatch` (host door, `via:
 * "dispatch"` provenance — the same journaling the removed `session.dispatch`
 * had), and the family topology-subscription pair.
 *
 * `ToolInfo` is the wire-safe projection; `session.toolExecutor` remains for
 * power users who need the live declaration.
 */
export interface ToolsHandle {
  /** Current registered tools as {@link ToolInfo} rows, optionally filtered by exposure. */
  list(query?: { readonly exposure?: ToolExposure }): readonly ToolInfo[];
  /** Look one tool up by name, then alias; a {@link ToolHandle} or `undefined`. */
  get(name: string): ToolHandle | undefined;
  /** True when a tool by that name (or alias) is registered. */
  has(name: string): boolean;
  /**
   * Invoke a tool by name without the model (host door). Auto-validates input
   * against the tool's schema, resolves by name then alias, and returns the
   * tool's content blocks — or, with `{ envelope: true }`, the full
   * {@link DispatchResult} (typed `structuredContent`, domain-error flag).
   * Replaces `session.dispatch`. Throws `ToolExecutorError` on
   * validation/permission/handler failure.
   */
  dispatch(
    name: string,
    input: unknown,
    opts: DispatchOptions & { readonly envelope: true },
  ): Promise<DispatchResult>;
  dispatch(
    name: string,
    input: unknown,
    opts?: DispatchOptions & { readonly envelope?: false },
  ): Promise<readonly ContentBlock[]>;
  /** Fire when the named tool's registrations change (declaration / presence). */
  subscribe(name: string, listener: () => void): Unsubscribe;
  /** Fire on any registry topology change (add / remove of any tool). */
  subscribeAll(listener: () => void): Unsubscribe;
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
   *
   * ABSENT (`undefined`) marks a CLIENT-HANDLED tool: no server handler
   * exists and the tool executor relays dispatch to the client instead
   * of invoking locally (a handler-less `createTool`, or a wire-
   * registered declaration). PRESENT-but-unresolvable stays a
   * `ToolHandlerMissing` bug. `toRegistration` fills the `declaration.id`
   * fallback, so registrations built through it are always
   * server-handled.
   */
  readonly handlerRef?: string;
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
 * (gateway/app/session/execution/compiler/extension) uses when it
 * turns adopter-supplied declarations into binding-tagged
 * registrations.
 *
 * `handlerRef` falls back to `decl.id` when the declaration doesn't
 * supply one — matches the compiler's default resolution
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
    // NOT defaulted to `declaration.id`. An ABSENT `handlerRef` is the only
    // signal the executor has that a tool is CLIENT-HANDLED — it relays the
    // call instead of resolving a server handler. Filling one in erased that,
    // so a `createTool` declared without a handler failed with
    // `ToolHandlerMissing` rather than reaching the client that could run it.
    ...(declaration.handlerRef !== undefined ? { handlerRef: declaration.handlerRef } : {}),
    binding,
  };
}

export interface RegisterToolInput {
  readonly registration: ToolRegistration;
  /**
   * Replace an existing registration in the SAME binding slot rather than
   * refusing it. Off by default: a collision is usually two sources claiming
   * one name, which should be loud.
   *
   * On for a declarative source that owns its slice and re-declares — a client
   * re-sending its tools after a reconnect, or a second client contributing to
   * the same slice. Other bindings' registrations are untouched.
   */
  readonly replace?: boolean;
  readonly opId?: string;
}

/**
 * Fold a {@link ClientToolDeclaration} (one element of the serializable set a
 * client declares over `session/set_client_tools`) into a CLIENT-HANDLED
 * {@link ToolRegistration}.
 *
 * Two firewall crossings happen here — the single canonical adapter the wire
 * layer calls so the mapping is not re-derived per transport:
 *
 *   1. The raw `inputSchema` JSON Schema object is wrapped into a
 *      `StandardSchemaV1` via {@link jsonSchema} (the executor validates the
 *      dispatch input against it; the projector re-emits it to the model via
 *      `toJsonSchema()`). A wire client cannot carry a live validator.
 *   2. `handlerRef` is deliberately OMITTED — its absence is the
 *      CLIENT-HANDLED discriminator (`dispatchBody` relays the call to the
 *      client instead of resolving a local handler). Contrast
 *      {@link toRegistration}, which fills `handlerRef` and is therefore always
 *      server-handled.
 *
 * `exposure` is `["model"]` — a wire-declared client tool enters the model's
 * tool list via the normal `compileForTick` path. The `binding` is
 * caller-supplied (the wire layer passes `{ scope: "client", sessionId }` — the
 * distinct client slice that `session/set_client_tools` clears-and-reinstalls
 * and that session close reaps, held apart from `{ scope: "session" }` so a
 * client's declarative replace never clobbers `createSession({ tools })`).
 */
export function toClientToolRegistration(
  declaration: ClientToolDeclaration,
  binding: ToolBinding,
): ToolRegistration {
  const decl: ToolDeclaration = {
    id: declaration.name,
    name: declaration.name,
    description: declaration.description,
    inputSchema: jsonSchema(declaration.inputSchema),
    exposure: ["model"],
    ...(declaration.summary !== undefined ? { summary: declaration.summary } : {}),
    ...(declaration.group !== undefined ? { group: declaration.group } : {}),
    ...(declaration.aliases !== undefined ? { aliases: declaration.aliases } : {}),
    ...(declaration.annotations !== undefined
      ? { annotations: stripServerOnlyAnnotations(declaration.annotations) }
      : {}),
    // NO handlerRef — client-handled.
  };
  return { declaration: decl, binding };
}

/**
 * Strip server-authoritative annotation fields a wire client must never set.
 *
 * `executedBy` (execution provenance) is absent from {@link ClientToolAnnotations}
 * by design (see its docblock), so a well-typed client cannot set it. But a raw
 * JSON payload can smuggle it as an excess property that survives the spread —
 * TypeScript's excess-property check does not run on values parsed off the wire.
 * Dropping it HERE, at the single wire fold, makes the guarantee runtime-true:
 * a client can never seed provenance onto its registration. Defense-in-depth —
 * the executor also refuses to READ `executedBy` on the client-handled path.
 */
function stripServerOnlyAnnotations(ann: ClientToolAnnotations): ClientToolAnnotations {
  if (!("executedBy" in ann)) return ann;
  const { executedBy: _executedBy, ...rest } = ann as ClientToolAnnotations & {
    executedBy?: unknown;
  };
  return rest;
}

/**
 * Input for {@link ToolExecutorProtocol.respondToToolCall}. The client's
 * relayed result for a suspended CLIENT-HANDLED dispatch, keyed by the
 * `correlationId` carried on the outbound tool-call request envelope's
 * metadata.
 */
export interface RespondToToolCallInput {
  readonly correlationId: string;
  /** The ADR 70 result currency — `string` | `ContentBlock[]` | envelope. */
  readonly result: ToolResultInput;
}

export interface UnregisterToolInput {
  readonly name: string;
  readonly opId?: string;
}

/**
 * Input for {@link ToolExecutorProtocol.removeBoundTools}. Removes
 * every registration whose binding key matches the supplied
 * `binding` (the whole slice). Used to clean up scope-bound tools when
 * their scope closes, and to clear a declarative slice before a
 * whole-slice replace:
 *
 *   - Execution ends → `removeBoundTools({ binding: { scope: "execution", executionId }})`
 *   - Session ends → `removeBoundTools({ binding: { scope: "session", sessionId }})`
 *     plus the client slice `removeBoundTools({ binding: { scope: "client", sessionId }})`
 *   - `session/set_client_tools` → clears `{ scope: "client", sessionId }`
 *     then reinstalls the declared set (the wire twin of
 *     `replaceCompilerTools`).
 *
 * Equality is by `sameBindingKey` (the identity-defining fields per
 * variant — see {@link ToolBinding}). Other binding slices are
 * untouched — clearing the client slice never touches `{ scope:
 * "session" }` app tools.
 */
export interface RemoveBoundToolsInput {
  readonly binding: import("../data/declarations.js").ToolBinding;
  readonly opId?: string;
}

/**
 * Input for {@link ToolExecutorProtocol.replaceCompilerTools}.
 * Atomically swaps the compiler-bound slice of the registry for a
 * single `mountId`.
 *
 * The loop calls this after each `renderTree()` so the registry's
 * compiler slice mirrors the just-rendered tree's tool
 * declarations. Registrations passed here MUST carry
 * `binding.scope === "compiler"` with
 * `binding.mountId === input.mountId`.
 *
 * The "compiler" slot is compiler-agnostic — any harness that
 * produces a valid `RenderedTree` (React/JSX, programmatic builder,
 * template-based) contributes through this slot.
 */
export interface ReplaceCompilerToolsInput {
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
 * How one confirmation ask ended. Covers both un-answered cases, so the
 * outcome is a four-arm discriminator rather than the host's `approved`
 * boolean: a `timeout` is nobody deciding and an `aborted` is nobody being
 * asked any more — neither is a denial. A `declined` reply IS one.
 *
 * Published on {@link DispatchResult.confirmation} for the three arms that
 * resolve, and on `ToolConfirmationTimeoutError.confirmation` for the one
 * that rejects — so an interceptor around the dispatch sees every decision.
 * NOT a wire payload: an answer arrives as an `ElicitationResponse` carrying
 * `approved` / `always` / `modifiedArguments` inside `value`.
 */
export interface ToolConfirmationResolution {
  readonly toolUseId: string;
  /**
   * The CANONICAL tool name — the declaration's own `name`, never the alias
   * a caller happened to dispatch by. A grant store keyed on an alias grants
   * nothing when the next call comes in under the real name.
   */
  readonly toolName: string;
  /** The session whose gate asked — the scope any grant written from this belongs to. */
  readonly sessionId: string;
  readonly outcome: "approved" | "denied" | "timeout" | "aborted";
  /** The validated arguments the ask carried, before any host edit. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /**
   * The host asked for a standing grant. The framework RELAYS it and forgets
   * it — remembering a decision is application policy, written from this
   * record and read back through {@link ToolConfirmationPolicy}.
   */
  readonly always?: boolean;
  readonly reason?: string;
  /** The host edited the call before approving; re-validated before the handler ran. */
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
export interface ToolExecutorFx extends HarnessFx {
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
   * Atomically replace the compiler-bound slice of the registry for
   * `input.mountId` (remove every `binding.scope === "compiler" &&
   * binding.mountId === mountId` row, then add the supplied
   * registrations). The loop calls this after each `renderTree()` so the
   * compiler slice mirrors the just-rendered tree — composed in the
   * loop's fiber via this twin so the mutation's span nests under the
   * tick. A binding mismatch surfaces as a `ToolValidationError` on the
   * `E` channel (catchable — not a fiber-crashing defect).
   */
  replaceCompilerTools(
    input: ReplaceCompilerToolsInput,
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

export interface ToolExecutorProtocol extends PromiseView<Omit<ToolExecutorFx, keyof HarnessFx>> {
  /**
   * The Effect-canonical composable surface (ADR 77) — `fx.dispatch` for
   * in-fiber composition by the loop. On the protocol so a protocol-typed
   * ref (the loop's `RunExecutionInput.toolExecutor`) composes without
   * severing the fiber at the Promise facade.
   */
  readonly fx: ToolExecutorFx;

  /**
   * The curated host handle — `session.tools` (three-audiences-plan §F). SYNC
   * View reads (`list`/`get`/`has`) over the registry, the host-door
   * `dispatch(name, input, opts?)` (`via: "dispatch"`), and the family
   * topology-subscription pair. The concrete harness builds this once over its
   * own registry; the session getter forwards it.
   */
  readonly tools: ToolsHandle;

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
   * Land a CLIENT's relayed result into the request/response registry,
   * resolving the pending `this.request(TOOL_CALL_CHANNEL, …)` a
   * client-handled dispatch (`handlerRef` absent + `requiresResponse: true`)
   * is suspended on. The twin of the client-tool relay to
   * {@link register}'s handler-less declarations.
   *
   * Mirrors `ElicitationHarnessProtocol.respond`: routes the result through
   * the harness inbox as a `request-response` envelope so in-process and
   * cross-process replies resolve on ONE path (`BaseHarness.dispatchMessage`
   * auto-intercept → `requests.resolve(correlationId, result)`) — no separate
   * suspend/resume machinery. Idempotent: unknown / already-resolved
   * correlationIds are silent no-ops (first-write-wins on the registry).
   */
  respondToToolCall(input: RespondToToolCallInput): Promise<void>;

  // `dispatch` is derived from `PromiseView<Omit<ToolExecutorFx, "use">>` — the Promise
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
   * at session scope and once by the compiler), `list` returns both.
   * For the precedence-resolved set the model should see at a given
   * tick, use {@link compileForTick}.
   *
   * Suitable for diagnostics, devtools, and audit. Not for projection.
   */
  list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]>;

  /**
   * Remove every registration whose binding-key equals the supplied
   * `binding` (the whole slice), returning the COUNT of registrations
   * removed (0 when nothing matched — an honest no-op). The bulk sweep used
   * by scope lifecycle hooks (execution close, session close) and by
   * `session/set_client_tools` to clear the `{ scope: "client", sessionId }`
   * slice before reinstalling the declared set.
   *
   * Distinct from {@link unregister}, which removes every binding slot for a
   * given name (cross-scope). `removeBoundTools` removes one scope across all
   * names. The count is an honest existence signal for callers that want it;
   * the declarative `set_client_tools` clear path ignores it.
   */
  removeBoundTools(input: RemoveBoundToolsInput): Promise<number>;

  // `replaceCompilerTools` and `compileForTick` are derived from
  // `PromiseView<Omit<ToolExecutorFx, "use">>` — the Promise facades of the
  // Effect-canonical twins ({@link ToolExecutorFx.replaceCompilerTools} /
  // {@link ToolExecutorFx.compileForTick}). The concrete harness exposes
  // the Effect surface as `toolExecutor.fx`.
  //
  // `compileForTick` resolution rules (unchanged; documented on the twin):
  // filter every registration by the supplied {@link ToolListFilter}
  // (`{ exposure: "model" }` for the model's list), then dedup by
  // `declaration.name` — on collision the most-specific binding wins
  // (`runtime < gateway < {app, extension@app} < {session,
  // extension@session} < execution < compiler`). Canonical source for
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
 * import type { Tools } from "@agentick/spec";
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
 * Mirrors the args every `BaseHarness` subclass takes.
 *
 */
export interface ToolExecutorFactoryDeps {
  /**
   * The host's interceptor cascade, in the SAME nested shape a
   * {@link InstallerInterceptors} handle takes — so `inheritedFrom(deps)` from
   * `@agentick/runtime` spreads it straight into your harness options.
   *
   * Absent before this existed, which meant a factory-built harness received no
   * app hooks, no guards, and no telemetry enrichment — silently, since the
   * harness still worked.
   */
  readonly interceptors?: InstallerInterceptors;
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
 * `deps` is OPTIONAL: a parent harness passes its substrate so the executor's
 * events flow on the shared bus/journal, while a STANDALONE caller (a test, a
 * REPL, an adopter probing their callbacks before wiring an app) calls the
 * factory bare and gets a private local substrate. Same convention as
 * {@link ExecutorFactory}.
 *
 * Marker symbol `toolExecutorFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface ToolExecutorFactory {
  readonly toolExecutorFactory: true;
  (deps?: ToolExecutorFactoryDeps): ToolExecutorProtocol;
}

/** Type guard. */
export function isToolExecutorFactory(v: unknown): v is ToolExecutorFactory {
  return (
    typeof v === "function" && (v as { toolExecutorFactory?: unknown }).toolExecutorFactory === true
  );
}
