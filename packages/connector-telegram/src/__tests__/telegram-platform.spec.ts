import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectorBridge, ConnectorOutput, ConnectorStatusEvent } from "@agentick/connector";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/shared";
import { TelegramPlatform } from "../telegram-platform.js";

// --- grammy mock infrastructure ---

type MessageHandler = (ctx: any) => Promise<void>;
type CallbackHandler = (ctx: any) => Promise<void>;

function createMockBot() {
  const handlers: {
    "message:text"?: MessageHandler;
    "callback_query:data"?: CallbackHandler;
  } = {};

  const sentMessages: Array<{
    chatId: number;
    text: string;
    options?: Record<string, unknown>;
  }> = [];

  const editedMessages: Array<{
    chatId: number;
    messageId: number;
    text: string;
  }> = [];

  let onStartCallback: (() => void) | null = null;

  const bot = {
    on: vi.fn((event: string, handler: any) => {
      handlers[event as keyof typeof handlers] = handler;
    }),
    start: vi.fn((options?: { onStart?: () => void }) => {
      onStartCallback = options?.onStart ?? null;
      // Simulate connected after a microtask
      if (onStartCallback) {
        Promise.resolve().then(() => onStartCallback!());
      }
      return Promise.resolve();
    }),
    stop: vi.fn(),
    api: {
      sendMessage: vi.fn(async (chatId: number, text: string, options?: any) => {
        const msg = { chatId, text, options };
        sentMessages.push(msg);
        return { message_id: sentMessages.length };
      }),
      editMessageText: vi.fn(async (chatId: number, messageId: number, text: string) => {
        editedMessages.push({ chatId, messageId, text });
      }),
      sendChatAction: vi.fn(async () => {}),
      getMe: vi.fn(async () => ({ id: 1, is_bot: true, first_name: "Test", username: "test_bot" })),
    },
  };

  return {
    bot,
    handlers,
    sentMessages,
    editedMessages,
    simulateMessage(text: string, userId = 100, chatId = 200, username?: string) {
      const handler = handlers["message:text"];
      if (!handler) throw new Error("No message:text handler registered");
      return handler({
        from: { id: userId, username },
        chat: { id: chatId },
        message: { text },
      });
    },
    simulateCallback(data: string, userId = 100) {
      const handler = handlers["callback_query:data"];
      if (!handler) throw new Error("No callback_query:data handler registered");
      return handler({
        from: { id: userId },
        callbackQuery: { data },
        answerCallbackQuery: vi.fn(),
        editMessageText: vi.fn(),
      });
    },
  };
}

function createMockBridge() {
  const deliveries: ConnectorOutput[] = [];
  const statusEvents: ConnectorStatusEvent[] = [];
  const confirmations: Array<{
    request: ToolConfirmationRequest;
    respond: (r: ToolConfirmationResponse) => void;
  }> = [];

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
    reportStatus: vi.fn((status, error) => {
      statusEvents.push({ status, error });
    }),
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
    deliveries,
    statusEvents,
    confirmations,
    executionStartHandlers,
    emitDelivery(output: ConnectorOutput) {
      deliverHandler?.(output);
    },
    emitConfirmation(
      request: ToolConfirmationRequest,
      respond: (r: ToolConfirmationResponse) => void,
    ) {
      confirmHandler?.(request, respond);
    },
    fireExecutionStart() {
      for (const h of executionStartHandlers) h();
    },
  };
}

// Mock grammy module
vi.mock("grammy", () => ({
  Bot: vi.fn(),
  InlineKeyboard: vi.fn(() => ({
    text: vi.fn().mockReturnThis(),
  })),
}));

