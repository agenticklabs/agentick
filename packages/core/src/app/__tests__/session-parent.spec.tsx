/**
 * Session Graph Primitives — parentSessionId & notifyParent
 *
 * Tests:
 *
 * parentSessionId:
 * - Null by default
 * - Set from SessionOptions
 * - Survives snapshot round-trip
 * - Survives store persist + restore
 * - Ephemeral spawn child has both parent and parentSessionId
 * - Persistent child (app.session({ parentSessionId })) has parentSessionId but parent === null
 *
 * notifyParent:
 * - Delivers message to parent inbox
 * - Throws when no parent
 * - Works when parent session is active (subscriber fires immediately)
 * - Multiple children notifying parent concurrently (all messages arrive)
 *
 * Adversarial:
 * - notifyParent after parent session closed (succeeds — inbox outlives session)
 * - Race: parent closes while notifyParent in flight (write still succeeds)
 * - notifyParent after own session closed / inbox storage gone (throws)
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { MemoryInboxStorage } from "../inbox-storage.js";
import { MemorySessionStore } from "../session-store.js";
import type { InboxMessageInput } from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

function createModel(response = "OK") {
  return createTestAdapter({ defaultResponse: response });
}

function TestAgent() {
  return (
    <>
      <Model model={createModel()} />
      <System>Test agent</System>
      <Timeline />
    </>
  );
}

function makeMessage(text: string): InboxMessageInput {
  return {
    source: "child",
    type: "message",
    payload: { role: "user", content: [{ type: "text", text }] },
  };
}

// ============================================================================
// parentSessionId
// ============================================================================

describe("parentSessionId", () => {
  it("is null by default", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session();
    expect(session.parentSessionId).toBeNull();
    await session.close();
  });

  it("set from SessionOptions", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ parentSessionId: "parent-123" });
    expect(session.parentSessionId).toBe("parent-123");
    await session.close();
  });

  it("survives snapshot round-trip", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ parentSessionId: "parent-456" });

    const snap = session.snapshot();
    expect(snap.parentSessionId).toBe("parent-456");

    // Create a new session, restore from snapshot
    const session2 = await app.session({ sessionId: "restored-from-snap" });
    // Manually set snapshot for resolve (simulating what app does on hydration)
    (session2 as any).setSnapshotForResolve(snap);
    expect(session2.parentSessionId).toBe("parent-456");

    await session.close();
    await session2.close();
  });

  it("survives store persist + restore", async () => {
    const store = new MemorySessionStore();
    const app = createApp(TestAgent, { sessions: { store } });

    const session = await app.session({ parentSessionId: "parent-789" });
    // Trigger persist by running
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }).result;

    const sessionId = session.id;

    // Verify snapshot was saved to store with parentSessionId
    const snap = await store.load(sessionId);
    expect(snap).not.toBeNull();
    expect(snap!.parentSessionId).toBe("parent-789");

    // Create a fresh app with the same store — simulates restart
    const app2 = createApp(TestAgent, { sessions: { store } });
    const restored = await app2.session(sessionId);
    expect(restored.parentSessionId).toBe("parent-789");
    await restored.close();
    await session.close();
  });

  it("ephemeral spawn child has both parent and parentSessionId", async () => {
    // Use a slow model so we can observe the child mid-execution
    const slowModel = createTestAdapter({ defaultResponse: "slow", delay: 50 });

    function SlowAgent() {
      return (
        <>
          <Model model={slowModel} />
          <System>Slow agent</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(TestAgent, {});
    const parent = await app.session();
    await parent.mount();

    const handle = await parent.spawn(SlowAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    });

    // Child should appear in parent.children while model is processing
    // Small delay to let spawn set up the child session
    await new Promise((r) => setTimeout(r, 10));

    expect(parent.children.length).toBe(1);
    const child = parent.children[0];
    expect(child.parent).toBe(parent);
    expect(child.parentSessionId).toBe(parent.id);

    await handle.result;
    await parent.close();
  });

  it("persistent child has parentSessionId but parent === null", async () => {
    const app = createApp(TestAgent, {});

    const parent = await app.session({ sessionId: "the-parent" });
    const child = await app.session({ parentSessionId: "the-parent" });

    expect(child.parentSessionId).toBe("the-parent");
    expect(child.parent).toBeNull(); // Not an ephemeral spawn — no live ref

    await child.close();
    await parent.close();
  });
});

// ============================================================================
// notifyParent
// ============================================================================

describe("notifyParent", () => {
  it("delivers message to parent inbox", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const parent = await app.session({ sessionId: "parent-inbox" });
    const child = await app.session({ parentSessionId: "parent-inbox" });

    await child.notifyParent(makeMessage("job done"));

    const pending = await inbox.pending("parent-inbox");
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("child");

    await child.close();
    await parent.close();
  });

  it("throws when no parentSessionId", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const orphan = await app.session();
    await expect(orphan.notifyParent(makeMessage("lost"))).rejects.toThrow("no parentSessionId");
    await orphan.close();
  });

  it("works when parent session is active (subscriber fires immediately)", async () => {
    const inbox = new MemoryInboxStorage();
    const receivedMessages: string[] = [];

    const app = createApp(TestAgent, { inbox });

    const parent = await app.session({ sessionId: "active-parent" });
    await parent.mount();

    // Track inbox messages arriving at parent
    inbox.subscribe("active-parent", () => {
      receivedMessages.push("notification");
    });

    const child = await app.session({ parentSessionId: "active-parent" });
    await child.notifyParent(makeMessage("hello parent"));

    // Subscriber should have fired
    expect(receivedMessages).toContain("notification");

    await child.close();
    await parent.close();
  });

  it("multiple children notifying parent concurrently — all messages arrive", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const parent = await app.session({ sessionId: "multi-parent" });

    const children = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.session({ parentSessionId: "multi-parent", sessionId: `child-${i}` }),
      ),
    );

    // All children notify concurrently
    await Promise.all(
      children.map((child, i) => child.notifyParent(makeMessage(`from child ${i}`))),
    );

    const pending = await inbox.pending("multi-parent");
    expect(pending).toHaveLength(5);

    // All messages should be present
    const texts = pending.map((m) => {
      if (m.type === "message") {
        const content = m.payload.content;
        return Array.isArray(content) && content[0]?.type === "text"
          ? (content[0] as any).text
          : "";
      }
      return "";
    });
    for (let i = 0; i < 5; i++) {
      expect(texts).toContain(`from child ${i}`);
    }

    for (const child of children) await child.close();
    await parent.close();
  });
});

// ============================================================================
// Adversarial
// ============================================================================

describe("notifyParent — adversarial", () => {
  it("succeeds after parent session is closed (inbox outlives session)", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const parent = await app.session({ sessionId: "doomed-parent" });
    const child = await app.session({ parentSessionId: "doomed-parent" });

    // Close parent
    await parent.close();

    // Child can still write to parent's inbox — the inbox storage is session-independent
    await child.notifyParent(makeMessage("you're gone but I still wrote"));

    const pending = await inbox.pending("doomed-parent");
    expect(pending).toHaveLength(1);

    await child.close();
  });

  it("race: parent closes while notifyParent in flight", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const parent = await app.session({ sessionId: "racing-parent" });
    const child = await app.session({ parentSessionId: "racing-parent" });

    // Start both concurrently
    const [, writeResult] = await Promise.allSettled([
      parent.close(),
      child.notifyParent(makeMessage("racing message")),
    ]);

    // The write should still succeed — inbox storage doesn't depend on session liveness
    expect(writeResult.status).toBe("fulfilled");

    const pending = await inbox.pending("racing-parent");
    expect(pending).toHaveLength(1);

    await child.close();
  });

  it("throws after own session closed (inbox storage gone)", async () => {
    const inbox = new MemoryInboxStorage();
    const app = createApp(TestAgent, { inbox });

    const child = await app.session({ parentSessionId: "some-parent" });

    // Close the child session — this nulls its _inboxStorage
    await child.close();

    await expect(child.notifyParent(makeMessage("too late"))).rejects.toThrow(
      "inbox storage unavailable",
    );
  });
});
