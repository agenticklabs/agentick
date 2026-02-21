/**
 * mount() and dispatch() Tests
 *
 * Tests that:
 * - mount() compiles the tree and registers tools without calling the model
 * - mount() is idempotent (second call is a no-op)
 * - dispatch() resolves tools by name and alias
 * - dispatch() executes tool handlers and returns ContentBlock[]
 * - audience: "user" tools are dispatchable but not visible to the model
 * - audience: "all" tools are dispatchable AND visible to the model
 * - Error cases: unknown command, no handler
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { createTool } from "../../tool/tool.js";
import { z } from "zod";

// ============================================================================
// Test Agent with audience: "user" tool
// ============================================================================

function createMockModel(response = "Mock response") {
  return createTestAdapter({ defaultResponse: response });
}

const MountTestTool = createTool({
  name: "mount-test",
  description: "A user-only test tool",
  input: z.object({ path: z.string() }),
  audience: "user",
  aliases: ["mt", "test-mount"],
  handler: async ({ path }) => {
    return [{ type: "text" as const, text: `mounted: ${path}` }];
  },
});

const VisibleTool = createTool({
  name: "visible-tool",
  description: "A normal tool visible to the model",
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => {
    return [{ type: "text" as const, text: `result: ${query}` }];
  },
});

function TestAgent() {
  return (
    <>
      <MountTestTool />
      <VisibleTool />
      <Model model={createMockModel()} />
      <System>Test agent</System>
      <Timeline />
    </>
  );
}

// ============================================================================
// mount()
// ============================================================================

describe("session.mount()", () => {
  it("should compile the tree and register tools without calling the model", async () => {
    const model = createMockModel();

    function Agent() {
      return (
        <>
          <MountTestTool />
          <VisibleTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.mount();

    // Model should NOT have been called
    expect(model.getCapturedInputs()).toHaveLength(0);

    // But tools should be registered — dispatch should work
    const result = await session.dispatch("mount-test", { path: "/tmp" });
    expect(result).toEqual([{ type: "text", text: "mounted: /tmp" }]);

    await session.close();
  });

  it("should be idempotent — second call is a no-op", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    await session.mount();
    await session.mount(); // Should not throw or re-compile

    const result = await session.dispatch("mount-test", { path: "/foo" });
    expect(result).toEqual([{ type: "text", text: "mounted: /foo" }]);

    await session.close();
  });

  it("should be callable after render() — no-op since tree already compiled", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    // Render first (normal execution)
    await session.render({}).result;

    // mount() after render should not throw
    await session.mount();

    // Commands should still work
    const result = await session.dispatch("mount-test", { path: "/bar" });
    expect(result).toEqual([{ type: "text", text: "mounted: /bar" }]);

    await session.close();
  });
});

// ============================================================================
// dispatch()
// ============================================================================

describe("session.dispatch()", () => {
  it("should resolve tool by name", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatch("mount-test", { path: "/tmp" });
    expect(result).toEqual([{ type: "text", text: "mounted: /tmp" }]);

    await session.close();
  });

  it("should resolve tool by alias", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatch("mt", { path: "/via-alias" });
    expect(result).toEqual([{ type: "text", text: "mounted: /via-alias" }]);

    await session.close();
  });

  it("should resolve tool by second alias", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatch("test-mount", { path: "/alias2" });
    expect(result).toEqual([{ type: "text", text: "mounted: /alias2" }]);

    await session.close();
  });

  it("should dispatch tools of any audience", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatch("visible-tool", { query: "hello" });
    expect(result).toEqual([{ type: "text", text: "result: hello" }]);

    await session.close();
  });

  it("should throw for unknown command", async () => {
    const app = createApp(TestAgent, { maxTicks: 1 });
    const session = await app.session();

    await expect(session.dispatch("nonexistent", {})).rejects.toThrow(
      "Unknown command: nonexistent",
    );

    await session.close();
  });

  it("should auto-mount if not already mounted", async () => {
    const model = createMockModel();

    function Agent() {
      return (
        <>
          <MountTestTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // dispatch without explicit mount() — should auto-mount
    const result = await session.dispatch("mount-test", { path: "/auto" });
    expect(result).toEqual([{ type: "text", text: "mounted: /auto" }]);

    // Model should NOT have been called (only mount, not render)
    expect(model.getCapturedInputs()).toHaveLength(0);

    await session.close();
  });

  it("should coerce string handler results to ContentBlock[]", async () => {
    const StringTool = createTool({
      name: "string-returner",
      description: "Returns a plain string",
      input: z.object({}),
      audience: "user",
      handler: async () => "just a string" as any,
    });

    function Agent() {
      return (
        <>
          <StringTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.dispatch("string-returner", {});
    expect(result).toEqual([{ type: "text", text: "just a string" }]);

    await session.close();
  });

  it("should throw on non-array, non-string handler results", async () => {
    const NullTool = createTool({
      name: "null-returner",
      description: "Returns null",
      input: z.object({}),
      audience: "user",
      handler: async () => null as any,
    });

    const UndefinedTool = createTool({
      name: "undefined-returner",
      description: "Returns undefined",
      input: z.object({}),
      audience: "user",
      handler: async () => undefined as any,
    });

    const ObjectTool = createTool({
      name: "object-returner",
      description: "Returns a plain object",
      input: z.object({}),
      audience: "user",
      handler: async () => ({ foo: "bar" }) as any,
    });

    function Agent() {
      return (
        <>
          <NullTool />
          <UndefinedTool />
          <ObjectTool />
          <Model model={createMockModel()} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await expect(session.dispatch("null-returner", {})).rejects.toThrow(
      "Unexpected tool result type",
    );

    await expect(session.dispatch("undefined-returner", {})).rejects.toThrow(
      "Unexpected tool result type",
    );

    await expect(session.dispatch("object-returner", {})).rejects.toThrow(
      "Unexpected tool result type",
    );

    await session.close();
  });
});

// ============================================================================
// audience + model visibility
// ============================================================================

describe("audience model visibility", () => {
  it("should exclude audience: 'user' tools from model input", async () => {
    const model = createMockModel();

    function Agent() {
      return (
        <>
          <MountTestTool />
          <VisibleTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.render({}).result;

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThan(0);

    const lastInput = inputs[inputs.length - 1];
    const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);

    // visible-tool should be in model input
    expect(toolNames).toContain("visible-tool");

    // mount-test (audience: "user") should NOT be in model input
    expect(toolNames).not.toContain("mount-test");

    await session.close();
  });

  it("audience: 'user' tool should still be dispatchable after render()", async () => {
    const model = createMockModel();

    function Agent() {
      return (
        <>
          <MountTestTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Run a normal tick
    await session.render({}).result;

    // audience: "user" tool should still be dispatchable
    const result = await session.dispatch("mount-test", { path: "/after-render" });
    expect(result).toEqual([{ type: "text", text: "mounted: /after-render" }]);

    await session.close();
  });

  it("audience: 'all' tool should be in model input AND dispatchable", async () => {
    const model = createMockModel();

    const BothTool = createTool({
      name: "both-tool",
      description: "Visible to model AND user-dispatchable",
      input: z.object({ msg: z.string() }),
      audience: "all",
      handler: async ({ msg }) => [{ type: "text" as const, text: `both: ${msg}` }],
    });

    function Agent() {
      return (
        <>
          <BothTool />
          <VisibleTool />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.render({}).result;

    // Should be in model definitions
    const inputs = model.getCapturedInputs();
    const lastInput = inputs[inputs.length - 1];
    const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toContain("both-tool");
    expect(toolNames).toContain("visible-tool");

    // Should also be dispatchable
    const result = await session.dispatch("both-tool", { msg: "hello" });
    expect(result).toEqual([{ type: "text", text: "both: hello" }]);

    await session.close();
  });
});
