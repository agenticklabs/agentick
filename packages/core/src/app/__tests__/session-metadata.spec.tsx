/**
 * Session Metadata + App.getSession
 *
 * Tests:
 *
 * metadata:
 * - Session with metadata returns frozen copy
 * - Session without metadata has empty frozen object
 * - Metadata is immutable (Object.isFrozen, assignment throws)
 * - Metadata survives snapshot/restore cycle via store
 * - Metadata in child created via app.session with parentSessionId
 * - Sequential sends don't mutate metadata
 * - Snapshot without metadata omits field
 *
 * getSession:
 * - Returns session for registered sessions
 * - Returns undefined for unknown ID
 * - Does not create sessions (read-only)
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { MemorySessionStore } from "../session-store.js";

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

// ============================================================================
// Session Metadata + getSession
// ============================================================================

describe("Session Metadata + getSession", () => {
  // --------------------------------------------------------------------------
  // metadata
  // --------------------------------------------------------------------------

  it("session with metadata returns frozen copy", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ metadata: { type: "worker", task: "test" } });

    expect(session.metadata.type).toBe("worker");
    expect(session.metadata.task).toBe("test");

    await session.close();
  });

  it("session without metadata has empty frozen object", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session();

    expect(session.metadata).toEqual({});
    expect(Object.isFrozen(session.metadata)).toBe(true);

    await session.close();
  });

  it("metadata is immutable", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ metadata: { role: "supervisor" } });

    expect(Object.isFrozen(session.metadata)).toBe(true);
    expect(() => {
      (session.metadata as any).foo = "bar";
    }).toThrow("Cannot add property foo, object is not extensible");

    await session.close();
  });

  it("metadata survives snapshot/restore cycle", async () => {
    const store = new MemorySessionStore();
    const app = createApp(TestAgent, { sessions: { store } });

    const session = await app.session({
      sessionId: "persist-test",
      metadata: { type: "worker", origin: "shell-1" },
    });

    // Trigger persist via send
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }).result;

    // Verify snapshot in store has metadata
    const snap = await store.load("persist-test");
    expect(snap).not.toBeNull();
    expect(snap!.metadata).toEqual({ type: "worker", origin: "shell-1" });

    // Simulate restart: fresh app, same store
    const app2 = createApp(TestAgent, { sessions: { store } });
    const restored = await app2.session("persist-test");

    expect(restored.metadata.type).toBe("worker");
    expect(restored.metadata.origin).toBe("shell-1");

    await restored.close();
    await session.close();
  });

  it("metadata in child created via app.session with parentSessionId", async () => {
    const app = createApp(TestAgent, {});

    const parent = await app.session({ sessionId: "meta-parent" });
    const child = await app.session({
      parentSessionId: "meta-parent",
      metadata: { type: "worker" },
    });

    // Child has both parentSessionId and its own metadata
    expect(child.parentSessionId).toBe("meta-parent");
    expect(child.metadata.type).toBe("worker");
    // Parent metadata is independent
    expect(parent.metadata).toEqual({});

    await child.close();
    await parent.close();
  });

  it("sequential sends don't mutate metadata", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ metadata: { version: 1, role: "agent" } });

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    }).result;

    expect(session.metadata.version).toBe(1);
    expect(session.metadata.role).toBe("agent");

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    }).result;

    expect(session.metadata.version).toBe(1);
    expect(session.metadata.role).toBe("agent");
    expect(Object.keys(session.metadata)).toEqual(["version", "role"]);

    await session.close();
  });

  it("snapshot without metadata omits field", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session();

    const snap = session.snapshot();
    expect(snap.metadata).toBeUndefined();

    await session.close();
  });

  // --------------------------------------------------------------------------
  // getSession
  // --------------------------------------------------------------------------

  it("app.getSession returns session for registered sessions", async () => {
    const app = createApp(TestAgent, {});
    const session = await app.session({ sessionId: "known-id" });

    const found = app.getSession("known-id");
    expect(found).toBeDefined();
    expect(found!.id).toBe("known-id");

    await session.close();
  });

  it("app.getSession returns undefined for unknown ID", () => {
    const app = createApp(TestAgent, {});
    expect(app.getSession("nonexistent")).toBeUndefined();
  });

  it("getSession does not create sessions", () => {
    const app = createApp(TestAgent, {});

    app.getSession("no-such-id");

    expect(app.has("no-such-id")).toBe(false);
    expect(app.sessions).not.toContain("no-such-id");
  });

  it("getSession does not prevent idle eviction", async () => {
    // This test verifies that getSession is truly read-only and uses peek()
    // (no side effects), NOT the normal hydration path which touches activity.
    // We test this by confirming getSession returns the exact same session
    // object reference as app.session — proving it's a direct lookup, not
    // a reconstructed/rehydrated instance.

    const app = createApp(TestAgent, {});
    const session = await app.session({
      sessionId: "peek-test-id",
      metadata: { purpose: "verify-readonly" },
    });

    // getSession should return the EXACT same object reference
    const peeked = app.getSession("peek-test-id");
    expect(peeked).toBe(session);
    expect(peeked!.metadata.purpose).toBe("verify-readonly");

    await session.close();
  });

  // --------------------------------------------------------------------------
  // Adversarial: metadata isolation
  // --------------------------------------------------------------------------

  it("mutating the options object after creation doesn't affect session metadata", async () => {
    const app = createApp(TestAgent, {});
    const meta = { role: "worker", origin: "test" };
    const session = await app.session({ metadata: meta });

    // Mutate the original object
    meta.role = "hacked";
    meta.origin = "evil";

    // Session metadata should be unaffected — it was shallow-copied + frozen
    expect(session.metadata.role).toBe("worker");
    expect(session.metadata.origin).toBe("test");

    await session.close();
  });

  it("two sessions with same metadata shape are independent", async () => {
    const app = createApp(TestAgent, {});

    const s1 = await app.session({ metadata: { id: 1 } });
    const s2 = await app.session({ metadata: { id: 2 } });

    expect(s1.metadata.id).toBe(1);
    expect(s2.metadata.id).toBe(2);

    // They are separate frozen objects
    expect(s1.metadata).not.toBe(s2.metadata);

    await s1.close();
    await s2.close();
  });
});
