/**
 * app.receive() and app.processInbox() Tests
 *
 * Tests:
 * - Routes to correct session via sessionResolver
 * - Creates new session when resolver returns null
 * - Creates new session when no resolver configured
 * - Async sessionResolver works
 * - Written message triggers processing on active session
 * - processInbox() hydrates sessions and drains
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createApp } from "../../app";
import { System } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import { createTool } from "../../tool/tool";
import { MemoryInboxStorage } from "../inbox-storage";
import { z } from "zod";
import type { InboxMessageInput } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function createModel(response = "OK") {
  return createTestAdapter({ defaultResponse: response });
}

const receivedDispatches: string[] = [];

const EchoTool = createTool({
  name: "echo",
  description: "Echo tool",
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => {
    receivedDispatches.push(`echo:${text}`);
    return [{ type: "text" as const, text }];
  },
});

function TestAgent() {
  return (
    <>
      <EchoTool />
      <Model model={createModel()} />
      <System>Test</System>
      <Timeline />
    </>
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("app.receive()", () => {
  beforeEach(() => {
    receivedDispatches.length = 0;
  });

  it("routes to correct session via sessionResolver", async () => {
    const inbox = new MemoryInboxStorage();
    const resolver = vi.fn((msg: InboxMessageInput) =>
      msg.source === "slack" ? "slack-session" : null,
    );

    const app = createApp(TestAgent, { inbox, sessionResolver: resolver });

    await app.receive({
      source: "slack",
      type: "message",
      payload: { role: "user", content: [{ type: "text", text: "hey" }] },
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    // Message should be in the inbox for slack-session
    const pending = await inbox.pending("slack-session");
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("slack");
  });

  it("creates new session ID when resolver returns null", async () => {
    const inbox = new MemoryInboxStorage();
    const resolver = vi.fn(() => null);

    const app = createApp(TestAgent, { inbox, sessionResolver: resolver });

    await app.receive({
      source: "unknown",
      type: "message",
      payload: { role: "user", content: [{ type: "text", text: "hello" }] },
    });

    // Should have created a message with some UUID session
    const sessions = await inbox.sessionsWithPending();
    expect(sessions).toHaveLength(1);
    // The session ID should be a UUID (not "unknown" or empty)
    expect(sessions[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("creates new session when no resolver configured", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    await app.receive({
      source: "api",
      type: "message",
      payload: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const sessions = await inbox.sessionsWithPending();
    expect(sessions).toHaveLength(1);
  });

  it("async sessionResolver works", async () => {
    const inbox = new MemoryInboxStorage();
    const resolver = vi.fn(async (_msg: InboxMessageInput) => {
      // Simulate async lookup
      await new Promise((r) => setTimeout(r, 10));
      return "async-session";
    });

    const app = createApp(TestAgent, { inbox, sessionResolver: resolver });

    await app.receive({
      source: "webhook",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "async" } },
    });

    const pending = await inbox.pending("async-session");
    expect(pending).toHaveLength(1);
  });

  it("triggers processing on active session", async () => {
    const inbox = new MemoryInboxStorage();
    const resolver = () => "active-session";

    const app = createApp(TestAgent, { inbox, sessionResolver: resolver });

    // Create and mount the session first
    const session = await app.session("active-session");
    await session.mount();

    // Now receive a dispatch message
    await app.receive({
      source: "ext",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "live-delivery" } },
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(receivedDispatches).toContain("echo:live-delivery");
    await session.close();
  });
});

describe("app.processInbox()", () => {
  beforeEach(() => {
    receivedDispatches.length = 0;
  });

  it("hydrates sessions and drains pending messages", async () => {
    const inbox = new MemoryInboxStorage();

    // Pre-populate inbox before app exists (simulating restart)
    await inbox.write("hydrate-session", {
      source: "pre-restart",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "from-before-restart" } },
    });

    const app = createApp(TestAgent, { inbox });

    // Process — should create session and drain
    await app.processInbox();

    await new Promise((r) => setTimeout(r, 300));

    expect(receivedDispatches).toContain("echo:from-before-restart");
    const pending = await inbox.pending("hydrate-session");
    expect(pending).toHaveLength(0);
  });

  it("processes multiple sessions", async () => {
    const inbox = new MemoryInboxStorage();

    await inbox.write("s1", {
      source: "ext",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "s1-msg" } },
    });
    await inbox.write("s2", {
      source: "ext",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "s2-msg" } },
    });

    const app = createApp(TestAgent, { inbox });
    await app.processInbox();

    await new Promise((r) => setTimeout(r, 300));

    expect(receivedDispatches).toContain("echo:s1-msg");
    expect(receivedDispatches).toContain("echo:s2-msg");
  });

  it("is idempotent — second call with nothing pending is a no-op", async () => {
    const inbox = new MemoryInboxStorage();

    await inbox.write("s1", {
      source: "ext",
      type: "dispatch",
      payload: { tool: "echo", input: { text: "once" } },
    });

    const app = createApp(TestAgent, { inbox });
    await app.processInbox();
    await new Promise((r) => setTimeout(r, 200));

    receivedDispatches.length = 0;
    await app.processInbox();
    await new Promise((r) => setTimeout(r, 100));

    // No additional dispatches
    expect(receivedDispatches).toHaveLength(0);
  });
});
