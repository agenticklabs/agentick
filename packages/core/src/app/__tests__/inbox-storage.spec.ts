/**
 * MemoryInboxStorage Unit Tests
 *
 * Tests the in-memory reference implementation of InboxStorage:
 * - write() assigns unique IDs and timestamps
 * - pending() returns FIFO order, defensive copies
 * - markDone() removes from pending, idempotent
 * - subscribe() fires on write, unsubscribe stops callback
 * - sessionsWithPending() correct session IDs
 *
 * Adversarial:
 * - Concurrent writes preserve ordering
 * - Subscriber that throws doesn't break subsequent writes
 * - markDone() during pending iteration (defensive copy)
 * - Multiple subscribers per session all fire
 * - Write after unsubscribe doesn't fire callback
 */

import { describe, it, expect, vi } from "vitest";
import { MemoryInboxStorage } from "../inbox-storage";
import type { InboxMessageInput } from "../types";

function makeMessage(source = "test", type: "message" | "dispatch" = "message"): InboxMessageInput {
  if (type === "dispatch") {
    return {
      source,
      type: "dispatch",
      payload: { tool: "search", input: { q: "test" } },
    };
  }
  return {
    source,
    type: "message",
    payload: { role: "user", content: [{ type: "text", text: `from ${source}` }] },
  };
}

