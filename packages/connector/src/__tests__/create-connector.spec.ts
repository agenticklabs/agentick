import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockClient, makeEvent } from "@agentick/client/testing";
import type { StreamEvent } from "@agentick/shared";
import type {
  ConnectorPlatform,
  ConnectorBridge,
  ConnectorOutput,
  ConnectorStatusEvent,
} from "../types.js";
import { createConnector } from "../create-connector.js";

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

function executionStart(): StreamEvent {
  return { ...makeEvent("execution_start"), type: "execution_start" } as StreamEvent;
}

function executionEnd(): StreamEvent {
  return {
    ...makeEvent("execution_end"),
    type: "execution_end",
    output: { timeline: [] },
    newTimelineEntries: [],
  } as unknown as StreamEvent;
}

function createSpyPlatform() {
  let _bridge: ConnectorBridge | null = null;

  const platform: ConnectorPlatform & {
    bridge: ConnectorBridge | null;
    startCalled: boolean;
    stopCalled: boolean;
  } = {
    bridge: null,
    startCalled: false,
    stopCalled: false,
    async start(b) {
      _bridge = b;
      platform.bridge = b;
      platform.startCalled = true;
      b.reportStatus("connected");
    },
    async stop() {
      platform.stopCalled = true;
    },
  };

  return platform;
}

describe("createConnector", () => {
  let client: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires platform to session end-to-end", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
    });

    await connector.start();
    expect(platform.startCalled).toBe(true);
    expect(platform.bridge).not.toBeNull();

    // Track deliveries via platform bridge
    const deliveries: ConnectorOutput[] = [];
    platform.bridge!.onDeliver((output) => {
      deliveries.push(output);
    });

    // Simulate content flowing through
    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].messages).toHaveLength(1);

    await connector.stop();
    expect(platform.stopCalled).toBe(true);
  });

  it("wires pre-start onStatus listeners to the session", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    // Register listener BEFORE start
    const events: ConnectorStatusEvent[] = [];
    const unsub = connector.onStatus((e) => events.push(e));

    await connector.start();
    // createSpyPlatform calls bridge.reportStatus("connected") during start
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("connected");

    // Further status changes also reach the pre-start listener
    platform.bridge!.reportStatus("error", new Error("oops"));
    expect(events).toHaveLength(2);
    expect(events[1].status).toBe("error");

    unsub();
    platform.bridge!.reportStatus("connected");
    expect(events).toHaveLength(2); // unsubscribed

    await connector.stop();
  });

  it("propagates status from platform through connector handle", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    expect(connector.status).toBe("disconnected");

    await connector.start();
    expect(connector.status).toBe("connected");

    const events: ConnectorStatusEvent[] = [];
    connector.onStatus((e) => events.push(e));

    // Platform reports error via bridge
    platform.bridge!.reportStatus("error", new Error("connection lost"));
    expect(connector.status).toBe("error");
    expect(events).toHaveLength(1);
    expect(events[0].error?.message).toBe("connection lost");

    await connector.stop();
  });

  it("reports error status and rethrows on platform start failure", async () => {
    const failingPlatform: ConnectorPlatform = {
      async start() {
        throw new Error("bot token invalid");
      },
      async stop() {},
    };

    const connector = createConnector(client, failingPlatform, { sessionId: "s1" });

    await expect(connector.start()).rejects.toThrow("bot token invalid");
    expect(connector.status).toBe("disconnected");
  });

  it("fans out execution lifecycle events to platform", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    await connector.start();

    const starts: number[] = [];
    const ends: number[] = [];
    platform.bridge!.onExecutionStart(() => starts.push(1));
    platform.bridge!.onExecutionEnd(() => ends.push(1));

    client._emitSessionEvent("s1", executionStart());
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);

    client._emitSessionEvent("s1", executionEnd());
    expect(ends).toHaveLength(1);

    await connector.stop();
  });

  it("platform can send messages via bridge", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    await connector.start();

    platform.bridge!.send("Hello from platform");

    const accessor = client.getAccessor("s1");
    expect(accessor.send).toHaveBeenCalledWith({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello from platform" }] }],
    });

    await connector.stop();
  });

  it("platform can abort execution via bridge", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    await connector.start();

    platform.bridge!.abort("user cancelled");

    const accessor = client.getAccessor("s1");
    expect(accessor.abort).toHaveBeenCalledWith("user cancelled");

    await connector.stop();
  });

  it("cleans up session on stop", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    await connector.start();

    const deliveries: ConnectorOutput[] = [];
    platform.bridge!.onDeliver(async (output) => {
      deliveries.push(await output);
    });

    await connector.stop();

    // Events after stop should not trigger delivery
    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Ghost"));
    client._emitSessionEvent("s1", executionEnd());

    expect(deliveries).toHaveLength(0);
    expect(connector.status).toBe("disconnected");
  });

  it("retries failed deliveries with configured retry policy", async () => {
    const platform = createSpyPlatform();
    const onExhausted = vi.fn();
    const connector = createConnector(client, platform, {
      sessionId: "s1",
      deliveryStrategy: "immediate",
      retry: { maxAttempts: 2, baseDelay: 100, onExhausted },
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await connector.start();

    let attempt = 0;
    platform.bridge!.onDeliver(async () => {
      attempt++;
      throw new Error("delivery failed");
    });

    client._emitSessionEvent("s1", executionStart());
    client._emitSessionEvent("s1", contentEvent("Hello!"));
    expect(attempt).toBe(1);

    // First retry after 100ms
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toBe(2);

    // Exhausted
    expect(onExhausted).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
    await connector.stop();
  });

  it("handles rapid start/stop without errors", async () => {
    const platform = createSpyPlatform();
    const connector = createConnector(client, platform, { sessionId: "s1" });

    await connector.start();
    await connector.stop();
    expect(connector.status).toBe("disconnected");

    // Can restart
    await connector.start();
    expect(connector.status).toBe("connected");
    await connector.stop();
  });
});
