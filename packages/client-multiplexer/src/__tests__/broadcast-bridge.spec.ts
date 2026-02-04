/**
 * Broadcast Bridge Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBroadcastBridge, generateRequestId, type BridgeMessage } from "../broadcast-bridge";

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
    // Broadcast to all other instances with same name
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

describe("BroadcastBridge", () => {
  let originalBroadcastChannel: typeof BroadcastChannel;

  beforeEach(() => {
    MockBroadcastChannel.reset();
    originalBroadcastChannel = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = MockBroadcastChannel as any;
  });

  afterEach(() => {
    globalThis.BroadcastChannel = originalBroadcastChannel;
  });

  it("creates bridge with tabId", () => {
    const bridge = createBroadcastBridge("test", "tab-1");
    expect(bridge.tabId).toBe("tab-1");
  });

  it("broadcasts messages to other tabs", () => {
    const bridge1 = createBroadcastBridge("test", "tab-1");
    const bridge2 = createBroadcastBridge("test", "tab-2");

    const received: BridgeMessage[] = [];
    bridge2.onMessage((msg) => received.push(msg));

    bridge1.broadcast({ type: "leader:ready", tabId: "tab-1" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "leader:ready", tabId: "tab-1" });
  });

  it("does not receive own messages", () => {
    const bridge = createBroadcastBridge("test", "tab-1");

    const received: BridgeMessage[] = [];
    bridge.onMessage((msg) => received.push(msg));

    bridge.broadcast({ type: "leader:ready", tabId: "tab-1" });

    expect(received).toHaveLength(0);
  });

  it("collects responses within timeout", async () => {
    const bridge1 = createBroadcastBridge("test", "tab-1");
    const bridge2 = createBroadcastBridge("test", "tab-2");
    const bridge3 = createBroadcastBridge("test", "tab-3");

    // Tab 2 and 3 respond to leader:ready
    bridge2.onMessage((msg) => {
      if (msg.type === "leader:ready") {
        bridge2.broadcast({
          type: "subscriptions:announce",
          tabId: "tab-2",
          sessions: ["session-a"],
          channels: [],
        });
      }
    });

    bridge3.onMessage((msg) => {
      if (msg.type === "leader:ready") {
        bridge3.broadcast({
          type: "subscriptions:announce",
          tabId: "tab-3",
          sessions: ["session-b"],
          channels: ["session-b:chat"],
        });
      }
    });

    // Tab 1 asks for subscriptions and collects responses
    const collectPromise = bridge1.collectResponses<{
      type: "subscriptions:announce";
      tabId: string;
      sessions: string[];
      channels: string[];
    }>("subscriptions:announce", 100);

    bridge1.broadcast({ type: "leader:ready", tabId: "tab-1" });

    const responses = await collectPromise;

    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.tabId).sort()).toEqual(["tab-2", "tab-3"]);
  });

  it("cleanup removes handler", () => {
    const bridge1 = createBroadcastBridge("test", "tab-1");
    const bridge2 = createBroadcastBridge("test", "tab-2");

    const received: BridgeMessage[] = [];
    const cleanup = bridge2.onMessage((msg) => received.push(msg));

    cleanup();

    bridge1.broadcast({ type: "leader:ready", tabId: "tab-1" });

    expect(received).toHaveLength(0);
  });

  it("close stops receiving messages", () => {
    const bridge1 = createBroadcastBridge("test", "tab-1");
    const bridge2 = createBroadcastBridge("test", "tab-2");

    const received: BridgeMessage[] = [];
    bridge2.onMessage((msg) => received.push(msg));

    bridge2.close();

    bridge1.broadcast({ type: "leader:ready", tabId: "tab-1" });

    expect(received).toHaveLength(0);
  });
});

describe("generateRequestId", () => {
  it("generates unique ids", () => {
    const id1 = generateRequestId("tab-1");
    const id2 = generateRequestId("tab-1");
    const id3 = generateRequestId("tab-2");

    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("includes tabId in id", () => {
    const id = generateRequestId("my-tab");
    expect(id).toContain("my-tab");
  });
});