describe("MemoryInboxStorage", () => {
  // ══════════════════════════════════════════════════════════════════════
  // write()
  // ══════════════════════════════════════════════════════════════════════

  it("assigns unique IDs on write", async () => {
    const storage = new MemoryInboxStorage();
    const id1 = await storage.write("s1", makeMessage("a"));
    const id2 = await storage.write("s1", makeMessage("b"));
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("assigns timestamps on write", async () => {
    const storage = new MemoryInboxStorage();
    const before = Date.now();
    await storage.write("s1", makeMessage());
    const after = Date.now();

    const [msg] = await storage.pending("s1");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  // ══════════════════════════════════════════════════════════════════════
  // pending()
  // ══════════════════════════════════════════════════════════════════════

  it("returns FIFO order", async () => {
    const storage = new MemoryInboxStorage();
    await storage.write("s1", makeMessage("first"));
    await storage.write("s1", makeMessage("second"));
    await storage.write("s1", makeMessage("third"));

    const pending = await storage.pending("s1");
    expect(pending).toHaveLength(3);
    expect(pending[0].source).toBe("first");
    expect(pending[1].source).toBe("second");
    expect(pending[2].source).toBe("third");
  });

  it("returns empty for unknown session", async () => {
    const storage = new MemoryInboxStorage();
    expect(await storage.pending("nonexistent")).toEqual([]);
  });

  it("returns defensive copy — mutation does not affect internal state", async () => {
    const storage = new MemoryInboxStorage();
    await storage.write("s1", makeMessage());

    const copy = await storage.pending("s1");
    copy.pop();
    copy.push({} as any);

    const fresh = await storage.pending("s1");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].source).toBe("test");
  });

  // ══════════════════════════════════════════════════════════════════════
  // markDone()
  // ══════════════════════════════════════════════════════════════════════

  it("removes a message from pending", async () => {
    const storage = new MemoryInboxStorage();
    const id = await storage.write("s1", makeMessage());
    expect(await storage.pending("s1")).toHaveLength(1);

    await storage.markDone("s1", id);
    expect(await storage.pending("s1")).toHaveLength(0);
  });

  it("is idempotent — marking unknown message is a no-op", async () => {
    const storage = new MemoryInboxStorage();
    await storage.write("s1", makeMessage());

    // Mark a non-existent message
    await expect(storage.markDone("s1", "nonexistent")).resolves.not.toThrow();
    // Mark from non-existent session
    await expect(storage.markDone("nope", "anything")).resolves.not.toThrow();
  });

  it("removes only the targeted message", async () => {
    const storage = new MemoryInboxStorage();
    const id1 = await storage.write("s1", makeMessage("a"));
    await storage.write("s1", makeMessage("b"));

    await storage.markDone("s1", id1);
    const pending = await storage.pending("s1");
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("b");
  });

  // ══════════════════════════════════════════════════════════════════════
  // subscribe()
  // ══════════════════════════════════════════════════════════════════════

  it("fires callback on write", async () => {
    const storage = new MemoryInboxStorage();
    const cb = vi.fn();
    storage.subscribe("s1", cb);

    await storage.write("s1", makeMessage());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire for writes to other sessions", async () => {
    const storage = new MemoryInboxStorage();
    const cb = vi.fn();
    storage.subscribe("s1", cb);

    await storage.write("s2", makeMessage());
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops callback", async () => {
    const storage = new MemoryInboxStorage();
    const cb = vi.fn();
    const unsub = storage.subscribe("s1", cb);

    await storage.write("s1", makeMessage());
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    await storage.write("s1", makeMessage());
    expect(cb).toHaveBeenCalledTimes(1); // No additional call
  });

  it("multiple subscribers per session all fire", async () => {
    const storage = new MemoryInboxStorage();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    storage.subscribe("s1", cb1);
    storage.subscribe("s1", cb2);
    storage.subscribe("s1", cb3);

    await storage.write("s1", makeMessage());
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // sessionsWithPending()
  // ══════════════════════════════════════════════════════════════════════

  it("returns correct session IDs", async () => {
    const storage = new MemoryInboxStorage();
    await storage.write("s1", makeMessage());
    await storage.write("s2", makeMessage());
    await storage.write("s3", makeMessage());

    const ids = await storage.sessionsWithPending();
    expect(ids.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("excludes fully-drained sessions", async () => {
    const storage = new MemoryInboxStorage();
    const id = await storage.write("s1", makeMessage());
    await storage.write("s2", makeMessage());

    await storage.markDone("s1", id);

    const ids = await storage.sessionsWithPending();
    expect(ids).toEqual(["s2"]);
  });

  it("returns empty when no pending messages", async () => {
    const storage = new MemoryInboxStorage();
    expect(await storage.sessionsWithPending()).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // size / clear
  // ══════════════════════════════════════════════════════════════════════

  it("size counts sessions with pending messages", async () => {
    const storage = new MemoryInboxStorage();
    expect(storage.size).toBe(0);

    await storage.write("s1", makeMessage());
    await storage.write("s2", makeMessage());
    expect(storage.size).toBe(2);
  });

  it("clear removes everything", async () => {
    const storage = new MemoryInboxStorage();
    const cb = vi.fn();
    storage.subscribe("s1", cb);
    await storage.write("s1", makeMessage());

    storage.clear();
    expect(storage.size).toBe(0);
    expect(await storage.pending("s1")).toEqual([]);
    // Subscribers also cleared
    await storage.write("s1", makeMessage());
    expect(cb).toHaveBeenCalledTimes(1); // Only from before clear
  });

  // ══════════════════════════════════════════════════════════════════════
  // Adversarial
  // ══════════════════════════════════════════════════════════════════════

  it("concurrent writes to same session preserve insertion order", async () => {
    const storage = new MemoryInboxStorage();

    // Fire N writes concurrently — they should all land in order
    const writes = Array.from({ length: 20 }, (_, i) =>
      storage.write("s1", makeMessage(`msg-${i}`)),
    );
    await Promise.all(writes);

    const pending = await storage.pending("s1");
    expect(pending).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(pending[i].source).toBe(`msg-${i}`);
    }
  });

  it("subscriber that throws does not break subsequent writes", async () => {
    const storage = new MemoryInboxStorage();
    const badCb = vi.fn(() => {
      throw new Error("subscriber boom");
    });
    const goodCb = vi.fn();

    storage.subscribe("s1", badCb);
    storage.subscribe("s1", goodCb);

    // Should not throw
    const id = await storage.write("s1", makeMessage());
    expect(id).toBeTruthy();
    expect(badCb).toHaveBeenCalled();
    expect(goodCb).toHaveBeenCalled();

    // Message still persisted
    expect(await storage.pending("s1")).toHaveLength(1);
  });

  it("markDone during iteration of defensive copy is safe", async () => {
    const storage = new MemoryInboxStorage();
    await storage.write("s1", makeMessage("a"));
    await storage.write("s1", makeMessage("b"));
    await storage.write("s1", makeMessage("c"));

    const pending = await storage.pending("s1");
    // Simulate processing: iterate defensive copy, markDone from internal
    for (const msg of pending) {
      await storage.markDone("s1", msg.id);
    }

    expect(await storage.pending("s1")).toHaveLength(0);
  });

  it("write after unsubscribe does not fire old callback", async () => {
    const storage = new MemoryInboxStorage();
    const cb = vi.fn();
    const unsub = storage.subscribe("s1", cb);
    unsub();

    await storage.write("s1", makeMessage());
    expect(cb).not.toHaveBeenCalled();
  });

  it("write preserves payload integrity for dispatch type", async () => {
    const storage = new MemoryInboxStorage();
    const input = makeMessage("cli", "dispatch");
    await storage.write("s1", input);

    const [msg] = await storage.pending("s1");
    expect(msg.type).toBe("dispatch");
    expect(msg.payload).toEqual({ tool: "search", input: { q: "test" } });
    expect(msg.source).toBe("cli");
  });
});
