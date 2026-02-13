/**
 * useMessageSteering Integration Tests
 *
 * Logic tests live in @agentick/client (MessageSteering class).
 * These verify React integration: rendering, subscriptions, cleanup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { type ReactNode } from "react";
import { AgentickProvider } from "../context";
import { useMessageSteering } from "../hooks/use-message-steering";
import type { AgentickClient, ConnectionState, StreamingTextState } from "@agentick/client";
import { createMockClient as createBaseMockClient, makeEvent } from "@agentick/client/testing";

// ============================================================================
// Mock Client (extends base with React-required fields)
// ============================================================================

function createMockClient() {
  const base = createBaseMockClient();

  return Object.assign(base, {
    get state(): ConnectionState {
      return "disconnected";
    },
    get streamingText(): StreamingTextState {
      return { text: "", isStreaming: false };
    },
    closeSession: vi.fn(async () => {}),
    subscribe: vi.fn((id: string) => base.getAccessor(id)),
    onEvent: vi.fn(() => () => {}),
    onConnectionChange: vi.fn(() => () => {}),
    onStreamingText: vi.fn((handler: (state: StreamingTextState) => void) => {
      handler({ text: "", isStreaming: false });
      return () => {};
    }),
    clearStreamingText: vi.fn(),
    on: vi.fn(() => () => {}),
  }) as any as AgentickClient & {
    _emitSessionEvent: ReturnType<typeof createBaseMockClient>["_emitSessionEvent"];
    getAccessor: ReturnType<typeof createBaseMockClient>["getAccessor"];
  };
}

function createWrapper(client: AgentickClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AgentickProvider client={client}>{children}</AgentickProvider>;
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("useMessageSteering (React integration)", () => {
  let client: ReturnType<typeof createMockClient>;
  let wrapper: ReturnType<typeof createWrapper>;

  beforeEach(() => {
    client = createMockClient();
    wrapper = createWrapper(client);
  });

  it("returns correct initial state", () => {
    const { result } = renderHook(() => useMessageSteering({ sessionId: "s1" }), { wrapper });

    expect(result.current.mode).toBe("steer");
    expect(result.current.queued).toEqual([]);
    expect(result.current.isExecuting).toBe(false);
  });

  it("re-renders on state changes", () => {
    const { result } = renderHook(() => useMessageSteering({ sessionId: "s1" }), { wrapper });

    act(() => result.current.queue("test"));

    expect(result.current.queued).toHaveLength(1);
  });

  it("tracks execution state from events", () => {
    const { result } = renderHook(() => useMessageSteering({ sessionId: "s1" }), { wrapper });

    act(() => client._emitSessionEvent("s1", makeEvent("execution_start")));
    expect(result.current.isExecuting).toBe(true);

    act(() => client._emitSessionEvent("s1", makeEvent("execution_end")));
    expect(result.current.isExecuting).toBe(false);
  });

  it("submit sends to client", () => {
    const { result } = renderHook(() => useMessageSteering({ sessionId: "s1" }), { wrapper });

    act(() => result.current.submit("Hello"));

    expect(client.send).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
      { sessionId: "s1" },
    );
  });

  it("mode switching works through React", () => {
    const { result } = renderHook(() => useMessageSteering({ sessionId: "s1" }), { wrapper });

    act(() => result.current.setMode("queue"));
    expect(result.current.mode).toBe("queue");
  });
});
