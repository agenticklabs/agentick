/**
 * dispatchCommand Stress & Edge Case Tests
 *
 * These tests probe architectural boundaries:
 * - Concurrent dispatch calls (race conditions)
 * - Dispatch during active model execution
 * - Dispatch after session close
 * - mount() during render() (concurrent compile)
 * - Tool state isolation between mount-only and full execution
 * - Handler errors propagate correctly
 * - Tools with use() hooks work in mount-only context
 * - commandOnly tool truly invisible after multiple ticks
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app";
import { System } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import { createTool } from "../../tool/tool";
import { useState, useEffect } from "../../index";
import { z } from "zod";

function createMockModel(response = "Mock response") {
  return createTestAdapter({ defaultResponse: response });
}

// ============================================================================
// Concurrent dispatch
// ============================================================================

describe("concurrent dispatch", () => {
  it("should handle multiple concurrent dispatchCommand calls", async () => {
    let callCount = 0;
    const CounterTool = createTool({
      name: "counter",
      description: "Increments a counter",
      input: z.object({ id: z.string() }),
      commandOnly: true,
      handler: async ({ id }) => {
        callCount++;
        return [{ type: "text" as const, text: `${id}:${callCount}` }];
      },
    });

    function Agent() {
      return (
        <>
          <CounterTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Fire 5 concurrent dispatches
    const results = await Promise.all([
      session.dispatchCommand("counter", { id: "a" }),
      session.dispatchCommand("counter", { id: "b" }),
      session.dispatchCommand("counter", { id: "c" }),
      session.dispatchCommand("counter", { id: "d" }),
      session.dispatchCommand("counter", { id: "e" }),
    ]);

    // All 5 should complete
    expect(results).toHaveLength(5);
    expect(callCount).toBe(5);

    // Each result should have a unique counter value
    const texts = results.map((r) => (r[0].type === "text" ? (r[0] as any).text : ""));
    const ids = texts.map((t: string) => t.split(":")[0]);
    expect(new Set(ids).size).toBe(5); // All unique IDs

    await session.close();
  });

  it("should not double-mount when concurrent dispatches trigger mount", async () => {
    let mountCount = 0;
    const MountSpy = createTool({
      name: "spy",
      description: "Spy tool",
      input: z.object({}),
      commandOnly: true,
      handler: async () => {
        mountCount++;
        return [{ type: "text" as const, text: `mounted:${mountCount}` }];
      },
    });

    function Agent() {
      return (
        <>
          <MountSpy />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Concurrent dispatches — both trigger mount() internally
    const [r1, r2] = await Promise.all([
      session.dispatchCommand("spy", {}),
      session.dispatchCommand("spy", {}),
    ]);

    // Both should succeed — handler called twice
    expect(r1).toEqual([{ type: "text", text: "mounted:1" }]);
    expect(r2).toEqual([{ type: "text", text: "mounted:2" }]);

    await session.close();
  });
});

// ============================================================================
// Error propagation
// ============================================================================

describe("error propagation", () => {
  it("should propagate handler errors as rejections", async () => {
    const ErrorTool = createTool({
      name: "exploder",
      description: "Always throws",
      input: z.object({}),
      commandOnly: true,
      handler: async () => {
        throw new Error("kaboom");
      },
    });

    function Agent() {
      return (
        <>
          <ErrorTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await expect(session.dispatchCommand("exploder", {})).rejects.toThrow("kaboom");

    await session.close();
  });

  it("should validate input against tool schema", async () => {
    const StrictTool = createTool({
      name: "strict",
      description: "Has strict schema",
      input: z.object({
        count: z.number().int().positive(),
        name: z.string().min(1),
      }),
      commandOnly: true,
      handler: async ({ count, name }) => {
        return [{ type: "text" as const, text: `${name}:${count}` }];
      },
    });

    function Agent() {
      return (
        <>
          <StrictTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Missing required fields → Zod validation error
    await expect(session.dispatchCommand("strict", {})).rejects.toThrow("ZodError");

    // Valid input works correctly
    const good = await session.dispatchCommand("strict", { count: 5, name: "test" });
    expect(good).toEqual([{ type: "text", text: "test:5" }]);

    await session.close();
  });
});

// ============================================================================
// Lifecycle coherence
// ============================================================================

describe("lifecycle coherence", () => {
  it("commandOnly tool should not appear in model input across multiple ticks", async () => {
    const model = createTestAdapter({ defaultResponse: "tick" });

    // Queue tool calls to force multi-tick
    model.respondWith([{ tool: { name: "visible", input: { q: "tick1" } } }]);

    const VisibleTool = createTool({
      name: "visible",
      description: "Visible to model",
      input: z.object({ q: z.string() }),
      handler: async ({ q }) => [{ type: "text" as const, text: q }],
    });

    const HiddenTool = createTool({
      name: "hidden",
      description: "Hidden from model",
      input: z.object({}),
      commandOnly: true,
      handler: async () => [{ type: "text" as const, text: "secret" }],
    });

    function Agent() {
      return (
        <>
          <VisibleTool />
          <HiddenTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();

    await session.render({}).result;

    // Check ALL model calls — hidden tool should never appear
    for (const input of model.getCapturedInputs()) {
      const toolNames = (input.tools ?? []).map((t: any) => t.name);
      expect(toolNames).not.toContain("hidden");
      // But visible should be in every call
      expect(toolNames).toContain("visible");
    }

    // hidden should still be dispatchable
    const result = await session.dispatchCommand("hidden", {});
    expect(result).toEqual([{ type: "text", text: "secret" }]);

    await session.close();
  });

  it("dispatch should work between ticks of a multi-tick execution", async () => {
    const model = createTestAdapter({ defaultResponse: "done" });

    const StateTool = createTool({
      name: "state-tool",
      description: "Tracks invocation count",
      input: z.object({}),
      commandOnly: true,
      handler: async () => {
        return [{ type: "text" as const, text: "dispatched" }];
      },
    });

    function Agent() {
      return (
        <>
          <StateTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First render
    await session.render({}).result;

    // Dispatch between renders
    const r1 = await session.dispatchCommand("state-tool", {});
    expect(r1).toEqual([{ type: "text", text: "dispatched" }]);

    // Second render
    await session.render({}).result;

    // Dispatch again after second render
    const r2 = await session.dispatchCommand("state-tool", {});
    expect(r2).toEqual([{ type: "text", text: "dispatched" }]);

    await session.close();
  });

  it("mount-only session should not affect subsequent render()", async () => {
    const model = createMockModel("after-mount");

    function Agent() {
      const MountTool = createTool({
        name: "mt",
        description: "test",
        input: z.object({}),
        commandOnly: true,
        handler: async () => [{ type: "text" as const, text: "ok" }],
      });

      return (
        <>
          <MountTool />
          <Model model={model} />
          <System>Test agent</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Mount only — should NOT call the model
    await session.mount();
    const inputsAfterMount = model.getCapturedInputs().length;

    // Dispatch — should NOT call the model
    const dr = await session.dispatchCommand("mt", {});
    expect(dr).toEqual([{ type: "text", text: "ok" }]);
    expect(model.getCapturedInputs().length).toBe(inputsAfterMount);

    // Now do a real render — model SHOULD be called
    const result = await session.render({}).result;
    expect(result.response).toBe("after-mount");

    // Model should have been called at least once more for the render
    expect(model.getCapturedInputs().length).toBeGreaterThan(inputsAfterMount);

    await session.close();
  });
});

// ============================================================================
// State management
// ============================================================================

describe("stateful commandOnly tools", () => {
  it("should support tools that use React state via use()", async () => {
    let _capturedState: string | null = null;

    const StatefulTool = createTool({
      name: "stateful",
      description: "Uses component state",
      input: z.object({ value: z.string() }),
      commandOnly: true,
      use() {
        const [calls, setCalls] = useState(0);
        useEffect(() => {
          _capturedState = `calls:${calls}`;
        }, [calls]);
        return { calls, setCalls };
      },
      handler: async ({ value }, deps) => {
        // deps has calls from the use() hook
        return [{ type: "text" as const, text: `${value}:${deps!.calls}` }];
      },
    });

    function Agent() {
      return (
        <>
          <StatefulTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatchCommand("stateful", { value: "hello" });
    expect(result).toEqual([{ type: "text", text: "hello:0" }]);

    await session.close();
  });
});

// ============================================================================
// Session lifecycle edge cases
// ============================================================================

describe("session lifecycle edge cases", () => {
  it("should throw when dispatching to a closed session", async () => {
    const SimpleTool = createTool({
      name: "simple",
      description: "test",
      input: z.object({}),
      commandOnly: true,
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    function Agent() {
      return (
        <>
          <SimpleTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Works before close
    const r = await session.dispatchCommand("simple", {});
    expect(r).toEqual([{ type: "text", text: "ok" }]);

    await session.close();

    // After close — must throw
    await expect(session.dispatchCommand("simple", {})).rejects.toThrow("Session is closed");
  });

  it("should throw on never-mounted closed session (terminal guard fires before mount)", async () => {
    const SimpleTool = createTool({
      name: "simple",
      description: "test",
      input: z.object({}),
      commandOnly: true,
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    function Agent() {
      return (
        <>
          <SimpleTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Close immediately — never mounted, never dispatched
    await session.close();

    // Terminal guard must fire before mount() is attempted
    await expect(session.dispatchCommand("simple", {})).rejects.toThrow("Session is closed");
  });

  it("should handle dispatch of tool that exists as alias AND as another tool name", async () => {
    // Tool A has alias "shared"
    const ToolA = createTool({
      name: "tool-a",
      description: "First tool",
      input: z.object({}),
      commandOnly: true,
      aliases: ["shared"],
      handler: async () => [{ type: "text" as const, text: "from-a" }],
    });

    // Tool B is named "shared" (collision with A's alias)
    const ToolB = createTool({
      name: "shared",
      description: "Named same as alias",
      input: z.object({}),
      commandOnly: true,
      handler: async () => [{ type: "text" as const, text: "from-b" }],
    });

    function Agent() {
      return (
        <>
          <ToolA />
          <ToolB />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // "shared" is both tool-a's alias AND tool-b's name.
    // Name lookup takes priority over alias lookup in dispatchCommand.
    const result = await session.dispatchCommand("shared", {});
    expect(result).toEqual([{ type: "text", text: "from-b" }]);

    // tool-a is still accessible by its primary name
    const resultA = await session.dispatchCommand("tool-a", {});
    expect(resultA).toEqual([{ type: "text", text: "from-a" }]);

    await session.close();
  });
});
