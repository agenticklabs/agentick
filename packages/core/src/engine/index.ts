/**
 * Engine Types and Utilities
 *
 * This module exports the essential types for execution:
 * - ExecutionHandle - The handle returned by session.tick()
 * - ExecutionMessage, ExecutionHandle - Core execution types
 * - StreamEvent - Event types for streaming
 * - ToolExecutor - Tool execution utilities
 *
 * Note: The Engine class has been replaced by SessionImpl.
 * Use createApp() and session.tick() for execution.
 *
 * @module tentickle/engine
 */

// Execution Handle
export * from "./execution-handle";

// Execution Types
export * from "./execution-types";

// Events
export {
  StopReason,
  isModelStreamEvent,
  isOrchestrationStreamEvent,
  isDeltaEvent,
  isFinalEvent,
  generateEventId,
  createEventBase,
  createExecutionStartEvent,
  createExecutionEndEvent,
  createTickStartEvent,
  createTickEndEvent,
  createToolCallEvent,
  createToolResultEvent,
  createToolConfirmationRequiredEvent,
  createToolConfirmationResultEvent,
  createEngineErrorEvent,
} from "./engine-events";
export type {
  StreamEventBase,
  ModelStreamEvent,
  OrchestrationStreamEvent,
  ResultStreamEvent,
  CompiledEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  StreamEvent,
} from "./engine-events";

// Response Types
export type { EngineResponse, COMSection, COMTimelineEntry } from "./engine-response";

// Tool Executor
export { ToolExecutor } from "./tool-executor";
