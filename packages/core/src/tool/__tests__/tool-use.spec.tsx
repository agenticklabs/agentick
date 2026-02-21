/**
 * Tool use() Hook Tests
 *
 * Tests for the `use()` option on createTool:
 * - use() captures render-time context and passes it as deps to handler
 * - Core deps (ctx) are auto-populated
 * - Direct .run() invocation does not call use(), deps is undefined
 * - Multiple tools with different use() contexts work independently
 */

import { describe, it, expect, vi } from "vitest";
import React, { createContext, useContext } from "react";
import { createApp } from "../../app.js";
import { createTool } from "../../tool/tool.js";
import { Model, Section } from "../../jsx/components/primitives.js";
import { createTestAdapter, type TestAdapterInstance } from "../../testing/index.js";
import { z } from "zod";

// ============================================================================
// Test Context — simulates a provider like <Sandbox>
// ============================================================================

interface TestSandbox {
  exec(command: string): Promise<{ stdout: string }>;
}

const SandboxContext = createContext<TestSandbox | null>(null);

function useSandbox(): TestSandbox {
  const sandbox = useContext(SandboxContext);
  if (!sandbox) throw new Error("useSandbox must be used within a SandboxProvider");
  return sandbox;
}

/**
 * Simulates the <Sandbox> provider component.
 * Provides a TestSandbox via React Context to children.
 */
function SandboxProvider({
  sandbox,
  children,
}: {
  sandbox: TestSandbox;
  children: React.ReactNode;
}) {
  return React.createElement(SandboxContext.Provider, { value: sandbox }, children);
}

// ============================================================================
// Helper
// ============================================================================

