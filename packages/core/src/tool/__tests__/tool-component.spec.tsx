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
import { createTestAdapter, type TestAdapterInstance } from "../../testing";
import type { ToolCall } from "@agentick/shared";
import { StopReason } from "@agentick/shared";
import { z } from "zod";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock model using createTestAdapter.
 */
function createMockModel(options?: {
  toolCalls?: ToolCall[];
  response?: string;
}): TestAdapterInstance {
  const model = createTestAdapter({
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
      const session = await app.session();

      // Run a tick to trigger tool registration
      await session.render({}).result;

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
      const capturingModel = createTestAdapter({
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
      const session = await app.session();

      await session.render({}).result;

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

      // Model that calls the tool on first call, then returns text
      const toolCallingModel = createTestAdapter({
        defaultResponse: "Done",
      });

      // Queue the tool call for the first response
      toolCallingModel.respondWith([{ tool: { name: "execute_test", input: { value: "test" } } }]);

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
      const session = await app.session();

      await session.render({}).result;

      // Handler should have been called with input and com
      expect(handler).toHaveBeenCalledWith({ value: "test" }, expect.anything());

      session.close();
    });

    it("should pass COM to tool handler during execution", async () => {
      let receivedCom: any = null;

      const StatefulTool = createTool({
        name: "stateful_tool",
        description: "A tool that uses COM",
        input: z.object({ key: z.string(), value: z.string() }),
        handler: (input, ctx) => {
          receivedCom = ctx;
          ctx?.setState(input.key, input.value);
          return [{ type: "text" as const, text: `Set ${input.key}=${input.value}` }];
        },
      });

      const toolCallingModel = createTestAdapter({
        defaultResponse: "Done",
      });

      toolCallingModel.respondWith([
        { tool: { name: "stateful_tool", input: { key: "color", value: "blue" } } },
      ]);

      function Agent() {
        return (
          <>
            <StatefulTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={toolCallingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = await app.session();

      await session.render({}).result;

      // COM should have been passed to the handler
      expect(receivedCom).toBeDefined();
      expect(receivedCom).not.toBeNull();
      // COM should have setState method
      expect(typeof receivedCom.setState).toBe("function");

      session.close();
    });

    it("should not pass COM when running tool directly", async () => {
      let receivedCom: any = "NOT_CALLED";

      const DirectTool = createTool({
        name: "direct_tool",
        description: "A tool for direct execution",
        input: z.object({ value: z.string() }),
        handler: (input, ctx) => {
          receivedCom = ctx;
          return [{ type: "text" as const, text: input.value }];
        },
      });

      // Run directly - no COM available
      await DirectTool.run!({ value: "test" }).result;

      expect(receivedCom).toBeUndefined();
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
      const capturingModel = createTestAdapter({
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
      const session = await app.session();

      await session.render({}).result;

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
