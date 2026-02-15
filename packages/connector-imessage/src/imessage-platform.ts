import type {
  ConnectorPlatform,
  ConnectorBridge,
  ConnectorOutput,
  ConnectorStatus,
} from "@agentick/connector";
import { extractText, parseTextConfirmation, formatConfirmationMessage } from "@agentick/connector";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/shared";
import { IMessageDB } from "./imessage-db.js";
import { sendIMessage } from "./imessage-send.js";

export interface IMessageConnectorOptions {
  /** Phone number or email to watch for messages. */
  handle: string;
  /** How often to poll chat.db, in milliseconds. Default: 2000. */
  pollIntervalMs?: number;
  /** Delay between sending multiple messages, in milliseconds. Default: 500. */
  sendDelay?: number;
  /** Custom path to chat.db (for testing). */
  dbPath?: string;
}

/**
 * iMessage platform adapter for the Agentick connector system.
 * macOS only.
 *
 * Polls ~/Library/Messages/chat.db for incoming messages and sends
 * responses via AppleScript -> Messages.app.
 *
 * Recommended config:
 * - deliveryStrategy: "on-idle"
 * - contentPolicy: "summarized"
 * - renderMode: "message"
 */
export class IMessagePlatform implements ConnectorPlatform {
  private readonly _handle: string;
  private readonly _pollIntervalMs: number;
  private readonly _sendDelay: number;
  private readonly _dbPath?: string;

  private _db: IMessageDB | null = null;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _bridge: ConnectorBridge | null = null;
  private _status: ConnectorStatus = "disconnected";

  private _pendingConfirmation: {
    respond: (r: ToolConfirmationResponse) => void;
  } | null = null;

  constructor(options: IMessageConnectorOptions) {
    this._handle = options.handle;
    this._pollIntervalMs = options.pollIntervalMs ?? 2000;
    this._sendDelay = options.sendDelay ?? 500;
    this._dbPath = options.dbPath;
  }

  get status(): ConnectorStatus {
    return this._status;
  }

  async start(bridge: ConnectorBridge): Promise<void> {
    this._bridge = bridge;
    this._status = "connecting";
    bridge.reportStatus("connecting");

    this._db = new IMessageDB(this._handle, this._dbPath);
    this._db.open();

    bridge.onDeliver((output) => {
      return this._handleDelivery(output);
    });

    bridge.onConfirmation((request, respond) => {
      this._handleConfirmation(request, respond).catch((err) => {
        console.error("iMessage confirmation error:", err);
      });
    });

    this._status = "connected";
    bridge.reportStatus("connected");
    this._scheduleNextPoll();
  }

  async stop(): Promise<void> {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._db?.close();
    this._db = null;
    this._bridge = null;
    this._status = "disconnected";
    this._pendingConfirmation = null;
  }

  // --- Private ---

  private _scheduleNextPoll(): void {
    this._pollTimer = setTimeout(() => {
      this._poll();
      if (this._bridge) this._scheduleNextPoll();
    }, this._pollIntervalMs);
  }

  private _poll(): void {
    if (!this._db || !this._bridge) return;

    let messages;
    try {
      messages = this._db.poll();
    } catch (err) {
      // chat.db may be locked by Messages.app — log and retry next interval
      console.error("iMessage poll error (will retry):", err);
      return;
    }

    for (const msg of messages) {
      const text = msg.text;

      if (this._pendingConfirmation) {
        const { respond } = this._pendingConfirmation;
        this._pendingConfirmation = null;
        respond(parseTextConfirmation(text));
        continue;
      }

      this._bridge.send(text);
    }
  }

  private async _handleDelivery(output: ConnectorOutput): Promise<void> {
    for (const message of output.messages) {
      const text = extractText(message.content, "\n\n");
      if (!text) continue;

      await sendIMessage(this._handle, text);

      if (this._sendDelay > 0) {
        await sleep(this._sendDelay);
      }
    }
  }

  private async _handleConfirmation(
    request: ToolConfirmationRequest,
    respond: (r: ToolConfirmationResponse) => void,
  ): Promise<void> {
    this._pendingConfirmation = { respond };

    const msg = formatConfirmationMessage(request);
    await sendIMessage(this._handle, `${msg}\n\nReply yes/no (or explain what you'd like instead)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
