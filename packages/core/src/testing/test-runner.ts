/**
 * Test Runner Factory
 *
 * Creates mock ExecutionRunner instances for testing.
 * Tracks all lifecycle hook invocations for assertions.
 *
 * @example
 * ```typescript
 * const { runner, tracker } = createTestRunner({
 *   name: "test",
 *   interceptTools: { my_tool: "intercepted!" },
 * });
 *
 * const app = createApp(Agent, { model, runner });
 * // ... run agent ...
 *
 * expect(tracker.initCalls).toHaveLength(1);
 * expect(tracker.prepareModelInputCalls).toHaveLength(1);
 * expect(tracker.toolCalls).toHaveLength(1);
 * ```
 */

import type { ExecutionRunner, SessionRef, SessionSnapshot } from "../app/types";
import type { COMInput } from "../com/types";
import type { ExecutableTool } from "../tool/tool";
import type { ToolCall, ToolResult } from "@agentick/shared";

// ============================================================================
// Types
// ============================================================================

export interface TestRunnerOptions {
  /**
   * Runner name.
   * @default "test"
   */
  name?: string;

  /**
   * Tool names to intercept. Values are either a string (becomes the result text)
   * or a function that receives the ToolCall and returns a ToolResult.
   * Non-intercepted tools pass through to normal execution.
   *
   * @example
   * ```typescript
   * // Static string result
   * interceptTools: { execute: "sandbox result" }
   *
   * // Dynamic function result
   * interceptTools: {
   *   execute: (call) => ({
   *     id: call.id, toolUseId: call.id, name: call.name,
   *     success: true, content: [{ type: "text", text: `ran: ${call.input.code}` }],
   *   }),
   * }
   * ```
   */
  interceptTools?: Record<string, string | ((call: ToolCall) => ToolResult | Promise<ToolResult>)>;

  /**
   * Transform function for prepareModelInput.
   * If not provided, input passes through unchanged.
   */
  transformInput?: (compiled: COMInput, tools: ExecutableTool[]) => COMInput | Promise<COMInput>;

  /**
   * Data to add to snapshot during onPersist.
   */
  persistData?: Record<string, unknown>;
}

export interface RunnerTracker {
  /** All onSessionInit calls (session IDs) */
  initCalls: string[];
  /** All prepareModelInput calls */
  prepareModelInputCalls: Array<{ tools: string[] }>;
  /** All executeToolCall calls */
  toolCalls: Array<{ name: string; intercepted: boolean }>;
  /** All onPersist calls (session IDs) */
  persistCalls: string[];
  /** All onRestore calls (session IDs) */
  restoreCalls: string[];
  /** All onDestroy calls (session IDs) */
  destroyCalls: string[];

  /** Reset all tracked calls */
  reset(): void;
}

export interface TestRunnerResult {
  /** The runner instance to pass to AppOptions */
  runner: ExecutionRunner;
  /** Tracker for asserting lifecycle calls */
  tracker: RunnerTracker;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a test execution runner with call tracking.
 *
 * @example Basic usage
 * ```typescript
 * const { runner, tracker } = createTestRunner();
 * const app = createApp(Agent, { model, runner });
 * const session = await app.session();
 * await session.send({ messages: [...] }).result;
 *
 * expect(tracker.initCalls).toHaveLength(1);
 * expect(tracker.prepareModelInputCalls).toHaveLength(1);
 * ```
 *
 * @example Intercepting tools
 * ```typescript
 * const { runner, tracker } = createTestRunner({
 *   interceptTools: { execute: "sandboxed!" },
 * });
 * // When model calls "execute" tool, it gets "sandboxed!" instead of real execution
 * ```
 *
 * @example Transforming model input
 * ```typescript
 * const { runner } = createTestRunner({
 *   transformInput: (compiled, tools) => ({
 *     ...compiled,
 *     tools: [], // Remove all tools from model input
 *   }),
 * });
 * ```
 */
export function createTestRunner(options: TestRunnerOptions = {}): TestRunnerResult {
  const { name = "test", interceptTools = {}, transformInput, persistData } = options;

  const tracker: RunnerTracker = {
    initCalls: [],
    prepareModelInputCalls: [],
    toolCalls: [],
    persistCalls: [],
    restoreCalls: [],
    destroyCalls: [],
    reset() {
      this.initCalls = [];
      this.prepareModelInputCalls = [];
      this.toolCalls = [];
      this.persistCalls = [];
      this.restoreCalls = [];
      this.destroyCalls = [];
    },
  };

  const runner: ExecutionRunner = {
    name,

    onSessionInit(session: SessionRef) {
      tracker.initCalls.push(session.id);
    },

    async prepareModelInput(compiled: COMInput, tools: ExecutableTool[]) {
      tracker.prepareModelInputCalls.push({
        tools: tools.map((t) => t.metadata?.name ?? "unknown"),
      });
      if (transformInput) {
        return transformInput(compiled, tools);
      }
      return compiled;
    },

    async executeToolCall(
      call: ToolCall,
      tool: ExecutableTool | undefined,
      next: () => Promise<ToolResult>,
    ) {
      const interceptor = interceptTools[call.name];
      if (interceptor !== undefined) {
        tracker.toolCalls.push({ name: call.name, intercepted: true });
        if (typeof interceptor === "function") {
          return interceptor(call);
        }
        return {
          id: call.id,
          toolUseId: call.id,
          name: call.name,
          success: true,
          content: [{ type: "text" as const, text: interceptor }],
        };
      }
      tracker.toolCalls.push({ name: call.name, intercepted: false });
      return next();
    },

    onPersist(session: SessionRef, snapshot: SessionSnapshot) {
      tracker.persistCalls.push(session.id);
      if (persistData) {
        return {
          ...snapshot,
          comState: { ...snapshot.comState, ...persistData },
        };
      }
      return snapshot;
    },

    onRestore(session: SessionRef, _snapshot: SessionSnapshot) {
      tracker.restoreCalls.push(session.id);
    },

    onDestroy(session: SessionRef) {
      tracker.destroyCalls.push(session.id);
    },
  };

  return { runner, tracker };
}
