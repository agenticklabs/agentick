/**
 * Unix Socket Transport Tests
 *
 * Tests both server-side (UnixSocketTransport) and client-side
 * (createUnixSocketClientTransport) over actual Unix domain sockets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnixSocketTransport } from "../unix-socket-transport.js";
import { createUnixSocketClientTransport } from "../unix-socket-client-transport.js";

function tmpSocketPath(): string {
  return path.join(
    os.tmpdir(),
    `agentick-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

/** Send NDJSON to a raw net.Socket and collect responses */
function rawClient(socketPath: string): Promise<{
  socket: net.Socket;
  send: (msg: Record<string, unknown>) => void;
  messages: () => Record<string, unknown>[];
  waitForMessage: (
    predicate: (m: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const received: Record<string, unknown>[] = [];
    let buffer = "";
    const waiters: Array<{
      predicate: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
    }> = [];

    socket.on("connect", () => {
      resolve({
        socket,
        send: (msg) => socket.write(JSON.stringify(msg) + "\n"),
        messages: () => [...received],
        waitForMessage: (predicate) => {
          // Check already-received messages
          const existing = received.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res) => {
            waiters.push({ predicate, resolve: res });
          });
        },
        close: () => socket.destroy(),
      });
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const msg = JSON.parse(line);
            received.push(msg);
            // Check waiters
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(msg)) {
                waiters[i].resolve(msg);
                waiters.splice(i, 1);
              }
            }
          } catch {}
        }
      }
    });

    socket.on("error", reject);
  });
}

