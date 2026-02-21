/**
 * AgentickClient Tests (unified session architecture)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentickClient } from "../client.js";

function createMockEventSourceClass() {
  let instance: MockEventSourceInstance | null = null;

  interface MockEventSourceInstance {
    close: ReturnType<typeof vi.fn>;
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
    _triggerMessage: (data: unknown) => void;
    _triggerError: () => void;
  }

  class MockEventSource {
    private onmessage: ((event: MessageEvent) => void) | null = null;
    private onerror: (() => void) | null = null;

    close = vi.fn();

    constructor(_url: string, _init?: { withCredentials?: boolean }) {
      instance = this as unknown as MockEventSourceInstance;
    }

    addEventListener(type: string, listener: EventListener) {
      if (type === "message") this.onmessage = listener as (e: MessageEvent) => void;
      if (type === "error") this.onerror = listener as () => void;
    }

    removeEventListener(_type: string, _listener: EventListener) {}

    _triggerMessage(data: unknown) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
    }

    _triggerError() {
      this.onerror?.();
    }
  }

  return {
    MockEventSource,
    getInstance: () => instance!,
  };
}

type FetchMock = ReturnType<typeof vi.fn> &
  ((input: string | URL | Request, init?: RequestInit) => Promise<Response>);

function createMockFetch() {
  return vi.fn() as FetchMock;
}

function createSuccessResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createSSEResponse(events: unknown[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("AgentickClient", () => {
  let mockESClass: ReturnType<typeof createMockEventSourceClass>;
  let mockFetch: ReturnType<typeof createMockFetch>;
  let client: AgentickClient;

  beforeEach(() => {
    mockESClass = createMockEventSourceClass();
    mockFetch = createMockFetch();

    client = new AgentickClient({
      baseUrl: "https://api.example.com",
      fetch: mockFetch as any,
      EventSource: mockESClass.MockEventSource as any,
    });
  });

  afterEach(() => {
    client.destroy();
  });

  const getMockES = () => mockESClass.getInstance();

  it("subscribes and opens SSE connection", async () => {
    mockFetch.mockResolvedValueOnce(createSuccessResponse({ success: true }));

    const session = client.subscribe("conv-123");
    expect(session.isSubscribed).toBe(true);

    getMockES()._triggerMessage({
      type: "connection",
      connectionId: "conn-123",
      subscriptions: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.state).toBe("connected");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          connectionId: "conn-123",
          add: ["conv-123"],
        }),
      }),
    );
  });

  it("send returns handle and resolves result", async () => {
    const events = [
      {
        type: "execution_start",
        executionId: "exec-1",
        sessionId: "conv-1",
      },
      {
        type: "content_delta",
        delta: "Hello",
        sessionId: "conv-1",
      },
      {
        type: "result",
        sessionId: "conv-1",
        result: {
          response: "Hello",
          outputs: {},
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
      {
        type: "execution_end",
        executionId: "exec-1",
        sessionId: "conv-1",
      },
    ];

    mockFetch.mockResolvedValueOnce(createSSEResponse(events));

    const handle = client.send("Hello!");
    const result = await handle.result;

    expect(result.response).toBe("Hello");
  });

  it("session accessor sends with sessionId", async () => {
    const events = [
      { type: "execution_start", executionId: "exec-2", sessionId: "conv-2" },
      { type: "content_delta", delta: "Hi!", sessionId: "conv-2" },
      {
        type: "result",
        sessionId: "conv-2",
        result: {
          response: "Hi!",
          outputs: {},
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
      { type: "execution_end", executionId: "exec-2", sessionId: "conv-2" },
    ];

    mockFetch.mockResolvedValueOnce(createSSEResponse(events));

    const session = client.session("conv-2");
    const handle = session.send({
      message: { role: "user", content: [{ type: "text", text: "Hi" }] },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/send",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const callArgs = mockFetch.mock.calls[0];
    const bodyJSON = JSON.parse(callArgs[1].body as string);
    expect(bodyJSON.sessionId).toBe("conv-2");
    expect(bodyJSON.message.role).toBe("user");

    // Ensure execution completes properly
    await handle.result;
  });

  it("onEvent receives multiplexed events", async () => {
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    client.subscribe("conv-1");
    getMockES()._triggerMessage({
      type: "connection",
      connectionId: "conn-123",
      subscriptions: [],
    });

    getMockES()._triggerMessage({ type: "tick_start", tick: 1, sessionId: "conv-1" });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(1);
    expect((events[0] as any).sessionId).toBe("conv-1");
  });

  it("dedupes duplicate stream events by id", async () => {
    mockFetch.mockResolvedValueOnce(createSuccessResponse({ success: true }));

    client.subscribe("conv-1");
    getMockES()._triggerMessage({
      type: "connection",
      connectionId: "conn-123",
      subscriptions: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = {
      type: "content_delta",
      id: "evt-1",
      sequence: 1,
      tick: 1,
      timestamp: new Date().toISOString(),
      sessionId: "conv-1",
      blockType: "text",
      blockIndex: 0,
      delta: "Hi",
    };

    getMockES()._triggerMessage(event);
    getMockES()._triggerMessage(event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.streamingText.text).toBe("Hi");
  });
});
