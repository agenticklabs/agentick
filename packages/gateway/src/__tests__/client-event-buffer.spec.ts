/**
 * ClientEventBuffer Tests
 *
 * Unit + adversarial tests for per-client bounded event buffering.
 * Tests fast path (no buffer), backpressure (buffers when pressured),
 * overflow strategies (disconnect vs drop-oldest), and edge cases
 * (disconnect during drain, push after close, concurrent pushes).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClientEventBuffer, type OverflowStrategy } from "../client-event-buffer.js";
import type { TransportClient } from "../transport.js";
import type { GatewayMessage } from "../transport-protocol.js";
import type { ClientState } from "../types.js";

// ============================================================================
// Mock Transport Client
// ============================================================================

interface MockClientOpts {
  pressured?: boolean;
  connected?: boolean;
}

function createMockClient(opts: MockClientOpts = {}): TransportClient & {
  _sent: GatewayMessage[];
  _closed: boolean;
  _closeCode?: number;
  _closeReason?: string;
  setPressured(v: boolean): void;
} {
  let pressured = opts.pressured ?? false;
  let connected = opts.connected ?? true;
  const sent: GatewayMessage[] = [];

  return {
    id: `mock-${Math.random().toString(36).slice(2, 8)}`,
    state: {
      id: "mock",
      connectedAt: new Date(),
      authenticated: true,
      subscriptions: new Set(),
    } as ClientState,

    get isConnected() {
      return connected;
    },
    isPressured() {
      return pressured;
    },
    send(message: GatewayMessage) {
      sent.push(message);
    },
    close(code?: number, reason?: string) {
      connected = false;
      (this as any)._closed = true;
      (this as any)._closeCode = code;
      (this as any)._closeReason = reason;
    },

    _sent: sent,
    _closed: false,
    setPressured(v: boolean) {
      pressured = v;
    },
  };
}

function makeEvent(n: number): GatewayMessage {
  return {
    type: "event" as const,
    event: "content_delta" as any,
    sessionId: "test",
    data: { index: n },
  };
}

// ============================================================================
// Fast Path
// ============================================================================

describe("ClientEventBuffer", () => {
  describe("fast path (no backpressure)", () => {
    it("sends directly when not pressured and no queue", () => {
      const client = createMockClient();
      const buffer = new ClientEventBuffer(client);

      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      buffer.push(makeEvent(3));

      expect(client._sent).toHaveLength(3);
      expect(buffer.pending).toBe(0);
    });

    it("never touches queue on fast path", () => {
      const client = createMockClient();
      const buffer = new ClientEventBuffer(client);

      for (let i = 0; i < 100; i++) {
        buffer.push(makeEvent(i));
      }

      expect(client._sent).toHaveLength(100);
      expect(buffer.pending).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Backpressure (buffering)
  // ══════════════════════════════════════════════════════════════════════════

  describe("backpressure", () => {
    it("buffers when client is pressured", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client);

      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));

      // Nothing sent directly — all buffered
      expect(client._sent).toHaveLength(0);
      expect(buffer.pending).toBe(2);
    });

    it("drains buffer when pressure clears on next push", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client);

      // Buffer 3 events under pressure
      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      buffer.push(makeEvent(3));
      expect(buffer.pending).toBe(3);

      // Pressure clears, next push triggers drain + sends new event
      client.setPressured(false);
      buffer.push(makeEvent(4));

      // All 4 events sent: 3 drained + 1 new (fast path after drain)
      expect(client._sent).toHaveLength(4);
      expect(buffer.pending).toBe(0);
    });

    it("partial drain: only drains until pressured again", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client);

      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      buffer.push(makeEvent(3));
      buffer.push(makeEvent(4));

      // Clear pressure, but re-pressurize after first send
      let sendCount = 0;
      const origSend = client.send.bind(client);
      client.send = (msg: GatewayMessage) => {
        origSend(msg);
        sendCount++;
        // Re-pressurize after draining 2
        if (sendCount >= 2) client.setPressured(true);
      };

      client.setPressured(false);
      buffer.push(makeEvent(5)); // triggers drain

      // Drained 2, then pressured again. Event 5 goes to buffer.
      // Queue had [1,2,3,4], drained 1,2 (sendCount hit 2 → pressured).
      // Then 3,4 stay. Then push(5) → buffered.
      expect(sendCount).toBe(2);
      expect(buffer.pending).toBe(3); // events 3, 4, 5
    });

    it("explicit drain() flushes queue", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client);

      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));

      client.setPressured(false);
      buffer.drain();

      expect(client._sent).toHaveLength(2);
      expect(buffer.pending).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Overflow: disconnect strategy
  // ══════════════════════════════════════════════════════════════════════════

  describe("overflow: disconnect", () => {
    it("disconnects client when buffer exceeds max", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 5, "disconnect");

      for (let i = 0; i < 6; i++) {
        buffer.push(makeEvent(i));
      }

      expect(client._closed).toBe(true);
      expect(client._closeCode).toBe(4008);
      expect(buffer.pending).toBe(0); // queue cleared on disconnect
    });

    it("uses 4008 close code and overflow reason", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 3, "disconnect");

      for (let i = 0; i < 4; i++) {
        buffer.push(makeEvent(i));
      }

      expect(client._closeCode).toBe(4008);
      expect(client._closeReason).toBe("Event buffer overflow");
    });

    it("stays under limit when events drain between pushes", () => {
      const client = createMockClient({ pressured: false });
      const buffer = new ClientEventBuffer(client, 3, "disconnect");

      // All go via fast path → no buffer → no overflow
      for (let i = 0; i < 100; i++) {
        buffer.push(makeEvent(i));
      }

      expect(client._closed).toBe(false);
      expect(client._sent).toHaveLength(100);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Overflow: drop-oldest strategy
  // ══════════════════════════════════════════════════════════════════════════

  describe("overflow: drop-oldest", () => {
    it("drops oldest events when buffer exceeds max", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 3, "drop-oldest");

      // Push 5 events, buffer max is 3 → oldest 2 dropped
      for (let i = 0; i < 5; i++) {
        buffer.push(makeEvent(i));
      }

      expect(buffer.pending).toBe(3);
      expect(client._closed).toBe(false);

      // Drain and check we have the NEWEST events
      client.setPressured(false);
      buffer.drain();

      expect(client._sent).toHaveLength(3);
      expect((client._sent[0] as any).data.index).toBe(2);
      expect((client._sent[1] as any).data.index).toBe(3);
      expect((client._sent[2] as any).data.index).toBe(4);
    });

    it("drops one at a time at the boundary", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 2, "drop-oldest");

      buffer.push(makeEvent(0));
      buffer.push(makeEvent(1));
      expect(buffer.pending).toBe(2);

      // Push one more → drops oldest
      buffer.push(makeEvent(2));
      expect(buffer.pending).toBe(2);

      client.setPressured(false);
      buffer.drain();

      expect(client._sent).toHaveLength(2);
      expect((client._sent[0] as any).data.index).toBe(1);
      expect((client._sent[1] as any).data.index).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial / Edge Cases
  // ══════════════════════════════════════════════════════════════════════════

  describe("adversarial", () => {
    it("push after disconnect is a no-op", () => {
      const client = createMockClient({ connected: false });
      const buffer = new ClientEventBuffer(client);

      // Should not throw, should not buffer
      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));

      expect(client._sent).toHaveLength(0);
      expect(buffer.pending).toBe(0);
    });

    it("disconnect during drain does not crash", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 100);

      // Buffer several events
      for (let i = 0; i < 10; i++) {
        buffer.push(makeEvent(i));
      }

      // Make drain disconnect client after 3 sends
      let sendCount = 0;
      const origSend = client.send.bind(client);
      client.send = (msg: GatewayMessage) => {
        origSend(msg);
        sendCount++;
        if (sendCount >= 3) {
          client.close(1000, "gone");
        }
      };

      client.setPressured(false);
      // Should not throw — drain stops when isConnected becomes false
      expect(() => buffer.drain()).not.toThrow();
      expect(sendCount).toBe(3);
      // Remaining events stuck in queue (dead client)
      expect(buffer.pending).toBe(7);
    });

    it("clear() empties queue immediately", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client);

      for (let i = 0; i < 50; i++) {
        buffer.push(makeEvent(i));
      }
      expect(buffer.pending).toBe(50);

      buffer.clear();
      expect(buffer.pending).toBe(0);

      // After clear, push still works
      client.setPressured(false);
      buffer.push(makeEvent(99));
      expect(client._sent).toHaveLength(1);
    });

    it("drain on empty queue is a no-op", () => {
      const client = createMockClient();
      const buffer = new ClientEventBuffer(client);

      // Should not throw
      buffer.drain();
      expect(buffer.pending).toBe(0);
    });

    it("concurrent push+drain interleaving preserves order", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 100);

      // Buffer phase
      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      buffer.push(makeEvent(3));

      // Mid-stream: clear pressure, push triggers drain
      client.setPressured(false);
      buffer.push(makeEvent(4));

      // All events should be in order
      expect(client._sent.map((m: any) => m.data.index)).toEqual([1, 2, 3, 4]);
    });

    it("isPressured returning undefined treated as false", () => {
      // TransportClient.isPressured is optional
      const client = createMockClient();
      (client as any).isPressured = undefined;

      const buffer = new ClientEventBuffer(client);
      buffer.push(makeEvent(1));

      // Should send directly (fast path), not buffer
      expect(client._sent).toHaveLength(1);
      expect(buffer.pending).toBe(0);
    });

    it("overflow disconnect then push is no-op", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 3, "disconnect");

      // Overflow → disconnect
      for (let i = 0; i < 4; i++) {
        buffer.push(makeEvent(i));
      }
      expect(client._closed).toBe(true);

      // Push after overflow disconnect → no-op (isConnected = false)
      buffer.push(makeEvent(99));
      expect(buffer.pending).toBe(0);
      expect(client._sent).toHaveLength(0);
    });

    it("buffer of size 1 works correctly with drop-oldest", () => {
      const client = createMockClient({ pressured: true });
      const buffer = new ClientEventBuffer(client, 1, "drop-oldest");

      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      buffer.push(makeEvent(3));

      expect(buffer.pending).toBe(1);

      client.setPressured(false);
      buffer.drain();

      // Only the very last event survives
      expect(client._sent).toHaveLength(1);
      expect((client._sent[0] as any).data.index).toBe(3);
    });

    it("alternating pressure: buffer → drain → buffer → drain", () => {
      const client = createMockClient();
      const buffer = new ClientEventBuffer(client);

      // Phase 1: pressured
      client.setPressured(true);
      buffer.push(makeEvent(1));
      buffer.push(makeEvent(2));
      expect(buffer.pending).toBe(2);

      // Phase 2: unpressured → drain on next push
      client.setPressured(false);
      buffer.push(makeEvent(3));
      expect(client._sent).toHaveLength(3);
      expect(buffer.pending).toBe(0);

      // Phase 3: pressured again
      client.setPressured(true);
      buffer.push(makeEvent(4));
      buffer.push(makeEvent(5));
      expect(buffer.pending).toBe(2);

      // Phase 4: unpressured → drain
      client.setPressured(false);
      buffer.push(makeEvent(6));
      expect(client._sent).toHaveLength(6);
      expect(buffer.pending).toBe(0);

      // Order preserved
      expect(client._sent.map((m: any) => m.data.index)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});
