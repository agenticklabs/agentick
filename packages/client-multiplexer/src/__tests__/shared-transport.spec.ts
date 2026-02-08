/**
 * Shared Transport Tests
 *
 * Tests the SharedTransport in Node.js environment where navigator.locks
 * isn't available, so it uses the BroadcastChannel fallback for leader election.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SharedTransport, createSharedTransport } from "../shared-transport";
import type { TransportState } from "@agentick/client";

// Mock BroadcastChannel
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown) {
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && instance.onmessage) {
        instance.onmessage(new MessageEvent("message", { data }));
      }
    }
  }

  close() {
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }

  static reset() {
    MockBroadcastChannel.instances = [];
  }
}

describe("SharedTransport", () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates transport with correct initial state", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });

    expect(transport.state).toBe("disconnected");
    expect(transport.isLeader).toBe(false);
    expect(transport.tabId).toBeTruthy();
  });

  it("has unique tabId per instance", () => {
    const transport1 = createSharedTransport({ baseUrl: "https://api.example.com" });
    const transport2 = createSharedTransport({ baseUrl: "https://api.example.com" });

    expect(transport1.tabId).not.toBe(transport2.tabId);
  });

  it("onStateChange registers handler", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });
    const states: TransportState[] = [];

    const cleanup = transport.onStateChange((state) => states.push(state));

    expect(typeof cleanup).toBe("function");
  });

  it("cleanup removes handler", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });
    const events: unknown[] = [];

    const cleanup = transport.onEvent((e) => events.push(e));
    cleanup();

    expect(events).toHaveLength(0);
  });

  it("onLeadershipChange registers handler", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });
    const changes: boolean[] = [];

    const cleanup = transport.onLeadershipChange((isLeader) => changes.push(isLeader));

    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("disconnect sets state to disconnected", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });

    transport.disconnect();

    expect(transport.state).toBe("disconnected");
    expect(transport.connectionId).toBeUndefined();
  });
});

describe("SharedTransport factory", () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createSharedTransport returns SharedTransport instance", () => {
    const transport = createSharedTransport({ baseUrl: "https://api.example.com" });

    expect(transport).toBeInstanceOf(SharedTransport);
  });

  it("accepts config options", () => {
    const transport = createSharedTransport({
      baseUrl: "https://api.example.com",
      token: "secret-token",
      timeout: 5000,
    });

    expect(transport).toBeDefined();
    expect(transport.state).toBe("disconnected");
  });

  it("accepts WebSocket config options", () => {
    const transport = createSharedTransport({
      baseUrl: "wss://api.example.com",
      token: "secret-token",
      clientId: "my-client",
      reconnect: {
        enabled: true,
        maxAttempts: 3,
        delay: 500,
      },
    });

    expect(transport).toBeDefined();
    expect(transport.state).toBe("disconnected");
  });

  it("accepts explicit transport type", () => {
    const transport = createSharedTransport({
      baseUrl: "https://api.example.com",
      transport: "websocket",
    });

    expect(transport).toBeDefined();
  });
});
