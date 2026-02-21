/**
 * TelegramPlugin — GatewayPlugin implementation tests.
 *
 * Adversarial focus: confirmation races, double-click callbacks,
 * concurrent messages, whitelist bypass, destroy during processing,
 * stale confirmations, outbound without chatId.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@agentick/gateway";
import type { BlockType, StreamEvent } from "@agentick/shared";
import { TelegramPlugin } from "../telegram-plugin.js";

// ============================================================================
// Mock Infrastructure
// ============================================================================

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

  const bot = {
    on: vi.fn((event: string, handler: any) => {
      handlers[event as keyof typeof handlers] = handler;
    }),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    api: {
      sendMessage: vi.fn(async (chatId: number, text: string, options?: any) => {
        sentMessages.push({ chatId, text, options });
        return { message_id: sentMessages.length };
      }),
      sendChatAction: vi.fn(async () => {}),
      getMe: vi.fn(async () => ({
        id: 1,
        is_bot: true,
        first_name: "Test",
        username: "test_bot",
      })),
    },
  };

  return {
    bot,
    handlers,
    sentMessages,
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

/** Create an async iterable from an array of StreamEvents */
function createEventStream(events: Partial<StreamEvent>[]): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= events.length) return { done: true, value: undefined };
          return { done: false, value: events[i++] as StreamEvent };
        },
      };
    },
  };
}

/** Create an event stream that yields events with configurable delays */
// function createDelayedEventStream(
//   events: Array<{ event: Partial<StreamEvent>; delayMs?: number }>,
// ): AsyncIterable<StreamEvent> {
//   return {
//     [Symbol.asyncIterator]() {
//       let i = 0;
//       return {
//         async next() {
//           if (i >= events.length) return { done: true, value: undefined };
//           const { event, delayMs } = events[i++]!;
//           if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
//           return { done: false, value: event as StreamEvent };
//         },
//       };
//     },
//   };
// }

