import { Bot, InlineKeyboard } from "grammy";
import type { GatewayPlugin, PluginContext } from "@agentick/gateway";
import type {
  StreamEvent,
  ToolConfirmationRequiredEvent,
  ToolConfirmationResponse,
} from "@agentick/shared";
import { splitMessage } from "@agentick/shared";
import { parseTextConfirmation, formatConfirmationMessage } from "./confirmation-utils.js";

const TELEGRAM_MAX_LENGTH = 4096;

export interface TelegramPluginOptions {
  /** Telegram bot token. */
  token: string;
  /** Whitelist of allowed Telegram user IDs. Empty = allow all. */
  allowedUsers?: number[];
  /** Specific chat ID to use. If omitted, auto-detects from first message. */
  chatId?: number;
  /** How to present tool confirmations. Default: "inline-keyboard". */
  confirmationStyle?: "inline-keyboard" | "text";
  /** Session key pattern. Default: "default:telegram-{chatId}" */
  sessionKeyPattern?: (chatId: number) => string;
}

/**
 * Telegram gateway plugin.
 *
 * Bridges a Telegram bot to agent sessions via the gateway plugin system.
 * Receives messages from Telegram, routes them to sessions via
 * `PluginContext.sendToSession()`, and delivers responses back.
 * Tool confirmations are presented as inline keyboards or text prompts.
 *
 * Registers a `telegram:send` method for outbound messaging from tool handlers.
 */
export class TelegramPlugin implements GatewayPlugin {
  readonly id = "telegram";

  private readonly _bot: Bot;
  private readonly _options: TelegramPluginOptions;
  private readonly _allowedUsers: Set<number>;
  private readonly _confirmationStyle: "inline-keyboard" | "text";
  private _ctx: PluginContext | null = null;
  private _chatId: number | null;

  /** Pending inline-keyboard confirmations keyed by toolUseId. */
  private _pendingKeyboardConfirmations = new Map<
    string,
    { sessionKey: string; callId: string; messageText: string }
  >();

  /** Pending text-based confirmation (only one at a time). */
  private _pendingTextConfirmation: {
    sessionKey: string;
    callId: string;
  } | null = null;

  constructor(options: TelegramPluginOptions) {
    this._bot = new Bot(options.token);
    this._options = options;
    this._allowedUsers = new Set(options.allowedUsers ?? []);
    this._chatId = options.chatId ?? null;
    this._confirmationStyle = options.confirmationStyle ?? "inline-keyboard";
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this._ctx = ctx;

    // Register outbound method: telegram:send
    ctx.registerMethod("telegram:send", async (params) => {
      const { chatId: explicitChatId, text } = params as { chatId?: number; text: string };
      const chatId = explicitChatId ?? this._chatId;
      if (!chatId) throw new Error("No chatId available");
      if (!text) throw new Error("text is required");
      const chunks = splitMessage(text, { maxLength: TELEGRAM_MAX_LENGTH });
      for (const chunk of chunks) {
        await this._bot.api.sendMessage(chatId, chunk);
      }
      return { ok: true, chatId };
    });

    // Set up grammy handlers
    this._setupMessageHandler();
    this._setupCallbackHandler();

    // Validate token (fails fast on 401)
    await this._bot.api.getMe();

    // Start long polling (fire-and-forget)
    this._bot.start().catch((err) => {
      console.error("Telegram plugin polling error:", err);
    });
  }

  async destroy(): Promise<void> {
    await this._bot.stop();
    this._ctx = null;
    this._pendingKeyboardConfirmations.clear();
    this._pendingTextConfirmation = null;
  }

  private _sessionKey(chatId: number): string {
    return this._options.sessionKeyPattern?.(chatId) ?? `default:telegram-${chatId}`;
  }

