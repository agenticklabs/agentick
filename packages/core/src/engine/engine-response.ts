import { type ToolCall, type ToolResult } from "../tool/tool";
import type { COMSection, COMTimelineEntry } from "../com/types";
import type { StopReasonInfo } from "../component/component";
import type { UsageStats } from "@tentickle/shared";

export type { COMSection, COMTimelineEntry }; // Re-export for convenience

/**
 * Represents the delta/effects returned by a Model execution
 * that should be applied to the Engine's state.
 */
export interface EngineResponse {
  /**
   * New timeline entries to append.
   */
  newTimelineEntries?: COMTimelineEntry[];

  /**
   * Sections to update or add.
   */
  updatedSections?: COMSection[];

  /**
   * Tool calls that need execution by Engine.
   * These are tool_use blocks from the model that don't have corresponding
   * tool results in the response (i.e., not already executed by provider/adapter).
   */
  toolCalls?: ToolCall[];

  /**
   * Tool results from provider or adapter-executed tools.
   * These tools were already executed (by LLM provider like code interpreter,
   * or by the adapter library like AI SDK with maxSteps > 1).
   * Engine should NOT re-execute these - just add them to the timeline.
   */
  executedToolResults?: ToolResult[];

  /**
   * Whether the engine should stop the tick loop.
   */
  shouldStop: boolean;

  /**
   * Structured stop reason information.
   * Provides context about why execution stopped, allowing components
   * to handle graceful recovery, retries, etc.
   */
  stopReason?: StopReasonInfo;

  /**
   * Token usage from this model execution.
   * Contains inputTokens, outputTokens, totalTokens, and optional reasoning/cache tokens.
   */
  usage?: UsageStats;
}
