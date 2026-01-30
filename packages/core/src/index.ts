/**
 * @tentickle/core - Core engine for Tentickle
 *
 * Main entry point with all essential exports
 */

// ============================================================================
// Kernel primitives
// ============================================================================
export * from "./core/index";

// ============================================================================
// App & Session
// ============================================================================
export * from "./app/types.js";
export { createApp, Tentickle, TentickleInstance, run, runComponent, SessionImpl } from "./app.js";

// ============================================================================
// JSX Components (re-export from jsx/components)
// ============================================================================
export {
  Model,
  Section,
  Timeline,
  Message,
  User,
  Assistant,
  System,
  ToolResult as ToolResultComponent,
  Markdown,
  XML,
} from "./jsx/components/index";

// ============================================================================
// Hooks (re-export from compiler)
// ============================================================================
export {
  useState,
  useEffect,
  useReducer,
  useMemo,
  useCallback,
  useRef,
  useSignal,
  useComputed,
  useComState,
  useQueuedMessages,
} from "./compiler/index";

// ============================================================================
// Tools
// ============================================================================
export { createTool } from "./tool/index";
export type { ToolDefinition, ToolMetadata } from "./tool/index";

// ============================================================================
// Model types
// ============================================================================
export * from "./types";