  private _setupMessageHandler(): void {
    this._bot.on("message:text", async (tgCtx) => {
      const userId = tgCtx.from.id;
      const chatId = tgCtx.chat.id;

      if (this._allowedUsers.size > 0 && !this._allowedUsers.has(userId)) return;
      if (this._chatId === null) this._chatId = chatId;
      if (chatId !== this._chatId) return;

      const text = tgCtx.message.text;

      // Handle pending text confirmation
      if (this._pendingTextConfirmation) {
        const { sessionKey, callId } = this._pendingTextConfirmation;
        this._pendingTextConfirmation = null;
        const response = parseTextConfirmation(text);
        await this._ctx!.respondToConfirmation(sessionKey, callId, response);
        return;
      }

      // Send to session and observe response
      const sessionKey = this._sessionKey(chatId);
      this._bot.api.sendChatAction(chatId, "typing").catch(() => {});

      try {
        const events = await this._ctx!.sendToSession(sessionKey, {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text }],
            },
          ],
        });

        // Iterate events in background — deliver response + handle confirmations
        this._processEvents(sessionKey, chatId, events).catch((err) => {
          console.error("Telegram event processing error:", err);
        });
      } catch (err) {
        console.error("Telegram sendToSession error:", err);
      }
    });
  }

  private _setupCallbackHandler(): void {
    this._bot.on("callback_query:data", async (tgCtx) => {
      const data = tgCtx.callbackQuery.data;
      if (!data.startsWith("confirm:")) return;

      // Always answer to dismiss the loading spinner (even on double-click race)
      await tgCtx.answerCallbackQuery();

      // Parse confirm:<callId>:<action> — callId may contain colons
      const lastColon = data.lastIndexOf(":");
      const callId = data.slice(8, lastColon); // 8 = "confirm:".length
      const action = data.slice(lastColon + 1);

      const pending = this._pendingKeyboardConfirmations.get(callId);
      if (!pending) return; // Stale or already resolved — graceful no-op

      this._pendingKeyboardConfirmations.delete(callId);

      const approved = action === "approve";
      const response: ToolConfirmationResponse = { approved };

      await this._ctx!.respondToConfirmation(pending.sessionKey, callId, response);

      try {
        await tgCtx.editMessageText(
          `${pending.messageText}\n\n${approved ? "Approved" : "Denied"}`,
        );
      } catch {
        // Message may have been deleted
      }
    });
  }

  /** Core event loop: observe execution, deliver response, handle confirmations */
  private async _processEvents(
    sessionKey: string,
    chatId: number,
    events: AsyncIterable<StreamEvent>,
  ): Promise<void> {
    let responseText = "";

    for await (const event of events) {
      switch (event.type) {
        case "content_delta":
          if ("blockType" in event && event.blockType === "text" && "delta" in event) {
            responseText += event.delta;
          }
          break;

        case "tool_confirmation_required":
          await this._handleConfirmation(
            sessionKey,
            chatId,
            event as ToolConfirmationRequiredEvent,
          );
          break;

        case "tick_start":
          this._bot.api.sendChatAction(chatId, "typing").catch(() => {});
          break;
      }
    }

    // Deliver accumulated response
    if (responseText.trim()) {
      const chunks = splitMessage(responseText.trim(), { maxLength: TELEGRAM_MAX_LENGTH });
      for (const chunk of chunks) {
        await this._bot.api.sendMessage(chatId, chunk);
      }
    }
  }

  private async _handleConfirmation(
    sessionKey: string,
    chatId: number,
    event: ToolConfirmationRequiredEvent,
  ): Promise<void> {
    const text = formatConfirmationMessage({
      name: event.name,
      message: event.message,
      arguments: event.input,
    });

    if (this._confirmationStyle === "inline-keyboard") {
      this._pendingKeyboardConfirmations.set(event.callId, {
        sessionKey,
        callId: event.callId,
        messageText: text,
      });

      const keyboard = new InlineKeyboard()
        .text("Approve", `confirm:${event.callId}:approve`)
        .text("Deny", `confirm:${event.callId}:deny`);

      await this._bot.api.sendMessage(chatId, text, {
        reply_markup: keyboard,
      });
    } else {
      this._pendingTextConfirmation = { sessionKey, callId: event.callId };
      await this._bot.api.sendMessage(
        chatId,
        `${text}\n\nReply yes/no (or explain what you'd like instead)`,
      );
    }
  }
}
