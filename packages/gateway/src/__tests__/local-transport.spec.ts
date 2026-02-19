/**
 * Local Gateway Transport Tests
 *
 * Tests the in-process transport layer that bridges local clients
 * to the gateway's multi-app session management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ClientTransport, TransportEventData } from "@agentick/shared";
import { Gateway, createGateway } from "../gateway.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";

describe("Local Gateway Transport", () => {
  let gateway: Gateway;
  let chatApp: MockApp;
  let researchApp: MockApp;

  beforeEach(() => {
    chatApp = createMockApp();
    researchApp = createMockApp();
  });

  afterEach(async () => {
    if (gateway?.running) {
      await gateway.stop();
    }
  });

  function createTestGateway(opts?: { embedded?: boolean }) {
    gateway = createGateway({
      apps: { chat: chatApp, research: researchApp },
      defaultApp: "chat",
      embedded: opts?.embedded ?? true,
    });
    return gateway;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  describe("connection lifecycle", () => {
    it("creates a transport in disconnected state", () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();

      expect(transport.state).toBe("disconnected");
      expect(transport.connectionId).toBeDefined();
    });

    it("connects and transitions to connected state", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();

      await transport.connect();
      expect(transport.state).toBe("connected");
    });

    it("disconnects and transitions back to disconnected state", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();

      await transport.connect();
      transport.disconnect();
      expect(transport.state).toBe("disconnected");
    });

    it("fires state change handlers on connect/disconnect", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      const states: string[] = [];

      transport.onStateChange((state) => states.push(state));
      await transport.connect();
      transport.disconnect();

      expect(states).toEqual(["connected", "disconnected"]);
    });

    it("unsubscribes state change handler on cleanup", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      const states: string[] = [];

      const unsub = transport.onStateChange((state) => states.push(state));
      unsub();

      await transport.connect();
      expect(states).toEqual([]);
    });

    it("counts local clients in gateway status", () => {
      const gw = createTestGateway();
      expect(gw.status.clients).toBe(0);

      gw.createLocalTransport();
      expect(gw.status.clients).toBe(1);

      gw.createLocalTransport();
      expect(gw.status.clients).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Session Routing
  // ══════════════════════════════════════════════════════════════════════════

  describe("session routing", () => {
    it("sends to default app when no app prefix", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const events: TransportEventData[] = [];
      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        "main",
      );

      for await (const event of stream) {
        events.push(event);
      }

      // Mock sends content_delta + message_end
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].sessionId).toBe("main");

      // Should have created a session on the chat app (default)
      expect(chatApp.has("main")).toBe(true);
      expect(researchApp.has("main")).toBe(false);
    });

    it("routes to correct app with app-prefixed session key", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "search" }] }] },
        "research:task-1",
      );

      for await (const _event of stream) {
        // drain
      }

      expect(researchApp.has("task-1")).toBe(true);
      expect(chatApp.has("task-1")).toBe(false);
    });

    it("handles session keys with colons in name", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "chat:my:complex:session",
      );

      for await (const _event of stream) {
        // drain
      }

      // parseSessionKey("chat:my:complex:session") → appId="chat", sessionName="my:complex:session"
      expect(chatApp.has("my:complex:session")).toBe(true);
    });

    it("defaults to 'main' session when no sessionId provided", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      for await (const _event of stream) {
        // drain
      }

      expect(chatApp.has("main")).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Session Operations
  // ══════════════════════════════════════════════════════════════════════════

  describe("session operations", () => {
    it("dispatches tool calls", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // Ensure session exists first
      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      const result = await transport.dispatch!("main", "test-tool", { q: "foo" });
      expect(result).toEqual([{ type: "text", text: "mock" }]);
    });

    it("closes sessions via closeSession", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // Create a session
      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      // Session exists in gateway
      expect(gw.status.sessions).toBe(1);

      let closedEvent: any = null;
      gw.on("session:closed", (payload) => {
        closedEvent = payload;
      });

      await transport.closeSession("main");

      // Gateway emits session:closed and cleans up
      expect(closedEvent).toEqual({ sessionId: "main" });
      expect(gw.status.sessions).toBe(0);
    });

    it("subscribes and unsubscribes from sessions", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      await transport.subscribeToSession("chat:main");
      // No error means success

      await transport.unsubscribeFromSession("chat:main");
      // No error means success
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cross-client Push Events
  // ══════════════════════════════════════════════════════════════════════════

  describe("cross-client push events", () => {
    it("pushes events from one client to another subscribed client", async () => {
      const gw = createTestGateway();
      const transportA = gw.createLocalTransport();
      const transportB = gw.createLocalTransport();
      await transportA.connect();
      await transportB.connect();

      // A subscribes to session events
      await transportA.subscribeToSession("main");

      // Collect events pushed to A via onEvent
      const pushedEvents: TransportEventData[] = [];
      transportA.onEvent((event) => {
        pushedEvents.push(event);
      });

      // B sends to the same session → events should be pushed to A
      const stream = transportB.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello from B" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain B's direct stream
      }

      // A should have received push events via onEvent
      // (B auto-subscribes and also gets events, but we're checking A)
      expect(pushedEvents.length).toBeGreaterThan(0);
      expect(pushedEvents[0].sessionId).toBe("main");
    });

    it("only subscribers receive push events", async () => {
      const gw = createTestGateway();
      const transportA = gw.createLocalTransport();
      const transportB = gw.createLocalTransport();
      const transportC = gw.createLocalTransport();
      await transportA.connect();
      await transportB.connect();
      await transportC.connect();

      // A subscribes, C does not
      await transportA.subscribeToSession("main");

      const eventsA: TransportEventData[] = [];
      const eventsC: TransportEventData[] = [];
      transportA.onEvent((e) => eventsA.push(e));
      transportC.onEvent((e) => eventsC.push(e));

      // B sends
      const stream = transportB.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      expect(eventsA.length).toBeGreaterThan(0);
      expect(eventsC.length).toBe(0);
    });

    it("stops receiving push events after unsubscribe", async () => {
      const gw = createTestGateway();
      const transportA = gw.createLocalTransport();
      const transportB = gw.createLocalTransport();
      await transportA.connect();
      await transportB.connect();

      await transportA.subscribeToSession("main");

      const events: TransportEventData[] = [];
      transportA.onEvent((e) => events.push(e));

      // Unsubscribe A
      await transportA.unsubscribeFromSession("main");

      // B sends
      const stream = transportB.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      expect(events.length).toBe(0);
    });

    it("sender does not receive double-dispatched events via onEvent", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // Sender subscribes and registers onEvent handler
      await transport.subscribeToSession("main");

      const pushEvents: TransportEventData[] = [];
      transport.onEvent((e) => pushEvents.push(e));

      // Sender sends — gets events through direct iteration only
      const directEvents: TransportEventData[] = [];
      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        "main",
      );
      for await (const e of stream) {
        directEvents.push(e);
      }

      // Direct events from iteration: should have content
      expect(directEvents.length).toBeGreaterThan(0);

      // Push events via onEvent: sender should NOT receive them
      // (would be double-dispatch if they did)
      expect(pushEvents.length).toBe(0);
    });

    it("unsubscribes all on disconnect", async () => {
      const gw = createTestGateway();
      const transportA = gw.createLocalTransport();
      const transportB = gw.createLocalTransport();
      await transportA.connect();
      await transportB.connect();

      await transportA.subscribeToSession("main");

      const events: TransportEventData[] = [];
      transportA.onEvent((e) => events.push(e));

      // Disconnect A → should trigger unsubscribeAll
      transportA.disconnect();

      // B sends
      const stream = transportB.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      // A should not receive events after disconnect
      expect(events.length).toBe(0);
    });

    it("cleans up onEvent handlers on disconnect", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      let callCount = 0;
      transport.onEvent(() => {
        callCount++;
      });

      transport.disconnect();

      // After disconnect, the client's handlers should be cleared
      // Even if something tried to push events, they wouldn't fire
      expect(callCount).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Multiple Local Transports
  // ══════════════════════════════════════════════════════════════════════════

  describe("multiple local transports", () => {
    it("shares a single LocalGatewayTransport for multiple clients", () => {
      const gw = createTestGateway();

      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();

      // Different connection IDs
      expect(t1.connectionId).not.toBe(t2.connectionId);

      // Both counted
      expect(gw.status.clients).toBe(2);
    });

    it("each client operates independently", async () => {
      const gw = createTestGateway();
      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();
      await t1.connect();
      await t2.connect();

      // t1 sends to one session
      const s1 = t1.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "t1" }] }] },
        "session-1",
      );
      for await (const _e of s1) {
        // drain
      }

      // t2 sends to another session
      const s2 = t2.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "t2" }] }] },
        "session-2",
      );
      for await (const _e of s2) {
        // drain
      }

      // Both sessions created on default app
      expect(chatApp.has("session-1")).toBe(true);
      expect(chatApp.has("session-2")).toBe(true);
    });

    it("disconnect one client does not affect others", async () => {
      const gw = createTestGateway();
      const t1 = gw.createLocalTransport();
      const t2 = gw.createLocalTransport();
      await t1.connect();
      await t2.connect();

      t1.disconnect();

      // t2 still works
      const stream = t2.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );
      const events: TransportEventData[] = [];
      for await (const e of stream) {
        events.push(e);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(gw.status.clients).toBe(1); // only t2 remains
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial / Edge Cases
  // ══════════════════════════════════════════════════════════════════════════

  describe("adversarial", () => {
    it("errors on send to non-existent app", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "nonexistent:main",
      );

      await expect(async () => {
        for await (const _e of stream) {
          // drain
        }
      }).rejects.toThrow(/Unknown app/);
    });

    it("concurrent sends to same session both complete", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      async function drainStream(sessionId: string): Promise<TransportEventData[]> {
        const events: TransportEventData[] = [];
        const stream = transport.send(
          { messages: [{ role: "user", content: [{ type: "text", text: `msg-${sessionId}` }] }] },
          sessionId,
        );
        for await (const e of stream) {
          events.push(e);
        }
        return events;
      }

      // Send concurrently to the same session
      const [events1, events2] = await Promise.all([drainStream("main"), drainStream("main")]);

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
    });

    it("abort before execution starts", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );

      // Abort immediately
      stream.abort("cancelled");

      const events: TransportEventData[] = [];
      for await (const e of stream) {
        events.push(e);
      }

      // Stream should complete without or with very few events
      // The abort may or may not take effect depending on timing
      // but it should NOT throw
    });

    it("abort after execution completes is a no-op", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      const stream = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );

      // Drain first
      for await (const _e of stream) {
        // drain
      }

      // Abort after completion — should not throw
      stream.abort("too late");
    });

    it("re-creates terminal sessions automatically", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();
      await transport.connect();

      // Create and use a session
      const s1 = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        "main",
      );
      for await (const _e of s1) {
        // drain
      }

      // Close the session → makes it terminal
      await transport.closeSession("main");

      // Send again → should create a fresh session, not error
      const s2 = transport.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello again" }] }] },
        "main",
      );
      const events: TransportEventData[] = [];
      for await (const e of s2) {
        events.push(e);
      }

      expect(events.length).toBeGreaterThan(0);
    });

    it("onEvent handler removal works correctly", async () => {
      const gw = createTestGateway();
      const transportA = gw.createLocalTransport();
      const transportB = gw.createLocalTransport();
      await transportA.connect();
      await transportB.connect();

      await transportA.subscribeToSession("main");

      const events: TransportEventData[] = [];
      const unsub = transportA.onEvent((e) => events.push(e));

      // Remove handler
      unsub();

      // B sends
      const stream = transportB.send(
        { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] },
        "main",
      );
      for await (const _e of stream) {
        // drain
      }

      // A's handler was removed, should not receive events
      expect(events.length).toBe(0);
    });

    it("gateway.session() caches and reuses sessions", async () => {
      const gw = createTestGateway();

      const session1 = await gw.session("main");
      const session2 = await gw.session("main");

      // Same session object returned (cached in SessionManager)
      expect(session1).toBe(session2);
    });

    it("gateway stop cleans up local transport clients", async () => {
      const gw = createTestGateway({ embedded: false });
      await gw.start();

      const transport = gw.createLocalTransport();
      await transport.connect();

      expect(gw.status.clients).toBe(1);

      await gw.stop();

      expect(gw.status.clients).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Integration with Gateway Public API
  // ══════════════════════════════════════════════════════════════════════════

  describe("gateway public session API", () => {
    it("gateway.session() creates session on correct app", async () => {
      const gw = createTestGateway();

      await gw.session("research:analysis");
      expect(researchApp.has("analysis")).toBe(true);
      expect(chatApp.has("analysis")).toBe(false);
    });

    it("gateway.closeSession() emits session:closed event", async () => {
      const gw = createTestGateway();

      // Create session first
      await gw.session("main");

      let closedEvent: any = null;
      gw.on("session:closed", (payload) => {
        closedEvent = payload;
      });

      await gw.closeSession("main");
      expect(closedEvent).toEqual({ sessionId: "main" });
    });

    it("gateway.subscribe/unsubscribe manages session subscriptions", async () => {
      const gw = createTestGateway();
      const transport = gw.createLocalTransport();

      await gw.subscribe("main", transport.connectionId!);
      // No error means success

      gw.unsubscribe("main", transport.connectionId!);
      // No error means success
    });
  });
});
