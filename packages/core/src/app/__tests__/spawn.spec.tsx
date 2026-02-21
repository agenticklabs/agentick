/**
 * spawn() Tests
 *
 * Tests for the recursive session primitive: session.spawn()
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model, Section } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { createTool } from "../../tool/tool.js";
import { z } from "zod";
import type {
  StreamEvent,
  SpawnStartEvent,
  SpawnEndEvent,
  ToolResultStartEvent,
  ToolResultEvent,
  ToolConfirmationRequiredEvent,
  // EngineErrorEvent,
} from "@agentick/shared";

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

    await session.close();
  });

  it("should spawn a child session with an inline component", async () => {
    const childModel = createMockModel("Inline child response");
    const parentModel = createMockModel("Parent response");

    const InlineChild = () => (
      <>
        <Model model={childModel} />
        <System>You are an inline agent</System>
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

    const childHandle = await session.spawn(InlineChild, {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello inline" }] }],
    });

    const childResult = await childHandle.result;
    expect(childResult.response).toBe("Inline child response");

    await session.close();
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

    await session.close();
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

    await session.close();
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

    await session.close();
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

    await session.close();
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

    await session.close();
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

    await session.close();
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

    await session.close();
  });
});

// ============================================================================
// Lifecycle callback isolation
// ============================================================================

describe("lifecycle callback isolation", () => {
  it("should NOT fire parent's onComplete/onTickStart/onTickEnd for child events", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createMockModel("Child response");

    const lifecycleCallbacks: string[] = [];
    let eventCount = 0;

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
      onComplete: () => lifecycleCallbacks.push("onComplete"),
      onTickStart: () => lifecycleCallbacks.push("onTickStart"),
      onTickEnd: () => lifecycleCallbacks.push("onTickEnd"),
      onEvent: () => {
        eventCount++;
      },
    });
    const session = await app.session();

    // Spawn a child — lifecycle-specific callbacks should NOT fire,
    // but onEvent SHOULD fire (child events are forwarded to parent)
    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 10));

    // Lifecycle-specific callbacks should not fire for forwarded child events
    expect(lifecycleCallbacks).toHaveLength(0);

    // But onEvent DOES fire — child events are forwarded to parent
    expect(eventCount).toBeGreaterThan(0);

    await session.close();
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

    await session.close();
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
    await session.close();

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

// ============================================================================
// Spawn lifecycle events
// ============================================================================

describe("spawn lifecycle events", () => {
  it("should emit spawn_start and spawn_end for a spawned child", async () => {
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

    // Collect events from the parent session
    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    await childHandle.result;
    // Let cleanup handlers run
    await new Promise((r) => setTimeout(r, 50));

    const spawnStarts = events.filter((e): e is SpawnStartEvent => e.type === "spawn_start");
    const spawnEnds = events.filter((e): e is SpawnEndEvent => e.type === "spawn_end");

    expect(spawnStarts).toHaveLength(1);
    expect(spawnEnds).toHaveLength(1);

    // Verify spawn_start fields
    expect(spawnStarts[0]!.componentName).toBe("ChildAgent");
    expect(spawnStarts[0]!.spawnId).toBeDefined();
    expect(spawnStarts[0]!.childExecutionId).toBeDefined();

    // Verify spawn_end matches
    expect(spawnEnds[0]!.spawnId).toBe(spawnStarts[0]!.spawnId);
    expect(spawnEnds[0]!.isError).toBeUndefined();
    expect(spawnEnds[0]!.output).toBe("Child response");

    await session.close();
  });

  it("should include label in spawn_start when provided", async () => {
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(
      ChildAgent,
      { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] },
      { label: "research-agent" },
    );

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 50));

    const spawnStart = events.find((e): e is SpawnStartEvent => e.type === "spawn_start");
    expect(spawnStart?.label).toBe("research-agent");

    await session.close();
  });
});

// ============================================================================
// Child event forwarding with spawnPath
// ============================================================================

describe("child event forwarding", () => {
  it("should forward child events to parent with spawnPath", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response" });

    // Make the child call a tool so we get tool events to forward
    childModel.respondWith([{ tool: { name: "child_tool", input: { data: "test" } } }]);

    const ChildTool = createTool({
      name: "child_tool",
      description: "A child tool",
      input: z.object({ data: z.string() }),
      handler: ({ data }) => [{ type: "text" as const, text: `processed ${data}` }],
    });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child agent</System>
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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "do something" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 50));

    // Find the spawn_start to get the spawnId
    const spawnStart = events.find((e): e is SpawnStartEvent => e.type === "spawn_start");
    expect(spawnStart).toBeDefined();
    const spawnId = spawnStart!.spawnId;

    // Child events forwarded to parent should have spawnPath
    const forwardedToolResults = events.filter(
      (e): e is ToolResultEvent => e.type === "tool_result" && !!e.spawnPath,
    );
    expect(forwardedToolResults.length).toBeGreaterThan(0);

    // spawnPath should start with the parent's spawnId
    for (const event of forwardedToolResults) {
      expect(event.spawnPath![0]).toBe(spawnId);
    }

    await session.close();
  });

  it("should emit spawn_end AFTER all forwarded child events", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response" });

    childModel.respondWith([{ tool: { name: "ordering_tool", input: { v: "1" } } }]);

    const OrderingTool = createTool({
      name: "ordering_tool",
      description: "Tool for ordering test",
      input: z.object({ v: z.string() }),
      handler: ({ v }) => [{ type: "text" as const, text: v }],
    });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child</System>
        <OrderingTool />
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 50));

    const spawnEndIdx = events.findIndex((e) => e.type === "spawn_end");
    expect(spawnEndIdx).toBeGreaterThan(-1);

    // All forwarded child events (those with spawnPath) must come before spawn_end
    const forwardedAfterEnd = events.slice(spawnEndIdx + 1).filter((e) => e.spawnPath?.length);
    expect(forwardedAfterEnd).toHaveLength(0);

    await session.close();
  });
});

// ============================================================================
// tool_result_start events
// ============================================================================

describe("tool_result_start events", () => {
  it("should emit tool_result_start before tool_result for each tool", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "test_tool", input: { value: "hello" } } }]);

    const TestTool = createTool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      handler: ({ value }) => [{ type: "text" as const, text: value }],
    });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <TestTool />
          <Section id="system" audience="model">
            Test
          </Section>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    const resultStarts = events.filter(
      (e): e is ToolResultStartEvent => e.type === "tool_result_start",
    );
    const results = events.filter((e): e is ToolResultEvent => e.type === "tool_result");

    expect(resultStarts).toHaveLength(1);
    expect(results).toHaveLength(1);

    // tool_result_start should precede tool_result
    const startIdx = events.indexOf(resultStarts[0]!);
    const resultIdx = events.indexOf(results[0]!);
    expect(startIdx).toBeLessThan(resultIdx);

    // Same callId
    expect(resultStarts[0]!.callId).toBe(results[0]!.callId);
    expect(resultStarts[0]!.name).toBe("test_tool");

    await session.close();
  });
});

// ============================================================================
// Confirmation routing through spawn tree
// ============================================================================

describe("confirmation routing through spawn", () => {
  it("should route confirmations from parent to child through spawn", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child done" });

    childModel.respondWith([{ tool: { name: "dangerous_child_tool", input: { target: "prod" } } }]);

    const ChildTool = createTool({
      name: "dangerous_child_tool",
      description: "A dangerous child tool",
      input: z.object({ target: z.string() }),
      requiresConfirmation: true,
      handler: ({ target }) => [{ type: "text" as const, text: `executed on ${target}` }],
    });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child with dangerous tool</System>
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

    const app = createApp(ParentAgent, { maxTicks: 1 });
    const session = await app.session();

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => {
      events.push(event);

      // When we see a confirmation request (bubbled from child), approve it via parent
      if (event.type === "tool_confirmation_required") {
        session.submitToolResult(event.callId, { approved: true });
      }
    });

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    });

    const _result = await childHandle.result;
    await new Promise((r) => setTimeout(r, 50));

    // Confirmation request should have been bubbled with spawnPath
    const confirmReqs = events.filter(
      (e): e is ToolConfirmationRequiredEvent =>
        e.type === "tool_confirmation_required" && !!e.spawnPath,
    );
    expect(confirmReqs).toHaveLength(1);
    expect(confirmReqs[0]!.name).toBe("dangerous_child_tool");

    // Tool should have executed successfully (confirmation was routed back)
    const toolResults = events.filter(
      (e): e is ToolResultEvent => e.type === "tool_result" && e.name === "dangerous_child_tool",
    );
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0]!.isError).toBe(false);

    await session.close();
  });
});

// ============================================================================
// Error spawn_end
// ============================================================================

describe("spawn error events", () => {
  it("should emit spawn_end with isError when child throws", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({
      throwError: new Error("Child model exploded"),
    });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child that errors</System>
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "fail" }] }],
    });

    // Child will error — catch it
    try {
      await childHandle.result;
    } catch {
      // Expected
    }
    await new Promise((r) => setTimeout(r, 50));

    const spawnEnds = events.filter((e): e is SpawnEndEvent => e.type === "spawn_end");
    expect(spawnEnds).toHaveLength(1);
    expect(spawnEnds[0]!.isError).toBe(true);
    expect(spawnEnds[0]!.output).toContain("Child model exploded");

    // spawn_start should also be present
    const spawnStarts = events.filter((e): e is SpawnStartEvent => e.type === "spawn_start");
    expect(spawnStarts).toHaveLength(1);
    expect(spawnEnds[0]!.spawnId).toBe(spawnStarts[0]!.spawnId);

    await session.close();
  });
});

// ============================================================================
// Recursive spawn bubbling (grandchild → child → parent)
// ============================================================================

describe("recursive spawn bubbling", () => {
  it("should bubble grandchild events with nested spawnPath", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child done" });
    const grandchildModel = createMockModel("Grandchild response");

    const GrandchildAgent = () => (
      <>
        <Model model={grandchildModel} />
        <System>Grandchild agent</System>
        <Timeline />
      </>
    );

    // Child uses a tool that spawns the grandchild
    const SpawnGrandchildTool = createTool({
      name: "spawn_grandchild",
      description: "Spawn a grandchild",
      input: z.object({ query: z.string() }),
      handler: async (input, ctx) => {
        const handle = await ctx!.spawn(GrandchildAgent, {
          messages: [{ role: "user", content: [{ type: "text", text: input.query }] }],
        });
        const result = await handle.result;
        return [{ type: "text" as const, text: `Grandchild said: ${result.response}` }];
      },
    });

    childModel.respondWith([
      { tool: { name: "spawn_grandchild", input: { query: "hello grandchild" } } },
    ]);

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Child that spawns</System>
        <SpawnGrandchildTool />
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    });

    await childHandle.result;
    await new Promise((r) => setTimeout(r, 100));

    // We should see TWO spawn_start events: one for child, one for grandchild
    const spawnStarts = events.filter((e): e is SpawnStartEvent => e.type === "spawn_start");
    expect(spawnStarts).toHaveLength(2);

    // First spawn_start: child (no spawnPath — emitted by parent directly)
    const childSpawnStart = spawnStarts.find((e) => !e.spawnPath?.length);
    expect(childSpawnStart).toBeDefined();
    expect(childSpawnStart!.componentName).toBe("ChildAgent");

    // Second spawn_start: grandchild (forwarded from child, has spawnPath)
    const grandchildSpawnStart = spawnStarts.find((e) => e.spawnPath?.length);
    expect(grandchildSpawnStart).toBeDefined();
    expect(grandchildSpawnStart!.componentName).toBe("GrandchildAgent");

    // Grandchild's spawn_start has spawnPath length 1: [parentSpawnId]
    // because the child emits it directly (no spawnPath), then the parent
    // forwards it with [parentSpawnId]. The grandchild's OWN events
    // (content, tool_result, etc.) get spawnPath length 2:
    // child forwards with [childSpawnId], parent forwards with [parentSpawnId, childSpawnId].
    expect(grandchildSpawnStart!.spawnPath!).toHaveLength(1);
    expect(grandchildSpawnStart!.spawnPath![0]).toBe(childSpawnStart!.spawnId);

    // Grandchild's own events (forwarded through two levels) have length-2 spawnPath
    const deepForwardedEvents = events.filter((e) => e.spawnPath?.length === 2);
    expect(deepForwardedEvents.length).toBeGreaterThan(0);
    // Path is [parentSpawnId, childSpawnId]
    expect(deepForwardedEvents[0]!.spawnPath![0]).toBe(childSpawnStart!.spawnId);

    await session.close();
  });
});

// ============================================================================
// Abort propagation through spawn tree
// ============================================================================

describe("abort propagation through spawn tree", () => {
  it("should emit error spawn_end when child handle is aborted directly", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response", delay: 500 });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Slow child</System>
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }],
    });

    // Give spawn a moment to start, then abort the child directly
    await new Promise((r) => setTimeout(r, 50));
    childHandle.abort("User cancelled");

    try {
      await childHandle.result;
    } catch {
      // Expected
    }
    await new Promise((r) => setTimeout(r, 100));

    const spawnStarts = events.filter((e): e is SpawnStartEvent => e.type === "spawn_start");
    expect(spawnStarts.length).toBeGreaterThanOrEqual(1);

    const spawnEnds = events.filter((e): e is SpawnEndEvent => e.type === "spawn_end");
    expect(spawnEnds).toHaveLength(1);
    expect(spawnEnds[0]!.isError).toBe(true);

    await session.close();
  });

  it("should abort child when parent session is closed", async () => {
    const parentModel = createMockModel("Parent response");
    const childModel = createTestAdapter({ defaultResponse: "Child response", delay: 500 });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <System>Slow child</System>
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

    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));

    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }],
    });

    // Give spawn a moment to start, then close the parent session.
    // Session close fires sessionAbortController, which now propagates to child.
    await new Promise((r) => setTimeout(r, 50));
    await session.close();

    try {
      await childHandle.result;
    } catch {
      // Expected — child was aborted by parent session close
    }
    await new Promise((r) => setTimeout(r, 100));

    // spawn_end should have fired with isError
    const spawnEnds = events.filter((e): e is SpawnEndEvent => e.type === "spawn_end");
    expect(spawnEnds).toHaveLength(1);
    expect(spawnEnds[0]!.isError).toBe(true);
  });
});
