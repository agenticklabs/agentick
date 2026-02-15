import { Bot, InlineKeyboard } from "grammy";
import type {
  ConnectorPlatform,
  ConnectorBridge,
  ConnectorOutput,
  ConnectorStatus,
} from "@agentick/connector";
import {
  extractText,
  splitMessage,
  parseTextConfirmation,
  formatConfirmationMessage,
} from "@agentick/connector";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/shared";

declare module "@agentick/shared" {
  interface MessageSourceTypes {
    telegram: { type: "telegram"; chatId: number; userId?: number; username?: string };
  }
}

const TELEGRAM_MAX_LENGTH = 4096;

export interface TelegramConnectorOptions {
  /** Telegram bot token. */
  token: string;
  /** Whitelist of allowed Telegram user IDs. Empty = allow all. */
  allowedUsers?: number[];
  /** Specific chat ID to use. If omitted, auto-detects from first message. */
  chatId?: number;
  /** How to present tool confirmations. Default: "inline-keyboard". */
  confirmationStyle?: "inline-keyboard" | "text";
}

/**
 * Telegram platform adapter for the Agentick connector system.
 *
 * Receives messages from a Telegram bot and delivers agent responses
 * back as Telegram messages. Tool confirmations can use inline keyboards
 * or text-based confirmation.
 */
export class TelegramPlatform implements ConnectorPlatform {
  private readonly _bot: Bot;
  private readonly _allowedUsers: Set<number>;
  private readonly _confirmationStyle: "inline-keyboard" | "text";
  private _chatId: number | null;
  private _bridge: ConnectorBridge | null = null;
  private _status: ConnectorStatus = "disconnected";

  /** Pending inline-keyboard confirmations keyed by toolUseId. */
  private _pendingKeyboardConfirmations = new Map<
    string,
    { respond: (r: ToolConfirmationResponse) => void; messageText: string }
  >();

  /** Pending text-based confirmation (only one at a time). */
  private _pendingTextConfirmation: {
    respond: (r: ToolConfirmationResponse) => void;
  } | null = null;

  constructor(options: TelegramConnectorOptions) {
    this._bot = new Bot(options.token);
    this._allowedUsers = new Set(options.allowedUsers ?? []);
    this._chatId = options.chatId ?? null;
    this._confirmationStyle = options.confirmationStyle ?? "inline-keyboard";
  }

  get status(): ConnectorStatus {
    return this._status;
  }

  async start(bridge: ConnectorBridge): Promise<void> {
    this._bridge = bridge;
    this._status = "connecting";
    bridge.reportStatus("connecting");

    // Handle text messages
    this._bot.on("message:text", async (ctx) => {
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      if (this._allowedUsers.size > 0 && !this._allowedUsers.has(userId)) {
        return;
      }

      if (this._chatId === null) {
        this._chatId = chatId;
      }

      if (chatId !== this._chatId) return;

      const text = ctx.message.text;

      // Text-based confirmation response
      if (this._pendingTextConfirmation) {
        const { respond } = this._pendingTextConfirmation;
        this._pendingTextConfirmation = null;
        respond(parseTextConfirmation(text));
        return;
      }

      bridge.send(text, {
        type: "telegram",
        chatId,
        userId,
        username: ctx.from.username,
      });
    });

    // Single callback query handler — routes to pending confirmations by toolUseId
    this._bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith("confirm:")) return;

      // Always answer the callback query to dismiss the loading spinner,
      // even if the confirmation is already resolved (double-click race)
      await ctx.answerCallbackQuery();

      // Parse confirm:<toolUseId>:<action> — toolUseId may contain colons
      const lastColon = data.lastIndexOf(":");
      const toolUseId = data.slice(8, lastColon); // 8 = "confirm:".length
      const action = data.slice(lastColon + 1);

      const pending = this._pendingKeyboardConfirmations.get(toolUseId);
      if (!pending) return;

      this._pendingKeyboardConfirmations.delete(toolUseId);

      const confirmed = action === "approve";
      pending.respond({ approved: confirmed });

      try {
        await ctx.editMessageText(`${pending.messageText}\n\n${confirmed ? "Approved" : "Denied"}`);
      } catch {
        // Message may have been deleted
      }
    });

    // Subscribe to delivery events
    bridge.onDeliver((output) => {
      return this._handleDelivery(output);
    });

    // Subscribe to confirmation requests
    bridge.onConfirmation((request, respond) => {
      this._handleConfirmation(request, respond).catch((err) => {
        console.error("Telegram confirmation error:", err);
      });
    });

    // Typing indicator on execution start
    bridge.onExecutionStart(() => {
      if (this._chatId) {
        this._bot.api.sendChatAction(this._chatId, "typing").catch(() => {});
      }
    });

    // Validate token before starting (fails fast on 401)
    await this._bot.api.getMe();

    // Start long polling (fire-and-forget — errors reported via status)
    this._bot
      .start({
        onStart: () => {
          this._status = "connected";
          bridge.reportStatus("connected");
        },
      })
      .catch((err) => {
        this._status = "error";
        bridge.reportStatus("error", err);
      });
  }

  async stop(): Promise<void> {
    await this._bot.stop();
    this._status = "disconnected";
    this._bridge = null;
    this._pendingTextConfirmation = null;
    this._pendingKeyboardConfirmations.clear();
  }

  // --- Private ---

  private async _handleDelivery(output: ConnectorOutput): Promise<void> {
    if (!this._chatId) return;

    for (const message of output.messages) {
      const text = extractText(message.content, "\n\n");
      if (!text) continue;

      const chunks = splitMessage(text, { maxLength: TELEGRAM_MAX_LENGTH });
      for (const chunk of chunks) {
        await this._bot.api.sendMessage(this._chatId, chunk);
      }
    }
  }

  private async _handleConfirmation(
    request: ToolConfirmationRequest,
    respond: (r: ToolConfirmationResponse) => void,
  ): Promise<void> {
    if (!this._chatId) return;

    const text = formatConfirmationMessage(request);

    if (this._confirmationStyle === "inline-keyboard") {
      this._pendingKeyboardConfirmations.set(request.toolUseId, {
        respond,
        messageText: text,
      });

      const keyboard = new InlineKeyboard()
        .text("Approve", `confirm:${request.toolUseId}:approve`)
        .text("Deny", `confirm:${request.toolUseId}:deny`);

      await this._bot.api.sendMessage(this._chatId, text, {
        reply_markup: keyboard,
      });
    } else {
      this._pendingTextConfirmation = { respond };
      await this._bot.api.sendMessage(
        this._chatId,
        `${text}\n\nReply yes/no (or explain what you'd like instead)`,
      );
    }
  }
}