describe("TelegramPlatform", () => {
  let mockBot: ReturnType<typeof createMockBot>;

  beforeEach(async () => {
    mockBot = createMockBot();
    // Override Bot constructor to return our mock — must use regular functions for `new`
    const grammy = await import("grammy");
    (grammy.Bot as any).mockImplementation(function () {
      return mockBot.bot;
    });
    (grammy.InlineKeyboard as any).mockImplementation(function () {
      const kb = {
        text: vi.fn((_label: string, _data: string) => kb),
      };
      return kb;
    });
  });

  it("starts the bot and registers handlers", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const { bridge } = createMockBridge();

    await platform.start(bridge);

    expect(mockBot.bot.on).toHaveBeenCalledWith("message:text", expect.any(Function));
    expect(mockBot.bot.on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
    expect(mockBot.bot.start).toHaveBeenCalled();
  });

  it("forwards incoming messages to bridge.send", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await mockBot.simulateMessage("Hello agent");

    expect(bridge.send).toHaveBeenCalledWith("Hello agent", {
      type: "telegram",
      chatId: 200,
      userId: 100,
      username: undefined,
    });
  });

  it("auto-detects chatId from first message", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await mockBot.simulateMessage("First", 100, 42);
    await mockBot.simulateMessage("Second", 100, 42);

    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it("ignores messages from different chat after chatId is set", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await mockBot.simulateMessage("From chat 1", 100, 1);
    await mockBot.simulateMessage("From chat 2", 100, 2);

    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith("From chat 1", {
      type: "telegram",
      chatId: 1,
      userId: 100,
      username: undefined,
    });
  });

  it("filters by allowedUsers", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      allowedUsers: [100],
    });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await mockBot.simulateMessage("Allowed user", 100, 1);
    await mockBot.simulateMessage("Blocked user", 999, 1);

    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith("Allowed user", {
      type: "telegram",
      chatId: 1,
      userId: 100,
      username: undefined,
    });
  });

  it("delivers messages to Telegram as plain text", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      chatId: 42,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    mock.emitDelivery({
      messages: [{ id: "m1", role: "assistant", content: "Hello from agent" }],
      isComplete: true,
    });

    await vi.waitFor(() => {
      expect(mockBot.bot.api.sendMessage).toHaveBeenCalledWith(42, "Hello from agent");
    });
  });

  it("handles text-based confirmations", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      chatId: 42,
      confirmationStyle: "text",
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    const respond = vi.fn();
    mock.emitConfirmation(
      { toolUseId: "tu_1", name: "shell", arguments: { command: "rm -rf /tmp" } },
      respond,
    );

    // Platform should have sent a confirmation prompt
    await vi.waitFor(() => {
      expect(mockBot.bot.api.sendMessage).toHaveBeenCalled();
    });

    // User replies "yes"
    await mockBot.simulateMessage("yes", 100, 42);

    expect(respond).toHaveBeenCalledWith({ approved: true, reason: "yes" });
  });

  it("stops the bot cleanly", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const { bridge } = createMockBridge();

    await platform.start(bridge);
    await platform.stop();

    expect(mockBot.bot.stop).toHaveBeenCalled();
  });

  // --- Status reporting ---

  it("reports connecting status on start", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const mock = createMockBridge();

    // bot.start fires onStart via microtask, so by the time start()
    // returns, we may already be "connected". Just verify the call was made.
    await platform.start(mock.bridge);

    expect(mock.bridge.reportStatus).toHaveBeenCalledWith("connecting");
  });

  it("reports connected status when bot.start calls onStart", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    // Wait for the microtask that fires onStart
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.bridge.reportStatus).toHaveBeenCalledWith("connected");
    expect(platform.status).toBe("connected");
  });

  it("reports error status when bot.start rejects", async () => {
    const platform = new TelegramPlatform({ token: "test-token" });
    const mock = createMockBridge();

    // Make bot.start reject
    const error = new Error("polling failed");
    mockBot.bot.start.mockImplementation(() => Promise.reject(error));

    await platform.start(mock.bridge);

    // Wait for the rejection to propagate
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.bridge.reportStatus).toHaveBeenCalledWith("error", error);
    expect(platform.status).toBe("error");
  });

  // --- Typing indicator ---

  it("sends typing action on execution start", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      chatId: 42,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);
    mock.fireExecutionStart();

    expect(mockBot.bot.api.sendChatAction).toHaveBeenCalledWith(42, "typing");
  });

  // --- Message splitting ---

  it("splits long messages for Telegram's 4096 char limit", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      chatId: 42,
    });
    const mock = createMockBridge();

    await platform.start(mock.bridge);

    const longText = "A".repeat(5000);
    mock.emitDelivery({
      messages: [{ id: "m1", role: "assistant", content: longText }],
      isComplete: true,
    });

    await vi.waitFor(() => {
      // Should have been called at least twice (5000 > 4096)
      expect(mockBot.bot.api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --- Delivery error propagation ---

  it("propagates delivery errors for retry", async () => {
    const platform = new TelegramPlatform({
      token: "test-token",
      chatId: 42,
    });
    const mock = createMockBridge();

    mockBot.bot.api.sendMessage.mockRejectedValue(new Error("network error"));

    await platform.start(mock.bridge);

    await expect(
      (platform as any)._handleDelivery({
        messages: [{ id: "m1", role: "assistant", content: "test" }],
        isComplete: true,
      }),
    ).rejects.toThrow("network error");
  });
});

// parseTextConfirmation and formatConfirmationMessage are tested
// in @agentick/connector's own test suite (text-utils.spec.ts).
