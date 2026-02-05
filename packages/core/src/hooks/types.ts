/**
 * V2 Hook Types
 */

import type { CompiledStructure } from "../compiler/types";
import type { ContentBlock, ToolCall, ToolResult } from "@tentickle/shared";
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
 * TickResult - the result of a completed tick, passed to useTickEnd callbacks.
 *
 * Contains both data about the tick and control methods to influence continuation.
 * This enables agent loops with custom termination conditions.
 *
 * @example
 * ```tsx
 * useTickEnd((result) => {
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
   * @param reason - Why execution should stop (for debugging/logging)
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
   * @param reason - Why execution should continue (for debugging/logging)
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
 * Callback for useTickStart hook.
 *
 * Receives COM and TickState for consistency with other lifecycle hooks.
 *
 * @example
 * ```tsx
 * useTickStart((com, tickState) => {
 *   console.log(`Tick ${tickState.tick} starting`);
 * });
 * ```
 */
export type TickStartCallback = (com: COMImpl, tickState: TickState) => void | Promise<void>;

/**
 * Callback for useTickEnd hook.
 *
 * Receives COM and TickResult which contains both data about the completed tick
 * and control methods (stop/continue) to influence whether execution continues.
 *
 * Can return a boolean for simple cases (true = continue, false = stop),
 * or call result.stop()/result.continue() for control with reasons.
 *
 * @example
 * ```tsx
 * // Simple boolean return
 * useTickEnd((com, result) => !result.text?.includes("<DONE>"));
 *
 * // With reasons via methods
 * useTickEnd((com, result) => {
 *   if (result.text?.includes("<DONE>")) result.stop("complete");
 *   else result.continue("working");
 * });
 * ```
 */
export type TickEndCallback = (
  com: COMImpl,
  result: TickResult,
) => void | boolean | Promise<void | boolean>;

export type AfterCompileCallback = (compiled: CompiledStructure) => void | Promise<void>;

// Signal type is exported from ./signal.ts
