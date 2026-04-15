/**
 * RelayTransport — Transport implementation backed by a message relay.
 *
 * Enables AppBridge to run on the server instead of in the browser.
 * Instead of PostMessage (which requires DOM/iframes), messages are
 * sent and received through abstract send/receive callbacks.
 *
 * The relay layer (gateway, WS, channels, etc.) routes messages between
 * this transport and the browser, which relays them to/from the iframe
 * via PostMessage.
 *
 * ```
 * Server:  AppBridge ↔ RelayTransport ↔ [relay layer] ↔ Browser ↔ PostMessage ↔ iframe
 * ```
 *
 * Usage:
 *   const transport = new RelayTransport({
 *     send: (msg) => gatewayConnection.send({ appId, payload: msg }),
 *   });
 *   // Wire incoming messages from the relay:
 *   gatewayConnection.on('app-message', (msg) => transport.receive(msg.payload));
 *   // Connect to AppBridge:
 *   await bridge.connect(transport);
 */

import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export interface RelayTransportOptions {
  /**
   * Called when the transport needs to send a message to the remote end
   * (browser/iframe). The relay layer is responsible for delivery.
   */
  send: (message: JSONRPCMessage) => void | Promise<void>;
}

export class RelayTransport implements Transport {
  private _send: RelayTransportOptions["send"];
  private _started = false;

  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  constructor(options: RelayTransportOptions) {
    this._send = options.send;
  }

  async start(): Promise<void> {
    this._started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await this._send(message);
  }

  /**
   * Feed a message received from the relay layer (browser/iframe).
   * Call this when the gateway/channel delivers a message from the remote end.
   */
  receive(message: JSONRPCMessage): void {
    if (!this._started) return;
    this.onmessage?.(message);
  }

  async close(): Promise<void> {
    this._started = false;
    this.onclose?.();
  }

  setProtocolVersion?: (version: string) => void;
}
