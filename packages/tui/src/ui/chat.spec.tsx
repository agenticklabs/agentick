import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
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
// Mock Client (mirrors the pattern from @agentick/react tests)
// ============================================================================

function createMockClient() {
  const eventHandlers = new Set<(event: SessionStreamEvent) => void>();
  const stateHandlers = new Set<(state: ConnectionState) => void>();
  const streamingTextHandlers = new Set<(state: StreamingTextState) => void>();
  let state: ConnectionState = "disconnected";
  let streamingTextState: StreamingTextState = { text: "", isStreaming: false };

  // Tool confirmation support
  let toolConfirmationHandler:
    | ((request: ToolConfirmationRequest, respond: (r: ToolConfirmationResponse) => void) => void)
    | null = null;

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

  const createAccessor = (id: string) =>
    ({
      sessionId: id,
      isSubscribed: false,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      send: vi.fn(() => createHandle()),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      submitToolResult: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      onResult: vi.fn(() => () => {}),
      onToolConfirmation: vi.fn((handler: typeof toolConfirmationHandler) => {
        toolConfirmationHandler = handler;
        return () => {
          toolConfirmationHandler = null;
        };
      }),
      channel: vi.fn((name: string) => ({
        name,
        subscribe: vi.fn(() => () => {}),
        publish: vi.fn(async () => {}),
        request: vi.fn(async () => ({})),
      })),
    }) as any;

  const client = {
    _emitEvent(event: any) {
      const withSession: SessionStreamEvent = {
        sessionId: "test-session",
        ...event,
      };
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
      for (const handler of eventHandlers) {
        handler(withSession);
      }
    },

    _triggerToolConfirmation(request: ToolConfirmationRequest): Promise<ToolConfirmationResponse> {
      return new Promise((resolve) => {
        if (toolConfirmationHandler) {
          toolConfirmationHandler(request, resolve);
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
    session: vi.fn((id: string) => createAccessor(id)),
    subscribe: vi.fn((id: string) => createAccessor(id)),

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
  it("renders the header", async () => {
    const client = createMockClient();
    const { lastFrame } = render(
      <AgentickProvider client={client}>
        <Chat sessionId="main" />
      </AgentickProvider>,
    );
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("agentick");
    expect(frame).toContain("/exit");
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

    // Wait for Chat to fully mount (effects register onToolConfirmation handler)
    await waitFor(() => expect(lastFrame()!).toContain("agentick"));

    // Simulate streaming state first
    client._emitEvent({ type: "tick_start", timestamp: Date.now() });
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

    // Wait for Chat to fully mount
    await waitFor(() => expect(lastFrame()!).toContain("agentick"));

    // Simulate streaming state
    client._emitEvent({ type: "tick_start", timestamp: Date.now() });
    await flush();

    // Trigger tool confirmation
    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    // Wait for confirmation prompt to render
    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    // Press Y
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

    // Wait for Chat to fully mount
    await waitFor(() => expect(lastFrame()!).toContain("agentick"));

    client._emitEvent({ type: "tick_start", timestamp: Date.now() });
    await flush();

    const responsePromise = client._triggerToolConfirmation({
      toolUseId: "tool-1",
      name: "delete_file",
      arguments: { path: "/tmp/test.txt" },
    });

    // Wait for confirmation prompt to render
    await waitFor(() => {
      expect(lastFrame()!).toContain("[Y] Approve");
    });

    stdin.write("n");

    const response = await responsePromise;
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("rejected by user");
  });
});
