/**
 * Client Event Buffer
 *
 * Per-client bounded event buffering for backpressure.
 * Wraps client.send() with a queue that buffers events when the
 * client is under write pressure. Overflow disconnects the client
 * or drops oldest events depending on configuration.
 */

import type { GatewayMessage } from "./transport-protocol.js";
import type { TransportClient } from "./transport.js";

export type OverflowStrategy = "drop-oldest" | "disconnect";

export class ClientEventBuffer {
  private queue: GatewayMessage[] = [];

  constructor(
    private client: TransportClient,
    private maxBuffer = 1000,
    private overflow: OverflowStrategy = "disconnect",
  ) {}

  push(message: GatewayMessage): void {
    if (!this.client.isConnected) return;

    // Drain-on-push: each new event triggers a flush attempt.
    // Events arrive in streams (model output), so each push is a natural
    // drain point. After the last event in a burst, remaining queued events
    // drain on the next burst's first push.
    if (this.queue.length > 0) {
      this.drain();
    }

    // Fast path: nothing queued after drain, not pressured
    if (this.queue.length === 0 && !this.client.isPressured?.()) {
      this.client.send(message);
      return;
    }

    // Buffer
    this.queue.push(message);
    if (this.queue.length > this.maxBuffer) {
      if (this.overflow === "disconnect") {
        this.client.close(4008, "Event buffer overflow");
        this.queue.length = 0;
      } else {
        this.queue.shift();
      }
    }
  }

  drain(): void {
    while (this.queue.length > 0 && this.client.isConnected && !this.client.isPressured?.()) {
      this.client.send(this.queue.shift()!);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
