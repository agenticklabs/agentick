import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockClient, makeEvent } from "@agentick/client/testing";
import type { StreamEvent, ContentBlock } from "@agentick/shared";
import type { ConnectorOutput, ConnectorStatusEvent } from "../types.js";
import { ConnectorSession } from "../connector-session.js";

type MockClient = ReturnType<typeof createMockClient>;

function contentEvent(text: string): StreamEvent {
  return {
    ...makeEvent("message"),
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  } as unknown as StreamEvent;
}

function toolOnlyEvent(name: string): StreamEvent {
  return {
    ...makeEvent("message"),
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", toolUseId: `tu_${name}`, name, input: {} }],
    },
  } as unknown as StreamEvent;
}

function executionStart(): StreamEvent {
  return { ...makeEvent("execution_start"), type: "execution_start" } as StreamEvent;
}

function executionEnd(text?: string): StreamEvent {
  const timeline = text ? [{ role: "assistant", content: [{ type: "text", text }] }] : [];
  return {
    ...makeEvent("execution_end"),
    type: "execution_end",
    output: { timeline },
    newTimelineEntries: timeline,
  } as unknown as StreamEvent;
}

describe("ConnectorSession", () => {
  let client: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers messages on idle by default", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    // Emit a message event, then execution_end
    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(deliveries).toHaveLength(0); // on-idle: not yet

    client._emitSessionEvent("s1", executionEnd());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].isComplete).toBe(true);

    session.destroy();
  });

  it("delivers immediately with immediate strategy", () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(deliveries).toHaveLength(1);

    session.destroy();
  });

  it("delivers after debounce with debounced strategy", () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "debounced",
      debounceMs: 500,
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(deliveries).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(deliveries).toHaveLength(1);

    session.destroy();
  });

  it("applies text-only content policy by default", () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    // Message with both text and tool blocks
    const event = {
      ...makeEvent("message"),
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here's what I found" },
          { type: "tool_use", toolUseId: "tu_1", name: "shell", input: {} },
        ],
      },
    } as unknown as StreamEvent;

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", event);
    expect(deliveries).toHaveLength(1);

    const content = deliveries[0].messages[0].content as ContentBlock[];
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string; text: string }).text).toBe("Here's what I found");

    session.destroy();
  });

  it("delivers isComplete when content filter drops all messages", () => {
    // This tests the fix: when content filter removes all blocks but
    // execution is complete, isComplete: true must still be delivered.
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      contentPolicy: "text-only", // will drop tool-only messages
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    client._emitSessionEvent("s1", executionStart());
    // Send only tool blocks — text-only filter will drop all content
    client._emitSessionEvent("s1", toolOnlyEvent("shell"));
    // No delivery yet (on-idle strategy)
    expect(deliveries).toHaveLength(0);

    client._emitSessionEvent("s1", executionEnd());
    // Must deliver even with empty messages, because isComplete is true
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].isComplete).toBe(true);
    expect(deliveries[0].messages).toHaveLength(0);

    session.destroy();
  });

  it("does not deliver filtered-empty while execution is running", () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      contentPolicy: "text-only",
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    client._emitSessionEvent("s1", executionStart());
    // Tool-only message — should be dropped, not delivered as empty
    client._emitSessionEvent("s1", toolOnlyEvent("shell"));
    expect(deliveries).toHaveLength(0);

    session.destroy();
  });

  it("sends messages through the client", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    session.send("Hello agent!");

    const accessor = client.getAccessor("s1");
    expect(accessor.send).toHaveBeenCalledWith({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello agent!" }] }],
    });

    session.destroy();
  });

  it("rate limits inbound messages", () => {
    const onLimited = vi.fn(() => "Too fast!");
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      rateLimit: { maxPerMinute: 1, onLimited },
    });

    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    session.send("First"); // Allowed
    session.send("Second"); // Rate limited

    const accessor = client.getAccessor("s1");
    expect(accessor.send).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].messages[0].content).toBe("Too fast!");

    session.destroy();
  });

  it("forwards tool confirmations", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const confirmations: Array<{ request: any; respond: any }> = [];
    session.onConfirmation((request, respond) => {
      confirmations.push({ request, respond });
    });

    const respond = vi.fn();
    client._emitToolConfirmation(
      "s1",
      { toolUseId: "tu_1", name: "shell", arguments: { command: "rm -rf /" } },
      respond,
    );

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].request.name).toBe("shell");

    session.destroy();
  });

  it("subscribes to the session by default", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const accessor = client.getAccessor("s1");
    expect(accessor.subscribe).toHaveBeenCalled();
    session.destroy();
  });

  it("respects autoSubscribe: false", () => {
    const client2 = createMockClient();
    const session = new ConnectorSession(client2, {
      sessionId: "s1",
      autoSubscribe: false,
    });
    const accessor = client2.getAccessor("s1");
    expect(accessor.subscribe).not.toHaveBeenCalled();
    session.destroy();
  });

  it("unsubscribes listeners on destroy", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    session.destroy();

    // Events after destroy should not trigger delivery
    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Ghost"));
    client._emitSessionEvent("s1", executionEnd());

    expect(deliveries).toHaveLength(0);
  });

  it("uses custom tool summarizer with summarized policy", () => {
    const customSummarizer = vi.fn(
      (name: string, _input: Record<string, unknown>) => `[Custom: ${name}]`,
    );
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      contentPolicy: "summarized",
      toolSummarizer: customSummarizer,
    });
    const deliveries: ConnectorOutput[] = [];
    session.onDeliver((output) => deliveries.push(output));

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", toolOnlyEvent("my_custom_tool"));

    expect(deliveries).toHaveLength(1);
    const content = deliveries[0].messages[0].content as ContentBlock[];
    expect((content[0] as { text: string }).text).toBe("[Custom: my_custom_tool]");
    expect(customSummarizer).toHaveBeenCalledWith("my_custom_tool", {});

    session.destroy();
  });

  // --- Status reporting ---

  it("starts with disconnected status", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    expect(session.status).toBe("disconnected");
    session.destroy();
  });

  it("tracks status changes via reportStatus", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const events: ConnectorStatusEvent[] = [];
    session.onStatus((e) => events.push(e));

    session.reportStatus("connecting");
    expect(session.status).toBe("connecting");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ status: "connecting" });

    session.reportStatus("connected");
    expect(session.status).toBe("connected");
    expect(events).toHaveLength(2);

    session.destroy();
  });

  it("includes error in status event", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const events: ConnectorStatusEvent[] = [];
    session.onStatus((e) => events.push(e));

    const err = new Error("connection lost");
    session.reportStatus("error", err);
    expect(events[0]).toEqual({ status: "error", error: err });

    session.destroy();
  });

  it("unsubscribes status listeners", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const events: ConnectorStatusEvent[] = [];
    const unsub = session.onStatus((e) => events.push(e));

    session.reportStatus("connecting");
    expect(events).toHaveLength(1);

    unsub();
    session.reportStatus("connected");
    expect(events).toHaveLength(1);

    session.destroy();
  });

  // --- Execution lifecycle ---

  it("fires execution start/end listeners", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const starts: number[] = [];
    const ends: number[] = [];

    session.onExecutionStart(() => starts.push(Date.now()));
    session.onExecutionEnd(() => ends.push(Date.now()));

    client._emitSessionEvent("s1", executionStart());
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);

    client._emitSessionEvent("s1", executionEnd());
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    session.destroy();
  });

  it("unsubscribes execution lifecycle listeners", () => {
    const session = new ConnectorSession(client, { sessionId: "s1" });
    const starts: number[] = [];

    const unsub = session.onExecutionStart(() => starts.push(1));
    client._emitSessionEvent("s1", executionStart());
    expect(starts).toHaveLength(1);

    unsub();
    client._emitSessionEvent("s1", executionEnd());
    client._emitSessionEvent("s1", executionStart());
    expect(starts).toHaveLength(1);

    session.destroy();
  });

  // --- Delivery retry ---

  it("retries failed async delivery with exponential backoff", async () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 3, baseDelay: 100 },
    });

    let attempt = 0;
    session.onDeliver(async () => {
      attempt++;
      if (attempt < 3) throw new Error("transient failure");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(attempt).toBe(1);

    // Flush microtask (promise rejection) + advance timer (100ms retry delay)
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toBe(2);

    // Flush microtask + advance timer (200ms retry delay)
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt).toBe(3);

    session.destroy();
  });

  it("calls onExhausted after all retries fail", async () => {
    const onExhausted = vi.fn();
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 2, baseDelay: 50, onExhausted },
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    session.onDeliver(async () => {
      throw new Error("permanent failure");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));

    // Flush microtask (rejection) + advance timer (50ms) + flush microtask (second rejection)
    await vi.advanceTimersByTimeAsync(50);

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ isComplete: false }),
    );

    consoleSpy.mockRestore();
    session.destroy();
  });

  it("retries sync delivery errors", () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 2, baseDelay: 100 },
    });

    let attempt = 0;
    session.onDeliver(() => {
      attempt++;
      if (attempt === 1) throw new Error("sync failure");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(attempt).toBe(1);

    vi.advanceTimersByTime(100);
    expect(attempt).toBe(2);

    session.destroy();
  });

  it("cancels pending retry timers on destroy", async () => {
    const onExhausted = vi.fn();
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 3, baseDelay: 100, onExhausted },
    });

    session.onDeliver(async () => {
      throw new Error("fail");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));

    // First attempt failed, retry timer is pending
    session.destroy();

    // Advance past where retry would fire
    await vi.advanceTimersByTimeAsync(500);

    // onExhausted should never be called — timers were cleared
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("caps retry delay at maxDelay", async () => {
    const session = new ConnectorSession(client, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 5, baseDelay: 1000, maxDelay: 2000 },
    });

    let attempt = 0;
    session.onDeliver(async () => {
      attempt++;
      if (attempt < 5) throw new Error("fail");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));

    // attempt 1 fails → delay = min(1000*2^0, 2000) = 1000
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toBe(2);

    // attempt 2 fails → delay = min(1000*2^1, 2000) = 2000
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toBe(3);

    // attempt 3 fails → delay = min(1000*2^2, 2000) = 2000 (capped)
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toBe(4);

    session.destroy();
  });
});
