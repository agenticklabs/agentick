/**
 * Per-harness error classes — execution (loop / compiler / executor /
 * timeline) + domain (tool-executor / prompts / skills / knobs / mcp-server).
 *
 * Migrated from POJO `_tag` unions to the `AgentickError` class
 * hierarchy per ADR 41 (clusters 3 + 4). Each domain has an abstract
 * intermediate plus concrete subclasses; single-tag unions
 * (`NormalizeError`) become concrete classes directly under
 * `AgentickError`.
 */

import { AgentickError, type SerializedAgentickError } from "./base.js";
import { registerAgentickError } from "./registry.js";
import { JournalError } from "./substrate.js";
import type { ToolConfirmationResolution } from "../protocol/tool-executor.js";

// ============================================================================
// LoopExecutorError — loop orchestration failures
// ============================================================================

export abstract class LoopExecutorError extends AgentickError {}

export class ExecutionError extends LoopExecutorError {
  readonly _tag = "ExecutionError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`execution error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("ExecutionError", ExecutionError);

export class TickError extends LoopExecutorError {
  readonly _tag = "TickError" as const;
  readonly tick: number;
  readonly phase: "compile" | "execute" | "tool-dispatch" | "ingest" | "continuation";
  override readonly cause: unknown;
  constructor(args: {
    readonly tick: number;
    readonly phase: "compile" | "execute" | "tool-dispatch" | "ingest" | "continuation";
    readonly cause: unknown;
  }) {
    super(`tick ${args.tick} ${args.phase} failed: ${String(args.cause)}`, { cause: args.cause });
    this.tick = args.tick;
    this.phase = args.phase;
    this.cause = args.cause;
  }
}
registerAgentickError("TickError", TickError);

export class LoopCanceledError extends LoopExecutorError {
  readonly _tag = "LoopCanceledError" as const;
  readonly reason?: string;
  constructor(args?: { readonly reason?: string; readonly cause?: unknown }) {
    super(args?.reason ? `loop canceled: ${args.reason}` : `loop canceled`, { cause: args?.cause });
    if (args?.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("LoopCanceledError", LoopCanceledError);

export class MaxTicksExceeded extends LoopExecutorError {
  readonly _tag = "MaxTicksExceeded" as const;
  readonly maxTicks: number;
  constructor(args: { readonly maxTicks: number; readonly cause?: unknown }) {
    super(`max ticks exceeded (${args.maxTicks})`, { cause: args.cause });
    this.maxTicks = args.maxTicks;
  }
}
registerAgentickError("MaxTicksExceeded", MaxTicksExceeded);

/**
 * Structured-output terminal-tool NAME collision (three-audiences-plan §B2).
 * The terminal tool binds by NAME; a model-exposed tool (tree/compiler,
 * precedence ≥ execution) of the same name would silently SHADOW it. Rather
 * than shadow, the loop fails the send at tick 1. Loop-side because only the
 * loop sees the precedence-resolved `compileForTick` set.
 */
export class TerminalToolNameCollision extends LoopExecutorError {
  readonly _tag = "TerminalToolNameCollision" as const;
  readonly toolName: string;
  constructor(args: { readonly toolName: string; readonly cause?: unknown }) {
    super(
      `structured-output terminal tool "${args.toolName}" collides with a ` +
        `model-exposed tool of the same name — rename the output tool ` +
        `(\`name\` on the output spec) or the colliding tool`,
      { cause: args.cause },
    );
    this.toolName = args.toolName;
  }
}
registerAgentickError("TerminalToolNameCollision", TerminalToolNameCollision);

/**
 * A required structured-output terminal tool was never called
 * (three-audiences-plan §B2). Raised after the natural path AND the forced
 * wrap-up tick (`toolChoice: { tool }`) fail to elicit the terminal call —
 * the honest-failure sliver the guarantees chain documents. Loop-side: the
 * loop owns terminal detection + the wrap-up rung.
 *
 * `session.reflect()` raises it too, with `reason: "no_terminal_call"` — a
 * reflection has one tick, so it has no wrap-up rung to reach `"max_ticks"`.
 * It stays a `LoopExecutorError` rather than being re-homed: the taxonomy names
 * where the semantics were defined, and a second class for the same failure
 * would be the drift this error exists to report.
 */
export class StructuredOutputIncomplete extends LoopExecutorError {
  readonly _tag = "StructuredOutputIncomplete" as const;
  readonly toolName: string;
  readonly reason: "max_ticks" | "no_terminal_call";
  constructor(args: {
    readonly toolName: string;
    readonly reason: "max_ticks" | "no_terminal_call";
    readonly cause?: unknown;
  }) {
    super(
      `structured output incomplete: the model ended without calling the ` +
        `terminal tool "${args.toolName}" (${args.reason})`,
      { cause: args.cause },
    );
    this.toolName = args.toolName;
    this.reason = args.reason;
  }
}
registerAgentickError("StructuredOutputIncomplete", StructuredOutputIncomplete);

/**
 * More than one tree-level `<Output>` declaration was rendered
 * (three-audiences-plan §B2). Multi-output extraction is not supported yet —
 * one execution produces one shape. Fail loud rather than silently picking the
 * first. (A send-level `SendInput.output` overrides the tree entirely, so this
 * only fires when the tree alone declares 2+ outputs.)
 */
export class MultipleStructuredOutputs extends LoopExecutorError {
  readonly _tag = "MultipleStructuredOutputs" as const;
  readonly count: number;
  constructor(args: { readonly count: number; readonly cause?: unknown }) {
    super(
      `${args.count} <Output> declarations rendered — multi-output extraction ` +
        `is not supported; declare a single output shape`,
      { cause: args.cause },
    );
    this.count = args.count;
  }
}
registerAgentickError("MultipleStructuredOutputs", MultipleStructuredOutputs);

export type LoopExecutorErrorChannel =
  | ExecutionError
  | TickError
  | LoopCanceledError
  | MaxTicksExceeded
  | TerminalToolNameCollision
  | StructuredOutputIncomplete
  | MultipleStructuredOutputs;

// ============================================================================
// ReconcileError — compiler render + snapshot failures
// ============================================================================

export abstract class ReconcileError extends AgentickError {}

export class NotMounted extends ReconcileError {
  readonly _tag = "NotMounted" as const;
  readonly mountId: string;
  constructor(args: { readonly mountId: string; readonly cause?: unknown }) {
    super(`compiler not mounted: ${args.mountId}`, { cause: args.cause });
    this.mountId = args.mountId;
  }
}
registerAgentickError("NotMounted", NotMounted);

export class AlreadyMounted extends ReconcileError {
  readonly _tag = "AlreadyMounted" as const;
  readonly mountId: string;
  constructor(args: { readonly mountId: string; readonly cause?: unknown }) {
    super(`compiler already mounted: ${args.mountId}`, { cause: args.cause });
    this.mountId = args.mountId;
  }
}
registerAgentickError("AlreadyMounted", AlreadyMounted);

export class RenderFailed extends ReconcileError {
  readonly _tag = "RenderFailed" as const;
  override readonly cause: unknown;
  readonly path?: string;
  constructor(args: { readonly cause: unknown; readonly path?: string }) {
    super(`render failed${args.path ? ` at ${args.path}` : ""}: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.cause = args.cause;
    if (args.path !== undefined) this.path = args.path;
  }
}
registerAgentickError("RenderFailed", RenderFailed);

export class DataFetchFailed extends ReconcileError {
  readonly _tag = "DataFetchFailed" as const;
  readonly key: string;
  override readonly cause: unknown;
  constructor(args: { readonly key: string; readonly cause: unknown }) {
    super(`data fetch failed (${args.key}): ${String(args.cause)}`, { cause: args.cause });
    this.key = args.key;
    this.cause = args.cause;
  }
}
registerAgentickError("DataFetchFailed", DataFetchFailed);

export class MaxIterationsExceeded extends ReconcileError {
  readonly _tag = "MaxIterationsExceeded" as const;
  readonly iterations: number;
  readonly reason?: string;
  constructor(args: {
    readonly iterations: number;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(`max reconcile iterations (${args.iterations})${args.reason ? `: ${args.reason}` : ""}`, {
      cause: args.cause,
    });
    this.iterations = args.iterations;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("MaxIterationsExceeded", MaxIterationsExceeded);

export class UnstableTree extends ReconcileError {
  readonly _tag = "UnstableTree" as const;
  readonly iterations: number;
  constructor(args: { readonly iterations: number; readonly cause?: unknown }) {
    super(`unstable tree after ${args.iterations} iterations`, { cause: args.cause });
    this.iterations = args.iterations;
  }
}
registerAgentickError("UnstableTree", UnstableTree);

export class InvalidElement extends ReconcileError {
  readonly _tag = "InvalidElement" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`invalid element: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("InvalidElement", InvalidElement);

export class SnapshotIncompatible extends ReconcileError {
  readonly _tag = "SnapshotIncompatible" as const;
  readonly specVersion: string;
  readonly reason?: string;
  constructor(args: {
    readonly specVersion: string;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(
      `snapshot incompatible (specVersion=${args.specVersion})${args.reason ? `: ${args.reason}` : ""}`,
      { cause: args.cause },
    );
    this.specVersion = args.specVersion;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("SnapshotIncompatible", SnapshotIncompatible);

export class BridgeUnavailable extends ReconcileError {
  readonly _tag = "BridgeUnavailable" as const;
  readonly bridge: string;
  readonly hook: string;
  constructor(args: { readonly bridge: string; readonly hook: string; readonly cause?: unknown }) {
    super(`bridge unavailable: ${args.bridge}.${args.hook}`, { cause: args.cause });
    this.bridge = args.bridge;
    this.hook = args.hook;
  }
}
registerAgentickError("BridgeUnavailable", BridgeUnavailable);

export class FormatterFailed extends ReconcileError {
  readonly _tag = "FormatterFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`formatter failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("FormatterFailed", FormatterFailed);

export type ReconcileErrorChannel =
  | NotMounted
  | AlreadyMounted
  | RenderFailed
  | DataFetchFailed
  | MaxIterationsExceeded
  | UnstableTree
  | InvalidElement
  | SnapshotIncompatible
  | BridgeUnavailable
  | FormatterFailed;

// ============================================================================
// ExecuteError — model-provider call failures
// ============================================================================

export abstract class ExecuteError extends AgentickError {
  abstract override readonly _tag:
    | "ProviderRejected"
    | "ProviderTimeout"
    | "ProviderAborted"
    | "StreamFailed"
    | "MalformedModelOutput";
}

/**
 * The cause's own words, for a wrapper whose message would otherwise be a bare
 * classification.
 *
 * A wrapping error's `message` should be USEFUL, because it is what every consumer
 * reads — a log line, a telemetry attribute, an eval score, a UI. The `_tag` already
 * carries the classification, so repeating it in prose buys nothing while burying
 * the one sentence that explains the failure. Exported so any future wrapper has a
 * single right way to do this rather than reinventing the format.
 *
 * Returns `undefined` when the cause has nothing to say, which is when a bare
 * classification is the honest message.
 *
 * NOT applied in {@link AgentickError} itself, deliberately: a `cause` may carry
 * secrets, which is why some subclasses redact it from `toJSON()`. Folding a cause
 * into `message` — always serialized — would defeat that. It is the WRAPPER's call,
 * made where the wrapper knows what its cause is.
 */
export function causeMessage(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  // Covers AgentickError too — a nested one contributes its own composed message.
  if (cause instanceof Error) return clampErrorDetail(cause.message) || undefined;
  if (typeof cause === "string") return clampErrorDetail(cause) || undefined;
  const text = String(cause);
  return text === "" || text === "[object Object]" ? undefined : clampErrorDetail(text);
}

const ERROR_DETAIL_MAX = 2_048;

/**
 * A message is a sentence, not a payload. Providers echo request bytes into
 * their error strings (Gemini: the full base64 of a rejected image), and a
 * wrapper's message lands on the timeline, in logs, and in telemetry — the
 * uncut original stays on `cause` for whoever walks it.
 */
export function clampErrorDetail(text: string): string {
  return text.length <= ERROR_DETAIL_MAX
    ? text
    : `${text.slice(0, ERROR_DETAIL_MAX)}… [+${text.length - ERROR_DETAIL_MAX} chars]`;
}

export class ProviderRejected extends ExecuteError {
  readonly _tag = "ProviderRejected" as const;
  readonly status?: number;
  override readonly cause?: unknown;
  constructor(args?: {
    readonly status?: number;
    readonly cause?: unknown;
    /**
     * The message to report, when the adapter can do better than the cause's own.
     *
     * A provider SDK's `Error.message` is often a serialized envelope rather than a
     * sentence — Google's is a JSON string containing another JSON string, whose
     * innermost `error.message` is the only human-readable part. An adapter that
     * knows its provider's shape extracts that in `mapProviderError` and supplies it
     * here; the raw envelope stays on `cause`, so nothing is lost and the UI is not
     * handed 400 characters of escaped JSON to render.
     */
    readonly message?: string;
  }) {
    const statusPart = args?.status !== undefined ? ` (status=${args.status})` : "";
    // Adopt the cause's message. This was the ONE error in the family that did not
    // (`StreamFailed`, `NormalizationFailed`, `ProjectionFailed` and
    // `UnknownExecutorError` all inline theirs), and it is the wrapper the loop
    // puts around a failed stream — so the informative message went in and
    // `"provider rejected"` came out. That string was then the entire explanation
    // a caller, a log, and a UI ever saw, while the actual sentence — "Project/
    // location and API key are mutually exclusive in the client initializer" — sat
    // two levels down in `cause`, reachable only by a consumer that knew to walk it.
    //
    // No prefix: `_tag` is the classification and the grep key. Prefixing here
    // would stack "provider rejected: provider stream failed: …" on a chain that is
    // already nested.
    // Precedence: an adapter's extracted message (it knows its provider's envelope
    // shape) > the cause's own words > the bare classification.
    const detail =
      args?.message !== undefined ? clampErrorDetail(args.message) : causeMessage(args?.cause);
    super(detail !== undefined ? `${detail}${statusPart}` : `provider rejected${statusPart}`, {
      cause: args?.cause,
    });
    if (args?.status !== undefined) this.status = args.status;
    if (args?.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("ProviderRejected", ProviderRejected);

/**
 * The provider did not answer in time. `timeoutMs` is optional because the
 * shapes that classify here — an SDK's own timeout error, an `ETIMEDOUT`
 * socket — report that a deadline passed without naming it; a caller that set
 * the deadline itself supplies it and gets the sharper message.
 */
export class ProviderTimeout extends ExecuteError {
  readonly _tag = "ProviderTimeout" as const;
  readonly timeoutMs?: number;
  constructor(args?: { readonly timeoutMs?: number; readonly cause?: unknown }) {
    super(
      args?.timeoutMs !== undefined
        ? `provider timed out after ${args.timeoutMs}ms`
        : `provider timed out`,
      { cause: args?.cause },
    );
    if (args?.timeoutMs !== undefined) this.timeoutMs = args.timeoutMs;
  }
}
registerAgentickError("ProviderTimeout", ProviderTimeout);

export class ProviderAborted extends ExecuteError {
  readonly _tag = "ProviderAborted" as const;
  readonly reason?: string;
  constructor(args?: { readonly reason?: string; readonly cause?: unknown }) {
    super(args?.reason ? `provider aborted: ${args.reason}` : `provider aborted`, {
      cause: args?.cause,
    });
    if (args?.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ProviderAborted", ProviderAborted);

export class StreamFailed extends ExecuteError {
  readonly _tag = "StreamFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`provider stream failed: ${clampErrorDetail(String(args.cause))}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("StreamFailed", StreamFailed);

/**
 * The model emitted something no consumer can act on — a tool call whose
 * argument JSON does not parse, a provider finish reason that reports the
 * generation itself as malformed. Distinct from {@link ProviderRejected} because
 * the request was fine: this is nondeterministic model output, and re-issuing an
 * identical request is a promising recovery (ADR 99). Only the adapter can tell
 * the two apart, which is why it is classified there.
 */
export class MalformedModelOutput extends ExecuteError {
  readonly _tag = "MalformedModelOutput" as const;
  readonly toolName?: string;
  override readonly cause?: unknown;
  readonly rawArguments?: string;
  constructor(args?: {
    readonly toolName?: string;
    /** The unusable fragment, verbatim. Redacted from {@link toJSON}. */
    readonly rawArguments?: string;
    readonly cause?: unknown;
  }) {
    const toolPart = args?.toolName !== undefined ? ` (tool=${args.toolName})` : "";
    const detail = causeMessage(args?.cause);
    super(detail !== undefined ? `${detail}${toolPart}` : `malformed model output${toolPart}`, {
      cause: args?.cause,
    });
    if (args?.toolName !== undefined) this.toolName = args.toolName;
    if (args?.rawArguments !== undefined) this.rawArguments = args.rawArguments;
    if (args?.cause !== undefined) this.cause = args.cause;
  }

  /** Model output may carry user data, and this projection crosses the wire. */
  override toJSON(): SerializedAgentickError {
    const { rawArguments: _redacted, ...rest } = super.toJSON();
    return rest as SerializedAgentickError;
  }
}
registerAgentickError("MalformedModelOutput", MalformedModelOutput);

export type ExecuteErrorChannel =
  | ProviderRejected
  | ProviderTimeout
  | ProviderAborted
  | StreamFailed
  | MalformedModelOutput;

/**
 * Narrows to the CHANNEL rather than the abstract class: `ExecuteError` declares
 * `_tag` as the union of its subclasses' tags, which TypeScript will not accept
 * where a {@link ExecuteErrorChannel} member is expected. Every consumer that
 * re-raises an already-classified failure instead of re-wrapping it needs this.
 */
export function isExecuteError(value: unknown): value is ExecuteErrorChannel {
  return value instanceof ExecuteError;
}

/**
 * `ProjectionFailed` — JSX → model-input projection step. Carried in
 * the executor's terminal `failed` outcome alongside provider/normalize
 * failures.
 */
export class ProjectionFailed extends AgentickError {
  readonly _tag = "ProjectionFailed" as const;
  readonly reason: string;
  override readonly cause?: unknown;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`projection failed: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}
registerAgentickError("ProjectionFailed", ProjectionFailed);

/**
 * `UnknownExecutorError` — catch-all for executor failures that don't
 * fit the typed cases. Concrete class directly under `AgentickError`.
 */
export class UnknownExecutorError extends AgentickError {
  readonly _tag = "Unknown" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`unknown executor error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("Unknown", UnknownExecutorError);

/**
 * Full executor failure channel — overlaps with `ExecuteErrorChannel`
 * (provider call failures) and adds projection/normalize/unknown.
 * Replaces the legacy POJO `ExecutorError` union in
 * `data/execution-result.ts`.
 */
export type ExecutorErrorChannel =
  | ProjectionFailed
  | ProviderRejected
  | ProviderTimeout
  | ProviderAborted
  | StreamFailed
  | MalformedModelOutput
  | NormalizationFailed
  | UnknownExecutorError;

/**
 * Single-tag normalization failure. Concrete class directly under
 * `AgentickError` — no abstract intermediate.
 */
export class NormalizationFailed extends AgentickError {
  readonly _tag = "NormalizationFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`normalization failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("NormalizationFailed", NormalizationFailed);

// ============================================================================
// TimelineError — timeline projection failures
// ============================================================================

export abstract class TimelineError extends AgentickError {}

export class CompactHandlerFailed extends TimelineError {
  readonly _tag = "CompactHandlerFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`compact handler failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("CompactHandlerFailed", CompactHandlerFailed);

/**
 * The timeline's GENESIS seam threw (ADR 93 landmine 2). A hydrator failing is
 * not recoverable at session-open: a half-genesis session would render against a
 * partial conversation, so session CREATION fails with this instead. Carries the
 * hydrator's own error as `cause`.
 */
export class TimelineHydrateFailed extends TimelineError {
  readonly _tag = "TimelineHydrateFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`timeline hydrate (genesis) failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("TimelineHydrateFailed", TimelineHydrateFailed);

/**
 * `compact()` was invoked with no strategy argument and no
 * construction-bound default (`TimelineHarnessOptions.compact` /
 * `withTimeline({ compact })`). The no-arg signal form (ADR 51 — the
 * form that crosses the inbox/wire) requires a configured default.
 */
export class CompactStrategyMissing extends TimelineError {
  readonly _tag = "CompactStrategyMissing" as const;
  constructor() {
    super(
      "compact() requires a strategy: none supplied and no construction-bound default is configured (withTimeline({ compact }))",
      {},
    );
  }
}
registerAgentickError("CompactStrategyMissing", CompactStrategyMissing);

export type TimelineErrorChannel =
  | CompactHandlerFailed
  | TimelineHydrateFailed
  | CompactStrategyMissing;

// ============================================================================
// ToolExecutorError — tool dispatch failures
// ============================================================================

export abstract class ToolExecutorError extends AgentickError {}

export class ToolNotFoundError extends ToolExecutorError {
  readonly _tag = "ToolNotFoundError" as const;
  readonly toolName: string;
  readonly registered: readonly string[];
  constructor(args: {
    readonly toolName: string;
    readonly registered: readonly string[];
    readonly cause?: unknown;
  }) {
    super(`tool ${args.toolName} not found`, { cause: args.cause });
    this.toolName = args.toolName;
    this.registered = args.registered;
  }
}
registerAgentickError("ToolNotFoundError", ToolNotFoundError);

interface StandardSchemaIssueLike {
  readonly path?: ReadonlyArray<string | number | { readonly key: string | number }>;
  readonly message: string;
}

/** How many issues a validation message names before it summarizes the rest. */
const VALIDATION_ISSUES_IN_MESSAGE = 3;

/**
 * The issues as a sentence — `amount: expected number; items.0.id: required`.
 *
 * Same discipline as {@link causeMessage}: `message` is what every consumer
 * reads, and here one of those consumers is the MODEL (the loop renders this
 * text into the failed `tool_result` it persists, ADR 99 slice 4b), which
 * cannot correct an argument the message never names. Bounded, because a
 * hundred-issue schema failure would otherwise become the turn's largest
 * message.
 */
function describeIssues(issues: readonly StandardSchemaIssueLike[]): string | undefined {
  if (issues.length === 0) return undefined;
  const named = issues.slice(0, VALIDATION_ISSUES_IN_MESSAGE).map((issue) => {
    const path = (issue.path ?? [])
      .map((seg) => (typeof seg === "object" ? String(seg.key) : String(seg)))
      .join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  const rest = issues.length - named.length;
  return rest > 0 ? `${named.join("; ")} (+${rest} more)` : named.join("; ");
}

export class ToolValidationError extends ToolExecutorError {
  readonly _tag = "ToolValidationError" as const;
  readonly toolName: string;
  readonly issues: readonly StandardSchemaIssueLike[];
  constructor(args: {
    readonly toolName: string;
    readonly issues: readonly StandardSchemaIssueLike[];
    readonly cause?: unknown;
  }) {
    const detail = describeIssues(args.issues);
    super(`tool ${args.toolName} validation failed${detail !== undefined ? `: ${detail}` : ""}`, {
      cause: args.cause,
    });
    this.toolName = args.toolName;
    this.issues = args.issues;
  }
}
registerAgentickError("ToolValidationError", ToolValidationError);

export class ToolHandlerError extends ToolExecutorError {
  readonly _tag = "ToolHandlerError" as const;
  readonly toolName: string;
  override readonly cause: unknown;
  constructor(args: { readonly toolName: string; readonly cause: unknown }) {
    super(`tool ${args.toolName} handler error: ${String(args.cause)}`, { cause: args.cause });
    this.toolName = args.toolName;
    this.cause = args.cause;
  }
}
registerAgentickError("ToolHandlerError", ToolHandlerError);

export class ToolPermissionError extends ToolExecutorError {
  readonly _tag = "ToolPermissionError" as const;
  readonly toolName: string;
  readonly via: unknown;
  readonly reason?: string;
  constructor(args: {
    readonly toolName: string;
    readonly via: unknown;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(`tool ${args.toolName} permission denied${args.reason ? `: ${args.reason}` : ""}`, {
      cause: args.cause,
    });
    this.toolName = args.toolName;
    this.via = args.via;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ToolPermissionError", ToolPermissionError);

export class ToolTimeoutError extends ToolExecutorError {
  readonly _tag = "ToolTimeoutError" as const;
  readonly toolName: string;
  readonly ms: number;
  constructor(args: { readonly toolName: string; readonly ms: number; readonly cause?: unknown }) {
    super(`tool ${args.toolName} timed out after ${args.ms}ms`, { cause: args.cause });
    this.toolName = args.toolName;
    this.ms = args.ms;
  }
}
registerAgentickError("ToolTimeoutError", ToolTimeoutError);

export class ToolConfirmationDeniedError extends ToolExecutorError {
  readonly _tag = "ToolConfirmationDeniedError" as const;
  readonly toolName: string;
  readonly reason?: string;
  constructor(args: {
    readonly toolName: string;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(`tool ${args.toolName} confirmation denied${args.reason ? `: ${args.reason}` : ""}`, {
      cause: args.cause,
    });
    this.toolName = args.toolName;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ToolConfirmationDeniedError", ToolConfirmationDeniedError);

/**
 * Nobody answered the ask before its deadline. The one confirmation outcome
 * that REJECTS, so it carries the {@link ToolConfirmationResolution} the
 * other three publish on `DispatchResult.confirmation` — an interceptor
 * watching decisions must not have to infer this arm from an absence.
 */
export class ToolConfirmationTimeoutError extends ToolExecutorError {
  readonly _tag = "ToolConfirmationTimeoutError" as const;
  readonly toolName: string;
  readonly ms: number;
  readonly confirmation?: ToolConfirmationResolution;
  constructor(args: {
    readonly toolName: string;
    readonly ms: number;
    readonly confirmation?: ToolConfirmationResolution;
    readonly cause?: unknown;
  }) {
    super(`tool ${args.toolName} confirmation timed out after ${args.ms}ms`, { cause: args.cause });
    this.toolName = args.toolName;
    this.ms = args.ms;
    if (args.confirmation !== undefined) this.confirmation = args.confirmation;
  }
}
registerAgentickError("ToolConfirmationTimeoutError", ToolConfirmationTimeoutError);

/**
 * A CLIENT-HANDLED tool dispatch (declaration carried no `handlerRef`,
 * `annotations.requiresResponse === true`) waited past its response
 * timeout for the client's relayed result and no `defaultResult`
 * fallback was declared. HARD failure — the dispatch rejects. The
 * client-tools twin of {@link ToolConfirmationTimeoutError}.
 */
export class ToolCallTimeoutError extends ToolExecutorError {
  readonly _tag = "ToolCallTimeoutError" as const;
  readonly toolName: string;
  readonly ms: number;
  constructor(args: { readonly toolName: string; readonly ms: number; readonly cause?: unknown }) {
    super(`tool ${args.toolName} client call timed out after ${args.ms}ms`, { cause: args.cause });
    this.toolName = args.toolName;
    this.ms = args.ms;
  }
}
registerAgentickError("ToolCallTimeoutError", ToolCallTimeoutError);

export class ToolAbortedError extends ToolExecutorError {
  readonly _tag = "ToolAbortedError" as const;
  readonly toolCallId: string;
  readonly reason?: string;
  constructor(args: {
    readonly toolCallId: string;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(`tool call ${args.toolCallId} aborted${args.reason ? `: ${args.reason}` : ""}`, {
      cause: args.cause,
    });
    this.toolCallId = args.toolCallId;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ToolAbortedError", ToolAbortedError);

export class ToolAlreadyRegistered extends ToolExecutorError {
  readonly _tag = "ToolAlreadyRegistered" as const;
  readonly toolName: string;
  constructor(args: { readonly toolName: string; readonly cause?: unknown }) {
    super(`tool ${args.toolName} already registered`, { cause: args.cause });
    this.toolName = args.toolName;
  }
}
registerAgentickError("ToolAlreadyRegistered", ToolAlreadyRegistered);

export class ToolHandlerMissing extends ToolExecutorError {
  readonly _tag = "ToolHandlerMissing" as const;
  readonly toolName: string;
  readonly handlerRef: string;
  constructor(args: {
    readonly toolName: string;
    readonly handlerRef: string;
    readonly cause?: unknown;
  }) {
    super(`tool ${args.toolName} handler missing (ref=${args.handlerRef})`, { cause: args.cause });
    this.toolName = args.toolName;
    this.handlerRef = args.handlerRef;
  }
}
registerAgentickError("ToolHandlerMissing", ToolHandlerMissing);

export class ToolTaskModeConflictError extends ToolExecutorError {
  readonly _tag = "ToolTaskModeConflictError" as const;
  readonly toolName: string;
  readonly requestedTaskMode: "ref" | "inline";
  readonly supportMode: "unsupported" | "supported" | "required";
  constructor(args: {
    readonly toolName: string;
    readonly requestedTaskMode: "ref" | "inline";
    readonly supportMode: "unsupported" | "supported" | "required";
    readonly cause?: unknown;
  }) {
    super(
      `tool ${args.toolName} task mode conflict: requested=${args.requestedTaskMode}, support=${args.supportMode}`,
      { cause: args.cause },
    );
    this.toolName = args.toolName;
    this.requestedTaskMode = args.requestedTaskMode;
    this.supportMode = args.supportMode;
  }
}
registerAgentickError("ToolTaskModeConflictError", ToolTaskModeConflictError);

export type ToolExecutorErrorChannel =
  | ToolNotFoundError
  | ToolValidationError
  | ToolHandlerError
  | ToolPermissionError
  | ToolTimeoutError
  | ToolConfirmationDeniedError
  | ToolConfirmationTimeoutError
  | ToolCallTimeoutError
  | ToolAbortedError
  | ToolAlreadyRegistered
  | ToolHandlerMissing
  | ToolTaskModeConflictError;

// ============================================================================
// PromptsError — prompt registry + invocation failures
// ============================================================================

export abstract class PromptsError extends AgentickError {}

export class PromptNotFound extends PromptsError {
  readonly _tag = "PromptNotFound" as const;
  readonly promptName: string;
  constructor(args: { readonly promptName: string; readonly cause?: unknown }) {
    super(`prompt ${args.promptName} not found`, { cause: args.cause });
    this.promptName = args.promptName;
  }
}
registerAgentickError("PromptNotFound", PromptNotFound);

export class PromptAlreadyExists extends PromptsError {
  readonly _tag = "PromptAlreadyExists" as const;
  readonly promptName: string;
  constructor(args: { readonly promptName: string; readonly cause?: unknown }) {
    super(`prompt ${args.promptName} already exists`, { cause: args.cause });
    this.promptName = args.promptName;
  }
}
registerAgentickError("PromptAlreadyExists", PromptAlreadyExists);

export class PromptArgumentMissing extends PromptsError {
  readonly _tag = "PromptArgumentMissing" as const;
  readonly promptName: string;
  readonly argument: string;
  constructor(args: {
    readonly promptName: string;
    readonly argument: string;
    readonly cause?: unknown;
  }) {
    super(`prompt ${args.promptName} missing argument: ${args.argument}`, { cause: args.cause });
    this.promptName = args.promptName;
    this.argument = args.argument;
  }
}
registerAgentickError("PromptArgumentMissing", PromptArgumentMissing);

interface PromptIssueLike {
  readonly path?: ReadonlyArray<string | number>;
  readonly message: string;
}

export class PromptArgumentInvalid extends PromptsError {
  readonly _tag = "PromptArgumentInvalid" as const;
  readonly promptName: string;
  readonly argument: string;
  readonly issues: readonly PromptIssueLike[];
  constructor(args: {
    readonly promptName: string;
    readonly argument: string;
    readonly issues: readonly PromptIssueLike[];
    readonly cause?: unknown;
  }) {
    super(`prompt ${args.promptName} invalid argument ${args.argument}`, { cause: args.cause });
    this.promptName = args.promptName;
    this.argument = args.argument;
    this.issues = args.issues;
  }
}
registerAgentickError("PromptArgumentInvalid", PromptArgumentInvalid);

export class PromptMissingContent extends PromptsError {
  readonly _tag = "PromptMissingContent" as const;
  readonly promptName: string;
  constructor(args: { readonly promptName: string; readonly cause?: unknown }) {
    super(`prompt ${args.promptName} produced no content`, { cause: args.cause });
    this.promptName = args.promptName;
  }
}
registerAgentickError("PromptMissingContent", PromptMissingContent);

export class PromptRenderFailed extends PromptsError {
  readonly _tag = "PromptRenderFailed" as const;
  readonly promptName: string;
  override readonly cause: unknown;
  constructor(args: { readonly promptName: string; readonly cause: unknown }) {
    super(`prompt ${args.promptName} render failed: ${String(args.cause)}`, { cause: args.cause });
    this.promptName = args.promptName;
    this.cause = args.cause;
  }
}
registerAgentickError("PromptRenderFailed", PromptRenderFailed);

export class PromptsBackendError extends PromptsError {
  readonly _tag = "PromptsBackendError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`prompts backend error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("PromptsBackendError", PromptsBackendError);

/**
 * The prompts GENESIS seam threw (ADR 93 landmine 2). A hydrator failing is not
 * recoverable at session-open: a half-genesis catalog would leave the session
 * rendering against a partial prompt library, so session CREATION fails with
 * this instead. Carries the hydrator's own error as `cause`.
 */
export class PromptsHydrateFailed extends PromptsError {
  readonly _tag = "PromptsHydrateFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`prompts hydrate (genesis) failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("PromptsHydrateFailed", PromptsHydrateFailed);

export type PromptsErrorChannel =
  | PromptNotFound
  | PromptAlreadyExists
  | PromptArgumentMissing
  | PromptArgumentInvalid
  | PromptMissingContent
  | PromptRenderFailed
  | PromptsBackendError
  | PromptsHydrateFailed;

// ============================================================================
// ResourcesError — resource registry (URI → resolver) failures (ADR 62)
// ============================================================================

export abstract class ResourcesError extends AgentickError {}

export class ResourceNotFound extends ResourcesError {
  readonly _tag = "ResourceNotFound" as const;
  readonly uri: string;
  constructor(args: { readonly uri: string; readonly cause?: unknown }) {
    super(`resource ${args.uri} not found`, { cause: args.cause });
    this.uri = args.uri;
  }
}
registerAgentickError("ResourceNotFound", ResourceNotFound);

export class ResourceAlreadyRegistered extends ResourcesError {
  readonly _tag = "ResourceAlreadyRegistered" as const;
  readonly uri: string;
  constructor(args: { readonly uri: string; readonly cause?: unknown }) {
    super(`resource ${args.uri} already registered`, { cause: args.cause });
    this.uri = args.uri;
  }
}
registerAgentickError("ResourceAlreadyRegistered", ResourceAlreadyRegistered);

/**
 * A uri offered as an ALIAS by more than one registration — so reading it would
 * have to pick a winner.
 *
 * Thrown rather than resolved because the alternative is worse than a failure: two
 * MCP servers both publishing `config://app` register under distinct namespaced
 * uris (no shadowing), and both offer the bare uri as an alias. Silently answering
 * with whichever registered first hands the caller ANOTHER SERVER'S data under the
 * name it asked for — a wrong answer that looks right. The candidates are named so
 * the caller can address one exactly.
 */
export class ResourceAliasAmbiguous extends ResourcesError {
  readonly _tag = "ResourceAliasAmbiguous" as const;
  readonly uri: string;
  /** The registered uris that all claim `uri` as an alias. */
  readonly candidates: readonly string[];
  constructor(args: {
    readonly uri: string;
    readonly candidates: readonly string[];
    readonly cause?: unknown;
  }) {
    super(
      `resource alias ${args.uri} is ambiguous — claimed by ${args.candidates.join(", ")}; ` +
        `read one of those uris directly`,
      { cause: args.cause },
    );
    this.uri = args.uri;
    this.candidates = args.candidates;
  }
}
registerAgentickError("ResourceAliasAmbiguous", ResourceAliasAmbiguous);

export class ResourceResolverFailed extends ResourcesError {
  readonly _tag = "ResourceResolverFailed" as const;
  readonly uri: string;
  override readonly cause: unknown;
  constructor(args: { readonly uri: string; readonly cause: unknown }) {
    super(`resource ${args.uri} resolver failed: ${String(args.cause)}`, { cause: args.cause });
    this.uri = args.uri;
    this.cause = args.cause;
  }
}
registerAgentickError("ResourceResolverFailed", ResourceResolverFailed);

export class ResourcesBackendError extends ResourcesError {
  readonly _tag = "ResourcesBackendError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`resources backend error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("ResourcesBackendError", ResourcesBackendError);

export type ResourcesErrorChannel =
  | ResourceNotFound
  | ResourceAlreadyRegistered
  | ResourceAliasAmbiguous
  | ResourceResolverFailed
  | ResourcesBackendError;

// ============================================================================
// CompletionsError — argument-completion registry failures
// ============================================================================

export abstract class CompletionsError extends AgentickError {}

/**
 * `resolve` named a completion that is not registered. Errors-over-nulls: an
 * empty value list would read as "this argument has no candidates", which is a
 * wrong answer that looks right. A wire projection that WANTS the best-effort
 * empty (MCP's `completion/complete` probes freely) catches this at the wire.
 */
export class CompletionNotFound extends CompletionsError {
  readonly _tag = "CompletionNotFound" as const;
  /** `completionName`, not `name` — `name` is `Error`'s own slot (the class name). */
  readonly completionName: string;
  constructor(args: { readonly completionName: string; readonly cause?: unknown }) {
    super(`completion ${args.completionName} not found`, { cause: args.cause });
    this.completionName = args.completionName;
  }
}
registerAgentickError("CompletionNotFound", CompletionNotFound);

/** The registered resolver threw or rejected. Carries the source name + cause. */
export class CompletionResolveFailed extends CompletionsError {
  readonly _tag = "CompletionResolveFailed" as const;
  readonly completionName: string;
  override readonly cause: unknown;
  constructor(args: { readonly completionName: string; readonly cause: unknown }) {
    super(`completion ${args.completionName} resolver failed: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.completionName = args.completionName;
    this.cause = args.cause;
  }
}
registerAgentickError("CompletionResolveFailed", CompletionResolveFailed);

export type CompletionsErrorChannel = CompletionNotFound | CompletionResolveFailed;

// ============================================================================
// GatesError — gate registry failures (ADR 27 GatesHarness)
// ============================================================================

export abstract class GatesError extends AgentickError {}

/**
 * A gate verb (`gates:clear` / `gates:defer` / `gates:override`) named a gate
 * that is not registered. Errors-over-nulls: the command rejects rather than
 * silently no-op'ing, so a wire caller learns the name was wrong.
 */
export class GateNotFound extends GatesError {
  readonly _tag = "GateNotFound" as const;
  readonly gateName: string;
  constructor(args: { readonly gateName: string; readonly cause?: unknown }) {
    super(`gate ${args.gateName} not found`, { cause: args.cause });
    this.gateName = args.gateName;
  }
}
registerAgentickError("GateNotFound", GateNotFound);

export type GatesErrorChannel = GateNotFound;

// ============================================================================
// SkillsError — skill registry failures
// ============================================================================

export abstract class SkillsError extends AgentickError {}

export class SkillNotFound extends SkillsError {
  readonly _tag = "SkillNotFound" as const;
  readonly skillName: string;
  constructor(args: { readonly skillName: string; readonly cause?: unknown }) {
    super(`skill ${args.skillName} not found`, { cause: args.cause });
    this.skillName = args.skillName;
  }
}
registerAgentickError("SkillNotFound", SkillNotFound);

export class SkillAlreadyExists extends SkillsError {
  readonly _tag = "SkillAlreadyExists" as const;
  readonly skillName: string;
  constructor(args: { readonly skillName: string; readonly cause?: unknown }) {
    super(`skill ${args.skillName} already exists`, { cause: args.cause });
    this.skillName = args.skillName;
  }
}
registerAgentickError("SkillAlreadyExists", SkillAlreadyExists);

export class SkillsBackendError extends SkillsError {
  readonly _tag = "SkillsBackendError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`skills backend error: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("SkillsBackendError", SkillsBackendError);

/**
 * `skills.run(name, { isolate: true })` — the isolated (fork) execution site
 * is not yet available. C-core (three-audiences-plan §C split) ships
 * `skills.run` INLINE only; the fork enabler (`session.fork()` + the session
 * retaining its own agent root so `SpawnInput.agent` can default) is the C2
 * follow-up. Thrown eagerly rather than silently degrading to an inline run —
 * an adopter who asked for isolation must not get non-isolated execution.
 */
export class SkillIsolationUnavailable extends SkillsError {
  readonly _tag = "SkillIsolationUnavailable" as const;
  readonly skillName: string;
  constructor(args: { readonly skillName: string; readonly cause?: unknown }) {
    super(
      `skill ${args.skillName}: isolated run (isolate: true) is not yet available — ` +
        `the session.fork() enabler ships in C2 (three-audiences-plan §C split, item 3). ` +
        `Run inline (omit isolate) for now.`,
      { cause: args.cause },
    );
    this.skillName = args.skillName;
  }
}
registerAgentickError("SkillIsolationUnavailable", SkillIsolationUnavailable);

/**
 * `skills.run` was called on a skills harness with no bound send runner. The
 * runner is a session capability late-bound at session install (`bindRunner` —
 * the C-core injection seam); a standalone harness constructed outside a
 * session has no way to reach `session.send`, so `run` fails loud rather than
 * dereferencing an undefined runner.
 */
export class SkillRunnerUnbound extends SkillsError {
  readonly _tag = "SkillRunnerUnbound" as const;
  readonly skillName: string;
  constructor(args: { readonly skillName: string; readonly cause?: unknown }) {
    super(
      `skill ${args.skillName}: this skills harness has no bound send runner — ` +
        `skills.run needs a session (the runner is late-bound at session install ` +
        `via bindRunner). A standalone harness cannot run skills.`,
      { cause: args.cause },
    );
    this.skillName = args.skillName;
  }
}
registerAgentickError("SkillRunnerUnbound", SkillRunnerUnbound);

/**
 * The skills GENESIS seam threw (ADR 93 landmine 2). A hydrator failing is not
 * recoverable at session-open: a half-genesis library would leave the model
 * discovering a partial skill set, so session CREATION fails with this instead.
 * Carries the hydrator's own error as `cause` — an unreachable tier catalog, an
 * unreadable skills directory, a rejected manifest fetch.
 */
export class SkillsHydrateFailed extends SkillsError {
  readonly _tag = "SkillsHydrateFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`skills hydrate (genesis) failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("SkillsHydrateFailed", SkillsHydrateFailed);

export type SkillsErrorChannel =
  | SkillNotFound
  | SkillAlreadyExists
  | SkillsBackendError
  | SkillIsolationUnavailable
  | SkillRunnerUnbound
  | SkillsHydrateFailed;

// ============================================================================
// KnobsError — knob registry + dispatch failures
// ============================================================================

export abstract class KnobsError extends AgentickError {}

export class UnknownKnob extends KnobsError {
  readonly _tag = "UnknownKnob" as const;
  readonly id: string;
  constructor(args: { readonly id: string; readonly cause?: unknown }) {
    super(`unknown knob: ${args.id}`, { cause: args.cause });
    this.id = args.id;
  }
}
registerAgentickError("UnknownKnob", UnknownKnob);

export class ValidationFailed extends KnobsError {
  readonly _tag = "ValidationFailed" as const;
  readonly id: string;
  readonly reason: string;
  constructor(args: { readonly id: string; readonly reason: string; readonly cause?: unknown }) {
    super(`knob ${args.id} validation failed: ${args.reason}`, { cause: args.cause });
    this.id = args.id;
    this.reason = args.reason;
  }
}
registerAgentickError("ValidationFailed", ValidationFailed);

export class GroupEmpty extends KnobsError {
  readonly _tag = "GroupEmpty" as const;
  readonly group: string;
  constructor(args: { readonly group: string; readonly cause?: unknown }) {
    super(`knob group ${args.group} is empty`, { cause: args.cause });
    this.group = args.group;
  }
}
registerAgentickError("GroupEmpty", GroupEmpty);

export class GroupTypeMismatch extends KnobsError {
  readonly _tag = "GroupTypeMismatch" as const;
  readonly group: string;
  readonly reason: string;
  constructor(args: { readonly group: string; readonly reason: string; readonly cause?: unknown }) {
    super(`knob group ${args.group} type mismatch: ${args.reason}`, { cause: args.cause });
    this.group = args.group;
    this.reason = args.reason;
  }
}
registerAgentickError("GroupTypeMismatch", GroupTypeMismatch);

export class InvalidDispatchInput extends KnobsError {
  readonly _tag = "InvalidDispatchInput" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`invalid dispatch input: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("InvalidDispatchInput", InvalidDispatchInput);

export type KnobsErrorChannel =
  | UnknownKnob
  | ValidationFailed
  | GroupEmpty
  | GroupTypeMismatch
  | InvalidDispatchInput;

// ============================================================================
// McpServerError — MCP server lifecycle failures
// ============================================================================

export abstract class McpServerError extends AgentickError {}

export class McpServerNotFound extends McpServerError {
  readonly _tag = "McpServerNotFound" as const;
  readonly serverName: string;
  constructor(args: { readonly serverName: string; readonly cause?: unknown }) {
    super(`mcp server ${args.serverName} not found`, { cause: args.cause });
    this.serverName = args.serverName;
  }
}
registerAgentickError("McpServerNotFound", McpServerNotFound);

export class McpServerConfigInvalid extends McpServerError {
  readonly _tag = "McpServerConfigInvalid" as const;
  readonly reason: string;
  readonly path?: readonly string[];
  constructor(args: {
    readonly reason: string;
    readonly path?: readonly string[];
    readonly cause?: unknown;
  }) {
    const pathPart = args.path ? ` at ${args.path.join(".")}` : "";
    super(`mcp server config invalid${pathPart}: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
    if (args.path !== undefined) this.path = args.path;
  }
}
registerAgentickError("McpServerConfigInvalid", McpServerConfigInvalid);

export class McpServerTransportFailed extends McpServerError {
  readonly _tag = "McpServerTransportFailed" as const;
  readonly transportKind: string;
  override readonly cause: unknown;
  constructor(args: { readonly transportKind: string; readonly cause: unknown }) {
    super(`mcp server transport ${args.transportKind} failed: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.transportKind = args.transportKind;
    this.cause = args.cause;
  }
}
registerAgentickError("McpServerTransportFailed", McpServerTransportFailed);

export class McpServerConnectionRejected extends McpServerError {
  readonly _tag = "McpServerConnectionRejected" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`mcp server connection rejected: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("McpServerConnectionRejected", McpServerConnectionRejected);

export class McpServerAuthRejected extends McpServerError {
  readonly _tag = "McpServerAuthRejected" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`mcp server auth rejected: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("McpServerAuthRejected", McpServerAuthRejected);

export class McpServerAuthzDenied extends McpServerError {
  readonly _tag = "McpServerAuthzDenied" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`mcp server authorization denied: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("McpServerAuthzDenied", McpServerAuthzDenied);

export class McpServerRateLimited extends McpServerError {
  readonly _tag = "McpServerRateLimited" as const;
  readonly retryAfterMs?: number;
  constructor(args?: { readonly retryAfterMs?: number; readonly cause?: unknown }) {
    super(
      args?.retryAfterMs !== undefined
        ? `mcp server rate limited (retryAfter=${args.retryAfterMs}ms)`
        : `mcp server rate limited`,
      { cause: args?.cause },
    );
    if (args?.retryAfterMs !== undefined) this.retryAfterMs = args.retryAfterMs;
  }
}
registerAgentickError("McpServerRateLimited", McpServerRateLimited);

export class McpServerClosed extends McpServerError {
  readonly _tag = "McpServerClosed" as const;
  readonly serverId: string;
  constructor(args: { readonly serverId: string; readonly cause?: unknown }) {
    super(`mcp server ${args.serverId} closed`, { cause: args.cause });
    this.serverId = args.serverId;
  }
}
registerAgentickError("McpServerClosed", McpServerClosed);

/**
 * Union channel for MCP server harness. Includes `JournalError`
 * (substrate cluster) because the legacy POJO union did — adopters
 * who care about journal-side failures from the MCP server's
 * substrate path keep that pattern-match.
 */
export type McpServerErrorChannel =
  | McpServerNotFound
  | McpServerConfigInvalid
  | McpServerTransportFailed
  | McpServerConnectionRejected
  | McpServerAuthRejected
  | McpServerAuthzDenied
  | McpServerRateLimited
  | McpServerClosed
  | JournalError;

// ============================================================================
// ElicitError — failures specific to the elicitation flow (form / URL),
// surfaced by the `Elicit` sugar surface regardless of routing transport
// (MCP server, in-process ElicitationHarness, future flavors).
// ============================================================================

export abstract class ElicitError extends AgentickError {
  abstract override readonly _tag:
    | "ElicitationDeclined"
    | "ElicitationCancelled"
    | "ElicitationNotSupported"
    | "UrlElicitationRequired"
    | "ElicitSchemaTooComplex";
}

/**
 * Single URL-mode elicitation spec carried by
 * {@link UrlElicitationRequired.elicitations}. The shape is
 * cross-transport — mirrors MCP's wire `data.elicitations[]` entries
 * in the `-32042` JSON-RPC error, but the same class flows through
 * in-process tool-handler dispatch too.
 */
export interface UrlElicitationSpec {
  readonly mode: "url";
  readonly elicitationId: string;
  readonly url: string;
  readonly message: string;
}

/**
 * Thrown by `ctx.elicit.requireUrls(...)` to signal that the user
 * must walk one or more URL-mode elicitations before the originating
 * tool call can complete. Canonical use case: OAuth-style deferred
 * auth.
 *
 * Transport behavior:
 *   - **MCP server:** the transport layer reads `jsonRpcCode = -32042`
 *     and maps to the corresponding wire error with
 *     `data.elicitations: [...]`. The MCP client's tool wrapper
 *     recognises -32042, walks the URLs, then retries the originating
 *     tool call.
 *   - **In-process:** the tool dispatcher catches this class and
 *     surfaces the URLs to whoever owns the session's client surface
 *     (devtools, React UI, CLI). The retry pattern is the same; only
 *     the wire format differs.
 *
 * The `jsonRpcCode` field is informational — non-MCP transports
 * ignore it. The deferred-auth PATTERN is cross-transport; only the
 * SERIALIZATION at the MCP wire edge is MCP-specific.
 */
export class UrlElicitationRequired extends ElicitError {
  readonly _tag = "UrlElicitationRequired" as const;
  readonly elicitations: readonly UrlElicitationSpec[];
  /** JSON-RPC error code surfaced by the MCP wire codec. */
  readonly jsonRpcCode = -32042 as const;
  constructor(args: {
    readonly elicitations: readonly UrlElicitationSpec[];
    readonly cause?: unknown;
  }) {
    super(
      `URL elicitation required (${args.elicitations.length} URL${args.elicitations.length === 1 ? "" : "s"})`,
      { cause: args.cause },
    );
    this.elicitations = args.elicitations;
  }
}
registerAgentickError("UrlElicitationRequired", UrlElicitationRequired);

/** The user explicitly declined the elicitation. */
export class ElicitationDeclined extends ElicitError {
  readonly _tag = "ElicitationDeclined" as const;
  readonly reason?: string;
  constructor(args?: { readonly reason?: string; readonly cause?: unknown }) {
    super(args?.reason ? `user declined: ${args.reason}` : "user declined the elicitation", {
      cause: args?.cause,
    });
    if (args?.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ElicitationDeclined", ElicitationDeclined);

/** The user dismissed the elicitation without deciding. */
export class ElicitationCancelled extends ElicitError {
  readonly _tag = "ElicitationCancelled" as const;
  readonly reason?: string;
  constructor(args?: { readonly reason?: string; readonly cause?: unknown }) {
    super(args?.reason ? `user cancelled: ${args.reason}` : "user cancelled the elicitation", {
      cause: args?.cause,
    });
    if (args?.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("ElicitationCancelled", ElicitationCancelled);

/**
 * The requested elicitation mode is not supported — the connected
 * client did not advertise the matching sub-capability
 * (`elicitation.form` or `elicitation.url`).
 */
export class ElicitationNotSupported extends ElicitError {
  readonly _tag = "ElicitationNotSupported" as const;
  readonly mode: "form" | "url";
  constructor(args: { readonly mode: "form" | "url"; readonly cause?: unknown }) {
    super(`client did not advertise the \`elicitation.${args.mode}\` sub-capability`, {
      cause: args.cause,
    });
    this.mode = args.mode;
  }
}
registerAgentickError("ElicitationNotSupported", ElicitationNotSupported);

/**
 * Form-mode schema fails the MCP spec's "flat object with primitive
 * properties" rule. Thrown synchronously by the elicitation harness
 * BEFORE issuing the wire request — bad schemas never reach the
 * client.
 *
 * The MCP `elicitation/create` request schema must be:
 *   - Top-level `type: "object"` with a `properties` map.
 *   - Property types limited to `string` / `number` / `integer` /
 *     `boolean`, single-select string `enum`, or `array` whose items
 *     are an enumerated set (`items.enum` or `items.anyOf` with
 *     `const` + `title`).
 *   - No nested objects, no free-form string arrays, no
 *     discriminated unions at the property level.
 *
 * Carries the offending schema + a list of human-readable issues so
 * adopters can fix the schema or split a nested shape into multiple
 * elicitation calls.
 */
export class ElicitSchemaTooComplex extends ElicitError {
  readonly _tag = "ElicitSchemaTooComplex" as const;
  readonly issues: readonly string[];
  readonly schema: Readonly<Record<string, unknown>>;
  constructor(args: {
    readonly issues: readonly string[];
    readonly schema: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    super(`elicitation schema is not flat per MCP spec — ${args.issues.join("; ")}`, {
      cause: args.cause,
    });
    this.issues = args.issues;
    this.schema = args.schema;
  }
}
registerAgentickError("ElicitSchemaTooComplex", ElicitSchemaTooComplex);

export type ElicitErrorChannel =
  | ElicitationDeclined
  | ElicitationCancelled
  | ElicitationNotSupported
  | UrlElicitationRequired
  | ElicitSchemaTooComplex;

// ============================================================================
// CredentialsError — CredentialsHarness backend + lookup failures (#281)
// ============================================================================

/**
 * Abstract base for credentials-store failures. `err instanceof
 * CredentialsError` matches any of the concrete subclasses below.
 *
 * **Server-resident only.** Credentials never cross the wire, so these
 * errors are not expected to round-trip across the gateway boundary
 * (registered in the codec registry anyway for consistency + future
 * adapter-level RPCs).
 */
export abstract class CredentialsError extends AgentickError {
  declare readonly _tag:
    | "CredentialsNotFound"
    | "CredentialsBackendUnavailable"
    | "CredentialsCorrupted"
    | "CredentialsWriteFailed";
}

/**
 * Adopter asked for a key that does not exist. Distinct from `has()`
 * returning `false` — `get()` may resolve `undefined` for absent keys
 * without throwing; this fires when the caller asserts presence
 * (`require`-style accessors, post-set lookups that should have hit).
 */
export class CredentialsNotFound extends CredentialsError {
  readonly _tag = "CredentialsNotFound" as const;
  readonly namespace: string;
  readonly key: string;
  constructor(args: {
    readonly namespace: string;
    readonly key: string;
    readonly cause?: unknown;
  }) {
    super(`credentials not found: ${args.namespace}/${args.key}`, { cause: args.cause });
    this.namespace = args.namespace;
    this.key = args.key;
  }
}
registerAgentickError("CredentialsNotFound", CredentialsNotFound);

/**
 * Backend cannot be reached or initialized. Keychain locked, libsecret
 * daemon down, env vars unset, KV connection refused. Recoverable on
 * the adopter side — typically by retrying after the backend recovers
 * or by falling back to a different store.
 */
export class CredentialsBackendUnavailable extends CredentialsError {
  readonly _tag = "CredentialsBackendUnavailable" as const;
  readonly backend: string;
  override readonly cause: unknown;
  constructor(args: { readonly backend: string; readonly cause: unknown }) {
    super(`credentials backend ${args.backend} unavailable: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.backend = args.backend;
    this.cause = args.cause;
  }
}
registerAgentickError("CredentialsBackendUnavailable", CredentialsBackendUnavailable);

/**
 * Stored value exists but cannot be deserialized — JSON parse error,
 * schema drift, encryption decode failure. Non-recoverable without
 * external intervention (drop + re-auth). Adopter should treat this
 * the same as `CredentialsNotFound` semantically (no usable credential)
 * but distinct for telemetry.
 */
export class CredentialsCorrupted extends CredentialsError {
  readonly _tag = "CredentialsCorrupted" as const;
  readonly namespace: string;
  readonly key: string;
  override readonly cause: unknown;
  constructor(args: { readonly namespace: string; readonly key: string; readonly cause: unknown }) {
    super(`credentials at ${args.namespace}/${args.key} corrupted: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.namespace = args.namespace;
    this.key = args.key;
    this.cause = args.cause;
  }
}
registerAgentickError("CredentialsCorrupted", CredentialsCorrupted);

/**
 * Write to the backend failed — keychain rejected, disk full, KV
 * timeout. The credential was not persisted; callers should treat the
 * operation as not having happened.
 */
export class CredentialsWriteFailed extends CredentialsError {
  readonly _tag = "CredentialsWriteFailed" as const;
  readonly namespace: string;
  readonly key: string;
  override readonly cause: unknown;
  constructor(args: { readonly namespace: string; readonly key: string; readonly cause: unknown }) {
    super(`credentials write failed at ${args.namespace}/${args.key}: ${String(args.cause)}`, {
      cause: args.cause,
    });
    this.namespace = args.namespace;
    this.key = args.key;
    this.cause = args.cause;
  }
}
registerAgentickError("CredentialsWriteFailed", CredentialsWriteFailed);

export type CredentialsErrorChannel =
  | CredentialsNotFound
  | CredentialsBackendUnavailable
  | CredentialsCorrupted
  | CredentialsWriteFailed;
