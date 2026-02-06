/**
 * Test Fixtures
 *
 * Factory functions for creating test data with sensible defaults.
 * All functions accept partial overrides for flexibility.
 */

import type {
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  CodeBlock,
} from "../blocks";
import { BlockType } from "../block-types";
import type { Message } from "../messages";
import type { UsageStats } from "../models";
import type { SessionResultPayload } from "../protocol";
import {
  StopReason,
  type StreamEventBase,
  type ContentStartEvent,
  type ContentDeltaEvent,
  type ContentEndEvent,
  type ContentEvent,
  type ReasoningStartEvent,
  type ReasoningDeltaEvent,
  type ReasoningEndEvent,
  type ReasoningEvent,
  type MessageStartEvent,
  type MessageEndEvent,
  type MessageEvent,
  type ToolCallStartEvent,
  type ToolCallDeltaEvent,
  type ToolCallEndEvent,
  type ToolCallEvent,
  type StreamErrorEvent,
  type ExecutionStartEvent,
  type ExecutionEndEvent,
  type ExecutionEvent,
  type TickStartEvent,
  type TickEndEvent,
  type TickEvent,
  type ToolResultEvent,
  type ToolConfirmationRequiredEvent,
  type ToolConfirmationResultEvent,
  type EngineErrorEvent,
  type ResultStreamEvent,
  type ForkStartEvent,
  type ForkEndEvent,
  type SpawnStartEvent,
  type SpawnEndEvent,
  type StreamEvent,
  type OrchestrationStreamEvent,
} from "../streaming";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutor } from "../tools";

// =============================================================================
// ID Generation
// =============================================================================

let idCounter = 0;

/**
 * Generate a unique test ID
 */
export function testId(prefix: string = "test"): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * Reset the ID counter (call in beforeEach)
 */
export function resetTestIds(): void {
  idCounter = 0;
}

// =============================================================================
// Content Block Fixtures
// =============================================================================

/**
 * Create a text block
 */
export function createTextBlock(
  text: string = "Test text content",
  overrides: Partial<TextBlock> = {},
): TextBlock {
  return {
    type: "text",
    text,
    ...overrides,
  };
}

/**
 * Create an image block with URL source
 */
export function createImageBlock(
  url: string = "https://example.com/image.png",
  overrides: Partial<ImageBlock> = {},
): ImageBlock {
  return {
    type: "image",
    source: { type: "url", url },
    ...overrides,
  };
}

/**
 * Create an image block with base64 source
 */
export function createBase64ImageBlock(
  data: string = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  mimeType: string = "image/png",
  overrides: Partial<ImageBlock> = {},
): ImageBlock {
  return {
    type: "image",
    source: { type: "base64", data, mimeType },
    ...overrides,
  };
}

/**
 * Create a tool use block
 */
export function createToolUseBlock(
  name: string = "test_tool",
  input: Record<string, unknown> = {},
  overrides: Partial<ToolUseBlock> = {},
): ToolUseBlock {
  return {
    type: "tool_use",
    toolUseId: overrides.toolUseId ?? testId("tool-use"),
    name,
    input,
    ...overrides,
  };
}

/**
 * Create a tool result block
 */
export function createToolResultBlock(
  toolUseId: string,
  content: ContentBlock[] = [createTextBlock("Tool result")],
  overrides: Partial<ToolResultBlock> = {},
): ToolResultBlock {
  return {
    type: "tool_result",
    toolUseId,
    name: overrides.name ?? "test_tool",
    content,
    isError: false,
    ...overrides,
  };
}

/**
 * Create an error tool result block
 */
export function createErrorToolResultBlock(
  toolUseId: string,
  errorMessage: string = "Tool execution failed",
  overrides: Partial<ToolResultBlock> = {},
): ToolResultBlock {
  return createToolResultBlock(toolUseId, [createTextBlock(errorMessage)], {
    ...overrides,
    isError: true,
  });
}

/**
 * Create a reasoning block
 */
export function createReasoningBlock(
  text: string = "Let me think about this...",
  overrides: Partial<ReasoningBlock> = {},
): ReasoningBlock {
  return {
    type: "reasoning",
    text,
    ...overrides,
  };
}

/**
 * Create a code block
 */
