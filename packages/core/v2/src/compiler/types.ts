/**
 * V2 Compiler Types
 *
 * Types for the compiled output structure.
 */

import type { Renderer, SemanticContentBlock } from "../renderers/types";

/**
 * The compiled structure output from traversing the tree.
 * This is what gets sent to the model.
 */
export interface CompiledStructure {
  /** Named sections */
  sections: Map<string, CompiledSection>;

  /** Timeline entries (messages) */
  timelineEntries: CompiledTimelineEntry[];

  /** Available tools */
  tools: CompiledTool[];

  /** Ephemeral content */
  ephemeral: CompiledEphemeral[];

  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * A compiled section.
 */
export interface CompiledSection {
  id: string;
  title?: string;
  content: SemanticContentBlock[];
  renderer: Renderer | null;
  visibility?: "model" | "observer" | "log";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A compiled timeline entry.
 */
export interface CompiledTimelineEntry {
  id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: SemanticContentBlock[];
  renderer: Renderer | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

/**
 * A compiled tool.
 */
export interface CompiledTool {
  name: string;
  description?: string;
  schema?: unknown;
  handler: (...args: unknown[]) => unknown;
}

/**
 * Compiled ephemeral content.
 */
export interface CompiledEphemeral {
  content: SemanticContentBlock[];
  position: "before" | "after" | "inline";
  order: number;
  renderer: Renderer | null;
  metadata?: Record<string, unknown>;
}

/**
 * Create an empty compiled structure.
 */
export function createEmptyCompiledStructure(): CompiledStructure {
  return {
    sections: new Map(),
    timelineEntries: [],
    tools: [],
    ephemeral: [],
    metadata: {},
  };
}

/**
 * Result from compileUntilStable.
 */
export interface CompileResult {
  /** The compiled structure */
  compiled: CompiledStructure;

  /** Number of iterations taken */
  iterations: number;

  /** Whether we hit max iterations before stabilizing */
  forcedStable: boolean;

  /** Reasons for recompilation requests */
  recompileReasons: string[];
}