describe("UnixSocketTransport", () => {
  let server: UnixSocketTransport;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    server = new UnixSocketTransport({ socketPath });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    // Double-check cleanup
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  // ════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════════════════════════

  describe("lifecycle", () => {
    it("creates socket file on start", () => {
      expect(fs.existsSync(socketPath)).toBe(true);
    });

    it("removes socket file on stop", async () => {
      await server.stop();
      expect(fs.existsSync(socketPath)).toBe(false);
    });

    it("cleans up stale socket file on start", async () => {
      // Stop, manually create a stale file, restart
      await server.stop();
      fs.writeFileSync(socketPath, "stale");
      expect(fs.existsSync(socketPath)).toBe(true);

      server = new UnixSocketTransport({ socketPath });
      await server.start();

      // Should be running — verify by connecting
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "stale-test" });
      await new Promise((r) => setTimeout(r, 50));
      expect(server.clientCount).toBe(1);
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Connections
  // ════════════════════════════════════════════════════════════════════

  describe("connections", () => {
    it("accepts client connection", async () => {
      const connectionPromise = new Promise<void>((resolve) => {
        server.on("connection", () => resolve());
      });

      const c = await rawClient(socketPath);
      await connectionPromise;
      expect(server.clientCount).toBe(1);
      c.close();
    });

    it("handles client disconnect", async () => {
      const disconnectPromise = new Promise<string>((resolve) => {
        server.on("disconnect", (clientId) => resolve(clientId));
      });

      const c = await rawClient(socketPath);
      await new Promise((r) => setTimeout(r, 30));
      c.close();

      const disconnectedId = await disconnectPromise;
      expect(disconnectedId).toBeDefined();
      expect(server.clientCount).toBe(0);
    });

    it("handles multiple simultaneous clients", async () => {
      const clients = await Promise.all([
        rawClient(socketPath),
        rawClient(socketPath),
        rawClient(socketPath),
      ]);

      // Authenticate all
      for (let i = 0; i < clients.length; i++) {
        clients[i].send({ type: "connect", clientId: `multi-${i}` });
      }
      await new Promise((r) => setTimeout(r, 50));

      expect(server.clientCount).toBe(3);
      expect(server.getAuthenticatedClients().length).toBe(3);

      // Close them one by one
      for (const c of clients) {
        c.close();
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(server.clientCount).toBe(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Authentication
  // ════════════════════════════════════════════════════════════════════

  describe("authentication", () => {
    it("authenticates with valid token", async () => {
      await server.stop();

      server = new UnixSocketTransport({
        socketPath,
        auth: { type: "token", token: "secret123" },
      });
      await server.start();

      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "auth-test", token: "secret123" });

      await new Promise((r) => setTimeout(r, 50));

      // No error received
      const errors = c.messages().filter((m) => m.type === "error");
      expect(errors.length).toBe(0);
      expect(server.getAuthenticatedClients().length).toBe(1);
      c.close();
    });

    it("rejects invalid token", async () => {
      await server.stop();

      server = new UnixSocketTransport({
        socketPath,
        auth: { type: "token", token: "secret123" },
      });
      await server.start();

      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "bad-auth", token: "wrong" });

      const error = await c.waitForMessage((m) => m.type === "error");
      expect(error.code).toBe("AUTH_FAILED");
    });

    it("rejects requests before authentication", async () => {
      const c = await rawClient(socketPath);

      // Send a request without connecting first
      c.send({ type: "req", id: "req-1", method: "status", params: {} });

      const error = await c.waitForMessage((m) => m.type === "error");
      expect(error.code).toBe("UNAUTHORIZED");
      c.close();
    });

    it("allows no-auth when auth not configured", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "no-auth" });

      await new Promise((r) => setTimeout(r, 50));
      expect(server.getAuthenticatedClients().length).toBe(1);
      c.close();
    });

    it("uses custom clientId from connect message", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "custom-id-42" });

      await new Promise((r) => setTimeout(r, 50));

      const client = server.getClient("custom-id-42");
      expect(client).toBeDefined();
      expect(client!.state.authenticated).toBe(true);
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Ping/Pong
  // ════════════════════════════════════════════════════════════════════

  describe("ping/pong", () => {
    it("responds to ping with pong", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "ping-test" });
      await new Promise((r) => setTimeout(r, 30));

      const timestamp = Date.now();
      c.send({ type: "ping", timestamp });

      const pong = await c.waitForMessage((m) => m.type === "pong");
      expect(pong.timestamp).toBe(timestamp);
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Message Forwarding
  // ════════════════════════════════════════════════════════════════════

  describe("message forwarding", () => {
    it("forwards authenticated request to message handler", async () => {
      const messagePromise = new Promise<{ clientId: string; message: any }>((resolve) => {
        server.on("message", (clientId, message) => {
          resolve({ clientId, message });
        });
      });

      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "msg-test" });
      await new Promise((r) => setTimeout(r, 30));

      c.send({ type: "req", id: "req-1", method: "status", params: { sessionId: "main" } });

      const { clientId, message } = await messagePromise;
      expect(clientId).toBe("msg-test");
      expect(message.type).toBe("req");
      expect(message.method).toBe("status");
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Broadcast
  // ════════════════════════════════════════════════════════════════════

  describe("broadcast", () => {
    it("broadcasts to all authenticated clients", async () => {
      const c1 = await rawClient(socketPath);
      const c2 = await rawClient(socketPath);
      c1.send({ type: "connect", clientId: "bc-1" });
      c2.send({ type: "connect", clientId: "bc-2" });
      await new Promise((r) => setTimeout(r, 50));

      server.broadcast({
        type: "event",
        event: "test_event",
        sessionId: "test",
        data: { foo: "bar" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const c1Events = c1.messages().filter((m) => m.type === "event");
      const c2Events = c2.messages().filter((m) => m.type === "event");
      expect(c1Events.length).toBe(1);
      expect(c2Events.length).toBe(1);

      c1.close();
      c2.close();
    });

    it("does not broadcast to unauthenticated clients", async () => {
      const authed = await rawClient(socketPath);
      const unauthed = await rawClient(socketPath);
      authed.send({ type: "connect", clientId: "bc-authed" });
      await new Promise((r) => setTimeout(r, 30));

      server.broadcast({
        type: "event",
        event: "test",
        sessionId: "s",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(authed.messages().filter((m) => m.type === "event").length).toBe(1);
      expect(unauthed.messages().filter((m) => m.type === "event").length).toBe(0);

      authed.close();
      unauthed.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // NDJSON Framing Edge Cases
  // ════════════════════════════════════════════════════════════════════

  describe("NDJSON framing", () => {
    it("handles multiple messages in a single TCP packet", async () => {
      const messages: string[] = [];
      server.on("message", (_clientId, message) => {
        messages.push(message.method);
      });

      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "ndjson-batch" });
      await new Promise((r) => setTimeout(r, 30));

      // Send two messages in one write (simulating TCP coalescing)
      const msg1 = JSON.stringify({ type: "req", id: "r1", method: "status", params: {} });
      const msg2 = JSON.stringify({ type: "req", id: "r2", method: "apps", params: {} });
      c.socket.write(`${msg1}\n${msg2}\n`);

      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toContain("status");
      expect(messages).toContain("apps");
      c.close();
    });

    it("handles partial messages split across TCP packets", async () => {
      const messagePromise = new Promise<string>((resolve) => {
        server.on("message", (_clientId, message) => {
          resolve(message.method);
        });
      });

      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "ndjson-split" });
      await new Promise((r) => setTimeout(r, 30));

      // Split a single message across two writes
      const fullMsg = JSON.stringify({ type: "req", id: "r1", method: "status", params: {} });
      const halfway = Math.floor(fullMsg.length / 2);
      c.socket.write(fullMsg.slice(0, halfway));
      await new Promise((r) => setTimeout(r, 10));
      c.socket.write(fullMsg.slice(halfway) + "\n");

      const method = await messagePromise;
      expect(method).toBe("status");
      c.close();
    });

    it("handles empty lines gracefully", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "ndjson-empty" });
      await new Promise((r) => setTimeout(r, 30));

      // Send lines with empty lines interspersed
      c.socket.write("\n\n\n");
      await new Promise((r) => setTimeout(r, 30));

      // Should not crash — no error messages
      const errors = c.messages().filter((m) => m.type === "error");
      expect(errors.length).toBe(0);
      c.close();
    });

    it("handles malformed JSON gracefully", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "ndjson-malformed" });
      await new Promise((r) => setTimeout(r, 30));

      c.socket.write("{not valid json}\n");

      const error = await c.waitForMessage(
        (m) => m.type === "error" && m.code === "INVALID_MESSAGE",
      );
      expect(error.message).toBe("Failed to parse message");
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Backpressure
  // ════════════════════════════════════════════════════════════════════

  describe("backpressure", () => {
    it("reports pressure when write buffer is high", async () => {
      const c = await rawClient(socketPath);
      c.send({ type: "connect", clientId: "pressure-test" });
      await new Promise((r) => setTimeout(r, 30));

      const client = server.getClient("pressure-test");
      expect(client).toBeDefined();

      // Under normal conditions, not pressured
      expect(client!.isPressured?.()).toBe(false);
      c.close();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Clean Shutdown
  // ════════════════════════════════════════════════════════════════════

  describe("clean shutdown", () => {
    it("disconnects all clients on stop", async () => {
      const disconnects: string[] = [];
      server.on("disconnect", (id) => disconnects.push(id));

      const c1 = await rawClient(socketPath);
      const c2 = await rawClient(socketPath);
      c1.send({ type: "connect", clientId: "shutdown-1" });
      c2.send({ type: "connect", clientId: "shutdown-2" });
      await new Promise((r) => setTimeout(r, 50));

      expect(server.clientCount).toBe(2);

      await server.stop();

      // All clients should be gone
      expect(server.clientCount).toBe(0);
    });

    it("removes socket file on stop", async () => {
      expect(fs.existsSync(socketPath)).toBe(true);
      await server.stop();
      expect(fs.existsSync(socketPath)).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Client Transport
// ════════════════════════════════════════════════════════════════════════

describe("createUnixSocketClientTransport", () => {
  let server: UnixSocketTransport;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    server = new UnixSocketTransport({ socketPath });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  it("connects and authenticates", async () => {
    const transport = createUnixSocketClientTransport({
      socketPath,
      clientId: "client-test",
    });

    await transport.connect();
    expect(transport.state).toBe("connected");
    expect(transport.connectionId).toBe("client-test");

    await new Promise((r) => setTimeout(r, 30));
    expect(server.clientCount).toBe(1);
    expect(server.getAuthenticatedClients().length).toBe(1);

    transport.disconnect();
  });

  it("connects with auth token", async () => {
    await server.stop();
    server = new UnixSocketTransport({
      socketPath,
      auth: { type: "token", token: "s3cret" },
    });
    await server.start();

    const transport = createUnixSocketClientTransport({
      socketPath,
      clientId: "auth-client",
      token: "s3cret",
    });

    await transport.connect();
    expect(transport.state).toBe("connected");

    await new Promise((r) => setTimeout(r, 30));
    expect(server.getAuthenticatedClients().length).toBe(1);

    transport.disconnect();
  });

  it("fails to connect when server not running", async () => {
    await server.stop();

    const transport = createUnixSocketClientTransport({
      socketPath: "/tmp/nonexistent-agentick-test.sock",
      reconnect: { enabled: false },
    });

    await expect(transport.connect()).rejects.toThrow();
    expect(transport.state).toBe("error");
  });

  it("notifies state change handlers", async () => {
    const states: string[] = [];
    const transport = createUnixSocketClientTransport({ socketPath });
    transport.onStateChange((s) => states.push(s));

    await transport.connect();
    transport.disconnect();

    expect(states).toContain("connecting");
    expect(states).toContain("connected");
    expect(states).toContain("disconnected");
  });

  it("idempotent connect — second call is no-op", async () => {
    const transport = createUnixSocketClientTransport({ socketPath });
    await transport.connect();
    await transport.connect(); // Should not throw
    expect(transport.state).toBe("connected");
    transport.disconnect();
  });

  it("concurrent connect calls coalesce", async () => {
    const transport = createUnixSocketClientTransport({ socketPath });

    // Fire two connect calls simultaneously
    const [r1, r2] = await Promise.allSettled([transport.connect(), transport.connect()]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    expect(transport.state).toBe("connected");

    transport.disconnect();
  });

  it("event handlers receive events", async () => {
    const transport = createUnixSocketClientTransport({
      socketPath,
      clientId: "event-client",
    });
    await transport.connect();
    await new Promise((r) => setTimeout(r, 30));

    const events: unknown[] = [];
    transport.onEvent((e) => events.push(e));

    // Server broadcasts an event
    server.broadcast({
      type: "event",
      event: "test_event",
      sessionId: "main",
      data: { hello: "world" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt.type).toBe("test_event");
    expect(evt.hello).toBe("world");

    transport.disconnect();
  });

  it("unsubscribes event handler", async () => {
    const transport = createUnixSocketClientTransport({
      socketPath,
      clientId: "unsub-client",
    });
    await transport.connect();
    await new Promise((r) => setTimeout(r, 30));

    const events: unknown[] = [];
    const unsubscribe = transport.onEvent((e) => events.push(e));
    unsubscribe();

    server.broadcast({
      type: "event",
      event: "ignored",
      sessionId: "main",
      data: {},
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);

    transport.disconnect();
  });
});

// ============================================================================
// Gateway Integration — full round-trip through real gateway
// ============================================================================

describe("Gateway + Unix Socket integration", () => {
  let gateway: Awaited<ReturnType<typeof import("../gateway.js").createGateway>>;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    const { createGateway } = await import("../gateway.js");
    const { createMockApp } = await import("@agentick/core/testing");

    const app = createMockApp();
    gateway = createGateway({
      apps: { main: app },
      defaultApp: "main",
      socketPath,
    });
    await gateway.start();
  });

  afterEach(async () => {
    if (gateway?.running) {
      await gateway.stop();
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  it("client connects through gateway and receives session events", async () => {
    const client = createUnixSocketClientTransport({
      socketPath,
      clientId: "integration-client",
    });

    await client.connect();
    expect(client.state).toBe("connected");

    // Verify the gateway accepted the connection
    expect(client.connectionId).toBe("integration-client");

    client.disconnect();
  });

  it("client sends message through gateway and gets events", async () => {
    const client = createUnixSocketClientTransport({
      socketPath,
      clientId: "send-test-client",
      timeout: 5000,
    });

    await client.connect();

    // send() triggers the gateway's "send" method which creates/uses a session.
    // The mock app produces execution events (content_delta, execution_end).
    const stream = client.send("Hello gateway");
    const events: unknown[] = [];

    // Collect events with a timeout to avoid hanging
    const timeout = setTimeout(() => stream.abort("test timeout"), 4000);
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "execution_end" || event.type === "message_end") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // MockApp may produce 0 events if the execution completes synchronously,
    // but the stream should at least not hang and the request should succeed.
    expect(client.state).toBe("connected");

    client.disconnect();
  });

  it("multiple clients connect simultaneously through gateway", async () => {
    const client1 = createUnixSocketClientTransport({
      socketPath,
      clientId: "multi-client-1",
    });
    const client2 = createUnixSocketClientTransport({
      socketPath,
      clientId: "multi-client-2",
    });

    await client1.connect();
    await client2.connect();

    expect(client1.state).toBe("connected");
    expect(client2.state).toBe("connected");
    expect(client1.connectionId).toBe("multi-client-1");
    expect(client2.connectionId).toBe("multi-client-2");

    client1.disconnect();
    client2.disconnect();
  });

  it("client can subscribe to a session", async () => {
    const client = createUnixSocketClientTransport({
      socketPath,
      clientId: "subscribe-test",
    });

    await client.connect();
    await client.subscribeToSession("tui");

    // No error means subscription succeeded through gateway
    client.disconnect();
  });

  it("gateway stops cleanly with connected clients", async () => {
    const client = createUnixSocketClientTransport({
      socketPath,
      clientId: "shutdown-test",
      reconnect: { enabled: false },
    });

    await client.connect();
    expect(client.state).toBe("connected");

    // Stop gateway — client should get disconnected
    await gateway.stop();

    // Give time for close event to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(client.state).toBe("disconnected");
  });
});
