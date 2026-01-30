/**
 * Tests for TentickleService (signals-based)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { firstValueFrom } from "rxjs";
import type { StreamingTextState, SessionStreamEvent } from "@tentickle/client";

let mockStreamingTextState: StreamingTextState = { text: "", isStreaming: false };
let mockStreamingTextHandlers = new Set<(state: StreamingTextState) => void>();

const emitMockStreamingText = (state: StreamingTextState) => {
  mockStreamingTextState = state;
  for (const handler of mockStreamingTextHandlers) {
    handler(state);
  }
};

const createMockHandle = (sessionId: string) => ({
  sessionId,
  executionId: "exec-1",
  status: "completed" as const,
  result: Promise.resolve({
    response: "ok",
    outputs: {},
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }),
  abort: vi.fn(),
  queueMessage: vi.fn(),
  submitToolResult: vi.fn(),
  async *[Symbol.asyncIterator]() {},
});

const mockClient = {
  session: vi.fn((id: string) => ({
    sessionId: id,
    isSubscribed: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(() => createMockHandle(id)),
    abort: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    onResult: vi.fn(() => () => {}),
    onToolConfirmation: vi.fn(() => () => {}),
    channel: vi.fn((name: string) => ({
      name,
      subscribe: vi.fn(() => () => {}),
      publish: vi.fn(async () => {}),
      request: vi.fn(async () => ({})),
    })),
  })),
  subscribe: vi.fn((id: string) => ({
    sessionId: id,
    isSubscribed: true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(() => createMockHandle(id)),
    abort: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    onResult: vi.fn(() => () => {}),
    onToolConfirmation: vi.fn(() => () => {}),
    channel: vi.fn(),
  })),
  send: vi.fn(() => createMockHandle("ephemeral")),
  abort: vi.fn(),
  closeSession: vi.fn(),
  destroy: vi.fn(),
  onConnectionChange: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
  on: vi.fn(() => () => {}),
  onStreamingText: vi.fn((handler: (state: StreamingTextState) => void) => {
    mockStreamingTextHandlers.add(handler);
    handler(mockStreamingTextState);
    return () => mockStreamingTextHandlers.delete(handler);
  }),
  clearStreamingText: vi.fn(() => {
    emitMockStreamingText({ text: "", isStreaming: false });
  }),
  get streamingText() {
    return mockStreamingTextState;
  },
  get state() {
    return "disconnected" as const;
  },
};

vi.mock("@tentickle/client", () => ({
  createClient: vi.fn(() => mockClient),
}));

import { TentickleService } from "./tentickle.service";

describe("TentickleService", () => {
  let service: TentickleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamingTextState = { text: "", isStreaming: false };
    mockStreamingTextHandlers.clear();
    service = new TentickleService({ baseUrl: "https://api.example.com" });
  });

  afterEach(() => {
    service.ngOnDestroy();
  });

  it("initializes signals", () => {
    expect(service.connectionState()).toBe("disconnected");
    expect(service.sessionId()).toBeUndefined();
    expect(service.streamingText()).toEqual({ text: "", isStreaming: false });
  });

  it("subscribes to a session", () => {
    const accessor = service.subscribe("conv-123");
    expect(accessor.sessionId).toBe("conv-123");
    expect(service.sessionId()).toBe("conv-123");
  });

  it("sends via active session", async () => {
    service.subscribe("conv-123");
    const handle = service.send("Hello");
    const result = await handle.result;
    expect(result.response).toBe("ok");
  });

  it("streams text updates", async () => {
    emitMockStreamingText({ text: "hello", isStreaming: true });
    const text = await firstValueFrom(service.text$);
    expect(text).toBe("hello");
  });
});
