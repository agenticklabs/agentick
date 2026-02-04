/**
 * @tentickle/core - Core engine for Tentickle
 *
 * Main entry point with all essential exports
 */

// ============================================================================
// Kernel primitives
// ============================================================================
export * from "@tentickle/kernel";

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
// React Hooks (re-exported from React)
// ============================================================================
export { useState, useEffect, useReducer, useMemo, useCallback, useRef } from "react";

// ============================================================================
// Tentickle Hooks
// ============================================================================
export {
  useSignal,
  useComputed,
  useCom,
  useTickState,
  useTickStart,
  useTickEnd,
  useAfterCompile,
  useData,
  useInvalidateData,
  useComState,
  // Context utilization
  useContextInfo,
  useContextInfoStore,
  createContextInfoStore,
  ContextInfoProvider,
  type ContextInfo,
  type ContextInfoStore,
} from "./hooks";

// ============================================================================
// Tools
// ============================================================================
export { createTool } from "./tool/index";
export type { ToolDefinition, ToolMetadata } from "./tool/index";

// ============================================================================
// Class Components
// ============================================================================
export { TentickleComponent, createClassComponent } from "./component/tentickle-component";
export type { TentickleComponentProps } from "./component/tentickle-component";

// ============================================================================
// Model types
// ============================================================================
export * from "./types";

// ============================================================================
// DevTools
// ============================================================================
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disconnectReactDevTools,
} from "./reconciler/reconciler";
