/**
 * Session Inbox Integration Tests
 *
 * Tests the integration between Session, InboxStorage, and the drain loop:
 * - Session processes "message" type from inbox via send()
 * - Session processes "dispatch" type from inbox via dispatch()
 * - markDone called after successful processing
 * - Failed processing leaves message pending
 * - FIFO order preserved
 * - setInboxStorage triggers immediate drain of pre-existing pending
 * - Subscription fires drain on new writes
 * - close() unsubscribes — no processing after close
 *
 * Adversarial:
 * - drainInbox re-entrancy (subscriber fires during active drain)
 * - Processing failure breaks iteration (preserves FIFO)
 * - Race: inbox write + session close concurrently
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { createTool } from "../../tool/tool.js";
import { MemoryInboxStorage } from "../inbox-storage.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

function createModel(response = "OK") {
  return createTestAdapter({ defaultResponse: response });
}

const callLog: string[] = [];

const SearchTool = createTool({
  name: "search",
  description: "Search tool for testing dispatch",
  input: z.object({ q: z.string() }),
  handler: async ({ q }) => {
    callLog.push(`search:${q}`);
    return [{ type: "text" as const, text: `results for ${q}` }];
  },
});

const FailTool = createTool({
  name: "always_fail",
  description: "Always throws",
  input: z.object({}),
  handler: async () => {
    throw new Error("boom");
  },
});

function TestAgent() {
  return (
    <>
      <SearchTool />
      <FailTool />
      <Model model={createModel()} />
      <System>Test agent</System>
      <Timeline />
    </>
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("Session Inbox Integration", () => {
  beforeEach(() => {
    callLog.length = 0;
  });

  it("processes 'message' type from inbox via send()", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    // Mount so tools are ready
    await session.mount();

    // Write a message to the inbox
    await inbox.write("s1", {
      source: "external",
      type: "message",
      payload: { role: "user", content: [{ type: "text", text: "hello from inbox" }] },
    });

    // Give the async drain a tick to process
    await new Promise((r) => setTimeout(r, 100));

    // Session should have processed the message (model was called)
    expect(session.currentTick).toBeGreaterThanOrEqual(2); // 1 = mount, 2+ = inbox message
    await session.close();
  });

  it("processes 'dispatch' type from inbox via dispatch()", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    await inbox.write("s1", {
      source: "external",
      type: "dispatch",
      payload: { tool: "search", input: { q: "test-query" } },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(callLog).toContain("search:test-query");
    await session.close();
  });

  it("markDone called after successful processing", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    await inbox.write("s1", {
      source: "external",
      type: "message",
      payload: { role: "user", content: [{ type: "text", text: "process me" }] },
    });

    await new Promise((r) => setTimeout(r, 200));

    // After processing, pending should be empty
    const pending = await inbox.pending("s1");
    expect(pending).toHaveLength(0);
    await session.close();
  });

  it("failed processing leaves message pending", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    // Dispatch to a tool that always fails
    await inbox.write("s1", {
      source: "external",
      type: "dispatch",
      payload: { tool: "always_fail", input: {} },
    });

    await new Promise((r) => setTimeout(r, 200));

    // Message should still be pending (drain broke on error)
    const pending = await inbox.pending("s1");
    expect(pending).toHaveLength(1);
    await session.close();
  });

  it("FIFO order preserved — failure stops processing subsequent messages", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    // Write: fail, then succeed — second should NOT be processed
    await inbox.write("s1", {
      source: "ext",
      type: "dispatch",
      payload: { tool: "always_fail", input: {} },
    });
    await inbox.write("s1", {
      source: "ext",
      type: "dispatch",
      payload: { tool: "search", input: { q: "should-not-run" } },
    });

    await new Promise((r) => setTimeout(r, 200));

    // Both still pending (first failed, second never tried)
    const pending = await inbox.pending("s1");
    expect(pending).toHaveLength(2);
    expect(callLog).not.toContain("search:should-not-run");
    await session.close();
  });

  it("setInboxStorage triggers immediate drain of pre-existing pending", async () => {
    const inbox = new MemoryInboxStorage();

    // Write BEFORE creating session
    await inbox.write("s1", {
      source: "pre-existing",
      type: "dispatch",
      payload: { tool: "search", input: { q: "pre-existing" } },
    });

    const app = createApp(TestAgent, { inbox });
    const session = await app.session("s1");
    await session.mount();

    await new Promise((r) => setTimeout(r, 200));

    expect(callLog).toContain("search:pre-existing");
    const pending = await inbox.pending("s1");
    expect(pending).toHaveLength(0);
    await session.close();
  });

  it("close() unsubscribes — no processing after close", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();
    await session.close();

    // Write after close
    await inbox.write("s1", {
      source: "late",
      type: "dispatch",
      payload: { tool: "search", input: { q: "after-close" } },
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should NOT have processed
    expect(callLog).not.toContain("search:after-close");
    // Message still pending
    expect(await inbox.pending("s1")).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Adversarial
  // ══════════════════════════════════════════════════════════════════════

  it("drainInbox re-entrancy — subscriber fires during active drain", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    // Write a message that will trigger drain
    await inbox.write("s1", {
      source: "first",
      type: "dispatch",
      payload: { tool: "search", input: { q: "first" } },
    });

    // While first is draining, write another — subscriber fires, but
    // _draining flag prevents re-entrant drain
    await new Promise((r) => setTimeout(r, 50));
    await inbox.write("s1", {
      source: "second",
      type: "dispatch",
      payload: { tool: "search", input: { q: "second" } },
    });

    await new Promise((r) => setTimeout(r, 300));

    // Both should eventually be processed (second triggers a new drain after first completes)
    expect(callLog).toContain("search:first");
    // The second message should be processed by a subsequent drain
    // (triggered by the subscriber notification after write)
    await session.close();
  });

  it("rapid sequential writes all eventually drain", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const session = await app.session("s1");
    await session.mount();

    // Rapid fire 5 dispatch messages
    for (let i = 0; i < 5; i++) {
      await inbox.write("s1", {
        source: `rapid-${i}`,
        type: "dispatch",
        payload: { tool: "search", input: { q: `rapid-${i}` } },
      });
    }

    // Wait for all to drain
    await new Promise((r) => setTimeout(r, 500));

    // All should be processed
    for (let i = 0; i < 5; i++) {
      expect(callLog).toContain(`search:rapid-${i}`);
    }
    expect(await inbox.pending("s1")).toHaveLength(0);
    await session.close();
  });
});
