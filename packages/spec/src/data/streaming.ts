/**
 * Streaming wire types — `AdapterDelta` (provider emission) and
 * `StreamEvent` (session output).
 *
 * Two layers:
 *
 * 1. **`AdapterDelta`** is what executors / provider adapters emit
 *    DURING a model call. The adapter has the accumulator state, so
 *    producing the summary event (`message`, `content`, `tool-call`,
 *    `reasoning`) is essentially free — emit it right after the
 *    matching `*-end` event. Non-streaming providers (or non-streaming
 *    requests against streaming-capable providers) emit ONLY the
 *    summary events; consumer code doesn't special-case.
 *
 * 2. **`StreamEvent`** is what `SessionExecutionHandle.events()` yields
 *    to adopters. Built ON TOP of `AdapterDelta`: wraps each delta with
 *    session/execution context (`sessionId`, `executionId`, monotonic
 *    `sequence`, `tick`, `timestamp`) AND adds orchestration-level
 *    events (tool dispatch lifecycle, tick lifecycle, execution
 *    lifecycle, final result).
 *
 * The pattern across all hierarchical events is **symmetric**:
 *
 *   *-start  →  *-delta?  →  *-end  →  *  (summary)
 *
 * Consumers subscribe at whatever granularity they want:
 *
 *   - Streaming UI: subscribe to `content-delta` for tokens
 *   - "Just give me the final message": subscribe to `message`
 *   - Block-level rendering: subscribe to `content` and `tool-call`
 *
 * No filtering-and-assembling required.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §Streaming
 */

import type { ContentBlock } from "./content-blocks.js";
import type { BlockType } from "./content-blocks.js";
import type { ToolPresentation } from "./declarations.js";
import type { LanguageModelStopReason, UsageStats } from "./execution-result.js";
import type { ProgressToken, ProgressUpdate } from "./signals.js";

// ============================================================================
// Content metadata (citations, language hints, provider extensions)
// ============================================================================

/**
 * Metadata attached to content blocks (start/end events + summary
 * events). Skipped on `*-delta` events to avoid noise during streaming.
 */
export interface ContentMetadata {
  /** Citations / sources the model referenced. */
  readonly citations?: readonly ContentCitation[];
  /** Model-provided annotations on the content. */
  readonly annotations?: readonly ContentAnnotation[];
  /** Programming language hint (for code blocks). */
  readonly language?: string;
  /** MIME type hint (for media blocks). */
  readonly mimeType?: string;
  /** Provider-specific extensions — not normalized. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ContentCitation {
  readonly type: string;
  readonly url?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
}

export interface ContentAnnotation {
  readonly type: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Assembled message — what `message` summary events carry
// ============================================================================

/**
 * Assembled assistant message — the summary event's full content.
 * Distinct from `SessionMessage` (timeline-persisted, has id/ts/etc).
 */
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly model?: string;
  /**
   * The turn's full CONSULTED SET — every {@link import("./content-blocks.js").Source}
   * the model drew on this turn, deduped by {@link
   * import("./content-blocks.js").Source.id}. The roll-up of every block's
   * {@link import("./content-blocks.js").BaseContentBlock.sources} plus orphans
   * (sources consulted but cited in no span, which have no block to live on).
   * The home for a numbered "Sources" footer / the "what did this turn consult"
   * surface. Absent when the turn cited nothing.
   */
  readonly sources?: readonly import("./content-blocks.js").Source[];
}

// ============================================================================
// AdapterDelta — what providers emit during a model call
// ============================================================================

/**
 * Provider emission during a streaming (or non-streaming) model call.
 * Streaming providers emit start/delta/end + summary; non-streaming
 * providers emit ONLY summaries.
 */
