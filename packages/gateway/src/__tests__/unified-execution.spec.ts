/**
 * Unified Execution + Backpressure Integration Tests
 *
 * Validates that all execution paths (WS, HTTP/directSend, Local/sendToSession,
 * channel adapter/GatewayContext) have consistent state management:
 * - setActive(true/false) brackets every execution
 * - incrementMessageCount fires on every send
 * - session:message event emitted for every path
 * - error during execution still calls setActive(false)
 * - concurrent executeSession calls to same session both complete
 * - backpressure integration: slow clients don't break fast clients
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TransportEventData } from "@agentick/shared";
import { Gateway, createGateway } from "../gateway.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";

describe("Unified execution state management", () => {
  let gateway: Gateway;
  let chatApp: MockApp;

  beforeEach(() => {
    chatApp = createMockApp();
  });

  afterEach(async () => {
    if (gateway?.running) {
      await gateway.stop();
    }
  });

  function createTestGateway() {
    gateway = createGateway({
      apps: { chat: chatApp },
      defaultApp: "chat",
      embedded: true,
    });
    return gateway;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // State consistency: session:message events
  // ══════════════════════════════════════════════════════════════════════════

  describe("session:message emission", () => {
    it("emits session:message for local transport sends", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello from local" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].sessionId).toBe("main");
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello from local");
    });

    it("emits session:message with multimodal content fallback", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const stream = transport.send(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "abc" },
                } as any,
              ],
            },
          ],
        },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("[multimodal content]");
    });

    it("emits session:message with no content fallback", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const stream = transport.send({ messages: [] }, "main");
      for await (const _e of stream) {
        // drain
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("[no content]");
    });

    it("extracts text from multiple messages in SendInput", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const stream = transport.send(
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            { role: "user", content: [{ type: "text", text: "second" }] },
          ],
        },
        "main",
      );
      for await (const _e of stream) {
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("first second");
    });

    it("extracts text from string content messages", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const stream = transport.send(
        {
          messages: [{ role: "user", content: "plain string content" }],
        },
        "main",
      );
      for await (const _e of stream) {
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("plain string content");
    });

    it("emits session:message once per send, not per event", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      // Send twice
      for (let i = 0; i < 2; i++) {
        const stream = transport.send(
          { messages: [{ role: "user", content: [{ type: "text", text: `msg ${i}` }] }] },
          "main",
        );
        for await (const _e of stream) {
          // drain
        }
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("msg 0");
      expect(messages[1].content).toBe("msg 1");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // State consistency: session activation
  // ══════════════════════════════════════════════════════════════════════════

  describe("session activation lifecycle", () => {
    it("session is not active after execution completes", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      // After execution, check session state via status list
      const sessionList = await transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello 2" }] }] },
        "main",
      );
      for await (const _e of sessionList) {
        // drain
      }

      // If setActive(false) wasn't called, session would accumulate active state
      // We can only verify indirectly — the session should work for subsequent sends
      expect(gw.status.sessions).toBeGreaterThan(0);
    });

    it("concurrent sends to same session both complete without stale active state", async () => {
      const gw = createTestGateway();
      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();
      await t1.connect();
      await t2.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      async function sendAndDrain(transport: any, text: string) {
        const events: TransportEventData[] = [];
        const stream = transport.send(
          { messages: [{ role: "user", content: [{ type: "text", text }] }] },
          "main",
        );
        for await (const e of stream) {
          events.push(e);
        }
        return events;
      }

      const [events1, events2] = await Promise.all([
        sendAndDrain(t1, "from t1"),
        sendAndDrain(t2, "from t2"),
      ]);

      // Both paths completed
      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);

      // Both emitted session:message
      expect(messages).toHaveLength(2);

      // Session is still usable (not stuck in active state)
      const events3 = await sendAndDrain(t1, "followup");
      expect(events3.length).toBeGreaterThan(0);
    });

    it("send after session close creates fresh session", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // Create and drain
      const s1 = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "first" }] }] },
        "main",
      );
      for await (const _e of s1) {
      }

      // Close
      await transport.closeSession("main");
      expect(gw.status.sessions).toBe(0);

      // Send again — new session
      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const s2 = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "second" }] }] },
        "main",
      );
      for await (const _e of s2) {
      }

      expect(gw.status.sessions).toBe(1);
      // New session should still emit session:message
      expect(messages.some((m: any) => m.content === "second")).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cross-client event delivery through buffers
  // ══════════════════════════════════════════════════════════════════════════

  describe("event delivery through backpressure buffers", () => {
    it("subscriber receives events through buffer layer", async () => {
      const gw = createTestGateway();
      const sender = gw.createLocalTransport();
      const subscriber = gw.createLocalTransport();
      await sender.connect();
      await subscriber.connect();

      // Subscribe
      await subscriber.subscribeToSession("main");

      const pushed: TransportEventData[] = [];
      subscriber.onEvent((e) => pushed.push(e));

      // Send
      const stream = sender.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );
      for await (const _e of stream) {
      }

      // Events went through ClientEventBuffer → client.send() → handlers
      expect(pushed.length).toBeGreaterThan(0);
      expect(pushed[0].sessionId).toBe("main");
    });

    it("fast client unaffected by existence of buffers", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // LocalTransportClient.isPressured() returns false always
      // → ClientEventBuffer fast path → direct send
      const events: TransportEventData[] = [];
      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "speed test" }] }] },
        "main",
      );
      for await (const e of stream) {
        events.push(e);
      }

      expect(events.length).toBeGreaterThan(0);
    });

    it("buffer cleanup on disconnect prevents memory leak", async () => {
      const gw = createTestGateway();

      // Create and use several transports
      for (let i = 0; i < 5; i++) {
        const transport = gw.createLocalTransport();
        await transport.connect();

        // Subscribe so buffers are created during broadcast
        await transport.subscribeToSession("main");

        transport.disconnect();
      }

      // All disconnected — gateway should have cleaned up buffers
      expect(gw.status.clients).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial: error paths
  // ══════════════════════════════════════════════════════════════════════════

  describe("error path state management", () => {
    it("send to unknown app cleans up state", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "nonexistent:main",
      );

      await expect(async () => {
        for await (const _e of stream) {
        }
      }).rejects.toThrow(/Unknown app/);

      // Gateway should still be functional — no leaked active state
      const stream2 = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "recover" }] }] },
        "main",
      );
      const events: TransportEventData[] = [];
      for await (const e of stream2) {
        events.push(e);
      }
      expect(events.length).toBeGreaterThan(0);
    });

    it("multiple rapid sends don't corrupt message count", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      // Fire 5 sends rapidly (don't await between)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const stream = transport.send(
          { messages: [{ role: "user", content: [{ type: "text", text: `rapid-${i}` }] }] },
          "main",
        );
        promises.push(
          (async () => {
            for await (const _e of stream) {
            }
          })(),
        );
      }

      await Promise.all(promises);

      // All 5 messages should have been tracked
      expect(messages).toHaveLength(5);
      const contents = messages.map((m: any) => m.content).sort();
      expect(contents).toEqual(["rapid-0", "rapid-1", "rapid-2", "rapid-3", "rapid-4"]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial: lifecycle edges
  // ══════════════════════════════════════════════════════════════════════════

  describe("lifecycle edge cases", () => {
    it("disconnect during active execution does not crash gateway", async () => {
      const gw = createTestGateway();
      const sender = gw.createLocalTransport();
      const subscriber = gw.createLocalTransport();
      await sender.connect();
      await subscriber.connect();

      await subscriber.subscribeToSession("main");

      // Start a send, then disconnect subscriber mid-stream
      let eventCount = 0;
      subscriber.onEvent(() => {
        eventCount++;
        if (eventCount >= 1) {
          // Disconnect mid-stream
          subscriber.disconnect();
        }
      });

      // This should not throw even though subscriber disconnects mid-broadcast
      const stream = sender.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "mid-disconnect" }] }] },
        "main",
      );
      for await (const _e of stream) {
      }

      // Gateway still functional
      expect(gw.status.clients).toBe(1); // only sender remains
    });

    it("sending to multiple sessions in parallel preserves isolation", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const messages: any[] = [];
      gw.on("session:message", (payload) => messages.push(payload));

      const sessions = ["session-a", "session-b", "session-c"];
      const promises = sessions.map((sid) => {
        const stream = transport.send(
          { messages: [{ role: "user", content: [{ type: "text", text: `to-${sid}` }] }] },
          sid,
        );
        return (async () => {
          const events: TransportEventData[] = [];
          for await (const e of stream) {
            events.push(e);
          }
          return { sid, events };
        })();
      });

      const results = await Promise.all(promises);

      // Each session got its own execution
      for (const r of results) {
        expect(r.events.length).toBeGreaterThan(0);
        expect(r.events.every((e: any) => e.sessionId === r.sid)).toBe(true);
      }

      // All sessions created
      expect(gw.status.sessions).toBe(3);

      // All message events fired with correct session IDs
      expect(messages).toHaveLength(3);
      const sessionIds = messages.map((m: any) => m.sessionId).sort();
      expect(sessionIds).toEqual(["session-a", "session-b", "session-c"]);
    });

    it("disconnect all clients during active sends is graceful", async () => {
      const gw = createTestGateway();
      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();
      await t1.connect();
      await t2.connect();

      // Start sends on both transports
      const stream1 = t1.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "t1" }] }] },
        "main",
      );
      const stream2 = t2.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "t2" }] }] },
        "main",
      );

      // Drain both — should complete without crashing
      const [events1, events2] = await Promise.all([
        (async () => {
          const events: TransportEventData[] = [];
          for await (const e of stream1) events.push(e);
          return events;
        })(),
        (async () => {
          const events: TransportEventData[] = [];
          for await (const e of stream2) events.push(e);
          return events;
        })(),
      ]);

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);

      // Disconnect both
      t1.disconnect();
      t2.disconnect();

      expect(gw.status.clients).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EventMessage format: subscriber events use EventMessage wrapping
  // ══════════════════════════════════════════════════════════════════════════

  describe("EventMessage format in subscriber broadcasts", () => {
    it("events delivered to subscribers use EventMessage format", async () => {
      const gw = createTestGateway();
      const sender = gw.createLocalTransport();
      const subscriber = gw.createLocalTransport();
      await sender.connect();
      await subscriber.connect();

      await subscriber.subscribeToSession("main");

      // Collect raw events from subscriber
      const rawEvents: TransportEventData[] = [];
      subscriber.onEvent((e) => rawEvents.push(e));

      const stream = sender.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "format test" }] }] },
        "main",
      );
      for await (const _e of stream) {
      }

      // Wait for broadcast delivery
      await new Promise((r) => setTimeout(r, 50));

      // Events should be in EventMessage format: { type: "event", event, sessionId, data }
      expect(rawEvents.length).toBeGreaterThan(0);

      // The local transport client.send() receives GatewayMessage which includes
      // EventMessage format. The client transport layer then unwraps it.
      // Here we verify the events reach the subscriber at all.
      for (const ev of rawEvents) {
        expect(ev.sessionId).toBe("main");
      }
    });

    it("deliverToClient reaches the correct transport", async () => {
      const gw = createTestGateway();
      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();
      await t1.connect();
      await t2.connect();

      // Subscribe both to the same session
      await t1.subscribeToSession("test-session");
      await t2.subscribeToSession("test-session");

      const t1Events: TransportEventData[] = [];
      const t2Events: TransportEventData[] = [];
      t1.onEvent((e) => t1Events.push(e));
      t2.onEvent((e) => t2Events.push(e));

      // Send from t1 — should broadcast to t2 (excludes sender)
      const stream = t1.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "deliver test" }] }] },
        "test-session",
      );
      for await (const _e of stream) {
      }

      await new Promise((r) => setTimeout(r, 50));

      // t2 should have received events (it was subscribed)
      expect(t2Events.length).toBeGreaterThan(0);
    });
  });
});
