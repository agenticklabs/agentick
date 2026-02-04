/**
 * Tool Component Tests
 *
 * Tests for tool components in JSX context:
 * - Tool registration via useEffect
 * - Tool removal on unmount
 * - Tools available to model during execution
 * - Tool render function
 */

import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../app";
import { createTool } from "../../tool/tool";
import { Model, Section } from "../../jsx/components/primitives";
import { createTestModel, type TestModelInstance } from "../../testing";
import { createModel, type ModelInput, type ModelOutput } from "../../model/model";
import { fromEngineState, toEngineState } from "../../model/utils/language-model";
import type { ToolCall, StreamEvent } from "@tentickle/shared";
import { StopReason } from "@tentickle/shared";
import { z } from "zod";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock model using createTestModel.
 */
function createMockModel(options?: {
  toolCalls?: ToolCall[];
  response?: string;
}): TestModelInstance {
  const model = createTestModel({
    defaultResponse: options?.response ?? "Mock response",
    toolCalls: options?.toolCalls,
    stopReason: options?.toolCalls?.length ? StopReason.TOOL_USE : StopReason.STOP,
  });
  return model;
}

// ============================================================================
// Tests
// ============================================================================

describe("Tool Component", () => {
  describe("tool registration", () => {
    it("should register tool via component mount", async () => {
      const handler = vi.fn(() => [{ type: "text" as const, text: "result" }]);

      const TestTool = createTool({
        name: "test_tool",
        description: "A test tool",
        input: z.object({ value: z.string() }),
        handler,
      });

      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <TestTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      // Run a tick to trigger tool registration
      await session.tick({}).result;

      // Close session
      session.close();
    });

    it("should make tool available to model during execution", async () => {
      const TestTool = createTool({
        name: "test_tool",
        description: "A test tool",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "tool result" }],
      });

      // Create a model that captures inputs (including tools)
      const capturingModel = createTestModel({
        defaultResponse: "Response",
      });

      function Agent() {
        return (
          <>
            <TestTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.tick({}).result;

      // Tools should have been passed to the model
      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThan(0);

      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.length).toBeGreaterThan(0);
      expect(receivedTools.some((t: any) => t.name === "test_tool")).toBe(true);

      session.close();
    });

    it("should execute tool when model calls it", async () => {
      const handler = vi.fn(() => [{ type: "text" as const, text: "tool executed" }]);

      const TestTool = createTool({
        name: "execute_test",
        description: "A tool to test execution",
        input: z.object({ value: z.string() }),
        handler,
      });

      // Model that calls the tool, then stops
      let callCount = 0;
      const toolCallingModel = createModel<
        ModelInput,
        ModelOutput,
        ModelInput,
        ModelOutput,
        StreamEvent
      >({
        metadata: {
          id: "tool-calling-model",
          provider: "mock",
          capabilities: [],
        },
        executors: {
          execute: async () => {
            callCount++;
            if (callCount === 1) {
              // First call: request tool execution
              return {
                model: "mock-model",
                createdAt: new Date().toISOString(),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      toolUseId: "call-1",
                      id: "call-1",
                      name: "execute_test",
                      input: { value: "test" },
                    },
                  ],
                },
                toolCalls: [{ id: "call-1", name: "execute_test", input: { value: "test" } }],
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                stopReason: "tool_use" as StopReason,
                raw: {},
              } as ModelOutput;
            }
            // Second call: stop
            return {
              model: "mock-model",
              createdAt: new Date().toISOString(),
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Done" }],
              },
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              stopReason: "stop" as StopReason,
              raw: {},
            } as ModelOutput;
          },
          // Note: No executeStream - this test specifically tests tool execution
          // via the non-streaming (execute) path which returns toolCalls
        },
        fromEngineState,
        toEngineState,
      });

      function Agent() {
        return (
          <>
            <TestTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={toolCallingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = app.session();

      await session.tick({}).result;

      // Handler should have been called
      expect(handler).toHaveBeenCalledWith({ value: "test" });

      session.close();
    });
  });

  describe("tool render", () => {
    it("should include tool in model input when tool has render function", async () => {
      // Simpler test: verify that a tool with a render function is still registered
      // and available to the model (the render output goes to sections)
      const RenderingTool = createTool({
        name: "rendering_tool",
        description: "A tool that renders content",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
        render: () => (
          <Section id="tool-state" audience="model">
            Current tool state: active
          </Section>
        ),
      });

      // Model that captures inputs (including tools)
      const capturingModel = createTestModel({
        defaultResponse: "Response",
      });

      function Agent() {
        return (
          <>
            <RenderingTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.tick({}).result;

      // Tool should be registered even when it has a render function
      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThan(0);

      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.length).toBeGreaterThan(0);
      expect(receivedTools.some((t: any) => t.name === "rendering_tool")).toBe(true);

      session.close();
    });
  });

  describe("direct tool usage", () => {
    it("should have accessible metadata", () => {
      const TestTool = createTool({
        name: "metadata_test",
        description: "A tool for testing metadata",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
      });

      // Metadata should be accessible as static property
      expect(TestTool.metadata).toBeDefined();
      expect(TestTool.metadata.name).toBe("metadata_test");
      expect(TestTool.metadata.description).toBe("A tool for testing metadata");
      expect(TestTool.metadata.input).toBeDefined();
    });

    it("should be directly executable via .run()", async () => {
      const handler = vi.fn(() => [{ type: "text" as const, text: "executed!" }]);

      const TestTool = createTool({
        name: "runnable_test",
        description: "A tool for testing direct execution",
        input: z.object({ value: z.string() }),
        handler,
      });

      // Run should be accessible as static property
      expect(TestTool.run).toBeDefined();

      // Execute the tool directly - procedures return ExecutionHandle, use .result
      const result = await TestTool.run!({ value: "test input" }).result;

      expect(handler).toHaveBeenCalledWith({ value: "test input" });
      expect(result).toEqual([{ type: "text", text: "executed!" }]);
    });
  });
});