function createMockModel(options?: { response?: string }): TestAdapterInstance {
  return createTestAdapter({
    defaultResponse: options?.response ?? "Done",
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("createTool use() hook", () => {
  describe("basic use() + deps", () => {
    it("should pass use() return value to handler as deps when rendered in JSX", async () => {
      let receivedDeps: any = "NOT_CALLED";

      const mockSandbox: TestSandbox = {
        exec: vi.fn(async (cmd) => ({ stdout: `output of ${cmd}` })),
      };

      const ShellTool = createTool({
        name: "shell",
        description: "Execute a command",
        input: z.object({ command: z.string() }),
        use: () => ({ sandbox: useSandbox() }),
        handler: async ({ command }, deps) => {
          receivedDeps = deps;
          // Type inference test: deps.sandbox should be typed as TestSandbox
          const result = await deps!.sandbox.exec(command);
          return [{ type: "text" as const, text: result.stdout }];
        },
      });

      const model = createMockModel();
      model.respondWith([{ tool: { name: "shell", input: { command: "ls" } } }]);

      function Agent() {
        return (
          <SandboxProvider sandbox={mockSandbox}>
            <ShellTool />
            <Section id="system" audience="model">
              Test agent
            </Section>
            <Model model={model} />
          </SandboxProvider>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = await app.session();
      await session.render({}).result;

      // Handler should have been called with deps
      expect(receivedDeps).toBeDefined();
      expect(receivedDeps).not.toBe("NOT_CALLED");

      // Deps should contain the sandbox from use()
      expect(receivedDeps.sandbox).toBe(mockSandbox);

      // Deps should contain core ctx (COM)
      expect(receivedDeps.ctx).toBeDefined();
      expect(typeof receivedDeps.ctx.setState).toBe("function");

      // The sandbox.exec should have been called
      expect(mockSandbox.exec).toHaveBeenCalledWith("ls");

      session.close();
    });

    it("should pass undefined deps when tool is run directly via .run()", async () => {
      let receivedDeps: any = "NOT_CALLED";

      const ShellTool = createTool({
        name: "shell_direct",
        description: "Execute a command",
        input: z.object({ command: z.string() }),
        use: () => ({ sandbox: { exec: async () => ({ stdout: "mock" }) } }),
        handler: async ({ command }, deps) => {
          receivedDeps = deps;
          return [{ type: "text" as const, text: command }];
        },
      });

      // Direct execution — use() does NOT run, deps is undefined
      // The static run wraps the original handler, which receives (input, ctx)
      // where ctx comes from the executor (undefined for direct calls)
      await ShellTool.run!({ command: "test" }).result;

      // Handler was called but deps is whatever the static run passes (undefined for direct)
      expect(receivedDeps).toBeUndefined();
    });

    it("should auto-populate ctx in core deps", async () => {
      let receivedCtx: any = null;

      const CtxTool = createTool({
        name: "ctx_tool",
        description: "Tool that checks ctx in deps",
        input: z.object({ value: z.string() }),
        use: () => ({}), // No custom deps, just core
        handler: async ({ value }, deps) => {
          // Type inference: deps should be ToolCoreDeps & {} = ToolCoreDeps
          receivedCtx = deps?.ctx;
          return [{ type: "text" as const, text: value }];
        },
      });

      const model = createMockModel();
      model.respondWith([{ tool: { name: "ctx_tool", input: { value: "hello" } } }]);

      function Agent() {
        return (
          <>
            <CtxTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={model} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = await app.session();
      await session.render({}).result;

      // Core deps should include ctx (COM)
      expect(receivedCtx).toBeDefined();
      expect(typeof receivedCtx.setState).toBe("function");
      expect(typeof receivedCtx.addMessage).toBe("function");

      session.close();
    });
  });

  describe("tree scoping", () => {
    it("should scope use() to nearest provider in the tree", async () => {
      let receivedSandboxA: any = null;
      let receivedSandboxB: any = null;

      const sandboxA: TestSandbox = {
        exec: vi.fn(async () => ({ stdout: "from A" })),
      };
      const sandboxB: TestSandbox = {
        exec: vi.fn(async () => ({ stdout: "from B" })),
      };

      const ToolA = createTool({
        name: "tool_a",
        description: "Tool A",
        input: z.object({ value: z.string() }),
        use: () => ({ sandbox: useSandbox() }),
        handler: async ({ value }, deps) => {
          receivedSandboxA = deps?.sandbox;
          return [{ type: "text" as const, text: value }];
        },
      });

      const ToolB = createTool({
        name: "tool_b",
        description: "Tool B",
        input: z.object({ value: z.string() }),
        use: () => ({ sandbox: useSandbox() }),
        handler: async ({ value }, deps) => {
          receivedSandboxB = deps?.sandbox;
          return [{ type: "text" as const, text: value }];
        },
      });

      const model = createMockModel();
      // Call both tools
      model.respondWith([
        { tool: { name: "tool_a", input: { value: "a" } } },
        { tool: { name: "tool_b", input: { value: "b" } } },
      ]);

      function Agent() {
        return (
          <>
            <SandboxProvider sandbox={sandboxA}>
              <ToolA />
            </SandboxProvider>
            <SandboxProvider sandbox={sandboxB}>
              <ToolB />
            </SandboxProvider>
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={model} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = await app.session();
      await session.render({}).result;

      // Each tool should have captured its own provider's sandbox
      expect(receivedSandboxA).toBe(sandboxA);
      expect(receivedSandboxB).toBe(sandboxB);

      session.close();
    });
  });

  describe("backward compatibility", () => {
    it("should work normally without use() — handler receives ctx as before", async () => {
      let receivedCtx: any = "NOT_CALLED";

      const ClassicTool = createTool({
        name: "classic_tool",
        description: "A tool without use()",
        input: z.object({ value: z.string() }),
        handler: (input, ctx) => {
          receivedCtx = ctx;
          return [{ type: "text" as const, text: input.value }];
        },
      });

      const model = createMockModel();
      model.respondWith([{ tool: { name: "classic_tool", input: { value: "test" } } }]);

      function Agent() {
        return (
          <>
            <ClassicTool />
            <Section id="system" audience="model">
              Test
            </Section>
            <Model model={model} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 3 });
      const session = await app.session();
      await session.render({}).result;

      // Without use(), handler still receives COM as second arg (from tool executor)
      expect(receivedCtx).toBeDefined();
      expect(typeof receivedCtx.setState).toBe("function");

      session.close();
    });

    it("static metadata and run should be unchanged", () => {
      const TestTool = createTool({
        name: "meta_test",
        description: "Testing metadata",
        input: z.object({ x: z.number() }),
        use: () => ({ extra: 42 }),
        handler: async ({ x }, _deps) => [{ type: "text" as const, text: String(x) }],
      });

      // Static properties should still work
      expect(TestTool.metadata).toBeDefined();
      expect(TestTool.metadata.name).toBe("meta_test");
      expect(TestTool.run).toBeDefined();
    });

    it("static .run() should work when use() is provided", async () => {
      const handler = vi.fn(async ({ x }: { x: number }, _deps?: any) => [
        { type: "text" as const, text: String(x) },
      ]);

      const TestTool = createTool({
        name: "static_run_test",
        description: "Test static run with use()",
        input: z.object({ x: z.number() }),
        use: () => ({ extra: 42 }),
        handler,
      });

      // Static run still works — deps will be undefined
      const result = await TestTool.run!({ x: 7 }).result;
      expect(result).toEqual([{ type: "text", text: "7" }]);
      // Handler called with input, second arg is undefined (no COM for direct calls)
      expect(handler).toHaveBeenCalledWith({ x: 7 });
    });
  });
});
