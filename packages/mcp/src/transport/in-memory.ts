/**
 * In-memory MCP transport — paired client/server for testing and
 * in-process use.
 *
 * Messages deliver synchronously (matching the SDK's own
 * `InMemoryTransport`). This is safe because the SDK's
 * `Protocol.request()` registers the response handler BEFORE calling
 * `transport.send()`, so synchronously-arriving responses always find
 * their handler. Synchronous delivery also preserves real-transport
 * ordering — progress notifications arrive before tool results.
 *
 * **v1 origin:** ported from `packages/mcp/src/transport/in-memory.ts`.
 * Unchanged behavior.
 */

import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

interface QueuedMessage {
  readonly message: JSONRPCMessage;
  readonly extra?: MessageExtraInfo;
}

export class InMemoryMcpTransport implements Transport {
  private peer?: InMemoryMcpTransport;
  private queue: QueuedMessage[] = [];

  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  /**
   * Create a linked pair. One half goes to the MCP client, the other
   * to the MCP server. Messages sent on one are delivered to the other.
   */
  static createLinkedPair(): [InMemoryMcpTransport, InMemoryMcpTransport] {
    const a = new InMemoryMcpTransport();
    const b = new InMemoryMcpTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async start(): Promise<void> {
    // Drain anything queued while `onmessage` wasn't yet set.
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      this.onmessage?.(queued.message, queued.extra);
    }
  }

  async close(): Promise<void> {
    const other = this.peer;
    this.peer = undefined;
    await other?.close();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.peer) {
      throw new Error("InMemoryMcpTransport: not connected");
    }
    const peer = this.peer;
    if (peer.onmessage) {
      peer.onmessage(message);
    } else {
      peer.queue.push({ message });
    }
  }
}
