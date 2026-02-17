import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { AgentickProvider } from "@agentick/react";
import type {
  AgentickClient,
  ConnectionState,
  SessionStreamEvent,
  StreamingTextState,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
} from "@agentick/client";
import { Chat } from "./chat.js";
import { flush, waitFor } from "../testing.js";

// ============================================================================
// Mock Client — supports both global and accessor-level event routing
// ============================================================================

function createMockClient() {
  const eventHandlers = new Set<(event: SessionStreamEvent) => void>();
  const stateHandlers = new Set<(state: ConnectionState) => void>();
  const streamingTextHandlers = new Set<(state: StreamingTextState) => void>();
  let state: ConnectionState = "disconnected";
  let streamingTextState: StreamingTextState = { text: "", isStreaming: false };

  // Per-accessor storage
  const accessorEventHandlers = new Map<string, Set<(event: any) => void>>();
  const accessorToolHandlers = new Map<
    string,
    Set<(request: ToolConfirmationRequest, respond: (r: ToolConfirmationResponse) => void) => void>
  >();
  const accessors = new Map<string, any>();

  const emitStreamingText = (newState: StreamingTextState) => {
    streamingTextState = newState;
    for (const handler of streamingTextHandlers) {
      handler(newState);
    }
  };

  const createHandle = () =>
    ({
      sessionId: "test-session",
      executionId: "exec-1",
      status: "completed",
      result: Promise.resolve({
        response: "ok",
        outputs: {},
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
      abort: vi.fn(),
      queueMessage: vi.fn(),
      submitToolResult: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    }) as any;

  const getOrCreateAccessor = (id: string) => {
    if (accessors.has(id)) return accessors.get(id)!;

    if (!accessorEventHandlers.has(id)) {
      accessorEventHandlers.set(id, new Set());
    }
    if (!accessorToolHandlers.has(id)) {
      accessorToolHandlers.set(id, new Set());
    }

    const accessor = {
      sessionId: id,
      isSubscribed: false,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      send: vi.fn(() => createHandle()),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      submitToolResult: vi.fn(),
      onEvent: vi.fn((handler: (event: any) => void) => {
        accessorEventHandlers.get(id)!.add(handler);
        return () => accessorEventHandlers.get(id)!.delete(handler);
      }),
      onResult: vi.fn(() => () => {}),
      onToolConfirmation: vi.fn(
        (
          handler: (
            request: ToolConfirmationRequest,
            respond: (r: ToolConfirmationResponse) => void,
          ) => void,
        ) => {
          accessorToolHandlers.get(id)!.add(handler);
          return () => accessorToolHandlers.get(id)!.delete(handler);
        },
      ),
      channel: vi.fn((name: string) => ({
        name,
        subscribe: vi.fn(() => () => {}),
        publish: vi.fn(async () => {}),
        request: vi.fn(async () => ({})),
      })),
    } as any;

    accessors.set(id, accessor);
    return accessor;
  };

  const client = {
    _emitEvent(event: any, sessionId = "main") {
      const withSession: SessionStreamEvent = { sessionId, ...event };

      // Update streaming text state
      switch (event.type) {
        case "tick_start":
          emitStreamingText({ text: "", isStreaming: true });
          break;
        case "content_delta":
          emitStreamingText({
            text: streamingTextState.text + event.delta,
            isStreaming: true,
          });
          break;
        case "tick_end":
        case "execution_end":
          emitStreamingText({ text: streamingTextState.text, isStreaming: false });
          break;
      }

      // Fan out to global handlers
      for (const handler of eventHandlers) {
        handler(withSession);
      }

      // Fan out to accessor-level handlers (used by ChatSession via useChat)
      const handlers = accessorEventHandlers.get(sessionId);
      if (handlers) {
        for (const handler of handlers) {
          handler(event);
        }
      }
    },

    _triggerToolConfirmation(
      request: ToolConfirmationRequest,
      sessionId = "main",
    ): Promise<ToolConfirmationResponse> {
      return new Promise((resolve) => {
        const handlers = accessorToolHandlers.get(sessionId);
        if (handlers) {
          for (const handler of handlers) {
            handler(request, resolve);
          }
        }
      });
    },

    get state() {
      return state;
    },
    get streamingText() {
      return streamingTextState;
    },

    send: vi.fn(() => createHandle()),
    abort: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    session: vi.fn((id: string) => getOrCreateAccessor(id)),
    subscribe: vi.fn((id: string) => {
      const acc = getOrCreateAccessor(id);
      acc.subscribe();
      return acc;
    }),

    onEvent(handler: (event: SessionStreamEvent) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onConnectionChange(handler: (s: ConnectionState) => void) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    onStreamingText(handler: (s: StreamingTextState) => void) {
      streamingTextHandlers.add(handler);
      handler(streamingTextState);
      return () => streamingTextHandlers.delete(handler);
    },
    clearStreamingText() {
      emitStreamingText({ text: "", isStreaming: false });
    },
    on: vi.fn(() => () => {}),
    destroy: vi.fn(),
  };

  return client as typeof client & AgentickClient;
}

// ============================================================================
// Tests
// ============================================================================

describe("Chat", () => {
  it("renders the default status bar", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Enter");
    expect(frame).toContain("send");
    expect(frame).toContain("idle");
  });

  it("hides status bar when statusBar={false}", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" statusBar={false} />
      </AgentickProvider>,
    );
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Type a message...");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("Enter");
  });

  it("renders custom status bar via render prop", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" statusBar={({ mode }) => <Text>custom-{mode}</Text>} />
      </AgentickProvider>,
    );
    await flush();

    expect(lastFrame()!).toContain("custom-idle");
  });

  it("renders static custom status bar node", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" statusBar={<Text>my-footer</Text>} />
      </AgentickProvider>,
    );
    await flush();

    expect(lastFrame()!).toContain("my-footer");
  });

  it("renders input bar in idle state", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );
    await flush();

    expect(lastFrame()!).toContain("Type a message...");
  });

  it("shows tool confirmation prompt when tool_confirmation event arrives", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    // Wait for Chat to fully mount
    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    // Start execution so chatMode becomes "streaming"
    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    // Trigger tool confirmation
    client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => {
      const frame = lastFrame()!;
      expect(frame).toContain("delete_file");
      expect(frame).toContain("[Y] Approve");
    });
  });

  it("tool confirmation Y key approves and returns to streaming", async () => {
    const client = createMockClient();
    const { lastFrame, stdin } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    // Start execution
    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    // Trigger tool confirmation
    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    // Press Y — routed by Chat's centralized useInput
    stdin.write("y");

    const response = await responsePromise;
    expect(response.approved).toBe(true);

    // Prompt should be gone
    await waitFor(() => {
      expect(lastFrame()!).not.toContain("[Y] Approve");
    });
  });

  it("tool confirmation N key rejects", async () => {
    const client = createMockClient();
    const { stdin, lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    stdin.write("n");

    const response = await responsePromise;
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("rejected by user");
  });

  it("typing text and pressing Enter rejects with that text as reason", async () => {
    const client = createMockClient();
    const { stdin, lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    // Type feedback text — first char "d" is not y/n/a, goes to editor
    stdin.write("don't delete that");
    await flush();

    // Submit with Enter
    stdin.write("\r");

    const response = await responsePromise;
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("don't delete that");
  });

  it("Enter on empty editor during confirmation is a no-op", async () => {
    const client = createMockClient();
    const { stdin, lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    // Press Enter with empty editor — should NOT reject
    stdin.write("\r");
    await flush();

    // Confirmation prompt should still be visible
    expect(lastFrame()!).toContain("[Y] Approve");
  });

  it("Y key during confirmation does NOT leak into input bar", async () => {
    const client = createMockClient();
    const { stdin, lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );

    await waitFor(() => expect(lastFrame()!).toContain("idle"));

    // Start execution
    client._emitEvent({ type: "execution_start", timestamp: Date.now() });
    await flush();

    // Trigger confirmation
    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    await waitFor(() => expect(lastFrame()!).toContain("[Y] Approve"));

    // Press Y to approve
    stdin.write("y");
    await responsePromise;

    // End execution to return to idle
    client._emitEvent({ type: "execution_end", timestamp: Date.now() });
    await flush();

    await waitFor(() => {
      const frame = lastFrame()!;
      // The "y" should NOT appear in the input bar
      expect(frame).toContain("Type a message...");
    });
  });
});
