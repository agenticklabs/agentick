/**
 * Engine Types and Utilities
 *
 * This module exports the essential types for execution:
 * - ExecutionHandle - The handle returned by session.render()
 * - ExecutionMessage, ExecutionHandle - Core execution types
 * - StreamEvent - Event types for streaming
 * - ToolExecutor - Tool execution utilities
 *
 * Note: The Engine class has been replaced by SessionImpl.
 * Use createApp() and session.render() for execution.
 *
 * @module agentick/engine
 */

// Execution Handle
export * from "./execution-handle.js";

// Execution Types
export * from "./execution-types.js";

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
} from "./engine-events.js";
export type {
  StreamEventBase,
  ModelStreamEvent,
  OrchestrationStreamEvent,
  ResultStreamEvent,
  CompiledEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  StreamEvent,
} from "./engine-events.js";

// Response Types
export type { EngineResponse, COMSection, COMTimelineEntry } from "./engine-response.js";

// Tool Executor
export { ToolExecutor } from "./tool-executor.js";
