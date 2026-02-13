/**
 * Hook Types
 */

import type { CompiledStructure } from "../compiler/types";
import type { ContentBlock, ToolCall, ToolResult } from "@agentick/shared";
import type { COMStopRequest, COMContinueRequest, COM as COMImpl } from "../com/object-model";
import type { COMTimelineEntry } from "../com/types";

// TickState - canonical definition in component/component.ts
// Import for use in this file and re-export for consumers
import type { TickState } from "../component/component";
export type { TickState };

/**
 * COM - Context Object Model
 * The shared state object accessible to all components.
 */
export interface COM {
  /** Unique session ID */
  id: string;

  /** Conversation timeline */
  timeline: TimelineEntry[];

  /** Shared state storage */
  state: Map<string, unknown>;

  /** Get a state value */
  get<T>(key: string): T | undefined;

  /** Set a state value */
  set<T>(key: string, value: T): void;

  /** Request recompilation (for afterCompile hooks) */
  requestRecompile(reason?: string): void;
}

/**
 * Timeline entry in conversation history.
 */
export interface TimelineEntry {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: Date;
}

/**
 * Usage statistics from model response.
 */
export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

/**
 * TickResult - the result of a completed tick, passed to useOnTickEnd callbacks.
 *
 * Contains both data about the tick and control methods to influence continuation.
 * This enables agent loops with custom termination conditions.
 *
 * @example
 * ```tsx
 * useOnTickEnd((result) => {
 *   // Check if task is complete
 *   if (result.text?.includes("<DONE>")) {
 *     result.stop("task-complete");
 *   } else {
 *     result.continue("still-working");
 *   }
 * });
 * ```
 */
export interface TickResult {
  /** Current tick number */
  tick: number;

  /**
   * The current continuation decision.
   *
   * Before any callbacks run, this reflects the framework's default:
   * `true` if tool calls are pending or messages are queued, `false` otherwise.
   *
   * When multiple callbacks are registered, each sees the accumulated decision
   * from prior callbacks — not just the framework default. This enables
   * chaining: callback A overrides the default, callback B sees A's override.
   *
   * Return `undefined` (no return) to accept the current value.
   * Return `true`/`false` or call `stop()`/`continue()` to override.
   */
  shouldContinue: boolean;

  /**
   * Convenience: extracted text from assistant response.
   * Combined text from all text content blocks.
   */
  text?: string;

  /** Raw content blocks from assistant response */
  content: ContentBlock[];

  /** Tool calls made by the model this tick */
  toolCalls: ToolCall[];

  /** Results from executing tools this tick */
  toolResults: ToolResult[];

  /** Stop reason from model (e.g., "end_turn", "tool_use") */
  stopReason?: string;

  /** Token usage statistics */
  usage?: UsageStats;

  /** Full timeline entries for this tick */
  timeline: COMTimelineEntry[];

  /**
   * Request that execution stop after this tick.
   *
   * @example
   * ```tsx
   * result.stop("task-complete");
   * result.stop({ reason: "verified", status: "completed" });
   * ```
   */
  stop(reason?: string): void;
  stop(options: COMStopRequest): void;

  /**
   * Request that execution continue to the next tick.
   * Use this to override the default behavior (stop when no tool calls).
   *
   * @example
   * ```tsx
   * result.continue("verification-pending");
   * result.continue({ reason: "retry", priority: 10 });
   * ```
   */
  continue(reason?: string): void;
  continue(options: COMContinueRequest): void;
}

/**
 * Callback for useOnTickStart hook.
 *
 * Receives TickState first (primary data), COM second (context).
 *
 * @example
 * ```tsx
 * useOnTickStart((tickState) => {
 *   console.log(`Tick ${tickState.tick} starting`);
 * });
 *
 * useOnTickStart((tickState, ctx) => {
 *   ctx.setState("lastTick", tickState.tick);
 * });
 * ```
 */
export type TickStartCallback = (tickState: TickState, ctx: COMImpl) => void | Promise<void>;

/**
 * Continuation decision returned from tick-end / continuation callbacks.
 *
 * Three levels of expressiveness:
 * - `boolean` — shorthand (`true` = continue, `false` = stop)
 * - `ContinuationDecision` — decision with reason
 * - `void` — no opinion, defer to framework / previous callbacks
 *
 * Imperative `result.stop()` / `result.continue()` is always available too.
 */
export type ContinuationDecision =
  | { stop: true; reason?: string }
  | { continue: true; reason?: string };

/**
 * Callback for useOnTickEnd hook.
 *
 * Receives TickResult first (primary data), COM second (context).
 * `result.shouldContinue` reflects the current accumulated decision —
 * the framework default as modified by any prior callbacks in the chain.
 *
 * @example
 * ```tsx
 * // Defer to framework (no return = no opinion)
 * useOnTickEnd((result) => {
 *   console.log(`Tick ${result.tick}, continuing: ${result.shouldContinue}`);
 * });
 *
 * // Simple boolean override
 * useOnTickEnd((result) => !result.text?.includes("<DONE>"));
 *
 * // Object with reason
 * useOnTickEnd((result) => {
 *   if (result.tick > 10) return { stop: true, reason: "max ticks" };
 * });
 *
 * // Imperative methods
 * useOnTickEnd((result) => {
 *   if (result.text?.includes("<DONE>")) result.stop("complete");
 * });
 * ```
 */
export type TickEndCallback = (
  result: TickResult,
  ctx: COMImpl,
) => void | boolean | ContinuationDecision | Promise<void | boolean | ContinuationDecision>;

/**
 * Callback for useOnMount hook.
 *
 * Called when the component mounts.
 *
 * @example
 * ```tsx
 * useOnMount((ctx) => {
 *   console.log("Component mounted");
 * });
 * ```
 */
export type MountCallback = (ctx: COMImpl) => void | Promise<void>;

/**
 * Callback for useOnUnmount hook.
 *
 * Called when the component unmounts.
 *
 * @example
 * ```tsx
 * useOnUnmount((ctx) => {
 *   console.log("Component unmounting");
 * });
 * ```
 */
export type UnmountCallback = (ctx: COMImpl) => void | Promise<void>;

export type AfterCompileCallback = (
  compiled: CompiledStructure,
  ctx: COMImpl,
) => void | Promise<void>;

/**
 * Callback for useOnExecutionEnd hook.
 *
 * Called once per send() call, after the tick loop exits but before
 * the session snapshot is persisted. State changes here are captured
 * in the snapshot.
 */
export type ExecutionEndCallback = (ctx: COMImpl) => void | Promise<void>;

// Signal type is exported from ./signal.ts
