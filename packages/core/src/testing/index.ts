/**
 * Tentickle Testing Utilities
 *
 * Provides a React Testing Library-like API for testing Tentickle agents.
 *
 * @example
 * ```tsx
 * import {
 *   renderAgent,
 *   compileAgent,
 *   createTestModel,
 *   act,
 *   cleanup,
 * } from '@tentickle/core/testing';
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
 * @module @tentickle/core/testing
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

// Test model factory
export { createTestModel } from "./test-model";
export type { TestModelOptions, TestModelInstance, StreamingOptions } from "./test-model";

// Agent rendering
export { renderAgent, cleanup } from "./render-agent";
export type { RenderAgentOptions, RenderAgentResult, AgentTestResult } from "./render-agent";

// Compilation testing
export { compileAgent } from "./compile-agent";
export type { CompileAgentOptions, CompileAgentResult } from "./compile-agent";
