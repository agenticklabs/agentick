/**
 * Agentick Testing Utilities
 *
 * Provides a React Testing Library-like API for testing Agentick agents.
 *
 * @example
 * ```tsx
 * import {
 *   renderAgent,
 *   compileAgent,
 *   createTestAdapter,
 *   act,
 *   cleanup,
 * } from '@agentick/core/testing';
 *
 * afterEach(() => cleanup());
 *
 * test('agent responds to user', async () => {
 *   const { send, result, model } = renderAgent(MyAgent, {
 *     props: { mode: 'helpful' },
 *   });
 *
 *   await act(async () => {
 *     await send('Hello!');
 *   });
 *
 *   expect(result.current.lastAssistantMessage).toBe('Test response');
 *   expect(model.getCapturedInputs()).toHaveLength(1);
 * });
 *
 * test('agent compiles correct structure', async () => {
 *   const { sections, tools } = await compileAgent(MyAgent, {
 *     props: { mode: 'helpful' },
 *   });
 *
 *   expect(sections.get('system')).toContain('helpful');
 *   expect(tools).toHaveLength(2);
 * });
 * ```
 *
 * @module @agentick/core/testing
 */

// Act wrapper
export { act, actSync, flushMicrotasks, flushAll } from "./act";

// Async helpers
export {
  sleep,
  waitFor,
  createDeferred,
  captureAsyncGenerator,
  arrayToAsyncGenerator,
  createControllableGenerator,
} from "./async-helpers";

// Test adapter factory (uses createAdapter internally)
export { createTestAdapter } from "./test-adapter";
export type {
  TestAdapterOptions,
  TestAdapterInstance,
  StreamingOptions,
  ResponseItem,
  ToolCallInput,
} from "./test-adapter";

// Agent rendering
export { renderAgent, cleanup } from "./render-agent";
export type { RenderAgentOptions, RenderAgentResult, AgentTestResult } from "./render-agent";

// Compilation testing
export { compileAgent } from "./compile-agent";
export type { CompileAgentOptions, CompileAgentResult } from "./compile-agent";

// Test mocks
export {
  createMockCom,
  createMockTickState,
  createMockTickResult,
  makeTimelineEntry,
  makeCOMInput,
} from "./mocks";
export type {
  MockComOptions,
  MockCom,
  MockTickStateOptions,
  MockTickState,
  MockTickResultOptions,
  MockTickResult,
} from "./mocks";

// App/Session/Handle mocks
export { createMockExecutionHandle, createMockSession, createMockApp } from "./mock-app";
export type {
  MockExecutionHandleOptions,
  MockSessionExecutionHandle,
  MockSessionOptions,
  MockSession,
  MockAppOptions,
  MockApp,
} from "./mock-app";

// Test execution runner
export { createTestRunner } from "./test-runner";
export type { TestRunnerOptions, RunnerTracker, TestRunnerResult } from "./test-runner";

// Kernel testing primitives (re-exported for convenience)
export { createTestProcedure } from "@agentick/kernel/testing";
export type { TestProcedure, TestProcedureOptions } from "@agentick/kernel/testing";
