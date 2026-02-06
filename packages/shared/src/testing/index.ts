/**
 * # Tentickle Testing Utilities
 *
 * Fixtures, mocks, and helpers for testing Tentickle applications.
 * Import from `@tentickle/shared/testing` for test utilities.
 *
 * ## Features
 *
 * - **Fixtures** - Factory functions for messages, blocks, tools
 * - **Stream Helpers** - Create and capture async generators
 * - **SSE Utilities** - Parse and format Server-Sent Events
 * - **Mock Utilities** - Spies, mocks, and sequences
 *
 * ## Quick Start
 *
 * ```typescript
 * import {
 *   createUserMessage,
 *   createAssistantMessage,
 *   createTextStreamSequence,
 *   captureAsyncGenerator,
 *   waitForEvent,
 * } from '@tentickle/shared/testing';
 *
 * // Create test fixtures
 * const messages = [
 *   createUserMessage('Hello'),
 *   createAssistantMessage('Hi there!'),
 * ];
 *
 * // Create stream sequences
 * const chunks = createTextStreamSequence('Hello world');
 *
 * // Capture async generator output
 * const items = await captureAsyncGenerator(myStream());
 * ```
 *
 * @module @tentickle/shared/testing
 */

// Fixtures - factory functions for test data
export {
  // ID utilities
  testId,
  resetTestIds,
  // Content blocks
  createTextBlock,
  createImageBlock,
  createBase64ImageBlock,
  createToolUseBlock,
  createToolResultBlock,
  createErrorToolResultBlock,
  createReasoningBlock,
  createCodeBlock,
  // Messages
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  createToolMessage,
  createConversation,
  // Tools
  createToolDefinition,
  createToolCall,
  createToolResult,
  // StreamEvent fixtures
  createEventBase,
  createContentStartEvent,
  createContentDeltaEvent,
  createContentEndEvent,
  createContentEvent,
  createReasoningStartEvent,
  createReasoningDeltaEvent,
  createReasoningEndEvent,
  createReasoningCompleteEvent,
  createMessageStartEvent,
  createMessageEndEvent,
  createMessageCompleteEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolCallCompleteEvent,
  createStreamErrorEvent,
  // OrchestrationStreamEvent fixtures (orchestration events)
  createExecutionStartEvent,
  createExecutionEndEvent,
  createExecutionCompleteEvent,
  createResultStreamEvent,
  createTickStartEvent,
  createTickEndEvent,
  createTickCompleteEvent,
  createToolResultEvent,
  createErrorToolResultEvent,
  createToolConfirmationRequiredEvent,
  createToolConfirmationResultEvent,
  createEngineErrorEvent,
  // Fork/Spawn event fixtures
  createForkStartEvent,
  createForkEndEvent,
  createSpawnStartEvent,
  createSpawnEndEvent,
  // StreamEvent sequences
  createTextStreamEventSequence,
  createToolCallEventSequence,
  createForkEventSequence,
  createSpawnEventSequence,
  // Utility fixtures
  createUsageStats,
} from "./fixtures";

// Helpers - async utilities and test helpers
export {
  // Async utilities
  waitForEvent,
  waitForEvents,
  waitFor,
  sleep,
  createDeferred,
  // Stream utilities
  captureAsyncGenerator,
  arrayToAsyncGenerator,
  createControllableGenerator,
  // SSE utilities
  parseSSEEvent,
  parseSSEBuffer,
  formatSSEEvent,
  // Mock utilities
  createSpy,
  createMock,
  createMockSequence,
} from "./helpers";