function createMockPluginContext(overrides?: Partial<PluginContext>) {
  const methods = new Map<string, Function>();

  const ctx: PluginContext = {
    gatewayId: "test-gw",
    sendToSession: vi.fn(async () => createEventStream([])),
    respondToConfirmation: vi.fn(async () => {}),
    registerMethod: vi.fn((path: string, handler: any) => {
      methods.set(path, handler);
    }),
    unregisterMethod: vi.fn(),
    invoke: vi.fn(async (method: string, params: unknown) => {
      const handler = methods.get(method);
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(params);
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };

  return { ctx, methods };
}

// Mock grammy module
vi.mock("grammy", () => ({
  Bot: vi.fn(),
  InlineKeyboard: vi.fn(() => ({
    text: vi.fn().mockReturnThis(),
  })),
}));

// ============================================================================
// Tests
// ============================================================================

describe("TelegramPlugin", () => {
  let mockBot: ReturnType<typeof createMockBot>;

  beforeEach(async () => {
    mockBot = createMockBot();
    const grammy = await import("grammy");
    (grammy.Bot as any).mockImplementation(function () {
      return mockBot.bot;
    });
    (grammy.InlineKeyboard as any).mockImplementation(function () {
      const kb = { text: vi.fn((_label: string, _data: string) => kb) };
      return kb;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Initialization & Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  describe("initialization", () => {
    it("registers telegram:send method on initialize", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();

      await plugin.initialize(ctx);

      expect(ctx.registerMethod).toHaveBeenCalledWith("telegram:send", expect.any(Function));
    });

    it("validates bot token via getMe", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();

      await plugin.initialize(ctx);

      expect(mockBot.bot.api.getMe).toHaveBeenCalled();
    });

    it("starts long polling", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();

      await plugin.initialize(ctx);

      expect(mockBot.bot.start).toHaveBeenCalled();
    });

    it("registers message:text and callback_query:data handlers", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();

      await plugin.initialize(ctx);

      expect(mockBot.bot.on).toHaveBeenCalledWith("message:text", expect.any(Function));
      expect(mockBot.bot.on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
    });

    it("throws if getMe fails (bad token)", async () => {
      mockBot.bot.api.getMe.mockRejectedValue(new Error("401: Unauthorized"));
      const plugin = new TelegramPlugin({ token: "bad-token" });
      const { ctx } = createMockPluginContext();

      await expect(plugin.initialize(ctx)).rejects.toThrow("401: Unauthorized");
    });
  });

  describe("destroy", () => {
    it("stops the bot and clears state", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await plugin.destroy();

      expect(mockBot.bot.stop).toHaveBeenCalled();
    });

    it("is idempotent (safe to call twice)", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await plugin.destroy();
      await plugin.destroy();

      expect(mockBot.bot.stop).toHaveBeenCalledTimes(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Inbound Messages
  // ══════════════════════════════════════════════════════════════════════════

  describe("inbound messages", () => {
    it("sends user message to session via sendToSession", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hello agent");

      expect(ctx.sendToSession).toHaveBeenCalledWith("default:telegram-200", {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello agent" }],
          },
        ],
      });
    });

    it("auto-detects chatId from first message", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("First", 100, 42);
      await mockBot.simulateMessage("Second", 100, 42);

      expect(ctx.sendToSession).toHaveBeenCalledTimes(2);
    });

    it("ignores messages from different chat after chatId is set", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("From chat 1", 100, 1);
      await mockBot.simulateMessage("From chat 2", 100, 2);

      expect(ctx.sendToSession).toHaveBeenCalledTimes(1);
    });

    it("filters by allowedUsers", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        allowedUsers: [100],
      });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Allowed", 100, 1);
      await mockBot.simulateMessage("Blocked", 999, 1);

      expect(ctx.sendToSession).toHaveBeenCalledTimes(1);
    });

    it("uses custom sessionKeyPattern when provided", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        sessionKeyPattern: (chatId) => `coding:tg-${chatId}`,
      });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hello", 100, 42);

      expect(ctx.sendToSession).toHaveBeenCalledWith("coding:tg-42", expect.any(Object));
    });

    it("sends typing indicator before calling sendToSession", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hello", 100, 200);

      expect(mockBot.bot.api.sendChatAction).toHaveBeenCalledWith(200, "typing");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Response Delivery
  // ══════════════════════════════════════════════════════════════════════════

  describe("response delivery", () => {
    it("accumulates content_delta events and sends response", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        { type: "content_delta", delta: "Hello ", blockType: "text" as BlockType, blockIndex: 0 },
        { type: "content_delta", delta: "world!", blockType: "text" as BlockType, blockIndex: 0 },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hi");

      // Wait for async event processing
      await new Promise((r) => setTimeout(r, 50));

      // Should have sent the accumulated text
      const textMessages = mockBot.sentMessages.filter(
        (m) => m.text !== undefined && m.chatId === 200,
      );
      expect(textMessages.some((m) => m.text === "Hello world!")).toBe(true);
    });

    it("splits long responses at 4096 chars", async () => {
      const longText = "A".repeat(5000);
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        { type: "content_delta", delta: longText, blockType: "text" as BlockType, blockIndex: 0 },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Give me a long response");
      await new Promise((r) => setTimeout(r, 50));

      // Should have split into at least 2 messages
      const textMessages = mockBot.sentMessages.filter((m) => m.chatId === 200);
      // At least the typing indicator + 2 chunks
      expect(textMessages.length).toBeGreaterThanOrEqual(2);
    });

    it("does not send empty response if no content_delta events", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([{ type: "tick_start" }, { type: "tick_end" }]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      const sentBefore = mockBot.sentMessages.length;
      await mockBot.simulateMessage("Hi");
      await new Promise((r) => setTimeout(r, 50));

      // No text messages should have been sent (only typing indicator)
      const sentAfter = mockBot.sentMessages.filter((_, i) => i >= sentBefore);
      // No sendMessage calls with accumulated text (typing is sendChatAction, not sendMessage)
      expect(sentAfter.every((m) => m.text !== "")).toBe(true);
    });

    it("sends typing indicator on tick_start events", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        { type: "tick_start" },
        { type: "content_delta", delta: "response", blockType: "text" as BlockType, blockIndex: 0 },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hi");
      await new Promise((r) => setTimeout(r, 50));

      // Called at least twice: once for initial message, once for tick_start
      expect(mockBot.bot.api.sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Confirmation Flow — Inline Keyboard
  // ══════════════════════════════════════════════════════════════════════════

  describe("inline keyboard confirmations", () => {
    it("sends inline keyboard when tool_confirmation_required arrives", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: { command: "rm -rf /tmp" },
          message: "Allow shell to execute?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do something");
      await new Promise((r) => setTimeout(r, 50));

      // Should have sent a message with reply_markup (the keyboard)
      const keyboardMessages = mockBot.sentMessages.filter((m) => m.options?.reply_markup);
      expect(keyboardMessages.length).toBe(1);
    });

    it("calls respondToConfirmation when approve callback arrives", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: { command: "ls" },
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      // Simulate user clicking "Approve"
      await mockBot.simulateCallback("confirm:call-1:approve");

      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-1", {
        approved: true,
      });
    });

    it("calls respondToConfirmation when deny callback arrives", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: { command: "ls" },
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      await mockBot.simulateCallback("confirm:call-1:deny");

      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-1", {
        approved: false,
      });
    });

    it("handles double-click callback (already resolved) gracefully", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: {},
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      // First click — resolved
      await mockBot.simulateCallback("confirm:call-1:approve");
      // Second click — should be a no-op
      await mockBot.simulateCallback("confirm:call-1:approve");

      // respondToConfirmation called exactly once
      expect(ctx.respondToConfirmation).toHaveBeenCalledTimes(1);
    });

    it("ignores stale callback for unknown callId", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      // Callback for a callId that was never registered
      await mockBot.simulateCallback("confirm:nonexistent:approve");

      expect(ctx.respondToConfirmation).not.toHaveBeenCalled();
    });

    it("handles callId containing colons in callback data", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "tool:use:abc:123",
          name: "shell",
          input: {},
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      await mockBot.simulateCallback("confirm:tool:use:abc:123:approve");

      expect(ctx.respondToConfirmation).toHaveBeenCalledWith(
        "default:telegram-200",
        "tool:use:abc:123",
        { approved: true },
      );
    });

    it("ignores non-confirm callback data", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateCallback("other:data");
      expect(ctx.respondToConfirmation).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Confirmation Flow — Text Based
  // ══════════════════════════════════════════════════════════════════════════

  describe("text-based confirmations", () => {
    it("sends text prompt and parses yes response", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        confirmationStyle: "text",
      });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: { command: "ls" },
          message: "Allow shell?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      // Should have sent a text prompt
      const promptMessages = mockBot.sentMessages.filter((m) => m.text.includes("Reply yes/no"));
      expect(promptMessages.length).toBe(1);

      // User replies "yes"
      await mockBot.simulateMessage("yes", 100, 200);

      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-1", {
        approved: true,
        reason: "yes",
      });
    });

    it("parses no response as denial", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        confirmationStyle: "text",
      });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-2",
          name: "shell",
          input: {},
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      await mockBot.simulateMessage("no way", 100, 200);

      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-2", {
        approved: false,
        reason: "no way",
      });
    });

    it("text confirmation does not forward to session", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        confirmationStyle: "text",
      });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-1",
          name: "shell",
          input: {},
          message: "Allow?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do it");
      await new Promise((r) => setTimeout(r, 50));

      // Clear the call count from the initial message
      (ctx.sendToSession as any).mockClear();

      // Respond to confirmation
      await mockBot.simulateMessage("yes", 100, 200);

      // Should NOT have called sendToSession — it was a confirmation, not a new message
      expect(ctx.sendToSession).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Outbound: telegram:send
  // ══════════════════════════════════════════════════════════════════════════

  describe("telegram:send method", () => {
    it("sends message to auto-detected chatId", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx, methods } = createMockPluginContext();
      await plugin.initialize(ctx);

      // Auto-detect chatId
      await mockBot.simulateMessage("Hi", 100, 42);
      await new Promise((r) => setTimeout(r, 50));

      // Invoke the registered method
      const handler = methods.get("telegram:send")!;
      const result = await handler({ text: "Outbound message" });

      expect(result).toEqual({ ok: true, chatId: 42 });
      expect(
        mockBot.sentMessages.some((m) => m.text === "Outbound message" && m.chatId === 42),
      ).toBe(true);
    });

    it("uses explicit chatId param over auto-detected", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx, methods } = createMockPluginContext();
      await plugin.initialize(ctx);

      // Auto-detect chatId = 42
      await mockBot.simulateMessage("Hi", 100, 42);
      await new Promise((r) => setTimeout(r, 50));

      const handler = methods.get("telegram:send")!;
      await handler({ chatId: 99, text: "To specific chat" });

      expect(mockBot.sentMessages.some((m) => m.chatId === 99)).toBe(true);
    });

    it("throws when no chatId available", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const { ctx, methods } = createMockPluginContext();
      await plugin.initialize(ctx);

      // No message received yet — no auto-detected chatId
      const handler = methods.get("telegram:send")!;
      await expect(handler({ text: "Orphaned" })).rejects.toThrow("No chatId available");
    });

    it("splits long outbound messages", async () => {
      const plugin = new TelegramPlugin({ token: "test-token", chatId: 42 });
      const { ctx, methods } = createMockPluginContext();
      await plugin.initialize(ctx);

      const handler = methods.get("telegram:send")!;
      await handler({ text: "A".repeat(5000) });

      const sentToChat = mockBot.sentMessages.filter((m) => m.chatId === 42);
      expect(sentToChat.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Edge Cases & Adversarial
  // ══════════════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("handles sendToSession throwing without crashing", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => {
          throw new Error("session gone");
        }),
      });
      await plugin.initialize(ctx);

      // Should not throw — error is logged
      await mockBot.simulateMessage("Hello");
      await new Promise((r) => setTimeout(r, 50));

      consoleSpy.mockRestore();
    });

    it("handles concurrent messages from same chat", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      let callCount = 0;
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => {
          callCount++;
          return createEventStream([
            {
              type: "content_delta",
              delta: `Response ${callCount}`,
              blockType: "text" as BlockType,
              blockIndex: 0,
            },
          ]);
        }),
      });
      await plugin.initialize(ctx);

      // Fire two messages concurrently
      await Promise.all([
        mockBot.simulateMessage("First", 100, 200),
        mockBot.simulateMessage("Second", 100, 200),
      ]);

      await new Promise((r) => setTimeout(r, 100));

      expect(ctx.sendToSession).toHaveBeenCalledTimes(2);
    });

    it("empty allowedUsers set allows all users", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        allowedUsers: [],
      });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Anyone", 999, 200);

      expect(ctx.sendToSession).toHaveBeenCalledTimes(1);
    });

    it("uses configured chatId from start", async () => {
      const plugin = new TelegramPlugin({
        token: "test-token",
        chatId: 42,
      });
      const { ctx } = createMockPluginContext();
      await plugin.initialize(ctx);

      // Message from different chat should be ignored
      await mockBot.simulateMessage("Wrong chat", 100, 99);
      expect(ctx.sendToSession).not.toHaveBeenCalled();

      // Message from configured chat works
      await mockBot.simulateMessage("Right chat", 100, 42);
      expect(ctx.sendToSession).toHaveBeenCalledTimes(1);
    });

    it("event processing error does not crash plugin", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Create an event stream that throws mid-iteration
      const brokenStream: AsyncIterable<StreamEvent> = {
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            async next() {
              if (!yielded) {
                yielded = true;
                return {
                  done: false,
                  value: {
                    type: "content_delta",
                    delta: "Hi",
                    blockType: "text",
                    blockIndex: 0,
                  } as StreamEvent,
                };
              }
              throw new Error("stream broke");
            },
          };
        },
      };

      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => brokenStream),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Hello");
      await new Promise((r) => setTimeout(r, 50));

      // Should have logged the error but not crashed
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("multiple confirmations can be pending simultaneously (keyboard)", async () => {
      const plugin = new TelegramPlugin({ token: "test-token" });
      const events = createEventStream([
        {
          type: "tool_confirmation_required",
          callId: "call-a",
          name: "tool-a",
          input: {},
          message: "Allow A?",
        },
        {
          type: "tool_confirmation_required",
          callId: "call-b",
          name: "tool-b",
          input: {},
          message: "Allow B?",
        },
      ]);
      const { ctx } = createMockPluginContext({
        sendToSession: vi.fn(async () => events),
      });
      await plugin.initialize(ctx);

      await mockBot.simulateMessage("Do both");
      await new Promise((r) => setTimeout(r, 50));

      // Approve B first, then A (out of order)
      await mockBot.simulateCallback("confirm:call-b:approve");
      await mockBot.simulateCallback("confirm:call-a:deny");

      expect(ctx.respondToConfirmation).toHaveBeenCalledTimes(2);
      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-b", {
        approved: true,
      });
      expect(ctx.respondToConfirmation).toHaveBeenCalledWith("default:telegram-200", "call-a", {
        approved: false,
      });
    });
  });
});

// parseTextConfirmation and formatConfirmationMessage are tested in
// confirmation-utils.spec.ts (below) — they're pure functions with no mock deps.
