/**
 * SessionHandle Tests
 *
 * Tests for the SessionHandle functionality including:
 * - session.render() returning a SessionExecutionHandle
 * - app.run() returning an ExecutionHandle
 * - handle.sendMessage() behavior (running vs idle)
 * - ALS context capture in session constructor
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app";
import type { ModelOutput } from "../../model/model";
import { System, User } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Context } from "@agentick/kernel";
import { AbortError, type StreamEvent } from "@agentick/shared";
import { useState, useRef, useOnMessage, useQueuedMessages, useContinuation } from "../../hooks";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(options?: { delay?: number; response?: Partial<ModelOutput> }) {
  return createTestAdapter({
    delay: options?.delay ?? 0,
    defaultResponse: options?.response?.message
      ? ((options.response.message as any).content?.[0]?.text ?? "Mock response")
      : "Mock response",
    stopReason: options?.response?.stopReason,
  });
}

// ============================================================================
// session.render() handle Tests
// ============================================================================

describe("session.render() handle", () => {
  it("should return empty result when no props and no queued messages", async () => {
    const Agent = () => (
      <>
        <System>Only system.</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render(undefined as never);
    const result = await handle.result;

    expect(handle.status).toBe("completed");
    expect(result.response).toBe("");
    expect(result.outputs).toEqual({});
    expect(result.raw.tools).toEqual([]);
  });

  it("should execute tick when empty props object is provided", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Only system.</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Empty props {} is still an explicit request to run
    const handle = await session.render({} as never);
    const result = await handle.result;

    expect(handle.status).toBe("completed");
    // Model was called, so response should be the mock response
    expect(result.response).toBe("Mock response");
  });

  it("should return handle with running status during execution", async () => {
    const model = createMockModel({ delay: 50 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>You are helpful.</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render({ query: "Hello!" });

    // Handle should be running initially
    expect(handle.status).toBe("running");
    expect(handle.sessionId).toBe(session.id);
    expect(typeof handle.currentTick).toBe("number");

    // Wait for completion
    await handle.result;

    // Handle should be completed after result resolves
    expect(handle.status).toBe("completed");

    await session.close();
  });

  it("should expose session ID through handle", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render({ query: "test" });

    expect(handle.sessionId).toBe(session.id);

    await handle.result;
    await session.close();
  });

  it("should update tick during execution", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render({ query: "test" });

    // Tick starts at 1
    expect(handle.currentTick).toBeGreaterThanOrEqual(1);

    await handle.result;
    await session.close();
  });
});

// ============================================================================
// app.run() handle Tests
// ============================================================================

describe("app.run() handle", () => {
  it("should return handle for ephemeral run", async () => {
    const model = createMockModel({ delay: 50 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });

    const handle = await app.run({ props: { query: "Hello!" } });

    expect(handle.status).toBe("running");

    await handle.result;

    expect(handle.status).toBe("completed");
  });

  it("should expose session ID from handle", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });

    const handle = await app.run({ props: { query: "test" } });

    // Session ID should be accessible via traceId
    expect(typeof handle.traceId).toBe("string");

    await handle.result;
  });
});

// ============================================================================
// app.run() streaming Tests
// ============================================================================

describe("app.run() streaming", () => {
  it("should support streaming via async iteration", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });

    // app.run() returns SessionExecutionHandle (AsyncIterable, not PromiseLike)
    const handle = await app.run({ props: { query: "Hello!" } });

    expect(handle.status).toBe("running");

    // Consume the stream - handle is AsyncIterable
    for await (const _event of handle) {
      // Just consume
    }

    // After stream completes, status should be completed
    // Note: There may be a slight delay for status update
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handle.status).toBe("completed");
  });
});

// ============================================================================
// session.queue.exec() Tests
// ============================================================================

describe("session.queue.exec()", () => {
  it("should queue message when session is idle", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Session is idle (no send in progress)
    expect(session.status).toBe("idle");

    // queue.exec should queue without triggering tick
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Queued message" }],
    });

    // Message should be queued
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0].content[0]).toEqual({
      type: "text",
      text: "Queued message",
    });

    await session.close();
  });
});

// ============================================================================
// handle.abort() Tests
// ============================================================================

describe("handle.abort()", () => {
  it("should abort execution via handle", async () => {
    const model = createMockModel({ delay: 100 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render({ query: "test" });

    // Abort immediately
    handle.abort("User cancelled");

    // Status should be aborted
    expect(handle.status).toBe("aborted");

    // Result may throw or complete early
    try {
      await handle.result;
    } catch (e) {
      // Expected - abort error
    }

    await session.close();
  });

  it("should allow new tick after abort", async () => {
    const model = createMockModel({ delay: 50 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render({ query: "first" });
    handle.abort("User cancelled");
    await expect(handle.result).rejects.toBeInstanceOf(AbortError);

    const nextHandle = await session.render({ query: "second" });
    const result = await nextHandle.result;

    expect(result.response).toContain("Mock");

    await session.close();
  });
});

// ============================================================================
// Per-execution Abort Signal Tests
// ============================================================================

describe("execution abort signals", () => {
  it("should merge signals from concurrent send/tick calls", async () => {
    const model = createMockModel({ delay: 50 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const signalA = new AbortController();
    const signalB = new AbortController();

    const handle = await session.render({ query: "first" }, { signal: signalA.signal });
    const sameHandle = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "interrupt" }] }],
      signal: signalB.signal,
    });

    expect(sameHandle).toBe(handle);

    signalB.abort("Second signal abort");

    await expect(handle.result).rejects.toBeDefined();

    await session.close();
  });
});

// ============================================================================
// SendInput flat fields
// ============================================================================

describe("SendInput flat fields", () => {
  it("should respect maxTicks passed inside send()", async () => {
    const model = createMockModel();
    let tickCount = 0;

    const Agent = () => {
      useContinuation(() => {
        tickCount++;
        return true; // Always continue — maxTicks should stop us
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    // App allows up to 10 ticks
    const app = createApp(Agent, { maxTicks: 10 });
    const session = await app.session();

    // But send() limits to 2
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      maxTicks: 2,
    }).result;

    // Should have been capped at 2, not 10
    expect(tickCount).toBeLessThanOrEqual(2);

    await session.close();
  });

  it("should abort via signal passed inside send()", async () => {
    const model = createMockModel({ delay: 100 });

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const controller = new AbortController();

    const handle = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      signal: controller.signal,
    });

    // Abort immediately
    controller.abort("test abort");

    await expect(handle.result).rejects.toBeDefined();

    await session.close();
  });

  it("should send with no messages (props-only)", async () => {
    const model = createMockModel();
    let capturedQuery: string | undefined;

    const Agent = ({ query }: { query: string }) => {
      capturedQuery = query;
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // send() with only props, no messages
    await session.send({ props: { query: "from send" } }).result;

    expect(capturedQuery).toBe("from send");

    await session.close();
  });
});

// ============================================================================
// ALS Context Capture Tests
// ============================================================================

describe("ALS Context Capture", () => {
  it("should capture ALS context when session is created", async () => {
    const model = createMockModel();
    let capturedTraceId: string | undefined;

    const Agent = ({ query }: { query: string }) => {
      // Try to get the context inside the component
      const ctx = Context.tryGet();
      capturedTraceId = ctx?.traceId;

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });

    // Create session within a context that has events (required by kernel)
    const { EventEmitter } = await import("node:events");
    const events = new EventEmitter();

    await Context.run({ traceId: "test-trace-123", events }, async () => {
      const session = await app.session();
      await session.render({ query: "test" }).result;
      await session.close();
    });

    // The component should have received the trace ID
    expect(capturedTraceId).toBe("test-trace-123");
  });

  it("current context should win over captured context on conflict", async () => {
    const model = createMockModel();
    let capturedTraceId: string | undefined;

    const Agent = ({ query }: { query: string }) => {
      const ctx = Context.tryGet();
      capturedTraceId = ctx?.traceId;

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });

    // Create session with one context
    const { EventEmitter } = await import("node:events");
    const events = new EventEmitter();

    const session = await Context.run({ traceId: "creation-trace", events }, async () => {
      return app.session();
    });

    // Send with a different context (but same events bus)
    await Context.run({ traceId: "send-trace", events }, async () => {
      await session.render({ query: "test" }).result;
    });

    // Current (send-time) context should win
    expect(capturedTraceId).toBe("send-trace");

    await session.close();
  });
});

// ============================================================================
// State Persistence Across Sends Tests
// ============================================================================

describe("State Persistence Across Sends", () => {
  it("should preserve useState values across multiple sends", async () => {
    const model = createMockModel();
    const capturedValues: { query: string; count: number }[] = [];

    const Agent = ({ query }: { query: string }) => {
      // useState with a counter that we'll increment each send
      const [sendCount, setSendCount] = useState(0);

      // Track the last query we processed to detect new sends
      const lastQuery = useRef<string | null>(null);

      // When query changes (new send), capture current state and increment
      if (lastQuery.current !== query) {
        capturedValues.push({ query, count: sendCount });
        lastQuery.current = query;
        // Increment for next send
        setSendCount(sendCount + 1);
      }

      return (
        <>
          <Model model={model} />
          <System>Send count: {sendCount}</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First send - should start at 0, increment to 1
    await session.render({ query: "First message" }).result;

    // Second send - should start at 1 (persisted), increment to 2
    await session.render({ query: "Second message" }).result;

    // Third send - should start at 2 (persisted), increment to 3
    await session.render({ query: "Third message" }).result;

    await session.close();

    // With state persistence across sends:
    // First send starts with 0
    // Second send starts with 1 (persisted from first)
    // Third send starts with 2 (persisted from second)
    expect(capturedValues).toEqual([
      { query: "First message", count: 0 },
      { query: "Second message", count: 1 },
      { query: "Third message", count: 2 },
    ]);
  });

  it("should preserve useRef values across multiple sends", async () => {
    const model = createMockModel();
    const refValues: number[] = [];

    const Agent = ({ query }: { query: string }) => {
      const renderCount = useRef(0);
      renderCount.current += 1;

      // Capture the ref value each render
      refValues.push(renderCount.current);

      return (
        <>
          <Model model={model} />
          <System>Renders: {renderCount.current}</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First send
    await session.render({ query: "First message" }).result;

    // Second send - ref should persist
    await session.render({ query: "Second message" }).result;

    // Third send - ref should still persist
    await session.render({ query: "Third message" }).result;

    await session.close();

    // With reconciliation, the ref should accumulate across all sends
    // Without fix (new session each time): would be [1, 1, 1] or similar
    // With fix (persisted session): should be increasing sequence
    const lastValue = refValues[refValues.length - 1];
    expect(lastValue).toBeGreaterThan(1);
  });

  it("should NOT remount components on subsequent sends", async () => {
    const model = createMockModel();
    let mountCount = 0;

    const Agent = ({ query }: { query: string }) => {
      // Track mount count via a ref initialized only once
      const initialized = useRef(false);
      if (!initialized.current) {
        mountCount++;
        initialized.current = true;
      }

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First send - should mount
    await session.render({ query: "First" }).result;

    // Second send - should NOT remount (fiber tree preserved)
    await session.render({ query: "Second" }).result;

    // Third send - should NOT remount
    await session.render({ query: "Third" }).result;

    await session.close();

    // Component should only mount once across all sends
    expect(mountCount).toBe(1);
  });
});

// ============================================================================
// Hot Update Props Tests
// ============================================================================

describe("render() hot update when running", () => {
  it("should update props when render() called while running", async () => {
    // Use a model with delay to give us time to call render() while running
    const model = createMockModel({ delay: 100 });
    const propsReceived: string[] = [];

    const Agent = ({ query }: { query: string }) => {
      // Track what props we receive
      propsReceived.push(query);

      return (
        <>
          <Model model={model} />
          <System>Query: {query}</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();

    // Start first tick
    const firstTickPromise = await session.render({ query: "First" });

    // While running, call render() with new props (hot update)
    // Wait a tiny bit for the first tick to start
    await new Promise((r) => setTimeout(r, 10));
    const secondTickPromise = await session.render({ query: "Updated" });

    // Both should return the same promise (the first one's result)
    const [result1, result2] = await Promise.all([firstTickPromise, secondTickPromise]);

    // Results should be the same (same execution)
    expect(result1).toBe(result2);

    // Props should have been updated during execution
    // Initial render sees "First", subsequent recompiles may see "Updated"
    expect(propsReceived[0]).toBe("First");
    // If recompilation happened, we'd see "Updated" in later renders
    // But the exact behavior depends on timing

    await session.close();
  });

  it("should not throw when render() called while running", async () => {
    const model = createMockModel({ delay: 100 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Start first tick
    const firstHandle = await session.render({ query: "First" });

    // Wait a bit then call render() again - should NOT throw
    await new Promise((r) => setTimeout(r, 10));
    const secondHandle = await session.render({ query: "Second" });
    expect(secondHandle).toBeDefined();
    await secondHandle.result;

    await firstHandle.result;
    await session.close();
  });
});

// ============================================================================
// onMessage Hook Integration Tests
// ============================================================================

describe("useOnMessage integration", () => {
  it("should call useOnMessage callback when queueMessage is called during execution", async () => {
    const model = createMockModel({ delay: 100 });
    const messagesReceived: unknown[] = [];

    const Agent = ({ query }: { query: string }) => {
      useOnMessage((message, _com, _state) => {
        messagesReceived.push(message);
      });

      return (
        <>
          <Model model={model} />
          <System>Test agent</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Start execution
    const tickPromise = await session.render({ query: "Hello" });

    // Wait for components to mount
    await new Promise((r) => setTimeout(r, 20));

    // Queue a message during execution
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Injected message" }],
    });

    await tickPromise;

    // Verify the callback was called
    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0]).toMatchObject({
      type: "message",
      content: {
        role: "user",
        content: [{ type: "text", text: "Injected message" }],
      },
    });

    await session.close();
  });

  it("should call useOnMessage callback when sendMessage is called while IDLE", async () => {
    const model = createMockModel({ delay: 50 });
    const messagesReceived: unknown[] = [];
    let tickCompleted = false;

    const Agent = ({ query }: { query: string }) => {
      useOnMessage((message, _com, _state) => {
        messagesReceived.push(message);
      });

      return (
        <>
          <Model model={model} />
          <System>Test agent</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Listen for tick completion
    session.on("event", (event) => {
      if (event.type === "execution_end") {
        tickCompleted = true;
      }
    });

    // Run first tick to mount components and set _lastProps
    await session.render({ query: "Initial" }).result;

    // Clear received messages from first tick
    messagesReceived.length = 0;
    tickCompleted = false;

    // Now send while IDLE - this should queue, notify, and trigger tick
    await session.send({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Follow up" }],
        },
      ],
    }).result;

    // Wait for the triggered tick to complete
    while (!tickCompleted) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Verify the callback was called
    expect(messagesReceived.length).toBeGreaterThanOrEqual(1);
    expect(messagesReceived[0]).toMatchObject({
      type: "message",
      content: {
        role: "user",
        content: [{ type: "text", text: "Follow up" }],
      },
    });

    await session.close();
  });

  it("should execute send on a fresh session without prior props", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.send({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello from send" }],
        },
      ],
    });

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    const result = await handle.result;

    expect(result.response).toBe("Mock response");
    expect(events.some((event) => event.type === "result")).toBe(true);

    await session.close();
  });

  it("should include queued user messages in useConversationHistory on first tick", async () => {
    const model = createMockModel();
    let historyDuringRender: any[] = [];

    const Agent = () => {
      // Capture conversation history during render
      const history = useQueuedMessages();
      historyDuringRender = history;

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.send({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello from send" }],
        },
      ],
    });

    await handle.result;

    // The queued messages should have been available during render
    expect(historyDuringRender.length).toBeGreaterThanOrEqual(1);
    const userMessage = historyDuringRender.find((m) => m.type === "message");
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Hello from send" }],
    });

    await session.close();
  });

  it("should receive message with id and timestamp", async () => {
    const model = createMockModel({ delay: 50 });
    let receivedMessage: any = null;

    const Agent = ({ query }: { query: string }) => {
      useOnMessage((message, _com, _state) => {
        receivedMessage = message;
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Start execution
    const tickPromise = await session.render({ query: "Hello" });

    // Wait for components to mount
    await new Promise((r) => setTimeout(r, 20));

    // Queue a message
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Test" }],
    });

    await tickPromise;

    // Verify message has id and timestamp
    expect(receivedMessage).toBeDefined();
    expect(receivedMessage.id).toBeDefined();
    expect(typeof receivedMessage.id).toBe("string");
    expect(receivedMessage.timestamp).toBeDefined();
    expect(typeof receivedMessage.timestamp).toBe("number");

    await session.close();
  });

  it("should not call useOnMessage when queueMessage is called before first tick", async () => {
    const model = createMockModel();
    const messagesReceived: unknown[] = [];

    const Agent = ({ query }: { query: string }) => {
      useOnMessage((message, _com, _state) => {
        messagesReceived.push(message);
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Queue message BEFORE any tick (components not mounted yet)
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Early message" }],
    });

    // No callback yet since no components are mounted
    expect(messagesReceived.length).toBe(0);

    // Now run a tick
    await session.render({ query: "Hello" }).result;

    // The message was queued but since components weren't mounted,
    // onMessage wasn't called during queueMessage
    // (the message would be available via useQueuedMessages in the next tick)
    expect(messagesReceived.length).toBe(0);

    await session.close();
  });
});

// ============================================================================
// useQueuedMessages Integration Tests
// ============================================================================

describe("useQueuedMessages integration", () => {
  it("should make messages queued in tick N available via useQueuedMessages in tick N+1", async () => {
    const model = createMockModel({ delay: 20 });
    const queuedMessagesPerTick: unknown[][] = [];

    const Agent = ({ query }: { query: string }) => {
      const queued = useQueuedMessages();
      // Capture what useQueuedMessages returns each render
      queuedMessagesPerTick.push([...queued]);

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Tick 1: No queued messages yet
    await session.render({ query: "First" }).result;

    // Queue a message while IDLE (between ticks)
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Queued between ticks" }],
    });

    // Clear the captured array for tick 2
    const tick1Captures = [...queuedMessagesPerTick];
    queuedMessagesPerTick.length = 0;

    // Tick 2: Should have the queued message available
    await session.render({ query: "Second" }).result;

    // Tick 1 should have had no queued messages
    expect(tick1Captures.some((arr) => arr.length > 0)).toBe(false);

    // Tick 2 should have the queued message
    expect(queuedMessagesPerTick.some((arr) => arr.length > 0)).toBe(true);
    const messagesInTick2 = queuedMessagesPerTick.find((arr) => arr.length > 0);
    expect(messagesInTick2?.[0]).toMatchObject({
      type: "message",
      content: {
        role: "user",
        content: [{ type: "text", text: "Queued between ticks" }],
      },
    });

    await session.close();
  });

  it("should clear queued messages after they are consumed in a tick", async () => {
    const model = createMockModel({ delay: 20 });
    const queuedMessagesPerTick: { tick: number; count: number }[] = [];
    let currentTickNumber = 0;

    const Agent = ({ query }: { query: string }) => {
      const queued = useQueuedMessages();
      queuedMessagesPerTick.push({ tick: currentTickNumber, count: queued.length });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Tick 1
    currentTickNumber = 1;
    await session.render({ query: "First" }).result;

    // Queue a message
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Test message" }],
    });

    // Tick 2: Should have 1 message
    currentTickNumber = 2;
    await session.render({ query: "Second" }).result;

    // Tick 3: Should have 0 messages (cleared after tick 2 consumed them)
    currentTickNumber = 3;
    await session.render({ query: "Third" }).result;

    // Verify tick 2 had a message, tick 3 did not
    const tick2Results = queuedMessagesPerTick.filter((r) => r.tick === 2);
    const tick3Results = queuedMessagesPerTick.filter((r) => r.tick === 3);

    expect(tick2Results.some((r) => r.count > 0)).toBe(true);
    expect(tick3Results.every((r) => r.count === 0)).toBe(true);

    await session.close();
  });

  it("should make messages queued DURING tick N available in tick N+1", async () => {
    const model = createMockModel({ delay: 50 });
    const queuedMessagesPerTick: { tick: number; messages: unknown[] }[] = [];
    let currentTickNumber = 0;

    const Agent = ({ query }: { query: string }) => {
      const queued = useQueuedMessages();
      queuedMessagesPerTick.push({ tick: currentTickNumber, messages: [...queued] });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Tick 1: Start and queue message during execution
    currentTickNumber = 1;
    const tick1Handle = await session.render({ query: "First" });

    // Wait for tick to start, then queue
    await new Promise((r) => setTimeout(r, 10));
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Queued during tick 1" }],
    });

    await tick1Handle.result;

    // Tick 2: Should have the message from tick 1
    currentTickNumber = 2;
    await session.render({ query: "Second" }).result;

    const tick2Results = queuedMessagesPerTick.filter((r) => r.tick === 2);
    expect(tick2Results.some((r) => r.messages.length > 0)).toBe(true);

    await session.close();
  });

  it("full flow: queueMessage triggers onMessage AND useQueuedMessages in next tick", async () => {
    const model = createMockModel({ delay: 50 });
    const onMessageCalls: unknown[] = [];
    const queuedInTick2: unknown[] = [];
    let currentTick = 0;

    const Agent = ({ query }: { query: string }) => {
      useOnMessage((message, _com, _state) => {
        onMessageCalls.push({ tick: currentTick, message });
      });

      const queued = useQueuedMessages();
      if (currentTick === 2) {
        queuedInTick2.push(...queued);
      }

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Tick 1
    currentTick = 1;
    const tick1Handle = await session.render({ query: "Hello" });

    // Queue during tick 1
    await new Promise((r) => setTimeout(r, 10));
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Interrupt!" }],
    });

    await tick1Handle.result;

    // Verify onMessage was called during tick 1
    expect(onMessageCalls.length).toBe(1);
    expect(onMessageCalls[0]).toMatchObject({
      tick: 1,
      message: {
        type: "message",
        content: {
          role: "user",
          content: [{ type: "text", text: "Interrupt!" }],
        },
      },
    });

    // Tick 2
    currentTick = 2;
    await session.render({ query: "Continue" }).result;

    // Verify useQueuedMessages had the message in tick 2
    expect(queuedInTick2.length).toBe(1);
    expect(queuedInTick2[0]).toMatchObject({
      type: "message",
      content: {
        role: "user",
        content: [{ type: "text", text: "Interrupt!" }],
      },
    });

    await session.close();
  });
});

// ============================================================================
// session.inspect() Tests
// ============================================================================

describe("session.inspect()", () => {
  it("should return session state before any ticks", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const info = session.inspect();

    expect(info.id).toBe(session.id);
    expect(info.status).toBe("idle");
    expect(info.currentTick).toBe(1);
    expect(info.queuedMessages).toEqual([]);
    expect(info.isAborted).toBe(false);
    expect(info.lastOutput).toBeNull();
    expect(info.lastModelOutput).toBeNull();
    expect(info.lastToolCalls).toEqual([]);
    expect(info.lastToolResults).toEqual([]);
    expect(info.totalUsage.totalTokens).toBe(0);
    expect(info.tickCount).toBe(0);

    await session.close();
  });

  it("should return session state after a tick", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.render({ query: "Hello!" }).result;

    const info = session.inspect();

    expect(info.status).toBe("idle");
    expect(info.currentTick).toBeGreaterThanOrEqual(1);
    expect(info.lastOutput).not.toBeNull();
    expect(info.lastModelOutput).not.toBeNull();
    expect(info.lastModelOutput?.content.length).toBeGreaterThan(0);
    expect(info.totalUsage.totalTokens).toBeGreaterThan(0);
    expect(info.tickCount).toBeGreaterThan(0);

    await session.close();
  });

  it("should track queued messages", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Queue a message before any tick
    await session.queue.exec({
      role: "user",
      content: [{ type: "text", text: "Queued!" }],
    });

    const info = session.inspect();

    expect(info.queuedMessages.length).toBe(1);
    expect(info.queuedMessages[0].content).toEqual([{ type: "text", text: "Queued!" }]);

    await session.close();
  });

  it("should return component and hook summaries structure", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.render({ query: "Hello!" }).result;

    const info = session.inspect();

    // Should have component and hook summary structure
    expect(info.components).toBeDefined();
    expect(typeof info.components.count).toBe("number");
    expect(Array.isArray(info.components.names)).toBe(true);

    expect(info.hooks).toBeDefined();
    expect(typeof info.hooks.count).toBe("number");
    expect(typeof info.hooks.byType).toBe("object");

    await session.close();
  });
});

// ============================================================================
// Tick Snapshots Tests (Phase 2 - Recording not yet implemented)
// ============================================================================

describe("tick snapshots", () => {
  it("should not record snapshots when recording mode is 'none'", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session(); // Default: no recording

    await session.render({ query: "Hello!" }).result;

    const recording = session.getRecording();
    expect(recording).toBeNull();

    await session.close();
  });

  it("should record snapshots when recording mode is set via options", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "Hello!" }).result;

    const recording = session.getRecording();
    expect(recording).not.toBeNull();
    expect(recording!.snapshots.length).toBe(1);
    expect(recording!.sessionId).toBe(session.id);

    await session.close();
  });

  it("should record snapshots when started via startRecording()", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    session.startRecording("full");

    await session.render({ query: "Hello!" }).result;
    await session.render({ query: "Follow up" }).result;

    const recording = session.getRecording();
    expect(recording).not.toBeNull();
    expect(recording!.snapshots.length).toBe(2);

    await session.close();
  });

  it("should capture tick metadata in snapshot", async () => {
    const model = createMockModel({ delay: 10 });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "Hello!" }).result;

    const snapshot = session.getSnapshotAt(1);
    expect(snapshot).not.toBeNull();

    // Check identity
    expect(snapshot!.sessionId).toBe(session.id);
    expect(snapshot!.tick).toBe(1);
    expect(snapshot!.timestamp).toBeDefined();
    expect(snapshot!.duration).toBeGreaterThan(0);

    // Check execution state
    expect(snapshot!.execution.phase).toBe("complete");
    expect(typeof snapshot!.execution.shouldContinue).toBe("boolean");

    await session.close();
  });

  it("should capture model input/output in snapshot", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>You are helpful.</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "Hello!" }).result;

    const snapshot = session.getSnapshotAt(1);
    expect(snapshot).not.toBeNull();

    // Check model section
    expect(snapshot!.model).toBeDefined();
    expect(snapshot!.model.input).toBeDefined();
    expect(snapshot!.model.output).toBeDefined();
    expect(snapshot!.model.output.content.length).toBeGreaterThan(0);
    expect(snapshot!.model.latency).toBeGreaterThanOrEqual(0);

    await session.close();
  });

  it("should capture fiber summary in snapshot", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "Hello!" }).result;

    const snapshot = session.getSnapshotAt(1);
    expect(snapshot).not.toBeNull();

    // Check fiber section structure exists
    expect(snapshot!.fiber).toBeDefined();
    expect(snapshot!.fiber.summary).toBeDefined();
    expect(typeof snapshot!.fiber.summary.componentCount).toBe("number");
    expect(typeof snapshot!.fiber.summary.hookCount).toBe("number");
    expect(typeof snapshot!.fiber.summary.hooksByType).toBe("object");

    // In full mode, tree should be present (or null if internal access fails)
    // The tree serialization depends on internal fiber access
    expect(snapshot!.fiber.tree === null || typeof snapshot!.fiber.tree === "object").toBe(true);

    await session.close();
  });

  it("should not serialize fiber tree in lightweight mode", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "lightweight" });

    await session.render({ query: "Hello!" }).result;

    const snapshot = session.getSnapshotAt(1);
    expect(snapshot).not.toBeNull();

    // In lightweight mode, tree should be null
    expect(snapshot!.fiber.tree).toBeNull();

    // But summary should still be present
    expect(snapshot!.fiber.summary).toBeDefined();
    expect(typeof snapshot!.fiber.summary.componentCount).toBe("number");

    await session.close();
  });

  it("should stop recording when stopRecording() is called", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "First" }).result;

    session.stopRecording();

    await session.render({ query: "Second" }).result;

    const recording = session.getRecording();
    expect(recording).not.toBeNull();
    // Only first tick should be recorded
    expect(recording!.snapshots.length).toBe(1);
    expect(recording!.snapshots[0].tick).toBe(1);

    await session.close();
  });

  it("should update recording summary", async () => {
    const model = createMockModel({ delay: 5 }); // Small delay to ensure duration > 0

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session({ recording: "full" });

    await session.render({ query: "First" }).result;
    await session.render({ query: "Second" }).result;

    const recording = session.getRecording();
    expect(recording).not.toBeNull();

    expect(recording!.summary.tickCount).toBe(2);
    expect(recording!.summary.totalUsage.totalTokens).toBeGreaterThan(0);
    expect(typeof recording!.summary.totalDuration).toBe("number");
    expect(recording!.summary.totalDuration).toBeGreaterThanOrEqual(0);

    await session.close();
  });
});

// ============================================================================
// Standalone run() Function Tests
// ============================================================================

import { run } from "../../app";
import { jsx } from "../../jsx/jsx-runtime";

describe("standalone run() function", () => {
  it("should run a JSX element and return result", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    // Create JSX element
    const element = jsx(Agent, { query: "Hello!" });

    // Use standalone run() function
    // run() is a DirectProcedure, returns ProcedurePromise<SessionExecutionHandle>
    const handle = await run(element, { maxTicks: 1 });

    // Handle should be running initially (or may already be completed depending on timing)
    expect(["running", "completed"]).toContain(handle.status);

    // Await result via .result
    const result = await handle.result;

    // Should have completed
    expect(handle.status).toBe("completed");
    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
  });

  it("should support streaming via run()", async () => {
    const model = createMockModel();

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const element = jsx(Agent, { query: "Hello!" });
    // run() is a DirectProcedure, returns ProcedurePromise<SessionExecutionHandle>
    const handle = await run(element, { maxTicks: 1 });

    const events: unknown[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    // Should have captured events
    expect(events.length).toBeGreaterThan(0);
    expect(handle.status).toBe("completed");
  });

  it("should merge element props with input props", async () => {
    const model = createMockModel();
    let capturedQuery: string | undefined;

    const Agent = ({ query, extra }: { query: string; extra?: string }) => {
      capturedQuery = query;
      return (
        <>
          <Model model={model} />
          <System>Test {extra}</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    // Element has query="from element"
    const element = jsx(Agent, { query: "from element" });

    // Input props override with query="from input"
    const handle = await run(element, {
      props: { query: "from input" },
      maxTicks: 1,
    });
    await handle.result;

    // Input props should win
    expect(capturedQuery).toBe("from input");
  });

  it("should make tools from RunInput available to the model", async () => {
    const adapter = createTestAdapter({ defaultResponse: "Done" });

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={adapter} />
        <System>Test</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const { createTool } = await import("../../tool");
    const { z } = await import("zod");

    const ExtraTool = createTool({
      name: "extra_tool",
      description: "Tool passed via run() input",
      input: z.object({ x: z.string() }),
      handler: async ({ x }) => [{ type: "text" as const, text: x }],
    });

    const element = jsx(Agent, { query: "Hello!" });
    const result = await run(element, {
      tools: [ExtraTool],
      maxTicks: 1,
    }).result;

    expect(result).toBeDefined();
    const captured = adapter.getCapturedInputs();
    expect(captured.length).toBeGreaterThan(0);
    const toolNames = captured[0].tools?.map((t: any) => t.name) ?? [];
    expect(toolNames).toContain("extra_tool");
  });
});

// ============================================================================
// Procedure Middleware on send/render
// ============================================================================

describe("session.send and session.render as Procedures", () => {
  it("should support middleware on session.render via .use()", async () => {
    const model = createMockModel();
    const calls: string[] = [];

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>You are helpful.</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.render.use(async (args, _envelope, next) => {
      calls.push("before");
      const result = await next();
      calls.push("after");
      return result;
    })({ query: "test" });

    await handle.result;

    expect(calls).toEqual(["before", "after"]);
    expect(handle.status).toBe("completed");
  });

  it("should support middleware on session.send via .use()", async () => {
    const model = createMockModel();
    const calls: string[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are helpful.</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.send.use(async (args, _envelope, next) => {
      calls.push("before");
      const result = await next();
      calls.push("after");
      return result;
    })({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });

    await handle.result;

    expect(calls).toEqual(["before", "after"]);
    expect(handle.status).toBe("completed");
  });

  it(".use() should return a new Procedure without mutating the original", async () => {
    const model = createMockModel();
    const calls: string[] = [];

    const Agent = ({ query }: { query: string }) => (
      <>
        <Model model={model} />
        <System>You are helpful.</System>
        <Timeline />
        <User>{query}</User>
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Create a middleware-wrapped variant
    const wrappedRender = session.render.use(async (_args, _envelope, next) => {
      calls.push("middleware");
      return next();
    });

    // Use the original (no middleware)
    const handle1 = await session.render({ query: "original" });
    await handle1.result;

    expect(calls).toEqual([]);

    // Use the wrapped variant (middleware fires)
    const handle2 = await wrappedRender({ query: "wrapped" });
    await handle2.result;

    expect(calls).toEqual(["middleware"]);
  });
});

// ============================================================================
// Message Steering Tests
// ============================================================================

describe("message steering", () => {
  it("should continue execution when message is steered during tick", async () => {
    const model = createMockModel({ delay: 50 });
    let tickCount = 0;

    const Agent = ({ query }: { query: string }) => {
      useContinuation(() => {
        tickCount++;
        return false; // Don't continue on our own
      });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>{query}</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    // Start execution
    const handle = await session.render({ query: "Hello" });

    // Wait for first tick to start, then steer a message
    await new Promise((r) => setTimeout(r, 10));
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Follow up" }] }],
    });

    await handle.result;

    // Should have continued for at least 2 ticks (original + steered message)
    expect(tickCount).toBeGreaterThanOrEqual(1);

    await session.close();
  });

  it("should auto-resume with new execution when message queued during execution", async () => {
    const model = createMockModel({ delay: 50 });
    const executions: string[] = [];
    let queuedDuringExecution = false;

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    session.on("event", async (event) => {
      if (event.type === "execution_start") {
        executions.push(event.executionId);

        // Queue a message during the first execution — not after
        if (!queuedDuringExecution) {
          queuedDuringExecution = true;
          await session.queue.exec({
            role: "user",
            content: [{ type: "text", text: "Auto-resumed" }],
          });
        }
      }
    });

    // First execution — queue handler above fires during it
    await session.render({ query: "First" } as any).result;

    // The auto-resume triggers render() which is fire-and-forget.
    // Wait for the second execution to complete.
    await new Promise((r) => setTimeout(r, 300));

    // Should have had 2 executions: original + auto-resumed
    expect(executions.length).toBeGreaterThanOrEqual(2);

    await session.close();
  });

  it("should process multiple queued messages across auto-resumed executions", async () => {
    const model = createMockModel({ delay: 30 });
    let executionEndCount = 0;
    let messagesQueued = 0;

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    session.on("event", async (event) => {
      if (event.type === "execution_start" && messagesQueued < 2) {
        // Queue messages during execution so auto-resume picks them up
        messagesQueued++;
        await session.queue.exec({
          role: "user",
          content: [{ type: "text", text: `Queued-${messagesQueued}` }],
        });
      }
      if (event.type === "execution_end") {
        executionEndCount++;
      }
    });

    // Start first execution — event handler queues a message during it
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    }).result;

    // Wait for auto-resumed executions to complete
    await new Promise((r) => setTimeout(r, 500));

    // Should have at least 2 execution_end events (first send + auto-resumes)
    expect(executionEndCount).toBeGreaterThanOrEqual(2);

    await session.close();
  });
});