export type AdapterDelta =
  // ─── Message lifecycle ───────────────────────────────────────────
  | { readonly type: "message-start"; readonly role: "assistant"; readonly model?: string }
  | {
      readonly type: "message-end";
      readonly stopReason: LanguageModelStopReason;
      readonly usage: UsageStats;
    }
  | {
      readonly type: "message";
      readonly message: AssistantMessage;
      readonly stopReason: LanguageModelStopReason;
      readonly usage: UsageStats;
    }

  // ─── Content blocks ──────────────────────────────────────────────
  | {
      readonly type: "content-start";
      readonly blockIndex: number;
      readonly blockType: BlockType;
      readonly metadata?: ContentMetadata;
    }
  | { readonly type: "content-delta"; readonly blockIndex: number; readonly delta: string }
  | {
      readonly type: "content-end";
      readonly blockIndex: number;
      readonly metadata?: ContentMetadata;
    }
  | {
      readonly type: "content";
      readonly blockIndex: number;
      readonly content: ContentBlock;
      readonly metadata?: ContentMetadata;
    }

  // ─── Tool calls ──────────────────────────────────────────────────
  | {
      readonly type: "tool-call-start";
      readonly callId: string;
      readonly name: string;
      readonly blockIndex: number;
    }
  | { readonly type: "tool-call-delta"; readonly callId: string; readonly delta: string }
  | { readonly type: "tool-call-end"; readonly callId: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }

  // ─── Reasoning ───────────────────────────────────────────────────
  | { readonly type: "reasoning-start"; readonly blockIndex: number }
  | { readonly type: "reasoning-delta"; readonly blockIndex: number; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly blockIndex: number }
  | { readonly type: "reasoning"; readonly blockIndex: number; readonly reasoning: string }

  // ─── Custom blocks (XML-like tags extracted from text) ──────────
  //
  // Adapter-extracted structured blocks from the model's text stream.
  // Driven by adopter-declared `customBlocks` config on the executor.
  // The text outside these tags arrives as normal `content-delta`;
  // the tag content arrives as `custom-block-delta` and the executor
  // strips the tags from the text stream so adopters can render
  // them however they want.
  | {
      readonly type: "custom-block-start";
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
    }
  | { readonly type: "custom-block-delta"; readonly tag: string; readonly delta: string }
  | { readonly type: "custom-block-end"; readonly tag: string }
  | {
      readonly type: "custom-block";
      readonly tag: string;
      readonly content: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly selfClosing?: boolean;
    }

  // ─── Standalone ──────────────────────────────────────────────────
  | { readonly type: "usage"; readonly usage: UsageStats }
  | {
      readonly type: "error";
      readonly error: { readonly message: string; readonly code?: string };
    };

export type AdapterDeltaType = AdapterDelta["type"];

/**
 * Authoritative array of every `AdapterDelta` type. Used by type
 * guards, schema discovery, and conformance assertions.
 */
export const ADAPTER_DELTA_TYPES = [
  "message-start",
  "message-end",
  "message",
  "content-start",
  "content-delta",
  "content-end",
  "content",
  "tool-call-start",
  "tool-call-delta",
  "tool-call-end",
  "tool-call",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning",
  "custom-block-start",
  "custom-block-delta",
  "custom-block-end",
  "custom-block",
  "usage",
  "error",
] as const satisfies readonly AdapterDeltaType[];

// ============================================================================
// StreamEvent context — wraps AdapterDelta with session/execution metadata
// ============================================================================

/**
 * Context fields stamped onto every `StreamEvent`. The session
 * assigns `sequence` monotonically per-session for ordering, gap
 * detection, and replay.
 */
export interface StreamEventBase {
  /** Normalized event id (ULID). */
  readonly id: string;
  /**
   * Monotonic per-session sequence number. Starts at 1. Enables
   * durable streams (reconnection / replay), gap detection,
   * deduplication, and ordering guarantees.
   */
  readonly sequence: number;
  /** Tick index this event belongs to (1-based; orchestration events outside a tick use 0). */
  readonly tick: number;
  /** ISO 8601 timestamp when the event was emitted. */
  readonly timestamp: string;
  /** Session this event originated from. */
  readonly sessionId: string;
  /** Execution this event belongs to. */
  readonly executionId: string;
  /**
   * Spawn ancestry chain (root-first) of the session that EMITTED this
   * event. Stamped by a spawned child onto its OWN handle stream — it
   * describes the emitter's lineage; it is not a routing header, and no
   * event is ever bubbled from one handle onto another (a child's interior
   * events stay on the child's handle; the parent sees only
   * {@link SpawnStartEvent} / {@link SpawnEndEvent}). Absent for a root
   * session.
   */
  readonly spawnPath?: readonly string[];
  /** Original provider event / chunk for pass-through (debugging, provider-specific). */
  readonly raw?: unknown;
}

