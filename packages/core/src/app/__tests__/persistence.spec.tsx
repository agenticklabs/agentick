/**
 * Persistence Tests
 *
 * Tests for the session auto-persistence system including:
 * - MemorySessionStore operations
 * - Auto-persist (snapshot saved to store after each execution)
 * - Auto-restore (app.session(id) restores from store)
 * - Lifecycle hooks (onBeforePersist, onAfterPersist, onBeforeRestore, onAfterRestore)
 * - useTimeline hook
 * - maxTimelineEntries safety net
 * - State preservation across persist/restore cycles
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { createApp } from "../../app";
import { createTestAdapter } from "../../testing/test-adapter";
import { System, User } from "../../jsx/components/messages";
import { Model, Section } from "../../jsx/components/primitives";
import { MemorySessionStore } from "../session-store";
import { SqliteSessionStore, isSqliteAvailable, createSessionStore } from "../sqlite-session-store";
import type { ResolveContext, SessionSnapshot } from "../types";
import { Timeline } from "../../jsx/components/timeline";
import { useData } from "../../hooks/data";
import { useComState } from "../../hooks/com-state";
import { useTimeline } from "../../hooks/timeline";
import { useResolved } from "../../hooks/resolved";
import { useOnTickEnd } from "../../hooks/lifecycle";
import type { COMTimelineEntry } from "../../com/types";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(options?: { delay?: number; response?: Record<string, unknown> }) {
  return createTestAdapter({
    defaultResponse: "Mock response",
    delay: options?.delay,
  });
}

// ============================================================================
// MemorySessionStore Tests
// ============================================================================

describe("MemorySessionStore", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("should save and load a snapshot", async () => {
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 3,
      timeline: [{ kind: "message", message: { role: "user", content: [] } }],
      comState: {},
      dataCache: {},
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      timestamp: Date.now(),
    };

    await store.save("session-1", snapshot);

    const loaded = await store.load("session-1");
    expect(loaded).toEqual(snapshot);
  });

  it("should return null for non-existent session", async () => {
    const loaded = await store.load("non-existent");
    expect(loaded).toBeNull();
  });

  it("should delete a snapshot", async () => {
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", snapshot);
    expect(await store.has("session-1")).toBe(true);

    await store.delete("session-1");
    expect(await store.has("session-1")).toBe(false);
    expect(await store.load("session-1")).toBeNull();
  });

  it("should list all session IDs", async () => {
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });
    await store.save("session-3", { ...snapshot, sessionId: "session-3" });

    const ids = await store.list();
    expect(ids).toHaveLength(3);
    expect(ids).toContain("session-1");
    expect(ids).toContain("session-2");
    expect(ids).toContain("session-3");
  });

  it("should enforce maxSize with LRU eviction", async () => {
    const store = new MemorySessionStore({ maxSize: 2 });
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });
    await store.save("session-3", { ...snapshot, sessionId: "session-3" }); // Should evict session-1

    expect(await store.has("session-1")).toBe(false);
    expect(await store.has("session-2")).toBe(true);
    expect(await store.has("session-3")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("should update LRU order on load", async () => {
    const store = new MemorySessionStore({ maxSize: 2 });
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });

    // Access session-1 to move it to end of LRU
    await store.load("session-1");

    // Add session-3 - should evict session-2 (now oldest)
    await store.save("session-3", { ...snapshot, sessionId: "session-3" });

    expect(await store.has("session-1")).toBe(true);
    expect(await store.has("session-2")).toBe(false);
    expect(await store.has("session-3")).toBe(true);
  });

  it("should clear all sessions", async () => {
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });
});

// ============================================================================
// Auto-Persist Tests
// ============================================================================

describe("Auto-persist", () => {
  it("should auto-persist snapshot to store after execution", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
    });

    const session = await app.session("test-session");
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    // Wait a tick for fire-and-forget persist to complete
    await new Promise((r) => setTimeout(r, 50));

    // Snapshot should be in store
    const saved = await store.load("test-session");
    expect(saved).not.toBeNull();
    expect(saved?.version).toBe("1.0");
    expect(saved?.sessionId).toBe("test-session");

    await session.close();
  });

  it("should update snapshot in store on subsequent executions", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
    });

    const session = await app.session("test-session");

    // First execution
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    const snap1 = await store.load("test-session");
    const timeline1Length = snap1?.timeline?.length ?? 0;

    // Second execution
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Follow up" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    const snap2 = await store.load("test-session");
    const timeline2Length = snap2?.timeline?.length ?? 0;

    // Timeline should grow as more messages are exchanged
    expect(timeline2Length).toBeGreaterThan(timeline1Length);

    await session.close();
  });

  it("should not persist when no store configured", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    // No store configured — should not throw
    const app = createApp(Agent, {});
    const session = await app.session("test-session");
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    await session.close();
  });
});

// ============================================================================
// Auto-Restore Tests
// ============================================================================

describe("Auto-restore", () => {
  it("should restore session from store via app.session(id)", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
    });

    // Create and use a session
    const session1 = await app.session("test-session");
    await session1.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    // Verify snapshot is in store
    expect(await store.has("test-session")).toBe(true);

    // Close the session (removes from memory but snapshot stays in store)
    await session1.close();
    expect(app.has("test-session")).toBe(false);

    // Restore by requesting same session ID
    const session2 = await app.session("test-session");
    expect(session2).toBeDefined();
    expect(app.has("test-session")).toBe(true);

    // Can send messages to restored session
    await session2.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }).result;

    await session2.close();
  });

  it("should keep snapshot in store after restoring (store is cache)", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
    });

    // Create, send, wait for persist
    const session1 = await app.session("test-session");
    await session1.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    await session1.close();

    // Restore
    const session2 = await app.session("test-session");

    // Snapshot should still be in store (store is a cache, not a transfer)
    expect(await store.has("test-session")).toBe(true);

    await session2.close();
  });
});

// ============================================================================
// Persistence Lifecycle Hooks Tests
// ============================================================================

describe("Persistence lifecycle hooks", () => {
  it("should call onAfterPersist hook after auto-persist", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const onAfterPersist = vi.fn();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
      onAfterPersist,
    });

    const session = await app.session("test-session");
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    expect(onAfterPersist).toHaveBeenCalledTimes(1);
    expect(onAfterPersist).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({ version: "1.0" }),
    );

    await session.close();
  });

  it("should call onBeforeRestore and onAfterRestore on restore", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const onBeforeRestore = vi.fn();
    const onAfterRestore = vi.fn();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
      onBeforeRestore,
      onAfterRestore,
    });

    // Create, run, wait for persist, then close
    const session1 = await app.session("test-session");
    await session1.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));
    await session1.close();

    // Restore from store
    const session2 = await app.session("test-session");

    expect(onBeforeRestore).toHaveBeenCalledTimes(1);
    expect(onBeforeRestore).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({ version: "1.0" }),
    );

    expect(onAfterRestore).toHaveBeenCalledTimes(1);
    expect(onAfterRestore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test-session" }),
      expect.objectContaining({ version: "1.0" }),
    );

    await session2.close();
  });

  it("should cancel restore when onBeforeRestore returns false", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store },
      onBeforeRestore: () => false,
    });

    // Manually save a snapshot to store
    await store.save("test-session", {
      version: "1.0",
      sessionId: "test-session",
      tick: 3,
      timeline: [],
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    });

    // Restore should create a new session (restore was cancelled)
    const session = await app.session("test-session");

    // Session should exist but be fresh (tick 1, not 3)
    const snapshot = session.snapshot();
    expect(snapshot.tick).toBe(1);

    await session.close();
  });
});

// ============================================================================
// Session Snapshot Tests
// ============================================================================

describe("Session snapshot", () => {
  it("should include version, tick, and timestamp", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {});
    const session = await app.session("test-session");

    const snapshot = session.snapshot();

    expect(snapshot.version).toBe("1.0");
    expect(snapshot.tick).toBe(1);
    expect(typeof snapshot.timestamp).toBe("number");
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });

  it("should include timeline after ticks", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hello</User>
      </>
    );

    const app = createApp(Agent, {});
    const session = await app.session("test-session");
    await session.render({} as any);

    const snapshot = session.snapshot();

    expect(snapshot.timeline).toBeDefined();
    if (snapshot.timeline !== null) {
      expect(Array.isArray(snapshot.timeline)).toBe(true);
    }
  });

  it("should include usage stats after ticks", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hello</User>
      </>
    );

    const app = createApp(Agent, {});
    const session = await app.session("test-session");
    await session.render({} as any);

    const snapshot = session.snapshot();

    expect(snapshot.usage).toBeDefined();
    expect(snapshot.usage?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(snapshot.usage?.outputTokens).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Timeline Ownership Tests
// ============================================================================

describe("Timeline ownership", () => {
  it("should accumulate timeline entries across ticks", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session("test-session");

    // First tick
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    }).result;

    const snap1 = session.snapshot();
    const timelineAfterTick1 = snap1.timeline!;

    // Second tick
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
    }).result;

    const snap2 = session.snapshot();
    const timelineAfterTick2 = snap2.timeline!;

    // Timeline should grow across ticks
    expect(timelineAfterTick2.length).toBeGreaterThan(timelineAfterTick1.length);

    await session.close();
  });

  it("should trim timeline when maxTimelineEntries is exceeded", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      maxTimelineEntries: 4,
    });
    const session = await app.session("test-session");

    // Each tick adds ~2 entries (user + assistant). After 3 ticks = ~6 entries,
    // trimmed to 4.
    for (let i = 0; i < 3; i++) {
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: `Message ${i}` }] }],
      }).result;
    }

    const snapshot = session.snapshot();
    const timeline = snapshot.timeline!;
    expect(timeline.length).toBeLessThanOrEqual(4);

    await session.close();
  });

  it("should provide useTimeline with session history", async () => {
    const model = createMockModel();
    let _timelineEntries: COMTimelineEntry[] = [];

    const Agent = () => {
      const tl = useTimeline();
      _timelineEntries = tl.entries;
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First tick - timeline should be empty at render time
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    // After first tick, snapshot should show entries
    const snap = session.snapshot();
    expect(snap.timeline!.length).toBeGreaterThan(0);

    await session.close();
  });
});

// ============================================================================
// SQLite Session Store Tests
// ============================================================================

describe("SqliteSessionStore", () => {
  let sqliteAvailable = false;

  beforeAll(async () => {
    sqliteAvailable = await isSqliteAvailable();
  });

  it("should save and load a snapshot", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 3,
      timeline: [{ kind: "message", message: { role: "user", content: [] } }],
      comState: {},
      dataCache: {},
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      timestamp: Date.now(),
    };

    await store.save("session-1", snapshot);
    const loaded = await store.load("session-1");

    expect(loaded).toEqual(snapshot);
    await store.close();
  });

  it("should return null for non-existent session", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const loaded = await store.load("non-existent");

    expect(loaded).toBeNull();
    await store.close();
  });

  it("should delete a snapshot", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", snapshot);
    expect(await store.has("session-1")).toBe(true);

    await store.delete("session-1");
    expect(await store.has("session-1")).toBe(false);
    await store.close();
  });

  it("should list all session IDs", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });

    const ids = await store.list();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("session-1");
    expect(ids).toContain("session-2");
    await store.close();
  });

  it("should count sessions", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    expect(await store.count()).toBe(0);

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    expect(await store.count()).toBe(1);

    await store.save("session-2", { ...snapshot, sessionId: "session-2" });
    expect(await store.count()).toBe(2);

    await store.close();
  });

  it("should enforce max count with LRU eviction", async () => {
    if (!sqliteAvailable) return;
    const store = new SqliteSessionStore();
    const snapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "session-1",
      tick: 1,
      timeline: null,
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    };

    await store.save("session-1", { ...snapshot, sessionId: "session-1" });
    await store.save("session-2", { ...snapshot, sessionId: "session-2" });
    await store.save("session-3", { ...snapshot, sessionId: "session-3" });

    const deleted = await store.enforceMaxCount(2);
    expect(deleted).toBe(1);
    expect(await store.count()).toBe(2);

    await store.close();
  });
});

// ============================================================================
// createSessionStore Tests
// ============================================================================

describe("createSessionStore", () => {
  let sqliteAvailable = false;

  beforeAll(async () => {
    sqliteAvailable = await isSqliteAvailable();
  });

  it("should return undefined for undefined config", () => {
    const store = createSessionStore(undefined);
    expect(store).toBeUndefined();
  });

  it("should accept a MemorySessionStore instance", () => {
    const memStore = new MemorySessionStore();
    const store = createSessionStore(memStore);
    expect(store).toBe(memStore);
  });

  it("should create SqliteSessionStore from string path", async () => {
    if (!sqliteAvailable) return;
    const store = createSessionStore(":memory:");
    expect(store).toBeInstanceOf(SqliteSessionStore);
    await (store as SqliteSessionStore).close();
  });

  it("should create SqliteSessionStore from config object", async () => {
    if (!sqliteAvailable) return;
    const store = createSessionStore({ type: "sqlite", path: ":memory:", table: "test_sessions" });
    expect(store).toBeInstanceOf(SqliteSessionStore);
    await (store as SqliteSessionStore).close();
  });
});

// ============================================================================
// App with SQLite Store Tests
// ============================================================================

describe("App with SQLite store", () => {
  let sqliteAvailable = false;

  beforeAll(async () => {
    sqliteAvailable = await isSqliteAvailable();
  });

  it("should accept store as string path and auto-persist", async () => {
    if (!sqliteAvailable) return;
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store: ":memory:" },
    });

    const session = await app.session("test-session");
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    // Session should still be in memory
    expect(app.has("test-session")).toBe(true);

    await session.close();
  });

  it("should accept store as config object", async () => {
    if (!sqliteAvailable) return;
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: {
        store: { type: "sqlite", path: ":memory:", table: "custom_sessions" },
      },
    });

    const session = await app.session("test-session");
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    await session.close();
  });
});

// ============================================================================
// End-to-End Persist/Restore State Preservation Tests
// ============================================================================

describe("Persist/restore state preservation", () => {
  it("should preserve comState and dataCache across persist/restore", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const fetchUser = vi.fn().mockResolvedValue({ name: "Alice", role: "admin" });

    const Agent = () => {
      const counter = useComState("counter", 42);
      const user = useData<any>("user", fetchUser);

      return (
        <>
          <Model model={model} />
          <System>Test agent</System>
          <Timeline />
          <Section id="state" audience="model">
            Counter: {counter()}, User: {user.name}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    // Create session and run a tick to populate state
    const session = await app.session("test-session");
    const handle = await session.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await handle.result;

    // Verify snapshot captures real state
    const snapshot = session.snapshot();
    expect(snapshot.comState).toEqual(expect.objectContaining({ counter: 42 }));
    expect(snapshot.dataCache).toHaveProperty("user");
    expect(snapshot.dataCache.user.value).toEqual({ name: "Alice", role: "admin" });

    // Wait for auto-persist then close (evict from memory)
    await new Promise((r) => setTimeout(r, 50));
    await session.close();
    expect(app.has("test-session")).toBe(false);

    // Restore by requesting the same session ID
    const restored = await app.session("test-session");

    // Send another message — the session should continue with restored state
    const handle2 = await restored.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    } as any);
    await handle2.result;

    // Verify state was restored: tick advanced, useData did NOT re-fetch
    const newSnapshot = restored.snapshot();
    expect(newSnapshot.tick).toBeGreaterThan(1);

    // fetchUser should have been called only once (initial), not on restoration
    expect(fetchUser).toHaveBeenCalledTimes(1);

    await restored.close();
  });

  it("should not persist useData entries with persist: false", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const fetchSmall = vi.fn().mockResolvedValue("small-data");
    const fetchBig = vi.fn().mockResolvedValue("big-data");

    const Agent = () => {
      const small = useData("small", fetchSmall);
      const big = useData("big", fetchBig, [], { persist: false });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="data" audience="model">
            {small} | {big}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    const session = await app.session("test-session");
    const h1 = await session.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;

    // Snapshot should contain "small" but NOT "big"
    const snapshot = session.snapshot();
    expect(snapshot.dataCache).toHaveProperty("small");
    expect(snapshot.dataCache).not.toHaveProperty("big");

    // Persist and close
    await new Promise((r) => setTimeout(r, 50));
    await session.close();

    // Restore
    const restored = await app.session("test-session");

    // Reset mocks to track re-fetches
    fetchSmall.mockClear();
    fetchBig.mockClear();

    const h2 = await restored.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    } as any);
    await h2.result;

    // "small" should NOT re-fetch (persisted), "big" SHOULD re-fetch (not persisted)
    expect(fetchSmall).not.toHaveBeenCalled();
    expect(fetchBig).toHaveBeenCalledTimes(1);

    await restored.close();
  });

  it("should not persist useComState entries with persist: false", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();

    const Agent = () => {
      const saved = useComState("saved", "keep-me");
      const transient = useComState("transient", "lose-me", { persist: false });

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="state" audience="model">
            {saved()} | {transient()}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    const session = await app.session("test-session");
    const h1 = await session.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;

    const snapshot = session.snapshot();
    expect(snapshot.comState).toHaveProperty("saved", "keep-me");
    expect(snapshot.comState).not.toHaveProperty("transient");

    await session.close();
  });

  it("should snapshot comState and dataCache as empty objects for fresh sessions", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {});
    const session = await app.session("test-session");

    const snapshot = session.snapshot();
    expect(snapshot.comState).toEqual({});
    expect(snapshot.dataCache).toEqual({});

    await session.close();
  });

  it("should survive JSON roundtrip (simulates real store serialization)", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const fetchData = vi.fn().mockResolvedValue({ nested: { deep: [1, 2, 3] } });

    const Agent = () => {
      const status = useComState("status", "active");
      const data = useData("complex", fetchData);

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="state" audience="model">
            {status()} | {JSON.stringify(data)}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });
    const session = await app.session("test-session");
    const h1 = await session.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;

    // Simulate what a real store does: JSON roundtrip
    const snapshot = session.snapshot();
    const roundtripped = JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot;

    // Verify structure survives roundtrip
    expect(roundtripped.comState).toEqual(expect.objectContaining({ status: "active" }));
    expect(roundtripped.dataCache.complex.value).toEqual({ nested: { deep: [1, 2, 3] } });
    expect(roundtripped.tick).toBe(snapshot.tick);
    expect(roundtripped.version).toBe("1.0");

    await session.close();
  });

  it("should restore comState values readable by hooks (not just re-initialized)", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();

    let capturedValue: number | undefined;

    const Agent = () => {
      const counter = useComState("counter", 0);
      capturedValue = counter();

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="state" audience="model">
            Counter: {counter()}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    // First session: default counter=0
    const session = await app.session("test-session");
    const h1 = await session.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;

    const snapshot = session.snapshot();
    expect(snapshot.comState).toHaveProperty("counter", 0);

    // Modify the snapshot to simulate a session that had counter=99
    const modifiedSnapshot: SessionSnapshot = {
      ...snapshot,
      comState: { ...snapshot.comState, counter: 99 },
    };
    await store.save("test-session-modified", modifiedSnapshot);
    await session.close();

    // Restore from the modified snapshot
    const restored = await app.session("test-session-modified");
    const h2 = await restored.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    } as any);
    await h2.result;

    // The hook should read 99 from restored COM state, NOT re-initialize to 0
    expect(capturedValue).toBe(99);

    await restored.close();
  });

  it("should survive double persist/restore cycle", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const fetchConfig = vi.fn().mockResolvedValue({ theme: "dark" });

    const Agent = () => {
      const mode = useComState("mode", "auto");
      const config = useData<any>("config", fetchConfig);

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="state" audience="model">
            {mode()} | {config.theme}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    // Cycle 1: create → render → persist → close
    const s1 = await app.session("test-session");
    const h1 = await s1.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;
    await new Promise((r) => setTimeout(r, 50));
    await s1.close();

    // Cycle 2: restore → render → persist → close
    const s2 = await app.session("test-session");
    const h2 = await s2.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    } as any);
    await h2.result;
    await new Promise((r) => setTimeout(r, 50));
    await s2.close();

    // Cycle 3: restore → render — should still work
    const s3 = await app.session("test-session");
    fetchConfig.mockClear();

    const h3 = await s3.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Again" }] }],
    } as any);
    await h3.result;

    // Config should still be cached — no re-fetch across all 3 cycles
    expect(fetchConfig).not.toHaveBeenCalled();

    const finalSnapshot = s3.snapshot();
    expect(finalSnapshot.comState).toHaveProperty("mode", "auto");
    expect(finalSnapshot.dataCache).toHaveProperty("config");

    await s3.close();
  });

  it("should handle second render on restored session (reuse path)", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    const fetchItems = vi.fn().mockResolvedValue(["a", "b", "c"]);

    const Agent = () => {
      const items = useData<any[]>("items", fetchItems);

      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <Section id="items" audience="model">
            Items: {items.join(", ")}
          </Section>
        </>
      );
    };

    const app = createApp(Agent, { sessions: { store } });

    // Create, render, persist, close
    const s1 = await app.session("test-session");
    const h1 = await s1.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    } as any);
    await h1.result;
    await new Promise((r) => setTimeout(r, 50));
    await s1.close();

    // Restore
    const s2 = await app.session("test-session");

    // First render after restoration
    fetchItems.mockClear();
    const h2 = await s2.render({
      messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    } as any);
    await h2.result;
    expect(fetchItems).not.toHaveBeenCalled(); // still cached

    // Second render on same session (hits the reuse/reset path)
    const h3 = await s2.render({
      messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
    } as any);
    await h3.result;

    // Data cache should still be intact through the reuse path
    expect(fetchItems).not.toHaveBeenCalled();

    await s2.close();
  });
});

// ============================================================================
// Resolve (Layer 2) Tests
// ============================================================================

describe("Resolve (Layer 2)", () => {
  it("should resolve object form and provide via useResolved", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    let capturedGreeting: string | undefined;

    const Agent = () => {
      capturedGreeting = useResolved<string>("greeting");
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, {
      sessions: { store },
      resolve: { greeting: () => "hello" },
    });

    // Create session, run, persist, close
    const s1 = await app.session("test-resolve");
    await s1.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));
    await s1.close();

    // Restore
    const s2 = await app.session("test-resolve");
    await s2.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }).result;

    expect(capturedGreeting).toBe("hello");
    await s2.close();
  });

  it("should resolve function form and provide via useResolved", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    let capturedTick: number | undefined;

    const Agent = () => {
      capturedTick = useResolved<number>("tick");
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, {
      sessions: { store },
      resolve: async (ctx) => ({ tick: ctx.snapshot?.tick ?? -1 }),
    });

    // Create session, run, persist, close
    const s1 = await app.session("test-resolve-fn");
    await s1.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));
    const snap = await store.load("test-resolve-fn");
    await s1.close();

    // Restore
    const s2 = await app.session("test-resolve-fn");
    await s2.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }).result;

    expect(capturedTick).toBe(snap!.tick);
    await s2.close();
  });

  it("should NOT auto-apply comState when resolve is set", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    let capturedCounter: number | undefined;

    const Agent = () => {
      const counter = useComState("counter", 0);
      capturedCounter = counter();
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    // App has resolve — so Layer 2, comState should NOT be auto-applied
    const app = createApp(Agent, {
      sessions: { store },
      resolve: { mode: () => "restored" },
    });

    // Manually save a snapshot with counter=42
    await store.save("test-no-auto", {
      version: "1.0",
      sessionId: "test-no-auto",
      tick: 5,
      timeline: [],
      comState: { counter: 42 },
      dataCache: {},
      timestamp: Date.now(),
    });

    // Restore — resolve is set, so comState should NOT be auto-applied
    const s2 = await app.session("test-no-auto");
    await s2.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    // counter should be 0 (default), NOT 42 (from snapshot)
    expect(capturedCounter).toBe(0);
    await s2.close();
  });

  it("should provide snapshot in resolve context", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();
    let capturedSnap: SessionSnapshot | undefined;

    const Agent = () => {
      capturedSnap = useResolved<SessionSnapshot>("snap");
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, {
      sessions: { store },
      resolve: { snap: (ctx: ResolveContext) => ctx.snapshot },
    });

    // Manually save a snapshot
    const savedSnapshot: SessionSnapshot = {
      version: "1.0",
      sessionId: "test-snap-ctx",
      tick: 7,
      timeline: [],
      comState: { key: "val" },
      dataCache: {},
      timestamp: Date.now(),
    };
    await store.save("test-snap-ctx", savedSnapshot);

    // Restore
    const s2 = await app.session("test-snap-ctx");
    await s2.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    expect(capturedSnap).toBeDefined();
    expect(capturedSnap!.tick).toBe(7);
    expect(capturedSnap!.comState).toEqual({ key: "val" });
    await s2.close();
  });
});

// ============================================================================
// Timeline Mutation Tests (useTimeline set/update)
// ============================================================================

describe("Timeline mutation (useTimeline)", () => {
  it("should replace timeline via set()", async () => {
    const model = createMockModel();
    const customEntry: COMTimelineEntry = {
      kind: "message",
      message: { role: "user", content: [{ type: "text", text: "injected" }] },
    };

    const Agent = () => {
      const tl = useTimeline();
      useOnTickEnd(() => {
        tl.set([customEntry]);
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    const snap = session.snapshot();
    expect(snap.timeline).toHaveLength(1);
    expect(snap.timeline![0].message?.content).toEqual([{ type: "text", text: "injected" }]);

    await session.close();
  });

  it("should transform timeline via update()", async () => {
    const model = createMockModel();

    const Agent = () => {
      const tl = useTimeline();
      useOnTickEnd(() => {
        // Keep only the last entry
        tl.update((entries) => entries.slice(-1));
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    const snap = session.snapshot();
    expect(snap.timeline).toHaveLength(1);

    await session.close();
  });
});

// ============================================================================
// Persistence Error Handling Tests
// ============================================================================

describe("Persistence error handling", () => {
  it("should survive store.save() failure (non-fatal persist)", async () => {
    const failingStore: MemorySessionStore & { save: ReturnType<typeof vi.fn> } =
      new MemorySessionStore() as any;
    failingStore.save = vi.fn().mockRejectedValue(new Error("disk full"));

    const model = createMockModel();
    const onAfterPersist = vi.fn();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      sessions: { store: failingStore },
      onAfterPersist,
    });

    const session = await app.session("test-fail");
    // Should not throw even though persist fails
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    await new Promise((r) => setTimeout(r, 50));

    // onAfterPersist should NOT have been called (save failed before reaching it)
    expect(onAfterPersist).not.toHaveBeenCalled();

    // Session should still work after failed persist
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }).result;

    await session.close();
  });

  it("should propagate resolve function errors", async () => {
    const store = new MemorySessionStore();
    const model = createMockModel();

    const Agent = () => {
      useResolved("value");
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, {
      sessions: { store },
      resolve: {
        value: () => {
          throw new Error("boom");
        },
      },
    });

    // Save a snapshot to trigger restore
    await store.save("test-resolve-err", {
      version: "1.0",
      sessionId: "test-resolve-err",
      tick: 1,
      timeline: [],
      comState: {},
      dataCache: {},
      timestamp: Date.now(),
    });

    // Restore + send should fail because resolve throws
    const session = await app.session("test-resolve-err");
    await expect(
      session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result,
    ).rejects.toThrow(/resolve\["value"\] failed: boom/);

    await session.close();
  });
});

// ============================================================================
// maxTimelineEntries Trimming Direction Test
// ============================================================================

describe("maxTimelineEntries trimming", () => {
  it("should keep newest entries (not oldest)", async () => {
    const model = createMockModel();
    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      maxTimelineEntries: 4,
    });
    const session = await app.session("test-trim-dir");

    // Send 3 messages — each tick adds ~2 entries (user + assistant)
    for (let i = 0; i < 3; i++) {
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: `Message ${i}` }] }],
      }).result;
    }

    const snap = session.snapshot();
    const timeline = snap.timeline!;
    expect(timeline.length).toBeLessThanOrEqual(4);

    // The surviving entries should be from the latest messages, not the earliest.
    // Check that the last user message in the timeline contains "Message 2" (the latest).
    const lastUserEntry = [...timeline].reverse().find((e) => e.message?.role === "user");
    const lastUserText = lastUserEntry?.message?.content?.find((c: any) => c.type === "text") as
      | { text: string }
      | undefined;

    expect(lastUserText?.text).toBe("Message 2");

    // "Message 0" should have been trimmed away
    const hasMessage0 = timeline.some((e) =>
      e.message?.content?.some((c: any) => c.type === "text" && c.text === "Message 0"),
    );
    expect(hasMessage0).toBe(false);

    await session.close();
  });
});
