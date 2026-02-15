import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectorBridge, ConnectorOutput } from "@agentick/connector";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/shared";
import { IMessagePlatform } from "../imessage-platform.js";

// --- Mock infrastructure ---

function createMockDB(messages: Array<{ rowid: number; text: string }> = []) {
  let pollIndex = 0;
  return {
    open: vi.fn(),
    close: vi.fn(),
    poll: vi.fn(() => {
      const result = messages.slice(pollIndex);
      pollIndex = messages.length;
      return result;
    }),
    _addMessage(rowid: number, text: string) {
      messages.push({ rowid, text });
    },
  };
}

const sentMessages: Array<{ handle: string; text: string }> = [];

// Mock the iMessage dependencies — use regular functions for constructors
vi.mock("../imessage-db.js", () => ({
  IMessageDB: vi.fn(function () {
    return createMockDB();
  }),
}));

vi.mock("../imessage-send.js", () => ({
  sendIMessage: vi.fn(async (handle: string, text: string) => {
    sentMessages.push({ handle, text });
  }),
}));

function createMockBridge() {
  let deliverHandler: ((output: ConnectorOutput) => void | Promise<void>) | null = null;
  let confirmHandler:
    | ((request: ToolConfirmationRequest, respond: (r: ToolConfirmationResponse) => void) => void)
    | null = null;
  const executionStartHandlers = new Set<() => void>();
  const executionEndHandlers = new Set<() => void>();

  const bridge: ConnectorBridge = {
    send: vi.fn(),
    sendInput: vi.fn(),
    onDeliver(handler) {
      deliverHandler = handler;
      return () => {
        deliverHandler = null;
      };
    },
    onConfirmation(handler) {
      confirmHandler = handler;
      return () => {
        confirmHandler = null;
      };
    },
    reportStatus: vi.fn(),
    onExecutionStart(handler) {
      executionStartHandlers.add(handler);
      return () => executionStartHandlers.delete(handler);
    },
    onExecutionEnd(handler) {
      executionEndHandlers.add(handler);
      return () => executionEndHandlers.delete(handler);
    },
    abort: vi.fn(),
    destroy: vi.fn(),
  };

  return {
    bridge,
    emitDelivery(output: ConnectorOutput) {
      deliverHandler?.(output);
    },
    emitConfirmation(
      request: ToolConfirmationRequest,
      respond: (r: ToolConfirmationResponse) => void,
    ) {
      confirmHandler?.(request, respond);
    },
  };
}

describe("IMessagePlatform", () => {
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    sentMessages.length = 0;

    // Set up mock DB
    mockDB = createMockDB();
    const dbModule = await import("../imessage-db.js");
    (dbModule.IMessageDB as any).mockImplementation(function () {
      return mockDB;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts polling and opens the database", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 1000,
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    expect(mockDB.open).toHaveBeenCalled();

    await platform.stop();
  });

  it("forwards polled messages to bridge.send", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    // Add messages and advance timer to trigger poll
    mockDB._addMessage(1, "Hello from iMessage");
    vi.advanceTimersByTime(100);

    expect(bridge.send).toHaveBeenCalledWith("Hello from iMessage");

    await platform.stop();
  });

  it("delivers outbound messages via sendIMessage", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      sendDelay: 0,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    mock.emitDelivery({
      messages: [{ id: "m1", role: "assistant", content: "Reply from agent" }],
      isComplete: true,
    });

    // Allow async delivery to process
    await vi.advanceTimersByTimeAsync(10);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({
      handle: "+15551234567",
      text: "Reply from agent",
    });

    await platform.stop();
  });

  it("handles text-based confirmations", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
      sendDelay: 0,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    const respond = vi.fn();
    mock.emitConfirmation({ toolUseId: "tu_1", name: "shell", arguments: {} }, respond);

    // Platform should have sent a confirmation prompt
    await vi.advanceTimersByTimeAsync(10);
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0].text).toContain("Reply yes/no");

    // User replies "yes"
    mockDB._addMessage(1, "yes");
    vi.advanceTimersByTime(100);

    expect(respond).toHaveBeenCalledWith({ approved: true, reason: "yes" });

    await platform.stop();
  });

  it("routes confirmation denial with reason", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
      sendDelay: 0,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    const respond = vi.fn();
    mock.emitConfirmation({ toolUseId: "tu_1", name: "shell", arguments: {} }, respond);

    await vi.advanceTimersByTimeAsync(10);

    // User denies with explanation
    mockDB._addMessage(1, "no, try a different approach");
    vi.advanceTimersByTime(100);

    expect(respond).toHaveBeenCalledWith({
      approved: false,
      reason: "no, try a different approach",
    });

    await platform.stop();
  });

  it("closes DB and clears timer on stop", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await platform.stop();

    expect(mockDB.close).toHaveBeenCalled();

    // Polls after stop should not trigger bridge.send
    mockDB._addMessage(1, "Late message");
    vi.advanceTimersByTime(200);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it("handles poll errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    // Make poll throw (simulates locked DB)
    mockDB.poll.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    vi.advanceTimersByTime(100);

    // Should log error but not crash
    expect(consoleSpy).toHaveBeenCalledWith("iMessage poll error (will retry):", expect.any(Error));

    // Next poll should work fine
    mockDB._addMessage(1, "After error");
    vi.advanceTimersByTime(100);

    expect(bridge.send).toHaveBeenCalledWith("After error");

    consoleSpy.mockRestore();
    await platform.stop();
  });

  // --- Status reporting ---

  it("reports connecting then connected status", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    expect(bridge.reportStatus).toHaveBeenCalledWith("connecting");
    expect(bridge.reportStatus).toHaveBeenCalledWith("connected");
    expect(platform.status).toBe("connected");

    await platform.stop();
  });

  it("reports disconnected status on stop", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    expect(platform.status).toBe("connected");

    await platform.stop();
    expect(platform.status).toBe("disconnected");
  });

  // --- Poll guard (setTimeout chain) ---

  it("uses setTimeout chain to prevent poll stacking", async () => {
    const platform = new IMessagePlatform({
      handle: "+15551234567",
      pollIntervalMs: 100,
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    // Make poll slow (simulates slow DB query)
    let pollCallCount = 0;
    mockDB.poll.mockImplementation(() => {
      pollCallCount++;
      return [];
    });

    // Advance past multiple poll intervals
    vi.advanceTimersByTime(350);

    // With setInterval, this would be 3 calls (100, 200, 300).
    // With setTimeout chain, each poll schedules the next AFTER completion,
    // so we get 3 polls (at 100, 200, 300) since polls are synchronous.
    expect(pollCallCount).toBe(3);

    await platform.stop();
  });
});

// parseTextConfirmation is tested in @agentick/connector's own test suite.