export function createCodeBlock(
  text: string = "console.log('Hello');",
  language: string = "typescript",
  overrides: Partial<CodeBlock> = {},
): CodeBlock {
  return {
    type: "code",
    text,
    language: language as any,
    ...overrides,
  };
}

// =============================================================================
// Message Fixtures
// =============================================================================

/**
 * Create a user message
 */
export function createUserMessage(
  content: string | ContentBlock[] = "Hello",
  overrides: Partial<Message> = {},
): Message {
  const contentBlocks = typeof content === "string" ? [createTextBlock(content)] : content;

  return {
    id: overrides.id ?? testId("msg"),
    role: "user",
    content: contentBlocks,
    ...overrides,
  };
}

/**
 * Create an assistant message
 */
export function createAssistantMessage(
  content: string | ContentBlock[] = "Hello! How can I help?",
  overrides: Partial<Message> = {},
): Message {
  const contentBlocks = typeof content === "string" ? [createTextBlock(content)] : content;

  return {
    id: overrides.id ?? testId("msg"),
    role: "assistant",
    content: contentBlocks,
    ...overrides,
  };
}

/**
 * Create a system message
 */
export function createSystemMessage(
  content: string = "You are a helpful assistant.",
  overrides: Partial<Message> = {},
): Message {
  return {
    id: overrides.id ?? testId("msg"),
    role: "system",
    content: [createTextBlock(content)],
    ...overrides,
  };
}

/**
 * Create a tool message (tool result)
 */
export function createToolMessage(
  toolUseId: string,
  content: ContentBlock[] = [createTextBlock("Tool result")],
  overrides: Partial<Message> = {},
): Message {
  return {
    id: overrides.id ?? testId("msg"),
    role: "tool",
    content,
    ...overrides,
  };
}

/**
 * Create a conversation (array of messages)
 */
export function createConversation(
  exchanges: Array<{ user: string; assistant: string }>,
): Message[] {
  const messages: Message[] = [];

  for (const exchange of exchanges) {
    messages.push(createUserMessage(exchange.user));
    messages.push(createAssistantMessage(exchange.assistant));
  }

  return messages;
}

// =============================================================================
// Tool Fixtures
// =============================================================================

/**
 * Create a tool definition
 */
export function createToolDefinition(
  name: string = "test_tool",
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: overrides.description ?? `A test tool called ${name}`,
    input: overrides.input ?? {
      type: "object",
      properties: {
        value: { type: "string", description: "Input value" },
      },
      required: ["value"],
    },
    ...overrides,
  };
}

/**
 * Create an agent tool call
 */
export function createToolCall(
  name: string = "test_tool",
  input: Record<string, unknown> = { input: "test" },
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: overrides.id ?? testId("call"),
    name,
    input,
    ...overrides,
  };
}

/**
 * Create an agent tool result
 */
export function createToolResult(
  toolUseId: string,
  content: ContentBlock[] = [createTextBlock("Result")],
  overrides: Partial<ToolResult> = {},
): ToolResult {
  return {
    toolUseId,
    name: overrides.name ?? "test_tool",
    success: overrides.success ?? true,
    content,
    ...overrides,
  };
}

// =============================================================================
// StreamEvent Fixtures (New typed event system)
// =============================================================================

/**
 * Create a StreamEventBase with default values.
 * All StreamEvent types extend this base.
 */
export function createEventBase(
  tick: number = 1,
  overrides: Partial<StreamEventBase> = {},
): StreamEventBase {
  return {
    id: overrides.id ?? testId("evt"),
    sequence: overrides.sequence ?? 0, // In tests, sequence defaults to 0; in production, session assigns monotonically increasing values
    tick,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    raw: overrides.raw,
  };
}

// -----------------------------------------------------------------------------
// Content Events
// -----------------------------------------------------------------------------

/**
 * Create a content_start event
 */
