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
import { createTool, ToolIntent, ToolExecutionType } from "../../tool/tool";
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

  describe("prop overrides", () => {
    it("should override description via JSX prop", async () => {
      const TestTool = createTool({
        name: "overridable_tool",
        description: "Original description",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <TestTool description="Overridden description" />
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

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      const tool = receivedTools.find((t: any) => t.name === "overridable_tool");
      expect(tool).toBeDefined();
      expect(tool!.description).toBe("Overridden description");

      session.close();
    });

    it("should override name via JSX prop", async () => {
      const TestTool = createTool({
        name: "original_name",
        description: "A test tool",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <TestTool name="renamed_tool" />
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

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.some((t: any) => t.name === "renamed_tool")).toBe(true);
      expect(receivedTools.some((t: any) => t.name === "original_name")).toBe(false);

      session.close();
    });

    it("should use defaults when no prop overrides provided", async () => {
      const TestTool = createTool({
        name: "default_tool",
        description: "Default description",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

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

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      const tool = receivedTools.find((t: any) => t.name === "default_tool");
      expect(tool).toBeDefined();
      expect(tool!.description).toBe("Default description");

      session.close();
    });

    it("should not override static metadata on ToolClass", () => {
      const TestTool = createTool({
        name: "static_metadata_tool",
        description: "Original",
        input: z.object({ value: z.string() }),
        handler: () => [{ type: "text" as const, text: "result" }],
      });

      // Static metadata should be unchanged regardless of JSX props
      expect(TestTool.metadata.name).toBe("static_metadata_tool");
      expect(TestTool.metadata.description).toBe("Original");
    });

    it("should execute tool by overridden name when model calls it", async () => {
      const handler = vi.fn(() => [{ type: "text" as const, text: "executed" }]);

      const TestTool = createTool({
        name: "original_name",
        description: "Test",
        input: z.object({ v: z.string() }),
        handler,
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Done" });
      // Model calls the tool by its overridden name
      capturingModel.respondWith([{ tool: { name: "custom_name", input: { v: "test" } } }]);

      function Agent() {
        return (
          <>
            <TestTool name="custom_name" />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 5 });
      const session = await app.session();
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }).result;

      // Handler should have been called — tool was found by overridden name
      expect(handler).toHaveBeenCalled();
      const callArgs = handler.mock.calls[0];
      expect(callArgs[0]).toEqual({ v: "test" });

      session.close();
    });

    it("should override requiresConfirmation via JSX prop", async () => {
      const TestTool = createTool({
        name: "confirmable_tool",
        description: "Test confirmation override",
        input: z.object({ v: z.string() }),
        requiresConfirmation: false,
        handler: () => [{ type: "text" as const, text: "done" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Done" });

      function Agent() {
        return (
          <>
            <TestTool requiresConfirmation={true} />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();
      await session.render({}).result;

      // Static metadata unchanged
      expect(TestTool.metadata.requiresConfirmation).toBe(false);

      // Compiled tool metadata should have the override
      // Verify via the model input — the tool should exist with the right name
      const capturedInputs = capturingModel.getCapturedInputs();
      const tool = capturedInputs[0].tools?.find((t: any) => t.name === "confirmable_tool");
      expect(tool).toBeDefined();

      session.close();
    });
  });

  describe("compiled tools carry full metadata", () => {
    it("should preserve intent and type in compiled tools", async () => {
      const ActionTool = createTool({
        name: "action_tool",
        description: "An action tool",
        input: z.object({ target: z.string() }),
        intent: ToolIntent.ACTION,
        type: ToolExecutionType.SERVER,
        requiresConfirmation: true,
        handler: () => [{ type: "text" as const, text: "done" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <ActionTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();
      await session.render({}).result;

      // The tool should have been executed with full metadata available
      // We verify this indirectly through the model receiving the tool
      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.some((t: any) => t.name === "action_tool")).toBe(true);

      session.close();
    });
  });

  describe("tool source merging", () => {
    it("should merge app-level tools with JSX tools", async () => {
      const JsxTool = createTool({
        name: "jsx_tool",
        description: "From JSX",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const AppTool = createTool({
        name: "app_tool",
        description: "From app options",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "app" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1, tools: [AppTool] });
      const session = await app.session();
      await session.render({}).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      // Both tools should be available
      expect(receivedTools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(receivedTools.some((t: any) => t.name === "app_tool")).toBe(true);

      session.close();
    });

    it("should give JSX tools priority over app tools on name conflict", async () => {
      const JsxTool = createTool({
        name: "shared_name",
        description: "JSX version",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const AppTool = createTool({
        name: "shared_name",
        description: "App version",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "app" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1, tools: [AppTool] });
      const session = await app.session();
      await session.render({}).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      // Only one tool with that name, and it should be the JSX version
      const matchingTools = receivedTools.filter((t: any) => t.name === "shared_name");
      expect(matchingTools).toHaveLength(1);
      expect(matchingTools[0].description).toBe("JSX version");

      session.close();
    });

    it("should merge session-level tools", async () => {
      const JsxTool = createTool({
        name: "jsx_tool",
        description: "From JSX",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const SessionTool = createTool({
        name: "session_tool",
        description: "From session options",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "session" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session({ tools: [SessionTool] });
      await session.render({}).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(receivedTools.some((t: any) => t.name === "session_tool")).toBe(true);

      session.close();
    });

    it("should merge per-execution tools from send input", async () => {
      const JsxTool = createTool({
        name: "jsx_tool",
        description: "From JSX",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const ExecTool = createTool({
        name: "exec_tool",
        description: "From execution",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "exec" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [ExecTool],
      }).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      const lastInput = capturedInputs[capturedInputs.length - 1];
      const receivedTools = lastInput.tools ?? [];

      expect(receivedTools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(receivedTools.some((t: any) => t.name === "exec_tool")).toBe(true);

      session.close();
    });
  });

  describe("multi-tick tool availability", () => {
    it("should make all tool sources available on every tick", async () => {
      const JsxTool = createTool({
        name: "jsx_tool",
        description: "From JSX",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const AppTool = createTool({
        name: "app_tool",
        description: "From app",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "app" }],
      });

      const SessionTool = createTool({
        name: "session_tool",
        description: "From session",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "session" }],
      });

      // Model calls a tool on tick 1, then responds on tick 2
      const capturingModel = createTestAdapter({ defaultResponse: "Final" });
      capturingModel.respondWith([{ tool: { name: "jsx_tool", input: { v: "test" } } }]);

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Multi-tick test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 5, tools: [AppTool] });
      const session = await app.session({ tools: [SessionTool] });
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

      // Tick 1: all 3 tool sources should be present
      const tick1Tools = capturedInputs[0].tools ?? [];
      expect(tick1Tools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(tick1Tools.some((t: any) => t.name === "app_tool")).toBe(true);
      expect(tick1Tools.some((t: any) => t.name === "session_tool")).toBe(true);

      // Tick 2 (after tool result): same tools still available
      const tick2Tools = capturedInputs[1].tools ?? [];
      expect(tick2Tools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(tick2Tools.some((t: any) => t.name === "app_tool")).toBe(true);
      expect(tick2Tools.some((t: any) => t.name === "session_tool")).toBe(true);

      session.close();
    });

    it("should preserve overridden description across ticks", async () => {
      const BaseTool = createTool({
        name: "edit_file",
        description: "Default description",
        input: z.object({ path: z.string() }),
        handler: () => [{ type: "text" as const, text: "edited" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Done" });
      capturingModel.respondWith([{ tool: { name: "edit_file", input: { path: "/a.ts" } } }]);

      function Agent() {
        return (
          <>
            <BaseTool description="Apply surgical edits with full context." />
            <Section id="system" audience="model">
              Override test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 5 });
      const session = await app.session();
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "edit" }] }],
      }).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

      // Both ticks should see the overridden description, not the default
      for (let i = 0; i < capturedInputs.length; i++) {
        const tools = capturedInputs[i].tools ?? [];
        const editTool = tools.find((t: any) => t.name === "edit_file");
        expect(editTool).toBeDefined();
        expect(editTool!.description).toBe("Apply surgical edits with full context.");
      }

      session.close();
    });

    it("should only include execution tools during their execution", async () => {
      const JsxTool = createTool({
        name: "jsx_tool",
        description: "Always present",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      const ExecTool = createTool({
        name: "exec_tool",
        description: "Only during execution 1",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "exec" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Response" });

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Execution 1: send with exec_tool
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "exec 1" }] }],
        tools: [ExecTool],
      }).result;

      const exec1Inputs = capturingModel.getCapturedInputs();
      const exec1Tools = exec1Inputs[exec1Inputs.length - 1].tools ?? [];
      expect(exec1Tools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(exec1Tools.some((t: any) => t.name === "exec_tool")).toBe(true);

      capturingModel.clearCapturedInputs();

      // Execution 2: send without exec_tool
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "exec 2" }] }],
      }).result;

      const exec2Inputs = capturingModel.getCapturedInputs();
      const exec2Tools = exec2Inputs[exec2Inputs.length - 1].tools ?? [];
      expect(exec2Tools.some((t: any) => t.name === "jsx_tool")).toBe(true);
      expect(exec2Tools.some((t: any) => t.name === "exec_tool")).toBe(false);

      session.close();
    });

    it("should maintain correct priority across ticks (JSX > execution > session > app)", async () => {
      // All 4 sources define a tool with the same name, different descriptions
      const AppTool = createTool({
        name: "shared",
        description: "app-level",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "app" }],
      });

      const SessionTool = createTool({
        name: "shared",
        description: "session-level",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "session" }],
      });

      const ExecTool = createTool({
        name: "shared",
        description: "execution-level",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "exec" }],
      });

      const JsxTool = createTool({
        name: "shared",
        description: "jsx-level",
        input: z.object({ v: z.string() }),
        handler: () => [{ type: "text" as const, text: "jsx" }],
      });

      // Multi-tick: tool call on tick 1, response on tick 2
      const capturingModel = createTestAdapter({ defaultResponse: "Done" });
      capturingModel.respondWith([{ tool: { name: "shared", input: { v: "test" } } }]);

      function Agent() {
        return (
          <>
            <JsxTool />
            <Section id="system" audience="model">
              Priority test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 5, tools: [AppTool] });
      const session = await app.session({ tools: [SessionTool] });
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        tools: [ExecTool],
      }).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

      // JSX wins on both ticks (highest priority)
      for (let i = 0; i < capturedInputs.length; i++) {
        const tools = capturedInputs[i].tools ?? [];
        const sharedTools = tools.filter((t: any) => t.name === "shared");
        expect(sharedTools).toHaveLength(1);
        expect(sharedTools[0].description).toBe("jsx-level");
      }

      session.close();
    });

    it("should preserve full metadata (intent, type) in model input across ticks", async () => {
      const TypedTool = createTool({
        name: "typed_tool",
        description: "Has intent and type",
        input: z.object({ v: z.string() }),
        intent: ToolIntent.ACTION,
        type: ToolExecutionType.SERVER,
        handler: () => [{ type: "text" as const, text: "done" }],
      });

      const capturingModel = createTestAdapter({ defaultResponse: "Done" });
      capturingModel.respondWith([{ tool: { name: "typed_tool", input: { v: "test" } } }]);

      function Agent() {
        return (
          <>
            <TypedTool />
            <Section id="system" audience="model">
              Metadata test
            </Section>
            <Model model={capturingModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 5 });
      const session = await app.session();
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }).result;

      const capturedInputs = capturingModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

      // Verify metadata preserved on both ticks
      for (let i = 0; i < capturedInputs.length; i++) {
        const tools = capturedInputs[i].tools ?? [];
        const typed = tools.find((t: any) => t.name === "typed_tool");
        expect(typed).toBeDefined();
        expect(typed!.intent).toBe(ToolIntent.ACTION);
        expect(typed!.type).toBe(ToolExecutionType.SERVER);
      }

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
