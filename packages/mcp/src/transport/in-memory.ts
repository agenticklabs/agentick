/**
 * In-Memory Transport for MCP client/server testing and in-process use.
 *
 * Delivers messages synchronously — same as the SDK's InMemoryTransport.
 * This is correct because the SDK's Protocol.request() registers the
 * response handler BEFORE calling transport.send(), so responses arriving
 * synchronously will always find their handler.
 *
 * The previous queueMicrotask-based deferral was a workaround for a
 * different bug (duplicate MCPClient instances connecting to the same
 * transport). That bug was fixed by consolidating to a single MCPClient
 * class. Synchronous delivery is now safe and preserves message ordering
 * (progress notifications arrive before the tool result, matching real
 * transport behavior).
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
    while (this._messageQueue.length > 0) {
      const queued = this._messageQueue.shift()!;
      this.onmessage?.(queued.message, queued.extra);
    }
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
      other.onmessage(message);
    } else {
      other._messageQueue.push({ message });
    }
  }
}
