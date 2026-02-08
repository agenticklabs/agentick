/**
 * Engine Stream Events
 *
 * Re-exports and extends the platform-independent streaming types from @agentick/shared.
 * The engine emits StreamEvent (model + orchestration + result).
 *
 * Event Pattern:
 * - ModelStreamEvent: Model output events (content, reasoning, messages, tool calls)
 * - OrchestrationStreamEvent: Orchestration events (execution lifecycle, ticks, tool results)
 * - ResultStreamEvent: Final execution result
 *
 * For each streamable entity, events follow:
 *   [thing]_start → [thing]_delta (0..n) → [thing]_end → [thing] (final)
 */

// Re-export all streaming types from shared
export {
  // Enums
  StopReason,
  // Type guards
  isModelStreamEvent,
  isOrchestrationStreamEvent,
  isDeltaEvent,
  isFinalEvent,
} from "@agentick/shared";

export type {
  // Base types
  StreamEventBase,
  UsageStats,
  // Content events
  ContentStartEvent,
  ContentDeltaEvent,
  ContentEndEvent,
  ContentEvent,
  // Reasoning events
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  ReasoningEvent,
  // Message events
  MessageStartEvent,
  MessageEndEvent,
  MessageEvent,
  // Tool call events (model requesting tool)
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallEvent,
  // Tool result events
  ToolResultEvent,
  // Tool confirmation events
  ToolConfirmationRequiredEvent,
  ToolConfirmationResultEvent,
  // DevTools events
  CompiledEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  // Execution lifecycle
  ExecutionStartEvent,
  ExecutionEndEvent,
  ExecutionEvent,
  // Tick lifecycle
  TickStartEvent,
  TickEndEvent,
  TickEvent,
  // Error events
  StreamErrorEvent,
  EngineErrorEvent,
  // Union types
  ModelStreamEvent,
  OrchestrationStreamEvent,
  ResultStreamEvent,
  StreamEvent,
} from "@agentick/shared";

// ============================================================================
// Event Creation Helpers
// ============================================================================

import type {
  StreamEventBase,
  ExecutionStartEvent,
  ExecutionEndEvent,
  TickStartEvent,
  TickEndEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolConfirmationRequiredEvent,
  ToolConfirmationResultEvent,
  EngineErrorEvent,
  MessageEvent,
  UsageStats,
  StopReason,
  ToolExecutor,
  Message,
} from "@agentick/shared";

let eventIdCounter = 0;

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return `evt_${Date.now()}_${++eventIdCounter}`;
}

/**
 * Create base event fields
 */
export function createEventBase(tick: number = 1): StreamEventBase {
  return {
    id: generateEventId(),
    sequence: 0, // Placeholder - session.emitEvent assigns actual sequence
    tick,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an execution_start event
 */
export function createExecutionStartEvent(params: {
  executionId: string;
  parentExecutionId?: string;
  rootExecutionId?: string;
  componentName?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tick?: number;
}): ExecutionStartEvent {
  return {
    type: "execution_start",
    ...createEventBase(params.tick ?? 1),
    executionId: params.executionId,
    parentExecutionId: params.parentExecutionId,
    rootExecutionId: params.rootExecutionId,
    componentName: params.componentName,
    sessionId: params.sessionId,
    metadata: params.metadata,
  };
}

/**
 * Create an execution_end event
 */
export function createExecutionEndEvent(params: {
  executionId: string;
  parentExecutionId?: string;
  rootExecutionId?: string;
  output: unknown;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tick?: number;
}): ExecutionEndEvent {
  return {
    type: "execution_end",
    ...createEventBase(params.tick ?? 1),
    executionId: params.executionId,
    parentExecutionId: params.parentExecutionId,
    rootExecutionId: params.rootExecutionId,
    output: params.output,
    sessionId: params.sessionId,
    metadata: params.metadata,
  };
}

/**
 * Create a tick_start event
 */
export function createTickStartEvent(tick: number): TickStartEvent {
  return {
    type: "tick_start",
    ...createEventBase(tick),
    tick,
  };
}

/**
 * Create a tick_end event
 */
export function createTickEndEvent(
  tick: number,
  usage?: UsageStats,
  newTimelineEntries?: unknown[],
): TickEndEvent {
  return {
    type: "tick_end",
    ...createEventBase(tick),
    tick,
    usage,
    response: newTimelineEntries ? { newTimelineEntries } : undefined,
  };
}

/**
 * Create a tool_call event
 */
export function createToolCallEvent(params: {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  blockIndex: number;
  tick: number;
  startedAt: string;
}): ToolCallEvent {
  return {
    type: "tool_call",
    ...createEventBase(params.tick),
    callId: params.callId,
    name: params.name,
    input: params.input,
    blockIndex: params.blockIndex,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Create a tool_result event
 */
export function createToolResultEvent(params: {
  callId: string;
  name: string;
  result: unknown;
  isError?: boolean;
  executedBy: ToolExecutor;
  tick: number;
  startedAt: string;
}): ToolResultEvent {
  return {
    type: "tool_result",
    ...createEventBase(params.tick),
    callId: params.callId,
    name: params.name,
    result: params.result,
    isError: params.isError,
    executedBy: params.executedBy,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Create a tool_confirmation_required event
 */
export function createToolConfirmationRequiredEvent(params: {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  message: string;
  tick: number;
}): ToolConfirmationRequiredEvent {
  return {
    type: "tool_confirmation_required",
    ...createEventBase(params.tick),
    callId: params.callId,
    name: params.name,
    input: params.input,
    message: params.message,
  };
}

/**
 * Create a tool_confirmation_result event
 */
export function createToolConfirmationResultEvent(params: {
  callId: string;
  confirmed: boolean;
  always?: boolean;
  tick: number;
}): ToolConfirmationResultEvent {
  return {
    type: "tool_confirmation_result",
    ...createEventBase(params.tick),
    callId: params.callId,
    confirmed: params.confirmed,
    always: params.always,
  };
}

/**
 * Create an engine_error event
 */
export function createEngineErrorEvent(error: Error | string, tick: number = 1): EngineErrorEvent {
  return {
    type: "engine_error",
    ...createEventBase(tick),
    error: {
      message: error instanceof Error ? error.message : error,
      code: error instanceof Error ? (error as any).code : undefined,
    },
  };
}

/**
 * Create a message (complete) event
 * Emitted after the model stream is fully processed with the aggregated message.
 */
export function createMessageEvent(params: {
  message: Message;
  stopReason: StopReason;
  usage?: UsageStats;
  model?: string;
  raw?: unknown;
  tick: number;
  startedAt?: string;
}): MessageEvent {
  const now = new Date().toISOString();
  return {
    type: "message",
    ...createEventBase(params.tick),
    message: params.message,
    stopReason: params.stopReason,
    usage: params.usage,
    model: params.model,
    raw: params.raw,
    startedAt: params.startedAt || now,
    completedAt: now,
  };
}
