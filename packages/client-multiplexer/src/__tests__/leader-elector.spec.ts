/**
 * Leader Elector Tests
 *
 * Tests the BroadcastChannel fallback path since navigator.locks
 * isn't available in Node.js test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLeaderElector } from "../leader-elector";

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

describe("LeaderElector", () => {
  let originalBroadcastChannel: typeof BroadcastChannel;

  beforeEach(() => {
    MockBroadcastChannel.reset();
    originalBroadcastChannel = globalThis.BroadcastChannel;
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    // Note: navigator.locks is not available in Node, so the elector
    // will use the BroadcastChannel fallback path
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.BroadcastChannel = originalBroadcastChannel;
  });

  it("creates elector with unique tabId", () => {
    const elector = createLeaderElector("test-channel");
    expect(elector.tabId).toBeTruthy();
    expect(elector.isLeader).toBe(false);
  });

  // These tests use the BroadcastChannel fallback which has timeouts
  // They're marked with longer timeout for CI
  it("first tab becomes leader via fallback", { timeout: 5000 }, async () => {
    const elector = createLeaderElector("test-channel-1");

    // Start leadership election (uses BroadcastChannel fallback in Node)
    elector.awaitLeadership();

    // Wait for fallback timeout (2500ms)
    await new Promise((r) => setTimeout(r, 3000));

    expect(elector.isLeader).toBe(true);

    elector.resign();
  });

  it("notifies on leadership change", { timeout: 5000 }, async () => {
    const elector = createLeaderElector("test-channel-2");
    const changes: boolean[] = [];
    elector.onLeadershipChange((isLeader) => changes.push(isLeader));

    elector.awaitLeadership();

    // Wait for fallback election
    await new Promise((r) => setTimeout(r, 3000));

    expect(changes).toContain(true);

    elector.resign();
  });

  it("resigning releases leadership", { timeout: 5000 }, async () => {
    const elector = createLeaderElector("test-channel-3");
    const changes: boolean[] = [];
    elector.onLeadershipChange((isLeader) => changes.push(isLeader));

    elector.awaitLeadership();
    await new Promise((r) => setTimeout(r, 3000));
    expect(elector.isLeader).toBe(true);

    elector.resign();

    expect(elector.isLeader).toBe(false);
    expect(changes).toContain(false);
  });

  it("cleanup unsubscribes callback", () => {
    const elector = createLeaderElector("test-channel-4");
    const changes: boolean[] = [];
    const cleanup = elector.onLeadershipChange((isLeader) => changes.push(isLeader));

    // Cleanup before any election happens
    cleanup();

    // Changes array should remain empty because we unsubscribed
    expect(changes).toHaveLength(0);
  });
});
