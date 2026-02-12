/**
 * Test Runner Factory Tests
 *
 * Tests for createTestRunner helper.
 */

import { describe, it, expect } from "vitest";
import { createTestRunner } from "../test-runner";

describe("createTestRunner", () => {
  it("should create runner with default name", () => {
    const { runner } = createTestRunner();
    expect(runner.name).toBe("test");
  });

  it("should create runner with custom name", () => {
    const { runner } = createTestRunner({ name: "repl" });
    expect(runner.name).toBe("repl");
  });

  it("should have all lifecycle hooks defined", () => {
    const { runner } = createTestRunner();
    expect(runner.onSessionInit).toBeTypeOf("function");
    expect(runner.transformCompiled).toBeTypeOf("function");
    expect(runner.executeToolCall).toBeTypeOf("function");
    expect(runner.onPersist).toBeTypeOf("function");
    expect(runner.onRestore).toBeTypeOf("function");
    expect(runner.onDestroy).toBeTypeOf("function");
  });

  it("should start with empty tracker", () => {
    const { tracker } = createTestRunner();
    expect(tracker.initCalls).toHaveLength(0);
    expect(tracker.transformCompiledCalls).toHaveLength(0);
    expect(tracker.toolCalls).toHaveLength(0);
    expect(tracker.persistCalls).toHaveLength(0);
    expect(tracker.restoreCalls).toHaveLength(0);
    expect(tracker.destroyCalls).toHaveLength(0);
  });

  it("should reset tracker", () => {
    const { tracker } = createTestRunner();
    tracker.initCalls.push("session-1");
    tracker.transformCompiledCalls.push({ tools: ["tool-1"] });
    tracker.toolCalls.push({ name: "tool-1", intercepted: false });
    tracker.persistCalls.push("session-1");
    tracker.restoreCalls.push("session-1");
    tracker.destroyCalls.push("session-1");

    tracker.reset();

    expect(tracker.initCalls).toHaveLength(0);
    expect(tracker.transformCompiledCalls).toHaveLength(0);
    expect(tracker.toolCalls).toHaveLength(0);
    expect(tracker.persistCalls).toHaveLength(0);
    expect(tracker.restoreCalls).toHaveLength(0);
    expect(tracker.destroyCalls).toHaveLength(0);
  });

  it("should intercept configured tools", async () => {
    const { runner, tracker } = createTestRunner({
      interceptTools: { execute: "sandbox result" },
    });

    const result = await runner.executeToolCall!(
      { id: "call-1", name: "execute", input: { code: "1+1" } },
      undefined,
      async () => ({
        id: "result-1",
        toolUseId: "call-1",
        name: "execute",
        success: true,
        content: [{ type: "text" as const, text: "original" }],
      }),
    );

    expect(result.content).toEqual([{ type: "text", text: "sandbox result" }]);
    expect(tracker.toolCalls).toEqual([{ name: "execute", intercepted: true }]);
  });

  it("should pass through non-intercepted tools", async () => {
    const { runner, tracker } = createTestRunner({
      interceptTools: { execute: "sandbox result" },
    });

    const result = await runner.executeToolCall!(
      { id: "call-1", name: "other_tool", input: {} },
      undefined,
      async () => ({
        id: "result-1",
        toolUseId: "call-1",
        name: "other_tool",
        success: true,
        content: [{ type: "text" as const, text: "original" }],
      }),
    );

    expect(result.content).toEqual([{ type: "text", text: "original" }]);
    expect(tracker.toolCalls).toEqual([{ name: "other_tool", intercepted: false }]);
  });

  it("should apply transformInput when provided", async () => {
    const { runner } = createTestRunner({
      transformInput: (compiled) => ({ ...compiled, tools: [] }),
    });

    const input = { system: [], timeline: [], tools: [{ name: "tool" }] } as any;
    const result = await runner.transformCompiled!(input, []);

    expect(result.tools).toEqual([]);
  });

  it("should pass through input when no transformInput", async () => {
    const { runner } = createTestRunner();

    const input = { system: [], timeline: [], tools: [{ name: "tool" }] } as any;
    const result = await runner.transformCompiled!(input, []);

    expect(result).toBe(input);
  });

  // ==========================================================================
  // Function interceptors
  // ==========================================================================

  describe("function interceptors", () => {
    it("should call function interceptor with the ToolCall", async () => {
      const { runner, tracker } = createTestRunner({
        interceptTools: {
          execute: (call) => ({
            id: call.id,
            toolUseId: call.id,
            name: call.name,
            success: true,
            content: [{ type: "text" as const, text: `ran: ${call.input.code}` }],
          }),
        },
      });

      const result = await runner.executeToolCall!(
        { id: "call-1", name: "execute", input: { code: "1+1" } },
        undefined,
        async () => ({
          id: "x",
          toolUseId: "call-1",
          name: "execute",
          success: true,
          content: [{ type: "text" as const, text: "should not reach" }],
        }),
      );

      expect(result.content).toEqual([{ type: "text", text: "ran: 1+1" }]);
      expect(tracker.toolCalls).toEqual([{ name: "execute", intercepted: true }]);
    });

    it("should support async function interceptors", async () => {
      const { runner } = createTestRunner({
        interceptTools: {
          slow_tool: async (call) => {
            await new Promise((r) => setTimeout(r, 5));
            return {
              id: call.id,
              toolUseId: call.id,
              name: call.name,
              success: true,
              content: [{ type: "text" as const, text: "async result" }],
            };
          },
        },
      });

      const result = await runner.executeToolCall!(
        { id: "call-1", name: "slow_tool", input: {} },
        undefined,
        async () => ({
          id: "x",
          toolUseId: "call-1",
          name: "slow_tool",
          success: true,
          content: [{ type: "text" as const, text: "original" }],
        }),
      );

      expect(result.content).toEqual([{ type: "text", text: "async result" }]);
    });

    it("should mix string and function interceptors", async () => {
      const { runner, tracker } = createTestRunner({
        interceptTools: {
          simple: "static result",
          dynamic: (call) => ({
            id: call.id,
            toolUseId: call.id,
            name: call.name,
            success: true,
            content: [{ type: "text" as const, text: `dynamic: ${call.input.x}` }],
          }),
        },
      });

      const staticResult = await runner.executeToolCall!(
        { id: "c1", name: "simple", input: {} },
        undefined,
        async () => ({ id: "x", toolUseId: "c1", name: "simple", success: true, content: [] }),
      );

      const dynamicResult = await runner.executeToolCall!(
        { id: "c2", name: "dynamic", input: { x: 42 } },
        undefined,
        async () => ({ id: "x", toolUseId: "c2", name: "dynamic", success: true, content: [] }),
      );

      expect(staticResult.content).toEqual([{ type: "text", text: "static result" }]);
      expect(dynamicResult.content).toEqual([{ type: "text", text: "dynamic: 42" }]);
      expect(tracker.toolCalls).toEqual([
        { name: "simple", intercepted: true },
        { name: "dynamic", intercepted: true },
      ]);
    });
  });
});
