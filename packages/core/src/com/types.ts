import type {
  ToolCall,
  ToolResult,
  Message,
  TimelineEntry as BaseTimelineEntry,
  ClientToolDefinition,
} from "@tentickle/shared";
import type { ToolExecutionOptions } from "../types";
import type { ModelConfig } from "../model/model";
import type { ExecutableTool, ToolDefinition } from "../tool/tool";
import type { SemanticContentBlock, Formatter } from "../renderers";
import type { ContentBlock } from "@tentickle/shared";

// Note: ToolCall and NormalizedModelTool are unused imports - keeping for future use

// TimelineVisibility and TimelineTag are now exported from @tentickle/shared
export type TimelineVisibility = "model" | "observer" | "log";
export type TimelineTag = string;

// ============================================================================
// Ephemeral Entries (NOT persisted, NOT Messages)
// ============================================================================

/**
 * Position for ephemeral content in the message stream.
 * - 'start': At the beginning of messages (after system)
 * - 'end': At the end of messages (before current user message)
 * - 'before-user': Immediately before the last user message
 * - 'after-system': Immediately after the system message
 * - 'flow': In the flow of the timeline (treated as historical context)
 */
export type EphemeralPosition = "start" | "end" | "before-user" | "after-system" | "flow";

/**
 * Ephemeral entry - transient content that is NOT persisted.
 *
 * Ephemeral content provides current state/context to the model but is not
 * part of the conversation history. It is rebuilt fresh each tick.
 *
 * Unlike Messages (which have roles and are persisted), ephemeral entries
 * are transformed into messages (typically 'user' role) before being sent
 * to the model, based on the position and model configuration.
 *
 * Examples:
 * - Current account balance
 * - Available inventory
 * - System status
 * - Current date/time
 */
export interface EphemeralEntry {
  /**
   * Type/category of ephemeral content.
   * Used for semantic categorization and can be used by model config
   * to apply type-specific formatting (delimiters, etc.)
   */
  readonly type?: string;

  /** Content blocks to include */
  readonly content: ContentBlock[];

  /** Where to position this ephemeral content in the message stream */
  readonly position: EphemeralPosition;

  /** Secondary sort order (when multiple entries have the same position) */
  readonly order?: number;

  /** Optional metadata */
  readonly metadata?: Record<string, unknown>;

  /** Optional identifier for debugging/tracing */
  readonly id?: string;

  /** Tags for categorization/filtering */
  readonly tags?: string[];
}

// ============================================================================
// Timeline Entries (persisted Messages)
// ============================================================================

/**
 * COM Timeline Entry - extends base TimelineEntry with backend-specific fields.
 *
 * Extends the platform-independent TimelineEntry from @tentickle/shared with:
 * - SemanticContentBlock[] content (format-agnostic, can be rendered)
 * - Formatter reference (for formatting)
 */
export interface COMTimelineEntry extends BaseTimelineEntry {
  message: Message & {
    // Content can be SemanticContentBlocks (format-agnostic) or ContentBlocks (pre-formatted from model)
    content: SemanticContentBlock[];
  };
  // Formatter reference for formatting (temporary, not persisted)
  formatter?: Formatter;
}

export interface COMSection {
  id: string;
  title?: string;
  // Raw content (format-agnostic SemanticContentBlocks)
  content: SemanticContentBlock[] | string | unknown;
  // Cached formatted content (only for sections, formatted on apply)
  formattedContent?: ContentBlock[];
  formattedWith?: string; // Formatter ID that formatted it (for cache invalidation)
  visibility?: TimelineVisibility;
  audience?: "user" | "model" | "all";
  ttlMs?: number;
  ttlTicks?: number;
  tags?: TimelineTag[];
  metadata?: Record<string, unknown>;
  formatter?: Formatter; // Formatter function
}

export interface COMInput {
  /**
   * Conversation timeline - persistent messages (user, assistant, tool, event).
   * Does NOT include system messages - those go in `system`.
   */
  timeline: COMTimelineEntry[];

  /**
   * System messages - consolidated from sections each tick.
   * Rebuilt fresh each tick (declarative), NOT persisted in previous.
   * This separation ensures system content doesn't duplicate across ticks.
   * Uses COMTimelineEntry envelope for consistency with timeline entries.
   */
  system: COMTimelineEntry[];

  sections: Record<string, COMSection>;
  tools: ToolDefinition[];
  metadata: Record<string, unknown>;
  modelOptions?: ModelConfig;

  /**
   * Ephemeral entries - transient content rebuilt each tick.
   * Not persisted. Interleaved into messages based on position before model call.
   */
  ephemeral: EphemeralEntry[];
}

/**
 * Output state from the last tick execution.
 * Contains what was produced by the model and tool execution.
 *
 * On tick 1, before model execution, this may contain userInput (timeline, sections)
 * to allow components to render purely from previous + current without
 * needing to check tick number or access ctx.getUserInput().
 */
export interface COMOutput {
  /**
   * Timeline entries.
   * - Tick 1 (before model): userInput.timeline
   * - After model execution: new timeline entries from model (assistant messages, tool_use blocks, etc.)
   */
  timeline: COMTimelineEntry[];

  /**
   * Sections (only present on tick 1 before model execution, from userInput).
   */
  sections?: Record<string, COMSection>;

  /**
   * Tool calls from the model execution (only present after model execution).
   */
  toolCalls?: ToolCall[];

  /**
   * Tool results from tool execution (only present after model execution).
   */
  toolResults?: ToolResult[];
}

export interface ContextStructure {
  timeline?: COMTimelineEntry[];
  sections?: Record<string, COMSection>;
  tools?: ToolDefinition[];
  metadata?: Record<string, unknown>;
}

/**
 * Generic input for the Engine.
 * Replaces LLM-centric AgentInput.
 */
export interface EngineInput {
  /**
   * Initial timeline entries (e.g. conversation history).
   *
   * Accepts TimelineEntry[] (from clients) or COMTimelineEntry[] (backend format).
   * Clients send TimelineEntry[], which gets converted to COMTimelineEntry[] internally.
   */
  timeline?: BaseTimelineEntry[] | COMTimelineEntry[];

  /**
   * Initial sections.
   */
  sections?: Record<string, COMSection>;

  /**
   * Initial metadata.
   */
  metadata?: Record<string, unknown>;

  /**
   * Model options to pass through to the model.
   * These will be merged into ModelInput when converting from COMInput.
   */
  modelOptions?: ModelConfig;

  /**
   * Server-side tools to make available for this execution.
   * Merged with engine config tools.
   */
  tools?: (ToolDefinition | ExecutableTool)[];

  /**
   * Client-side tools provided by the connected client.
   * These are executed on the client and results are sent back.
   * Converted to ToolDefinitions with type=CLIENT before model call.
   */
  clientTools?: ClientToolDefinition[];

  /**
   * Tool execution options for this execution.
   * Overrides EngineConfig.toolExecution for this call.
   */
  toolExecution?: ToolExecutionOptions;

  /**
   * Any other arbitrary input data components might need.
   */
  [key: string]: unknown;
}
