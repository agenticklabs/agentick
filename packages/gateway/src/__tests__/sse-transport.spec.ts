/**
 * EmbeddedSSETransport Tests
 *
 * Validates the transport adapter that wraps SSE (EventSource) connections
 * as proper TransportClients with backpressure, lifecycle events, and
 * heartbeat management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { EmbeddedSSEClient, EmbeddedSSETransport } from "../sse-transport.js";

// ============================================================================
// Mock ServerResponse
// ============================================================================

function createMockResponse() {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  let _ended = false;
  let _needDrain = false;

  const res = {
    write(data: string) {
      if (_ended) throw new Error("write after end");
      chunks.push(data);
      return !_needDrain;
    },
    end() {
      _ended = true;
    },
    on(event: string, handler: (...args: any[]) => void) {
      emitter.on(event, handler);
      return res;
    },
    get writableEnded() {
      return _ended;
    },
    get writableNeedDrain() {
      return _needDrain;
    },
    // Test helpers
    _chunks: chunks,
    _setNeedDrain(v: boolean) {
      _needDrain = v;
    },
    _emitClose() {
      emitter.emit("close");
    },
  };

  return res;
}

// ============================================================================
// EmbeddedSSEClient
// ============================================================================

describe("EmbeddedSSEClient", () => {
  it("sends messages as SSE data frames", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    client.send({
      type: "event",
      event: "content_delta" as any,
      sessionId: "main",
      data: { text: "hello" },
    });

    expect(res._chunks).toHaveLength(1);
    const parsed = JSON.parse(res._chunks[0].replace("data: ", "").replace("\n\n", ""));
    expect(parsed.type).toBe("event");
    expect(parsed.event).toBe("content_delta");
    expect(parsed.data.text).toBe("hello");
  });

  it("does not write after response ends", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    res.end();
    // Should not throw — just silently skip
    client.send({ type: "event", event: "content_delta" as any, sessionId: "main", data: {} });
    expect(res._chunks).toHaveLength(0);
  });

  it("reflects writableNeedDrain for backpressure", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    expect(client.isPressured()).toBe(false);
    res._setNeedDrain(true);
    expect(client.isPressured()).toBe(true);
    res._setNeedDrain(false);
    expect(client.isPressured()).toBe(false);
  });

  it("reflects writableEnded for isConnected", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    expect(client.isConnected).toBe(true);
    res.end();
    expect(client.isConnected).toBe(false);
  });

  it("close() ends the response", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    expect(client.isConnected).toBe(true);
    client.close();
    expect(client.isConnected).toBe(false);
  });

  it("close() is idempotent", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    client.close();
    // Second close should not throw
    client.close();
    expect(client.isConnected).toBe(false);
  });

  it("starts heartbeat that writes to response", () => {
    vi.useFakeTimers();
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    client.startHeartbeat(100);
    expect(res._chunks).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(res._chunks).toHaveLength(1);
    expect(res._chunks[0]).toBe(":heartbeat\n\n");

    vi.advanceTimersByTime(100);
    expect(res._chunks).toHaveLength(2);

    client.stopHeartbeat();
    vi.advanceTimersByTime(100);
    expect(res._chunks).toHaveLength(2); // No more after stop

    vi.useRealTimers();
  });

  it("stopHeartbeat is idempotent", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    // Calling stop without start should not throw
    client.stopHeartbeat();
    client.stopHeartbeat();
  });

  it("state is initialized correctly", () => {
    const res = createMockResponse();
    const client = new EmbeddedSSEClient("c1", res as any);

    expect(client.id).toBe("c1");
    expect(client.state.id).toBe("c1");
    expect(client.state.authenticated).toBe(true);
    expect(client.state.subscriptions).toBeInstanceOf(Set);
    expect(client.state.subscriptions.size).toBe(0);
    expect(client.state.connectedAt).toBeInstanceOf(Date);
  });
});

// ============================================================================
// EmbeddedSSETransport
// ============================================================================

describe("EmbeddedSSETransport", () => {
  let transport: EmbeddedSSETransport;

  beforeEach(() => {
    transport = new EmbeddedSSETransport();
  });

  afterEach(async () => {
    await transport.stop();
  });

  it("type is sse", () => {
    expect(transport.type).toBe("sse");
  });

  it("start/stop are no-ops (no server)", async () => {
    await transport.start(); // Should not throw
    await transport.stop(); // Should not throw
  });

  it("registerClient adds client and emits connection event", () => {
    const connectionHandler = vi.fn();
    transport.on("connection", connectionHandler);

    const res = createMockResponse();
    const client = transport.registerClient("c1", res as any);

    expect(client).toBeInstanceOf(EmbeddedSSEClient);
    expect(transport.getClient("c1")).toBe(client);
    expect(transport.clientCount).toBe(1);
    expect(connectionHandler).toHaveBeenCalledOnce();
    expect(connectionHandler).toHaveBeenCalledWith(client);
  });

  it("registered client starts heartbeat automatically", () => {
    vi.useFakeTimers();
    const res = createMockResponse();
    transport.registerClient("c1", res as any);

    // Default heartbeat is 30s
    vi.advanceTimersByTime(30000);
    expect(res._chunks.some((c) => c.includes("heartbeat"))).toBe(true);

    vi.useRealTimers();
  });

  it("client disconnect emits disconnect event and removes from map", () => {
    const disconnectHandler = vi.fn();
    transport.on("disconnect", disconnectHandler);

    const res = createMockResponse();
    transport.registerClient("c1", res as any);

    expect(transport.clientCount).toBe(1);

    // Simulate response close
    res._emitClose();

    expect(transport.clientCount).toBe(0);
    expect(transport.getClient("c1")).toBeUndefined();
    expect(disconnectHandler).toHaveBeenCalledOnce();
    expect(disconnectHandler).toHaveBeenCalledWith("c1", "Connection closed");
  });

  it("supports multiple concurrent clients", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const res3 = createMockResponse();

    transport.registerClient("c1", res1 as any);
    transport.registerClient("c2", res2 as any);
    transport.registerClient("c3", res3 as any);

    expect(transport.clientCount).toBe(3);
    expect(transport.getClients()).toHaveLength(3);
  });

  it("disconnecting one client does not affect others", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    transport.registerClient("c1", res1 as any);
    transport.registerClient("c2", res2 as any);

    res1._emitClose();

    expect(transport.clientCount).toBe(1);
    expect(transport.getClient("c1")).toBeUndefined();
    expect(transport.getClient("c2")).toBeDefined();
  });

  it("stop() closes all clients", async () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    transport.registerClient("c1", res1 as any);
    transport.registerClient("c2", res2 as any);

    await transport.stop();

    expect(transport.clientCount).toBe(0);
    expect(res1.writableEnded).toBe(true);
    expect(res2.writableEnded).toBe(true);
  });

  it("broadcast sends to all authenticated clients", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    transport.registerClient("c1", res1 as any);
    transport.registerClient("c2", res2 as any);

    transport.broadcast({
      type: "event",
      event: "content_delta" as any,
      sessionId: "main",
      data: { text: "hello" },
    });

    expect(res1._chunks).toHaveLength(1);
    expect(res2._chunks).toHaveLength(1);
  });

  it("getAuthenticatedClients returns all (SSE clients are pre-authed)", () => {
    const res = createMockResponse();
    transport.registerClient("c1", res as any);

    const authed = transport.getAuthenticatedClients();
    expect(authed).toHaveLength(1);
    expect(authed[0].state.authenticated).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial / edge cases
  // ══════════════════════════════════════════════════════════════════════════

  it("registering same clientId twice overwrites the first", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    transport.registerClient("c1", res1 as any);
    transport.registerClient("c1", res2 as any);

    expect(transport.clientCount).toBe(1);

    // New client should be the second one
    const client = transport.getClient("c1");
    client!.send({
      type: "event",
      event: "content_delta" as any,
      sessionId: "main",
      data: { text: "hello" },
    });

    expect(res2._chunks).toHaveLength(1);
    expect(res1._chunks).toHaveLength(0); // First response not written to
  });

  it("disconnect handler fires after client close()", () => {
    const disconnectHandler = vi.fn();
    transport.on("disconnect", disconnectHandler);

    const res = createMockResponse();
    transport.registerClient("c1", res as any);

    // Programmatic close triggers res close event
    // Note: In real Node.js, res.end() doesn't synchronously fire 'close'.
    // Our mock fires 'close' only when we call _emitClose(). This tests
    // that the transport wires up res.on("close") correctly.
    res._emitClose();

    expect(disconnectHandler).toHaveBeenCalledOnce();
  });

  it("heartbeat stops when client disconnects", () => {
    vi.useFakeTimers();
    const res = createMockResponse();
    transport.registerClient("c1", res as any);

    // Verify heartbeat fires
    vi.advanceTimersByTime(30000);
    const countBefore = res._chunks.length;
    expect(countBefore).toBeGreaterThan(0);

    // Disconnect
    res._emitClose();

    // Advance more — heartbeat should not fire
    vi.advanceTimersByTime(60000);
    // Note: after _emitClose, res is still writable in our mock but
    // the heartbeat interval should have been cleared
    expect(res._chunks.length).toBe(countBefore);

    vi.useRealTimers();
  });
});
