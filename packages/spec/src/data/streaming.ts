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
import type { LanguageModelStopReason, UsageStats } from "./execution-result.js";

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
  /** Parent execution id when this event is from a spawned child. */
  readonly parentExecutionId?: string;
  /** Spawn ancestry chain — present on events bubbled from child sessions. */
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

export type ToolConfirmationResolvedEvent = {
  readonly type: "tool-confirmation-resolved";
  readonly callId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly always?: boolean;
} & StreamEventBase;

/** Tick lifecycle. Symmetric. */
export type TickStartEvent = {
  readonly type: "tick-start";
  readonly tickIndex: number;
} & StreamEventBase;

export type TickEndEvent = {
  readonly type: "tick-end";
  readonly tickIndex: number;
  readonly stopReason?: string;
  readonly shouldContinue: boolean;
  readonly usage?: UsageStats;
} & StreamEventBase;

export type TickEvent = {
  readonly type: "tick";
  readonly tickIndex: number;
  readonly stopReason: string;
  readonly usage: UsageStats;
  readonly durationMs: number;
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
  readonly usage: UsageStats;
  readonly stopReason: string;
  readonly ticks: number;
  readonly durationMs: number;
} & StreamEventBase;

export type OrchestrationStreamEvent =
  | ToolDispatchStartEvent
  | ToolDispatchEndEvent
  | ToolDispatchEvent
  | ToolConfirmationRequiredEvent
  | ToolConfirmationResolvedEvent
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
  "tool-confirmation-resolved",
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
// Combined StreamEvent
// ============================================================================

/**
 * The complete event union yielded by `SessionExecutionHandle.events()`.
 * Three layers: model, orchestration, result. Consumers narrow on
 * `.type` to dispatch.
 */
export type StreamEvent = ModelStreamEvent | OrchestrationStreamEvent | ResultStreamEvent;

export type StreamEventType = StreamEvent["type"];
