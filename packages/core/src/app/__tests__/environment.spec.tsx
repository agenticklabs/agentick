/**
 * ExecutionEnvironment Tests
 *
 * Comprehensive tests for the ExecutionEnvironment system including:
 * - Default behavior (no environment configured)
 * - prepareModelInput: transforming compiled input before model call
 * - executeToolCall: intercepting/wrapping tool execution
 * - Lifecycle hooks: onSessionInit, onPersist, onRestore, onDestroy
 * - Edge cases: async hooks, error handling, multi-tick interactions
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createApp } from "../../app";
import { createTestAdapter } from "../../testing/test-adapter";
import { createTestEnvironment } from "../../testing/test-environment";
import { createTool } from "../../tool";
import { System, User } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { MemorySessionStore } from "../session-store";
import type { ExecutionEnvironment } from "../types";
import type { ExecutableTool } from "../../tool/tool";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(response = "Mock response") {
  return createTestAdapter({ defaultResponse: response });
}

const SimpleAgent = ({ query }: { query: string }) => (
  <>
    <System>You are helpful.</System>
    <Timeline />
    <User>{query}</User>
  </>
);

// ============================================================================
// Default Behavior (no environment)
// ============================================================================

describe("ExecutionEnvironment", () => {
  describe("default behavior (no environment)", () => {
    it("should work identically without an environment configured", async () => {
      const model = createMockModel("Hello from model");

      const app = createApp(SimpleAgent, { model, maxTicks: 1 });
      const session = await app.session();

      const result = await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      expect(result.response).toBe("Hello from model");
    });
  });

  // ============================================================================
  // prepareModelInput
  // ============================================================================

  describe("prepareModelInput", () => {
    it("should transform model input before model call", async () => {
      const model = createMockModel("Transformed response");
      const capturedInputs: any[] = [];

      const env: ExecutionEnvironment = {
        name: "test-transform",
        prepareModelInput(compiled) {
          capturedInputs.push(compiled);
          // Add a custom section to the system messages
          const modifiedSystem = [
            ...(compiled.system ?? []),
            {
              kind: "message" as const,
              message: {
                role: "system" as const,
                content: [{ type: "text" as const, text: "ENVIRONMENT INJECTED" }],
              },
            },
          ];
          return { ...compiled, system: modifiedSystem };
        },
      };

      const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
      const session = await app.session();

      const result = await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      expect(result.response).toBe("Transformed response");
      expect(capturedInputs).toHaveLength(1);
      // Verify the transform was called with a COMInput-like object
      expect(capturedInputs[0]).toHaveProperty("system");
    });

    it("should receive tools list as second argument", async () => {
      const model = createMockModel("Response");
      let receivedTools: ExecutableTool[] = [];

      const TestTool = createTool({
        name: "test_tool",
        description: "A test tool",
        input: z.object({ value: z.string() }),
        handler: async (input) => [{ type: "text" as const, text: input.value }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const env: ExecutionEnvironment = {
        name: "test-tools",
        prepareModelInput(compiled, tools) {
          receivedTools = tools;
          return compiled;
        },
      };

      const app = createApp(AgentWithTool, { model, maxTicks: 1, environment: env });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      expect(receivedTools.length).toBeGreaterThanOrEqual(1);
      expect(receivedTools.some((t) => t.metadata?.name === "test_tool")).toBe(true);
    });

    it("should support async prepareModelInput", async () => {
      const model = createMockModel("Async transformed");

      const env: ExecutionEnvironment = {
        name: "test-async-transform",
        async prepareModelInput(compiled) {
          // Simulate async work
          await new Promise((r) => setTimeout(r, 5));
          return compiled;
        },
      };

      const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
      const session = await app.session();

      const result = await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      expect(result.response).toBe("Async transformed");
    });

    it("should be called on every tick", async () => {
      const model = createMockModel("Response");
      let callCount = 0;

      const TestTool = createTool({
        name: "noop_tool",
        description: "Does nothing",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "done" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const env: ExecutionEnvironment = {
        name: "test-multi-tick",
        prepareModelInput(compiled) {
          callCount++;
          return compiled;
        },
      };

      // Make model call tool on first tick, then stop on second
      model.respondWith([{ tool: { name: "noop_tool", input: {} } }]);

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment: env });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      // Should be called for each tick
      expect(callCount).toBe(2);
    });
  });

  // ============================================================================
  // executeToolCall
  // ============================================================================

  describe("executeToolCall", () => {
    it("should intercept tool execution", async () => {
      const model = createMockModel("Final response");

      const TestTool = createTool({
        name: "intercepted_tool",
        description: "A tool to intercept",
        input: z.object({ value: z.string() }),
        handler: async (input) => [{ type: "text" as const, text: `original: ${input.value}` }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const env: ExecutionEnvironment = {
        name: "test-intercept",
        async executeToolCall(call, _tool, _next) {
          if (call.name === "intercepted_tool") {
            return {
              id: call.id,
              toolUseId: call.id,
              name: call.name,
              success: true,
              content: [{ type: "text" as const, text: "intercepted!" }],
            };
          }
          return _next();
        },
      };

      // Make model call the tool
      model.respondWith([{ tool: { name: "intercepted_tool", input: { value: "test" } } }]);

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment: env });
      const session = await app.session();

      const result = await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Use the tool" }] }],
      }).result;

      expect(result.response).toBe("Final response");
    });

    it("should pass through to next() for non-intercepted tools", async () => {
      const model = createMockModel("Done");
      let handlerCalled = false;

      const PassthroughTool = createTool({
        name: "passthrough_tool",
        description: "A tool that passes through",
        input: z.object({}),
        handler: async () => {
          handlerCalled = true;
          return [{ type: "text" as const, text: "original handler" }];
        },
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <PassthroughTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const env: ExecutionEnvironment = {
        name: "test-passthrough",
        async executeToolCall(call, _tool, next) {
          // Only intercept "intercepted_tool", let everything else pass through
          if (call.name === "intercepted_tool") {
            return {
              id: call.id,
              toolUseId: call.id,
              name: call.name,
              success: true,
              content: [{ type: "text" as const, text: "intercepted!" }],
            };
          }
          return next();
        },
      };

      model.respondWith([{ tool: { name: "passthrough_tool", input: {} } }]);

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment: env });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Use tool" }] }],
      }).result;

      // The original handler should have been called via next()
      expect(handlerCalled).toBe(true);
    });

    it("should receive the resolved tool when found", async () => {
      const model = createMockModel("Done");
      let receivedTool: ExecutableTool | undefined;

      const MyTool = createTool({
        name: "my_tool",
        description: "My tool",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "result" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <MyTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const env: ExecutionEnvironment = {
        name: "test-tool-ref",
        async executeToolCall(call, tool, next) {
          receivedTool = tool;
          return next();
        },
      };

      model.respondWith([{ tool: { name: "my_tool", input: {} } }]);

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment: env });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Use tool" }] }],
      }).result;

      expect(receivedTool).toBeDefined();
      expect(receivedTool!.metadata?.name).toBe("my_tool");
    });

    it("should receive undefined tool for unknown tool names", async () => {
      const model = createMockModel("Done");
      let receivedTool: ExecutableTool | undefined = undefined;
      let executeToolCallCalled = false;

      const env: ExecutionEnvironment = {
        name: "test-unknown-tool",
        async executeToolCall(_call, tool, next) {
          receivedTool = tool;
          executeToolCallCalled = true;
          return next();
        },
      };

      // Model calls a tool that doesn't exist
      model.respondWith([{ tool: { name: "nonexistent_tool", input: {} } }]);

      const app = createApp(SimpleAgent, { model, maxTicks: 3, environment: env });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Use tool" }] }],
      }).result;

      expect(executeToolCallCalled).toBe(true);
      expect(receivedTool).toBeUndefined();
    });
  });

  // ============================================================================
  // Lifecycle Hooks
  // ============================================================================

  describe("lifecycle hooks", () => {
    describe("onSessionInit", () => {
      it("should be called once on first send", async () => {
        const model = createMockModel("Response");
        const initCalls: string[] = [];

        const env: ExecutionEnvironment = {
          name: "test-init",
          onSessionInit(session) {
            initCalls.push(session.id);
          },
        };

        const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
        const session = await app.session();

        expect(initCalls).toHaveLength(0);

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
        }).result;

        expect(initCalls).toHaveLength(1);
        expect(initCalls[0]).toBe(session.id);
      });

      it("should not be called again on subsequent sends", async () => {
        const model = createMockModel("Response");
        let initCount = 0;

        const env: ExecutionEnvironment = {
          name: "test-init-once",
          onSessionInit() {
            initCount++;
          },
        };

        const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
        const session = await app.session();

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
        }).result;

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
        }).result;

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Third" }] }],
        }).result;

        expect(initCount).toBe(1);
      });

      it("should support async onSessionInit", async () => {
        const model = createMockModel("Response");
        let initCompleted = false;

        const env: ExecutionEnvironment = {
          name: "test-async-init",
          async onSessionInit() {
            await new Promise((r) => setTimeout(r, 10));
            initCompleted = true;
          },
        };

        const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
        const session = await app.session();

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }).result;

        expect(initCompleted).toBe(true);
      });
    });

    describe("onPersist", () => {
      it("should be called when session auto-persists", async () => {
        const model = createMockModel("Response");
        const store = new MemorySessionStore();
        const persistCalls: { sessionId: string; snapshotVersion: string }[] = [];

        const env: ExecutionEnvironment = {
          name: "test-persist",
          onPersist(session, snapshot) {
            persistCalls.push({
              sessionId: session.id,
              snapshotVersion: snapshot.version,
            });
            return snapshot;
          },
        };

        const app = createApp(SimpleAgent, {
          model,
          maxTicks: 1,
          environment: env,
          sessions: { store },
        });
        const session = await app.session();

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }).result;

        // Wait for fire-and-forget persist to complete
        await new Promise((r) => setTimeout(r, 50));

        expect(persistCalls).toHaveLength(1);
        expect(persistCalls[0].sessionId).toBe(session.id);
      });

      it("should allow environment to augment snapshot", async () => {
        const model = createMockModel("Response");
        const store = new MemorySessionStore();

        const env: ExecutionEnvironment = {
          name: "test-persist-augment",
          onPersist(_session, snapshot) {
            // Add custom data to snapshot (environments can store their state here)
            return {
              ...snapshot,
              comState: {
                ...snapshot.comState,
                _env_data: { sandboxId: "sandbox-123" },
              },
            };
          },
        };

        const app = createApp(SimpleAgent, {
          model,
          maxTicks: 1,
          environment: env,
          sessions: { store },
        });
        const session = await app.session();

        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }).result;

        // Wait for persist
        await new Promise((r) => setTimeout(r, 50));

        const saved = await store.load(session.id);
        expect(saved).not.toBeNull();
        expect(saved!.comState._env_data).toEqual({ sandboxId: "sandbox-123" });
      });
    });

    describe("onRestore", () => {
      it("should be called when session is restored from store", async () => {
        const model = createMockModel("Response");
        const store = new MemorySessionStore();
        const restoreCalls: { sessionId: string }[] = [];

        const env: ExecutionEnvironment = {
          name: "test-restore",
          onRestore(session, _snapshot) {
            restoreCalls.push({ sessionId: session.id });
          },
        };

        const app = createApp(SimpleAgent, {
          model,
          maxTicks: 1,
          environment: env,
          sessions: { store },
        });

        // Create and use a session
        const session1 = await app.session({ sessionId: "restore-test" });
        await session1.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }).result;

        // Wait for persist
        await new Promise((r) => setTimeout(r, 50));
        await session1.close();

        // Restore the session
        const session2 = await app.session({ sessionId: "restore-test" });

        // onRestore hasn't been called yet (lazy init)
        expect(restoreCalls).toHaveLength(0);

        // Send triggers compilation infrastructure init, which triggers onRestore
        await session2.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Restored" }] }],
        }).result;

        expect(restoreCalls).toHaveLength(1);
        expect(restoreCalls[0].sessionId).toBe("restore-test");
      });
    });

    describe("onDestroy", () => {
      it("should be called when session is closed", async () => {
        const model = createMockModel("Response");
        const destroyCalls: string[] = [];

        const env: ExecutionEnvironment = {
          name: "test-destroy",
          onDestroy(session) {
            destroyCalls.push(session.id);
          },
        };

        const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
        const session = await app.session();

        // Must send at least once to initialize the environment
        await session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }).result;

        expect(destroyCalls).toHaveLength(0);

        await session.close();

        // onDestroy is fire-and-forget, wait a tick
        await new Promise((r) => setTimeout(r, 10));

        expect(destroyCalls).toHaveLength(1);
        expect(destroyCalls[0]).toBe(session.id);
      });

      it("should not be called if environment was never initialized", async () => {
        const model = createMockModel("Response");
        const destroyCalls: string[] = [];

        const env: ExecutionEnvironment = {
          name: "test-destroy-no-init",
          onSessionInit() {},
          onDestroy(session) {
            destroyCalls.push(session.id);
          },
        };

        const app = createApp(SimpleAgent, { model, maxTicks: 1, environment: env });
        const session = await app.session();

        // Close without ever sending (no infrastructure initialized)
        await session.close();

        await new Promise((r) => setTimeout(r, 10));

        expect(destroyCalls).toHaveLength(0);
      });
    });
  });

  // ============================================================================
  // Combined scenarios
  // ============================================================================

  describe("combined scenarios", () => {
    it("should support environment with all hooks", async () => {
      const model = createMockModel("Response");
      const store = new MemorySessionStore();
      const events: string[] = [];

      const env: ExecutionEnvironment = {
        name: "test-all-hooks",
        onSessionInit() {
          events.push("init");
        },
        prepareModelInput(compiled) {
          events.push("prepareModelInput");
          return compiled;
        },
        async executeToolCall(_call, _tool, next) {
          events.push("executeToolCall");
          return next();
        },
        onPersist(_session, snapshot) {
          events.push("persist");
          return snapshot;
        },
        onRestore() {
          events.push("restore");
        },
        onDestroy() {
          events.push("destroy");
        },
      };

      const TestTool = createTool({
        name: "event_tool",
        description: "A tool for testing",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "done" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      // Make model call the tool
      model.respondWith([{ tool: { name: "event_tool", input: {} } }]);

      const app = createApp(AgentWithTool, {
        model,
        maxTicks: 3,
        environment: env,
        sessions: { store },
      });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      // Wait for persist
      await new Promise((r) => setTimeout(r, 50));

      await session.close();
      await new Promise((r) => setTimeout(r, 10));

      // Verify lifecycle order
      expect(events).toContain("init");
      expect(events).toContain("prepareModelInput");
      expect(events).toContain("executeToolCall");
      expect(events).toContain("persist");
      expect(events).toContain("destroy");

      // init should come before prepareModelInput
      expect(events.indexOf("init")).toBeLessThan(events.indexOf("prepareModelInput"));
    });

    it("should work with app.run() ephemeral execution", async () => {
      const model = createMockModel("Ephemeral response");
      let initCalled = false;

      const env: ExecutionEnvironment = {
        name: "test-ephemeral",
        onSessionInit() {
          initCalled = true;
        },
        prepareModelInput(compiled) {
          return compiled;
        },
      };

      const app = createApp(SimpleAgent, {
        model,
        maxTicks: 1,
        environment: env,
      });

      const result = await app.run({
        props: { query: "Hello!" },
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      expect(result.response).toBe("Ephemeral response");
      expect(initCalled).toBe(true);
    });

    it("should support environment name for identification", async () => {
      const env: ExecutionEnvironment = {
        name: "repl-v2",
      };

      expect(env.name).toBe("repl-v2");
    });
  });

  // ============================================================================
  // Spawn: environment inheritance and SpawnOptions
  // ============================================================================

  describe("spawn environment inheritance", () => {
    it("should inherit parent environment in spawned children", async () => {
      const parentModel = createMockModel("Parent response");
      const childModel = createMockModel("Child response");
      const hookCalls: { hook: string; sessionId: string }[] = [];

      const ChildAgent = () => (
        <>
          <Model model={childModel} />
          <System>Child agent</System>
          <Timeline />
        </>
      );

      const ParentAgent = () => (
        <>
          <Model model={parentModel} />
          <System>Parent agent</System>
          <Timeline />
        </>
      );

      const env: ExecutionEnvironment = {
        name: "inherited-env",
        onSessionInit(session) {
          hookCalls.push({ hook: "init", sessionId: session.id });
        },
        prepareModelInput(compiled) {
          return compiled;
        },
      };

      const app = createApp(ParentAgent, { maxTicks: 1, environment: env });
      const session = await app.session();

      // Spawn a child — should inherit the environment
      const childHandle = await session.spawn(ChildAgent, {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello child" }] }],
      });

      await childHandle.result;

      // Environment onSessionInit should have been called for the child
      // (the parent hasn't sent yet, so only the child triggered init)
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].hook).toBe("init");
      // The child session gets its own ID, different from parent
      expect(hookCalls[0].sessionId).not.toBe(session.id);

      await session.close();
    });

    it("should intercept child tool calls via inherited environment", async () => {
      const parentModel = createMockModel("Parent done");
      const childModel = createMockModel("Child done");

      const ChildTool = createTool({
        name: "child_tool",
        description: "Tool in child",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "original handler" }],
      });

      const ChildAgent = () => (
        <>
          <Model model={childModel} />
          <System>Child</System>
          <ChildTool />
          <Timeline />
        </>
      );

      const ParentAgent = () => (
        <>
          <Model model={parentModel} />
          <System>Parent</System>
          <Timeline />
        </>
      );

      let intercepted = false;
      const env: ExecutionEnvironment = {
        name: "intercepting-env",
        async executeToolCall(call, _tool, next) {
          if (call.name === "child_tool") {
            intercepted = true;
            return {
              id: call.id,
              toolUseId: call.id,
              name: call.name,
              success: true,
              content: [{ type: "text" as const, text: "env intercepted" }],
            };
          }
          return next();
        },
      };

      // Make child model call the tool
      childModel.respondWith([{ tool: { name: "child_tool", input: {} } }]);

      const app = createApp(ParentAgent, { maxTicks: 3, environment: env });
      const session = await app.session();

      const childHandle = await session.spawn(ChildAgent, {
        messages: [{ role: "user", content: [{ type: "text", text: "Use tool" }] }],
      });

      await childHandle.result;
      expect(intercepted).toBe(true);

      await session.close();
    });

    it("should allow SpawnOptions to override the inherited environment", async () => {
      const parentModel = createMockModel("Parent");
      const childModel = createMockModel("Child");
      const parentEnvCalls: string[] = [];
      const childEnvCalls: string[] = [];

      const ChildAgent = () => (
        <>
          <Model model={childModel} />
          <System>Child</System>
          <Timeline />
        </>
      );

      const ParentAgent = () => (
        <>
          <Model model={parentModel} />
          <System>Parent</System>
          <Timeline />
        </>
      );

      const parentEnv: ExecutionEnvironment = {
        name: "parent-env",
        onSessionInit() {
          parentEnvCalls.push("init");
        },
        prepareModelInput(compiled) {
          parentEnvCalls.push("prepare");
          return compiled;
        },
      };

      const childEnv: ExecutionEnvironment = {
        name: "child-env",
        onSessionInit() {
          childEnvCalls.push("init");
        },
        prepareModelInput(compiled) {
          childEnvCalls.push("prepare");
          return compiled;
        },
      };

      const app = createApp(ParentAgent, { maxTicks: 1, environment: parentEnv });
      const session = await app.session();

      // Spawn with overridden environment
      const childHandle = await session.spawn(
        ChildAgent,
        { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
        { environment: childEnv },
      );

      await childHandle.result;

      // Child should use its own environment, not the parent's
      expect(childEnvCalls).toContain("init");
      expect(childEnvCalls).toContain("prepare");
      expect(parentEnvCalls).toHaveLength(0); // Parent never sent, so parent env unused
    });

    it("should allow SpawnOptions to override model", async () => {
      const parentModel = createMockModel("Parent model response");
      const overrideModel = createMockModel("Override model response");

      const ChildAgent = () => (
        <>
          <System>Child agent</System>
          <Timeline />
        </>
      );

      const ParentAgent = () => (
        <>
          <System>Parent</System>
          <Timeline />
        </>
      );

      const app = createApp(ParentAgent, { model: parentModel, maxTicks: 1 });
      const session = await app.session();

      const childHandle = await session.spawn(
        ChildAgent,
        { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
        { model: overrideModel },
      );

      const result = await childHandle.result;
      expect(result.response).toBe("Override model response");

      await session.close();
    });

    it("should allow SpawnOptions to override maxTicks", async () => {
      const parentModel = createMockModel("Parent response");
      const childModel = createMockModel("Child response");

      const ChildTool = createTool({
        name: "tick_tool",
        description: "Forces another tick",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "ticked" }],
      });

      const ChildAgent = () => (
        <>
          <Model model={childModel} />
          <System>Child</System>
          <ChildTool />
          <Timeline />
        </>
      );

      const ParentAgent = () => (
        <>
          <Model model={parentModel} />
          <System>Parent</System>
          <Timeline />
        </>
      );

      // Child model always calls tool (infinite loop without maxTicks)
      childModel.setToolCalls([{ id: "tc-1", name: "tick_tool", input: {} }]);

      const app = createApp(ParentAgent, { maxTicks: 10 });
      const session = await app.session();

      // Override maxTicks to 2 for the child
      const childHandle = await session.spawn(
        ChildAgent,
        { messages: [{ role: "user", content: [{ type: "text", text: "Loop" }] }] },
        { maxTicks: 2 },
      );

      const result = await childHandle.result;
      // Should stop after 2 ticks, not 10
      expect(result.response).toBeDefined();

      await session.close();
    });
  });

  // ============================================================================
  // createTestEnvironment integration
  // ============================================================================

  describe("createTestEnvironment helper", () => {
    it("should track all lifecycle calls end-to-end", async () => {
      const model = createMockModel("Response");
      const store = new MemorySessionStore();

      const TestTool = createTool({
        name: "tracked_tool",
        description: "A tracked tool",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "done" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      model.respondWith([{ tool: { name: "tracked_tool", input: {} } }]);

      const { environment, tracker } = createTestEnvironment({ name: "integration" });

      const app = createApp(AgentWithTool, {
        model,
        maxTicks: 3,
        environment,
        sessions: { store },
      });

      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      // Wait for persist
      await new Promise((r) => setTimeout(r, 50));

      // Verify init
      expect(tracker.initCalls).toHaveLength(1);
      expect(tracker.initCalls[0]).toBe(session.id);

      // Verify model input transformation was called (once per tick)
      expect(tracker.prepareModelInputCalls.length).toBeGreaterThanOrEqual(1);
      expect(tracker.prepareModelInputCalls[0].tools).toContain("tracked_tool");

      // Verify tool call tracking
      expect(tracker.toolCalls).toHaveLength(1);
      expect(tracker.toolCalls[0]).toEqual({ name: "tracked_tool", intercepted: false });

      // Verify persist
      expect(tracker.persistCalls).toHaveLength(1);

      await session.close();
      await new Promise((r) => setTimeout(r, 10));

      // Verify destroy
      expect(tracker.destroyCalls).toHaveLength(1);
    });

    it("should intercept tools via interceptTools option", async () => {
      const model = createMockModel("Final");

      const InterceptedTool = createTool({
        name: "sandbox_exec",
        description: "Execute in sandbox",
        input: z.object({ code: z.string() }),
        handler: async () => [{ type: "text" as const, text: "should not reach" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <InterceptedTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      model.respondWith([{ tool: { name: "sandbox_exec", input: { code: "1+1" } } }]);

      const { environment, tracker } = createTestEnvironment({
        interceptTools: { sandbox_exec: "2" },
      });

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "calc 1+1" }] }],
      }).result;

      expect(tracker.toolCalls).toHaveLength(1);
      expect(tracker.toolCalls[0]).toEqual({ name: "sandbox_exec", intercepted: true });
    });

    it("should transform model input via transformInput option", async () => {
      const model = createMockModel("Response");
      let modelReceivedTools: number | undefined;

      const TestTool = createTool({
        name: "removed_tool",
        description: "Will be removed",
        input: z.object({}),
        handler: async () => [{ type: "text" as const, text: "done" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <TestTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      const { environment } = createTestEnvironment({
        transformInput: (compiled) => {
          modelReceivedTools = compiled.tools?.length ?? 0;
          // Remove all tools from model input
          return { ...compiled, tools: [] };
        },
      });

      const app = createApp(AgentWithTool, { model, maxTicks: 1, environment });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      // transformInput was called and saw tools
      expect(modelReceivedTools).toBeGreaterThan(0);
    });

    it("should support function interceptors end-to-end", async () => {
      const model = createMockModel("Final");

      const ExecTool = createTool({
        name: "execute",
        description: "Execute code",
        input: z.object({ code: z.string() }),
        handler: async () => [{ type: "text" as const, text: "should not reach" }],
      });

      const AgentWithTool = ({ query }: { query: string }) => (
        <>
          <System>You are helpful.</System>
          <ExecTool />
          <Timeline />
          <User>{query}</User>
        </>
      );

      model.respondWith([{ tool: { name: "execute", input: { code: "2+2" } } }]);

      const { environment, tracker } = createTestEnvironment({
        interceptTools: {
          execute: (call) => ({
            id: call.id,
            toolUseId: call.id,
            name: call.name,
            success: true,
            content: [{ type: "text" as const, text: `result: ${call.input.code}` }],
          }),
        },
      });

      const app = createApp(AgentWithTool, { model, maxTicks: 3, environment });
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "calc 2+2" }] }],
      }).result;

      expect(tracker.toolCalls).toHaveLength(1);
      expect(tracker.toolCalls[0]).toEqual({ name: "execute", intercepted: true });
    });

    it("should reset tracker between tests", async () => {
      const { tracker } = createTestEnvironment();

      // Simulate some tracking
      tracker.initCalls.push("session-1");
      tracker.toolCalls.push({ name: "tool", intercepted: false });

      tracker.reset();

      expect(tracker.initCalls).toHaveLength(0);
      expect(tracker.toolCalls).toHaveLength(0);
    });
  });
});
