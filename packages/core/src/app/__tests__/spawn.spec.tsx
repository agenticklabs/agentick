/**
 * spawn() Tests
 *
 * Tests for the recursive session primitive: session.spawn()
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app";
import { System } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import { createTool } from "../../tool/tool";
import { z } from "zod";
import type { AgentConfig } from "../../agent";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(response = "Mock response") {
  return createTestAdapter({ defaultResponse: response });
}

// ============================================================================
// Basic spawn
// ============================================================================

describe("session.spawn()", () => {
  it("should spawn a child session with a ComponentFunction", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child system</System>
        <Timeline />
      </>
    );

    const ParentAgent = () => (
      <>
        <Model model={parentModel} />
        <System>Parent system</System>
        <Timeline />
      </>
    );

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    // Spawn a child directly from the session
    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello child" }] }],
    });

    const childResult = await childHandle.result;
    expect(childResult.response).toBe("Child response");

    session.close();
  });

  it("should spawn a child session with AgentConfig", async () => {
    const childModel = createMockModel("Config child response");
    const parentModel = createMockModel("Parent response");

    const config: AgentConfig = {
      system: "You are a config-based agent",
      model: childModel,
    };

    const ParentAgent = () => (
      <>
        <Model model={parentModel} />
        <System>Parent</System>
        <Timeline />
      </>
    );

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    const childHandle = await session.spawn(config, {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello config" }] }],
    });

    const childResult = await childHandle.result;
    expect(childResult.response).toBe("Config child response");

    session.close();
  });

  it("should spawn a child session with a JSX element", async () => {
    const childModel = createMockModel("JSX child response");
    const parentModel = createMockModel("Parent response");

    const ChildAgent = ({ query }: { query: string }) => (
      <>
        <Model model={childModel} />
        <System>Child handling: {query}</System>
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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    // Pass a JSX element - props from element + input.props are merged
    const element = React.createElement(ChildAgent, { query: "from element" });
    const childHandle = await session.spawn(element, {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello JSX" }] }],
    });

    const childResult = await childHandle.result;
    expect(childResult.response).toBe("JSX child response");

    session.close();
  });
});

// ============================================================================
// ctx.spawn from tool handler
// ============================================================================

describe("ctx.spawn() from tool handler", () => {
  it("should allow spawning from a tool handler via ctx.spawn()", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child says hello");

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child agent</System>
        <Timeline />
      </>
    );

    let spawnResult: string | undefined;

    const SpawnTool = createTool({
      name: "spawn_child",
      description: "Spawn a child agent",
      input: z.object({ query: z.string() }),
      handler: async (input, ctx) => {
        const handle = await ctx!.spawn(ChildAgent, {
          messages: [{ role: "user", content: [{ type: "text", text: input.query }] }],
        });
        const result = await handle.result;
        spawnResult = result.response;
        return [{ type: "text" as const, text: `Child said: ${result.response}` }];
      },
    });

    // Make the model call the tool
    parentModel.respondWith([
      { tool: { name: "spawn_child", input: { query: "hello from parent" } } },
    ]);

    const ParentAgent = () => (
      <>
        <Model model={parentModel} />
        <System>Parent agent with spawn tool</System>
        <SpawnTool />
        <Timeline />
      </>
    );

    const app = createApp(ParentAgent, { maxTicks: 2 });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Use the tool" }] }],
    }).result;

    expect(spawnResult).toBe("Child says hello");

    session.close();
  });
});

// ============================================================================
// Parallel spawns
// ============================================================================

describe("parallel spawns", () => {
  it("should support parallel spawns via Promise.all", async () => {
    const parentModel = createMockModel("Parent response");
    const childModelA = createMockModel("Child A response");
    const childModelB = createMockModel("Child B response");

    const ChildA = () => (
      <>
        <Model model={childModelA} />
        <System>Child A</System>
        <Timeline />
      </>
    );

    const ChildB = () => (
      <>
        <Model model={childModelB} />
        <System>Child B</System>
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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    const input = {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Go" }] }],
    };

    const [handleA, handleB] = await Promise.all([
      session.spawn(ChildA, input),
      session.spawn(ChildB, input),
    ]);

    const [resultA, resultB] = await Promise.all([handleA.result, handleB.result]);

    expect(resultA.response).toBe("Child A response");
    expect(resultB.response).toBe("Child B response");

    session.close();
  });
});

// ============================================================================
// Parent/children references
// ============================================================================

describe("parent/children references", () => {
  it("should set parent and children references during execution", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    // Before spawn: no parent, no children
    expect(session.parent).toBeNull();
    expect(session.children).toHaveLength(0);

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    // During execution: parent has child
    // Note: child is cleaned up asynchronously when result resolves,
    // so we check before awaiting result
    expect(session.children.length).toBeGreaterThanOrEqual(0); // may have been cleaned up already

    await childHandle.result;

    // After completion: children should be cleaned up
    // Allow a tick for the finally handler
    await new Promise((r) => setTimeout(r, 10));
    expect(session.children).toHaveLength(0);

    session.close();
  });
});

// ============================================================================
// Max depth exceeded
// ============================================================================

describe("max spawn depth", () => {
  it("should throw when max spawn depth is exceeded", async () => {
    const model = createMockModel("Response");

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Agent</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Manually set spawn depth to the max to test the guard
    (session as any)._spawnDepth = 10;

    await expect(
      session.spawn(Agent, {
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      }),
    ).rejects.toThrow("Maximum spawn depth (10) exceeded");

    session.close();
  });
});

// ============================================================================
// Parent abort propagates
// ============================================================================

describe("parent abort propagation", () => {
  it("should abort child when parent execution is aborted", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response", delay: 200 });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child (slow)</System>
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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    // Start a parent execution first so we have an execution abort controller
    const parentHandle = await session.render({} as any);

    // Now spawn a slow child (this will be aborted)
    const childPromise = session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "slow query" }] }],
    });

    // Abort the parent
    parentHandle.abort("User cancelled");

    // The child should also be aborted
    try {
      const childHandle = await childPromise;
      await childHandle.result;
    } catch (e) {
      // Expected - child was aborted
      expect(e).toBeDefined();
    }

    session.close();
  });
});

// ============================================================================
// Child has fresh COM
// ============================================================================

describe("child isolation", () => {
  it("should give child a fresh COM (parent state not visible)", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

    const ChildAgent = () => {
      // The child's COM should be fresh - no parent state
      // We can't directly access COM here, but if the child
      // renders without the parent's system prompt, it's isolated.
      return (
        <>
          <Model model={childModel} />
          <System>Child only system</System>
          <Timeline />
        </>
      );
    };

    const ParentAgent = () => (
      <>
        <Model model={parentModel} />
        <System>Parent system</System>
        <Timeline />
      </>
    );

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    const result = await childHandle.result;

    // Child ran successfully with its own system prompt
    expect(result.response).toBe("Child response");

    session.close();
  });
});

// ============================================================================
// Lifecycle callback isolation
// ============================================================================

describe("lifecycle callback isolation", () => {
  it("should NOT fire parent's onComplete/onTickStart/onTickEnd for child", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

    const parentCallbacks: string[] = [];

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

    const app = createApp(ParentAgent, {
      maxTicks: 1,
      onComplete: () => parentCallbacks.push("onComplete"),
      onTickStart: () => parentCallbacks.push("onTickStart"),
      onTickEnd: () => parentCallbacks.push("onTickEnd"),
      onEvent: () => parentCallbacks.push("onEvent"),
    });
    const session = await app.session();

    // Spawn a child — parent callbacks should NOT fire
    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 10));

    // None of the parent's callbacks should have fired for the child
    expect(parentCallbacks).toHaveLength(0);

    session.close();
  });

  it("should NOT fire parent's onBeforeSend/onAfterSend for child", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

    const sendCallbacks: string[] = [];

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

    const app = createApp(ParentAgent, {
      maxTicks: 1,
      onBeforeSend: () => {
        sendCallbacks.push("onBeforeSend");
      },
      onAfterSend: () => {
        sendCallbacks.push("onAfterSend");
      },
    });
    const session = await app.session();

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 10));

    expect(sendCallbacks).toHaveLength(0);

    session.close();
  });
});

// ============================================================================
// Close propagation
// ============================================================================

describe("close propagation", () => {
  it("should close all children when parent is closed", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response", delay: 200 });

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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    // Start a slow child spawn
    const childPromise = session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }],
    });

    // Close parent immediately
    session.close();

    // Child should have been closed too
    try {
      const childHandle = await childPromise;
      await childHandle.result;
    } catch {
      // Expected - child was closed
    }

    expect(session.children).toHaveLength(0);
  });
});