// ============================================================================
// ModelStreamEvent — AdapterDelta + StreamEventBase
// ============================================================================

/**
 * Model-layer event. Every `AdapterDelta` flows through to consumers
 * with `StreamEventBase` context stamped on.
 */
export type ModelStreamEvent = AdapterDelta & StreamEventBase;

// ============================================================================
// OrchestrationStreamEvent — tool dispatch + tick/execution lifecycle
// ============================================================================

/**
 * Tool dispatch lifecycle. Symmetric start/end + summary. Adopters
 * subscribe to `tool-dispatch` for the assembled outcome or to
 * `tool-dispatch-start` / `tool-dispatch-end` for granular UI.
 */
export type ToolDispatchStartEvent = {
  readonly type: "tool-dispatch-start";
  readonly callId: string;
  readonly name: string;
  readonly via: "model" | "dispatch";
} & StreamEventBase;

export type ToolDispatchEndEvent = {
  readonly type: "tool-dispatch-end";
  readonly callId: string;
  readonly name: string;
  readonly outcome: "succeeded" | "failed" | "vetoed" | "aborted";
  readonly durationMs: number;
  /**
   * The call's resolved {@link ToolPresentation} — the four un-collapsed
   * label materials (`name` / `title` / `summary` / `narration`) the client
   * composes into "what is this call doing?". Deliberately NOT on
   * `tool-dispatch-start`: the summary is resolved against the VALIDATED
   * input inside the dispatch, strictly after the start event, and the
   * alternative (re-resolving off the raw declaration) would be a second
   * divergent resolution path. Absent when the dispatch short-circuited
   * before the resolution point, or on a hard failure.
   */
  readonly presentation?: ToolPresentation;
} & StreamEventBase;