export function createContentStartEvent(
  blockType: BlockType = BlockType.TEXT,
  blockIndex: number = 0,
  overrides: Partial<ContentStartEvent> = {},
): ContentStartEvent {
  return {
    type: "content_start",
    blockType,
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a content_delta event
 */
export function createContentDeltaEvent(
  delta: string,
  blockType: BlockType = BlockType.TEXT,
  blockIndex: number = 0,
  overrides: Partial<ContentDeltaEvent> = {},
): ContentDeltaEvent {
  return {
    type: "content_delta",
    blockType,
    blockIndex,
    delta,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a content_end event
 */
export function createContentEndEvent(
  blockType: BlockType = BlockType.TEXT,
  blockIndex: number = 0,
  overrides: Partial<ContentEndEvent> = {},
): ContentEndEvent {
  return {
    type: "content_end",
    blockType,
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a content (complete) event
 */
export function createContentEvent(
  content: ContentBlock,
  blockIndex: number = 0,
  overrides: Partial<ContentEvent> = {},
): ContentEvent {
  const now = new Date().toISOString();
  return {
    type: "content",
    blockIndex,
    content,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Reasoning Events
// -----------------------------------------------------------------------------

/**
 * Create a reasoning_start event
 */
export function createReasoningStartEvent(
  blockIndex: number = 0,
  overrides: Partial<ReasoningStartEvent> = {},
): ReasoningStartEvent {
  return {
    type: "reasoning_start",
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a reasoning_delta event
 */
export function createReasoningDeltaEvent(
  delta: string,
  blockIndex: number = 0,
  overrides: Partial<ReasoningDeltaEvent> = {},
): ReasoningDeltaEvent {
  return {
    type: "reasoning_delta",
    blockIndex,
    delta,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a reasoning_end event
 */
export function createReasoningEndEvent(
  blockIndex: number = 0,
  overrides: Partial<ReasoningEndEvent> = {},
): ReasoningEndEvent {
  return {
    type: "reasoning_end",
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a reasoning (complete) event
 */
export function createReasoningCompleteEvent(
  reasoning: string,
  blockIndex: number = 0,
  overrides: Partial<ReasoningEvent> = {},
): ReasoningEvent {
  const now = new Date().toISOString();
  return {
    type: "reasoning",
    blockIndex,
    reasoning,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Message Events
// -----------------------------------------------------------------------------

/**
 * Create a message_start event
 */
export function createMessageStartEvent(
  model?: string,
  overrides: Partial<MessageStartEvent> = {},
): MessageStartEvent {
  return {
    type: "message_start",
    role: "assistant",
    model,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a message_end event
 */
export function createMessageEndEvent(
  stopReason: StopReason = StopReason.STOP,
  usage?: UsageStats,
  overrides: Partial<MessageEndEvent> = {},
): MessageEndEvent {
  return {
    type: "message_end",
    stopReason,
    usage,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a message (complete) event
 */
export function createMessageCompleteEvent(
  message: Message,
  stopReason: StopReason = StopReason.STOP,
  overrides: Partial<MessageEvent> = {},
): MessageEvent {
  const now = new Date().toISOString();
  return {
    type: "message",
    message,
    stopReason,
    usage: overrides.usage,
    model: overrides.model,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tool Call Events
// -----------------------------------------------------------------------------

/**
 * Create a tool_call_start event
 */
export function createToolCallStartEvent(
  name: string,
  callId: string = testId("call"),
  blockIndex: number = 0,
  overrides: Partial<ToolCallStartEvent> = {},
): ToolCallStartEvent {
  return {
    type: "tool_call_start",
    callId,
    name,
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a tool_call_delta event
 */
export function createToolCallDeltaEvent(
  callId: string,
  delta: string,
  blockIndex: number = 0,
  overrides: Partial<ToolCallDeltaEvent> = {},
): ToolCallDeltaEvent {
  return {
    type: "tool_call_delta",
    callId,
    blockIndex,
    delta,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a tool_call_end event
 */
export function createToolCallEndEvent(
  callId: string,
  blockIndex: number = 0,
  overrides: Partial<ToolCallEndEvent> = {},
): ToolCallEndEvent {
  return {
    type: "tool_call_end",
    callId,
    blockIndex,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a tool_call (complete) event
 */
export function createToolCallCompleteEvent(
  name: string,
  input: Record<string, unknown> = {},
  callId: string = testId("call"),
  blockIndex: number = 0,
  overrides: Partial<ToolCallEvent> = {},
): ToolCallEvent {
  const now = new Date().toISOString();
  return {
    type: "tool_call",
    callId,
    blockIndex,
    name,
    input,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Error Events
// -----------------------------------------------------------------------------

/**
 * Create a stream error event
 */
export function createStreamErrorEvent(
  message: string,
  code?: string,
  overrides: Partial<StreamErrorEvent> = {},
): StreamErrorEvent {
  return {
    type: "error",
    error: { message, code },
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// =============================================================================
// OrchestrationStreamEvent Fixtures (Orchestration events)
// =============================================================================

// -----------------------------------------------------------------------------
// Execution Events
// -----------------------------------------------------------------------------

/**
 * Create an execution_start event
 */
export function createExecutionStartEvent(
  executionId: string = testId("exec"),
  overrides: Partial<ExecutionStartEvent> = {},
): ExecutionStartEvent {
  return {
    type: "execution_start",
    executionId,
    parentExecutionId: overrides.parentExecutionId,
    rootExecutionId: overrides.rootExecutionId,
    componentName: overrides.componentName,
    sessionId: overrides.sessionId,
    metadata: overrides.metadata,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create an execution_end event
 */
export function createExecutionEndEvent(
  executionId: string,
  output: unknown = null,
  overrides: Partial<ExecutionEndEvent> = {},
): ExecutionEndEvent {
  return {
    type: "execution_end",
    executionId,
    output,
    parentExecutionId: overrides.parentExecutionId,
    rootExecutionId: overrides.rootExecutionId,
    sessionId: overrides.sessionId,
    metadata: overrides.metadata,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create an execution (complete) event
 */
export function createExecutionCompleteEvent(
  executionId: string = testId("exec"),
  output: unknown = null,
  overrides: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  const now = new Date().toISOString();
  return {
    type: "execution",
    executionId,
    output,
    usage: overrides.usage ?? createUsageStats(),
    stopReason: overrides.stopReason ?? StopReason.STOP,
    ticks: overrides.ticks ?? 1,
    parentExecutionId: overrides.parentExecutionId,
    rootExecutionId: overrides.rootExecutionId,
    sessionId: overrides.sessionId,
    metadata: overrides.metadata,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Result Events
// -----------------------------------------------------------------------------

/**
 * Create a session result event.
 */
export function createResultStreamEvent(
  result: SessionResultPayload = {
    response: "Test response",
    outputs: {},
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    stopReason: StopReason.STOP,
  },
  overrides: Partial<ResultStreamEvent> = {},
): ResultStreamEvent {
  return {
    type: "result",
    result,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tick Events
// -----------------------------------------------------------------------------

/**
 * Create a tick_start event
 */
export function createTickStartEvent(
  tickNumber: number = 1,
  overrides: Partial<TickStartEvent> = {},
): TickStartEvent {
  const base = createEventBase(tickNumber, overrides);
  return {
    type: "tick_start",
    ...base,
    tick: tickNumber, // Override base.tick with explicit tickNumber
    ...overrides,
  };
}

/**
 * Create a tick_end event
 */
export function createTickEndEvent(
  tickNumber: number = 1,
  usage?: UsageStats,
  overrides: Partial<TickEndEvent> = {},
): TickEndEvent {
  const base = createEventBase(tickNumber, overrides);
  return {
    type: "tick_end",
    ...base,
    tick: tickNumber, // Override base.tick with explicit tickNumber
    usage,
    ...overrides,
  };
}

/**
 * Create a tick (complete) event
 */
export function createTickCompleteEvent(
  tickNumber: number = 1,
  overrides: Partial<TickEvent> = {},
): TickEvent {
  const now = new Date().toISOString();
  const base = createEventBase(tickNumber, overrides);
  return {
    type: "tick",
    ...base,
    tick: tickNumber, // Override base.tick with explicit tickNumber
    usage: overrides.usage ?? createUsageStats(),
    stopReason: overrides.stopReason ?? StopReason.STOP,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tool Result Events
// -----------------------------------------------------------------------------

/**
 * Create a tool_result event
 */
export function createToolResultEvent(
  callId: string,
  name: string,
  result: unknown,
  executedBy: ToolExecutor = "engine",
  overrides: Partial<ToolResultEvent> = {},
): ToolResultEvent {
  const now = new Date().toISOString();
  return {
    type: "tool_result",
    callId,
    name,
    result,
    isError: overrides.isError ?? false,
    executedBy,
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create an error tool_result event
 */
export function createErrorToolResultEvent(
  callId: string,
  name: string,
  errorMessage: string,
  executedBy: ToolExecutor = "engine",
  overrides: Partial<ToolResultEvent> = {},
): ToolResultEvent {
  return createToolResultEvent(callId, name, { error: errorMessage }, executedBy, {
    ...overrides,
    isError: true,
  });
}

// -----------------------------------------------------------------------------
// Tool Confirmation Events
// -----------------------------------------------------------------------------

/**
 * Create a tool_confirmation_required event
 */
export function createToolConfirmationRequiredEvent(
  callId: string,
  name: string,
  input: Record<string, unknown> = {},
  message: string = "Confirm tool execution?",
  overrides: Partial<ToolConfirmationRequiredEvent> = {},
): ToolConfirmationRequiredEvent {
  return {
    type: "tool_confirmation_required",
    callId,
    name,
    input,
    message,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a tool_confirmation_result event
 */
export function createToolConfirmationResultEvent(
  callId: string,
  confirmed: boolean,
  always?: boolean,
  overrides: Partial<ToolConfirmationResultEvent> = {},
): ToolConfirmationResultEvent {
  return {
    type: "tool_confirmation_result",
    callId,
    confirmed,
    always,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Engine Error Events
// -----------------------------------------------------------------------------

/**
 * Create an engine_error event
 */
export function createEngineErrorEvent(
  message: string,
  code?: string,
  overrides: Partial<EngineErrorEvent> = {},
): EngineErrorEvent {
  return {
    type: "engine_error",
    error: { message, code },
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Fork Events
// -----------------------------------------------------------------------------

/**
 * Create a fork_start event
 */
export function createForkStartEvent(
  forkId: string = testId("fork"),
  parentExecutionId: string = testId("exec"),
  branches: string[] = ["branch-0", "branch-1"],
  strategy: "race" | "vote" | "all" = "race",
  overrides: Partial<ForkStartEvent> = {},
): ForkStartEvent {
  return {
    type: "fork_start",
    forkId,
    parentExecutionId,
    strategy,
    branches,
    branchCount: branches.length,
    input: overrides.input,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a fork_end event
 */
export function createForkEndEvent(
  forkId: string,
  parentExecutionId: string,
  results: Record<string, unknown> = {},
  overrides: Partial<ForkEndEvent> = {},
): ForkEndEvent {
  return {
    type: "fork_end",
    forkId,
    parentExecutionId,
    selectedBranch: overrides.selectedBranch,
    results,
    usage: overrides.usage,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Spawn Events
// -----------------------------------------------------------------------------

/**
 * Create a spawn_start event
 */
export function createSpawnStartEvent(
  spawnId: string = testId("spawn"),
  parentExecutionId: string = testId("exec"),
  childExecutionId: string = testId("exec"),
  overrides: Partial<SpawnStartEvent> = {},
): SpawnStartEvent {
  return {
    type: "spawn_start",
    spawnId,
    parentExecutionId,
    childExecutionId,
    componentName: overrides.componentName,
    label: overrides.label,
    input: overrides.input,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

/**
 * Create a spawn_end event
 */
export function createSpawnEndEvent(
  spawnId: string,
  parentExecutionId: string,
  childExecutionId: string,
  output: unknown = null,
  overrides: Partial<SpawnEndEvent> = {},
): SpawnEndEvent {
  return {
    type: "spawn_end",
    spawnId,
    parentExecutionId,
    childExecutionId,
    output,
    isError: overrides.isError ?? false,
    usage: overrides.usage,
    ...createEventBase(overrides.tick, overrides),
    ...overrides,
  };
}

// =============================================================================
// StreamEvent Sequences (for testing streaming flows)
// =============================================================================

/**
 * Create a sequence of StreamEvents for a simple text response.
 *
 * Follows the pattern: message_start → content_start → content_delta* → content_end → content → message_end → message
 */
export function createTextStreamEventSequence(
  text: string,
  chunkSize: number = 10,
  tick: number = 1,
): StreamEvent[] {
  const events: StreamEvent[] = [];

  events.push(createMessageStartEvent(undefined, { tick }));
  events.push(createContentStartEvent(BlockType.TEXT, 0, { tick }));

  // Split text into delta chunks
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push(createContentDeltaEvent(text.slice(i, i + chunkSize), BlockType.TEXT, 0, { tick }));
  }

  events.push(createContentEndEvent(BlockType.TEXT, 0, { tick }));
  events.push(createContentEvent(createTextBlock(text), 0, { tick }));
  events.push(createMessageEndEvent(StopReason.STOP, undefined, { tick }));

  // Final message event with fully-formed message
  events.push(
    createMessageCompleteEvent(createAssistantMessage([createTextBlock(text)]), StopReason.STOP, {
      tick,
    }),
  );

  return events;
}

/**
 * Create a sequence of StreamEvents for a tool call.
 *
 * Follows the pattern: message_start → tool_call_start → tool_call_delta* → tool_call_end → tool_call → message_end → message
 */
export function createToolCallEventSequence(
  toolName: string,
  toolInput: Record<string, unknown>,
  tick: number = 1,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const callId = testId("call");

  events.push(createMessageStartEvent(undefined, { tick }));
  events.push(createToolCallStartEvent(toolName, callId, 0, { tick }));
  events.push(createToolCallDeltaEvent(callId, JSON.stringify(toolInput), 0, { tick }));
  events.push(createToolCallEndEvent(callId, 0, { tick }));
  events.push(createToolCallCompleteEvent(toolName, toolInput, callId, 0, { tick }));
  events.push(createMessageEndEvent(StopReason.TOOL_USE, undefined, { tick }));

  // Final message event with fully-formed message containing the tool use block
  events.push(
    createMessageCompleteEvent(
      createAssistantMessage([createToolUseBlock(toolName, toolInput, { toolUseId: callId })]),
      StopReason.TOOL_USE,
      { tick },
    ),
  );

  return events;
}

/**
 * Create a sequence of OrchestrationStreamEvents for a Fork operation.
 *
 * Note: Branch-level events are not included - each branch runs as a
 * separate execution with its own stream. Subscribe to those executions
 * directly if you need branch-level observability.
 */
export function createForkEventSequence(
  branchCount: number = 2,
  strategy: "race" | "vote" | "all" = "race",
  input?: unknown,
  tick: number = 1,
): OrchestrationStreamEvent[] {
  const events: OrchestrationStreamEvent[] = [];
  const forkId = testId("fork");
  const parentExecutionId = testId("exec");
  const branches = Array.from({ length: branchCount }, (_, i) => `branch-${i}`);

  // Fork start
  events.push(createForkStartEvent(forkId, parentExecutionId, branches, strategy, { tick, input }));

  // Fork end with results (branches run as separate executions)
  const results: Record<string, unknown> = {};
  branches.forEach((branch, i) => {
    results[branch] = { result: `output-${i}` };
  });

  events.push(
    createForkEndEvent(forkId, parentExecutionId, results, {
      tick,
      selectedBranch: strategy === "race" ? branches[0] : undefined,
      usage: createUsageStats(),
    }),
  );

  return events;
}

/**
 * Create a sequence of OrchestrationStreamEvents for a Spawn operation
 */
export function createSpawnEventSequence(
  componentName: string = "ChildAgent",
  input?: unknown,
  output: unknown = { result: "spawned result" },
  tick: number = 1,
): OrchestrationStreamEvent[] {
  const events: OrchestrationStreamEvent[] = [];
  const spawnId = testId("spawn");
  const parentExecutionId = testId("exec");
  const childExecutionId = testId("exec");

  events.push(
    createSpawnStartEvent(spawnId, parentExecutionId, childExecutionId, {
      tick,
      componentName,
      input,
    }),
  );

  events.push(
    createSpawnEndEvent(spawnId, parentExecutionId, childExecutionId, output, {
      tick,
      usage: createUsageStats(),
    }),
  );

  return events;
}

// =============================================================================
// Utility Fixtures
// =============================================================================

/**
 * Create a token usage object
 */
export function createUsageStats(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    inputTokens: overrides.inputTokens ?? 10,
    outputTokens: overrides.outputTokens ?? 20,
    totalTokens: overrides.totalTokens ?? 30,
    reasoningTokens: overrides.reasoningTokens,
    cachedInputTokens: overrides.cachedInputTokens,
    ticks: overrides.ticks ?? 1,
    cacheCreationTokens: overrides.cacheCreationTokens,
  };
}
