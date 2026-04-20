/**
 * In-Memory Transport with correct async delivery semantics.
 *
 * The MCP SDK's InMemoryTransport delivers messages synchronously in
 * `send()`, which causes responses to arrive before the sender has
 * registered its response handler ("unknown message ID" errors).
 *
 * This implementation uses `queueMicrotask` to defer delivery, ensuring
 * the sender's call stack completes before the recipient processes the
 * message. This matches the behavior of real transports (stdio, HTTP)
 * where delivery is inherently asynchronous.
 *
 * Implements the MCP SDK's Transport interface directly.
 */

import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

interface QueuedMessage {
  message: JSONRPCMessage;
  extra?: MessageExtraInfo;
}

export class InMemoryTransport implements Transport {
  private _otherTransport?: InMemoryTransport;
  private _messageQueue: QueuedMessage[] = [];

  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  /**
   * Creates a linked pair of transports. One goes to the Client, the other
   * to the Server. Messages sent on one are delivered to the other.
   */
  static createLinkedPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a._otherTransport = b;
    b._otherTransport = a;
    return [a, b];
  }

  async start(): Promise<void> {
    // Drain any messages that arrived before start() was called
    while (this._messageQueue.length > 0) {
      const queued = this._messageQueue.shift()!;
      this.onmessage?.(queued.message, queued.extra);
    }
  }

  /**
   * Reset the transport for reuse — clears onmessage/onclose/onerror handlers.
   * Call this before connecting a new SDK Client to the same transport to
   * prevent stale handler chaining.
   */
  reset(): void {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
  }

  async close(): Promise<void> {
    const other = this._otherTransport;
    this._otherTransport = undefined;
    await other?.close();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this._otherTransport) {
      throw new Error("Not connected");
    }

    const other = this._otherTransport;

    if (other.onmessage) {
      // Defer delivery via microtask so the sender's call stack completes
      // before the recipient processes the message.
      queueMicrotask(() => other.onmessage?.(message));
    } else {
      other._messageQueue.push({ message });
    }
  }
}