export type ToolDispatchEvent = {
  readonly type: "tool-dispatch";
  readonly callId: string;
  readonly name: string;
  readonly content: readonly ContentBlock[];
  readonly succeeded: boolean;
  readonly durationMs: number;
  readonly executedBy?: string;
  readonly isError?: boolean;
  /** See {@link ToolDispatchEndEvent.presentation}. */
  readonly presentation?: ToolPresentation;
  /**
   * The result's own metadata bag, forwarded verbatim from
   * `DispatchResult.metadata`. Result-scoped presentation payloads ride
   * here under their namespaced key — an MCP tool's `CallToolResult._meta`
   * arrives as `metadata.mcp.meta` (the same namespace the server-side
   * result extensions project from), which is where an MCP-Apps `ui`
   * descriptor lives. The framework forwards; it never interprets.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
} & StreamEventBase;

/** Tool confirmation request — fired when the model requests a tool that requires host approval. */
export type ToolConfirmationRequiredEvent = {
  readonly type: "tool-confirmation-required";
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
} & StreamEventBase;

/**
 * Child-execution boundary, emitted on the PARENT's stream (never the
 * child's). The pair brackets one `session.spawn({ send })` — the
 * spawn-and-run form, the only form whose child execution the parent
 * observes; an unbound `spawn()` has no execution to bound and emits
 * nothing.
 *
 * `originCallId` is the parent tool call whose handler asked for the
 * spawn. It travels as DATA (`SpawnInput.originCallId`, read off the
 * dispatch ctx's `toolCallId`) because the parent's spawn operation runs
 * on a fresh fiber that cannot see the dispatch's ambient context.
 *
 * The child's INTERIOR events stay on the child's own handle — see
 * `spawnPath` on {@link StreamEventBase}.
 */
export type SpawnStartEvent = {
  readonly type: "spawn-start";
  /** The spawned child session's id. */
  readonly spawnSessionId: string;
  /** The child execution this spawn started. */
  readonly spawnExecutionId: string;
  /** Parent tool call that caused the spawn. Absent for a host-driven spawn. */
  readonly originCallId?: string;
} & StreamEventBase;

export type SpawnEndEvent = {
  readonly type: "spawn-end";
  readonly spawnSessionId: string;
  /** Whether the child execution settled by rejecting. */
  readonly isError: boolean;
} & StreamEventBase;

/** Tick lifecycle. Symmetric. */
export type TickStartEvent = {
  readonly type: "tick-start";
  readonly tickIndex: number;
  /**
   * The index of the failed tick this one re-issues (ADR 99 slice 2). A failed
   * tick persists nothing, so the retry is an identical model request — a UI
   * collapses the failed attempt off this instead of rendering dead air.
   */
  readonly retryOfTick?: number;
} & StreamEventBase;

export type TickEndEvent = {
  readonly type: "tick-end";
  readonly tickIndex: number;
  readonly stopReason?: string;
  readonly shouldContinue: boolean;
  readonly usage?: UsageStats;
  /** Stamped at act time. Absent = UNPRICED, never zero. */
  readonly cost?: import("./usage-cost.js").Cost;
  /** WHICH model produced this tick's usage — usage alone cannot be priced. */
  readonly model?: Pick<import("./execution-target.js").ExecutionTarget, "provider" | "modelId">;
} & StreamEventBase;

export type TickEvent = {
  readonly type: "tick";
  readonly tickIndex: number;
  readonly stopReason: string;
  readonly usage: UsageStats;
  readonly durationMs: number;
  /** Stamped at act time. Absent = UNPRICED, never zero. */
  readonly cost?: import("./usage-cost.js").Cost;
  /** WHICH model produced this tick's usage — usage alone cannot be priced. */
  readonly model?: Pick<import("./execution-target.js").ExecutionTarget, "provider" | "modelId">;
} & StreamEventBase;

/** Execution lifecycle. Symmetric. */
export type ExecutionStartEvent = {
  readonly type: "execution-start";
  readonly rootExecutionId?: string;
} & StreamEventBase;

export type ExecutionEndEvent = {
  readonly type: "execution-end";
  readonly stopReason: string;
  readonly aborted?: boolean;
  readonly error?: { readonly message: string; readonly name: string };
} & StreamEventBase;

export type ExecutionEvent = {
  readonly type: "execution";
  readonly output: readonly ContentBlock[];
  /** Flat totals across every model. Safe to sum; meaningless to price. */
  readonly usage: UsageStats;
  /** Per-model breakdown, keyed `` `${provider}/${modelId}` ``. */
  readonly byModel?: Readonly<Record<string, import("./usage-cost.js").ModelUsage>>;
  /** `partial` when any tick was unpriced — an unpriced tick never folds in as zero. */
  readonly cost?: import("./usage-cost.js").CostRollup;
  readonly stopReason: string;
  readonly ticks: number;
  readonly durationMs: number;
} & StreamEventBase;

export type OrchestrationStreamEvent =
  | ToolDispatchStartEvent
  | ToolDispatchEndEvent
  | ToolDispatchEvent
  | ToolConfirmationRequiredEvent
  | SpawnStartEvent
  | SpawnEndEvent
  | TickStartEvent
  | TickEndEvent
  | TickEvent
  | ExecutionStartEvent
  | ExecutionEndEvent
  | ExecutionEvent;

/**
 * Authoritative array of every orchestration event type.
 */
export const ORCHESTRATION_EVENT_TYPES = [
  "tool-dispatch-start",
  "tool-dispatch-end",
  "tool-dispatch",
  "tool-confirmation-required",
  "spawn-start",
  "spawn-end",
  "tick-start",
  "tick-end",
  "tick",
  "execution-start",
  "execution-end",
  "execution",
] as const satisfies readonly OrchestrationStreamEvent["type"][];

// ============================================================================
// ResultStreamEvent — final assembled result
// ============================================================================

/**
 * Final assembled `SendResult` for an execution. The last event a
 * `SessionExecutionHandle` yields before its iterator completes.
 *
 * Typed as `unknown` here because importing `SendResult` from the
 * protocol layer would create a circular reference; concrete callers
 * narrow via a cast at the boundary.
 */
export type ResultStreamEvent = {
  readonly type: "result";
  readonly result: unknown;
} & StreamEventBase;

// ============================================================================
// ProgressStreamEvent — a runtime `progress` signal, on the same stream
// ============================================================================

/**
 * ONE {@link ProgressUpdate} frame from the runtime signal family (ADR 64),
 * carried on the same stream as the turn's events.
 *
 * **Why it is here at all.** A turn's `events()` stream has TWO producers: the
 * execution-event fan-out, and the `<surface>:signal:progress` bus signals a
 * tool emits through `ctx.progress` (its descendants' too, under `fanIn`).
 * Both already ride one wire; before this variant the second arrived as a bare
 * `ProgressEventPayload` wearing a `StreamEvent` type, so every consumer
 * duck-typed to tell them apart.
 *
 * **Why `type` and not `name`.** The frame's kind is on the bus envelope's
 * `name`, and stamping that onto the payload COLLIDES: six variants of this
 * union already carry a `name` and it is the TOOL name (`tool-call-start`,
 * `tool-call`, `tool-dispatch-start`, `tool-dispatch-end`, `tool-dispatch`,
 * `tool-confirmation-required`). Discriminating on the union's EXISTING `type`
 * costs nothing and leaves those six alone.
 *
 * **Why it does NOT extend {@link StreamEventBase}.** The base demands `id`,
 * `sequence`, `tick` and `timestamp`; a signal can honestly supply none of
 * them. It is emitted on the bus by a tool handler, not minted by the session's
 * event pipeline: there is no per-session monotonic `sequence` behind it (so it
 * participates in no gap detection or replay), and it belongs to a tool call
 * rather than to a tick. Faking those fields would put four lies on every frame
 * to satisfy a structural relation nothing reads. A union member need not share
 * the base — `type` is the discriminant, and it is the only field consumers
 * narrow on.
 *
 * **Correlation instead.** `token` is the ProgressToken the emitting surface
 * minted (the tool call id, in the tool executor) — what ties successive frames
 * of one operation together. `sessionId` / `executionId` are the EMITTER's
 * identity, read off the bus envelope's scope, and are what attributes a
 * descendant's frame under `fanIn` — a sub-agent's progress carries the child's
 * ids, never the turn's. Optional because the envelope's scope is gap-filled
 * and may carry neither.
 *
 * **`progress` only.** The other signal in the family — `log` — is NOT on this
 * stream today (the gateway fans out progress signals only), so it gets no
 * variant. The door is the same one if a consumer ever needs it: another
 * `type`, not another `name`.
 *
 * The four laws every frame obeys are on {@link ProgressUpdate} — in
 * particular, each frame classifies ALONE (`total` present = determinate), so a
 * consumer that joins mid-turn renders correctly from the first frame it sees.
 */
export type ProgressStreamEvent = ProgressUpdate & {
  readonly type: "progress";
  /** Correlation token minted by the emitting surface — the tool call id, in the tool executor. */
  readonly token: ProgressToken;
  /** The EMITTING session (a descendant's own id under `fanIn`), from the envelope scope. */
  readonly sessionId?: string;
  /** The EMITTING execution (a descendant runs its own), from the envelope scope. */
  readonly executionId?: string;
};

// ============================================================================
// Combined StreamEvent
// ============================================================================

/**
 * The complete event union yielded by `SessionExecutionHandle.events()`.
 * Four layers: model, orchestration, result, and runtime progress signals.
 * Consumers narrow on `.type` to dispatch.
 *
 * Not every producer emits every layer: {@link ProgressStreamEvent} is
 * produced by the client-side stitch of the per-token progress stream
 * (`@agentick/client-core`), where the two producers actually meet. An
 * in-process handle's stream carries no signals today — the same way a stream
 * that runs no tools carries no `tool-dispatch`.
 */
export type StreamEvent =
  | ModelStreamEvent
  | OrchestrationStreamEvent
  | ResultStreamEvent
  | ProgressStreamEvent;

export type StreamEventType = StreamEvent["type"];
