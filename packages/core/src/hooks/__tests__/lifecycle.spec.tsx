/**
 * Lifecycle Hooks Tests
 *
 * Tests for useContinuation, useOnTickEnd, and related hooks.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app";
import { System, User } from "../../jsx/components/messages";
import { Model, Tool } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import { useContinuation, useOnTickEnd, useOnTickStart } from "../../hooks";
import type { TickResult } from "../types";
import { type ToolCall, StopReason } from "@tentickle/shared";
import { z } from "zod";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(options?: { response?: string; stopReason?: StopReason }) {
  return createTestAdapter({
    defaultResponse: options?.response ?? "Mock response",
    stopReason: options?.stopReason,
  });
}

function createToolCallingModel(toolName: string, toolInput: Record<string, unknown>) {
  return createTestAdapter({
    defaultResponse: "",
    toolCalls: [{ id: "1", name: toolName, input: toolInput }],
  });
}

// ============================================================================
// useContinuation Tests
// ============================================================================

describe("useContinuation", () => {
  it("should receive TickResult with correct properties", async () => {
    const model = createMockModel({ response: "Hello world" });
    const receivedResults: TickResult[] = [];

    const Agent = () => {
      useContinuation((result, _com) => {
        receivedResults.push({ ...result });
        return false; // Stop after first tick
      });

      return (
        <>
          <Model model={model} />
          <System>Test system</System>
          <Timeline />
          <User>Hello</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] })
      .result;
    session.close();

    expect(receivedResults.length).toBe(1);
    const result = receivedResults[0];

    // Check required properties exist
    expect(typeof result.tick).toBe("number");
    expect(result.tick).toBe(1);
    expect(result.text).toBe("Hello world");
    expect(Array.isArray(result.content)).toBe(true);
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(Array.isArray(result.toolResults)).toBe(true);
    expect(Array.isArray(result.timeline)).toBe(true);
    expect(typeof result.stop).toBe("function");
    expect(typeof result.continue).toBe("function");
  });

  it("should receive tool calls in TickResult", async () => {
    const model = createToolCallingModel("greet", { name: "World" });
    let receivedToolCalls: ToolCall[] = [];

    const Agent = () => {
      useContinuation((result, _com) => {
        receivedToolCalls = [...result.toolCalls];
        return false; // Stop after first tick
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Tool
            name="greet"
            description="Greet someone"
            input={z.object({ name: z.string() })}
            handler={async ({ name }) => [{ type: "text", text: `Hello, ${name}!` }]}
          />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Greet" }] }] })
      .result;
    session.close();

    expect(receivedToolCalls.length).toBe(1);
    expect(receivedToolCalls[0].name).toBe("greet");
    expect(receivedToolCalls[0].input).toEqual({ name: "World" });
  });

  it("should stop execution when callback returns false", async () => {
    const model = createToolCallingModel("test_tool", { value: 1 });
    let tickCount = 0;

    const Agent = () => {
      useContinuation((_result, _com) => {
        tickCount++;
        return false; // Always stop
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Tool
            name="test_tool"
            description="A test tool"
            input={z.object({ value: z.number() })}
            handler={async () => [{ type: "text", text: "Tool executed" }]}
          />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Should only run 1 tick even though tool was called (which normally continues)
    expect(tickCount).toBe(1);
  });

  it("should continue execution when callback returns true", async () => {
    const model = createMockModel({ response: "Response", stopReason: StopReason.STOP });
    let tickCount = 0;

    const Agent = () => {
      useContinuation((_result, _com) => {
        tickCount++;
        // Continue for first 2 ticks, then stop
        return tickCount < 2;
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Should run 2 ticks because we returned true on first tick
    expect(tickCount).toBe(2);
  });

  it("should stop execution when result.stop() is called", async () => {
    const model = createToolCallingModel("test_tool", { value: 1 });
    let tickCount = 0;

    const Agent = () => {
      useContinuation((result, _com) => {
        tickCount++;
        result.stop("custom-stop-reason");
        // Note: we don't return anything - the method call handles it
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Tool
            name="test_tool"
            description="A test tool"
            input={z.object({ value: z.number() })}
            handler={async () => [{ type: "text", text: "Executed" }]}
          />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Should only run 1 tick because stop() was called
    expect(tickCount).toBe(1);
  });

  it("should continue execution when result.continue() is called", async () => {
    const model = createMockModel({ response: "Done", stopReason: StopReason.STOP });
    let tickCount = 0;

    const Agent = () => {
      useContinuation((result, _com) => {
        tickCount++;
        if (tickCount < 3) {
          result.continue("keep-going");
        } else {
          result.stop("done");
        }
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Should run 3 ticks because continue() overrides default stop behavior
    expect(tickCount).toBe(3);
  });

  it("should support async callbacks", async () => {
    const model = createMockModel({ response: "Response" });
    let tickCount = 0;
    let asyncCompleted = false;

    const Agent = () => {
      useContinuation(async (_result, _com) => {
        tickCount++;
        // Simulate async verification
        await new Promise((resolve) => setTimeout(resolve, 10));
        asyncCompleted = true;
        return false; // Stop
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    expect(tickCount).toBe(1);
    expect(asyncCompleted).toBe(true);
  });

  it("should detect done marker in response text", async () => {
    let callCount = 0;
    const model = createTestAdapter({
      responseGenerator: () => {
        callCount++;
        return callCount === 1 ? "Still working..." : "Task complete <DONE>";
      },
    });
    let tickCount = 0;

    const Agent = () => {
      useContinuation((result, _com) => {
        tickCount++;
        // Continue until we see the done marker
        return !result.text?.includes("<DONE>");
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Should run 2 ticks - first continues, second has done marker
    expect(tickCount).toBe(2);
  });
});

// ============================================================================
// useOnTickEnd Tests
// ============================================================================

describe("useOnTickEnd", () => {
  it("should be called after each tick", async () => {
    const model = createMockModel();
    const tickEndCalls: number[] = [];

    const Agent = () => {
      useOnTickEnd((result, _com) => {
        tickEndCalls.push(result.tick);
        return false; // Stop after first tick
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    expect(tickEndCalls).toEqual([1]);
  });

  it("should receive content in TickResult", async () => {
    const model = createMockModel({ response: "Test content here" });
    let receivedContent: any[] = [];

    const Agent = () => {
      useOnTickEnd((result, _com) => {
        // Capture content from the result
        receivedContent = [...result.content];
        return false; // Stop after capturing
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // Content should be present in the TickResult
    expect(receivedContent.length).toBeGreaterThan(0);
    expect(receivedContent[0].type).toBe("text");
  });
});

// ============================================================================
// useOnTickStart Tests
// ============================================================================

describe("useOnTickStart", () => {
  it("should register callback via useOnTickStart", async () => {
    const model = createMockModel();
    let tickStartCallCount = 0;

    const Agent = () => {
      // useOnTickStart uses useEffect, which runs after first render
      // On subsequent ticks (tick 2+), the callback should be registered
      useOnTickStart((_tickState, _com) => {
        tickStartCallCount++;
      });

      // Continue for 2 ticks to ensure callback gets registered and called
      useContinuation((result, _com) => result.tick < 2);

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    // By tick 2, the effect should have run and callback should be called
    expect(tickStartCallCount).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Multiple Callbacks Tests
// ============================================================================

describe("multiple continuation callbacks", () => {
  it("should stop wins over continue (stop has higher priority)", async () => {
    const model = createMockModel();
    let callback1Called = false;
    let callback2Called = false;

    const Agent = () => {
      // First callback says continue
      useContinuation((result, _com) => {
        callback1Called = true;
        result.continue("want-to-continue");
      });

      // Second callback says stop - should win
      useContinuation((result, _com) => {
        callback2Called = true;
        result.stop("must-stop");
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }] })
      .result;
    session.close();

    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    // Execution should have stopped after 1 tick because stop wins
    expect(session.currentTick).toBe(2); // Tick incremented after tick 1 completes
  });
});
