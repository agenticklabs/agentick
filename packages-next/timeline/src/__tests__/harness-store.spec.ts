/**
 * TimelineHarness × TimelineStore — durability wiring (ADR 49).
 *
 * The persisted tier is store-backed; memory stays authoritative with a
 * write-behind pump and a `flush()` barrier. These tests pin:
 *   - write-behind drains to the store at the flush barrier, in order;
 *   - write-through persists synchronously with each append;
 *   - hydrate() loads the durable log into memory (the resume path);
 *   - close() flushes buffered writes (session-close barrier);
 *   - compaction NEVER touches the store (persisted tier is append-only);
 *   - a store-write failure surfaces (flush rejects / write-through throws).
 */

import { describe, expect, it } from "vitest";
import { TimelineWriteFailed, type TimelineEntry, type TimelineStore } from "@agentick/spec-next";

import { MemoryTimelineStore } from "../store.js";
import { stubTimelineHarness } from "../testing/index.js";

function messageEntry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const ids = (entries: readonly TimelineEntry[]): string[] =>
  entries.map((e) => (e as { message: { id: string } }).message.id);

/** A store that rejects on the Nth append (1-based), for failure-path tests. */
function failingStore(failOnAppend: number): TimelineStore {
  const inner = new MemoryTimelineStore();
  let appends = 0;
  return {
    backend: "failing",
    read: (s) => inner.read(s),
    keys: () => inner.keys(),
    delete: (s) => inner.delete(s),
    append: (s, entries) => {
      appends += 1;
      if (appends >= failOnAppend) return Promise.reject(new Error("store append boom"));
      return inner.append(s, entries);
    },
  };
}

describe("TimelineHarness — write-behind (default)", () => {
  it("drains appended entries to the store at the flush barrier, in order", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });

    await h.append(messageEntry("a"), messageEntry("b"));
    await h.append(messageEntry("c"));
    // Memory is authoritative immediately.
    expect(ids(h.readPersisted())).toEqual(["a", "b", "c"]);

    await h.flush();
    expect(ids(await store.read(h.id))).toEqual(["a", "b", "c"]);
  });

  it("flush() is idempotent and a no-op when nothing is buffered", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.flush(); // nothing appended yet
    await h.append(messageEntry("a"));
    await h.flush();
    await h.flush(); // already drained
    expect(ids(await store.read(h.id))).toEqual(["a"]);
  });

  it("reports the store's backend identifier", () => {
    const h = stubTimelineHarness([], { store: new MemoryTimelineStore() });
    expect(h.backend).toBe("memory");
  });

  it("defaults to a bundled MemoryTimelineStore when none is injected", async () => {
    const h = stubTimelineHarness();
    expect(h.backend).toBe("memory");
    await h.append(messageEntry("a"));
    await expect(h.flush()).resolves.toBeUndefined();
  });
});

describe("TimelineHarness — write-through", () => {
  it("persists to the store synchronously with each append", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store, writePolicy: "through" });

    await h.append(messageEntry("a"));
    // No flush needed — the append awaited the store.
    expect(ids(await store.read(h.id))).toEqual(["a"]);
    await h.append(messageEntry("b"));
    expect(ids(await store.read(h.id))).toEqual(["a", "b"]);
  });
});

describe("TimelineHarness — hydrate (resume path)", () => {
  it("loads the durable log into both tiers", async () => {
    const store = new MemoryTimelineStore();
    // Simulate a prior process that persisted this session.
    await store.append("stub-session", [messageEntry("x"), messageEntry("y")]);

    // New harness bound to the same store + same session id.
    const h = stubTimelineHarness([], { store });
    // Override: stubTimelineHarness generates its own id, so hydrate reads
    // from the harness's own id. Seed under that id instead.
    await store.delete("stub-session");
    await store.append(h.id, [messageEntry("x"), messageEntry("y")]);

    expect(ids(h.readPersisted())).toEqual([]); // nothing loaded yet
    await h.hydrate();
    expect(ids(h.readPersisted())).toEqual(["x", "y"]);
    expect(ids(h.read().entries)).toEqual(["x", "y"]);
  });
});

describe("TimelineHarness — close flushes", () => {
  it("drains buffered write-behind entries on close()", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.append(messageEntry("a"), messageEntry("b"));
    await h.close();
    expect(ids(await store.read(h.id))).toEqual(["a", "b"]);
  });
});

describe("TimelineHarness — compaction never touches the store", () => {
  it("compact() rewrites only the projection; the durable log is untouched", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.append(messageEntry("a"), messageEntry("b"), messageEntry("c"));
    await h.flush();

    // Compact the projection down to a single summary entry.
    await h.compact({
      source: "projection",
      run: async () => [messageEntry("summary")],
    });
    await h.flush();

    // Projection collapsed…
    expect(ids(h.read().entries)).toEqual(["summary"]);
    // …but the store's append-only log is exactly the original three.
    expect(ids(await store.read(h.id))).toEqual(["a", "b", "c"]);
  });
});

describe("TimelineHarness — store failure surfaces", () => {
  it("write-behind: flush() rejects with typed TimelineWriteFailed when a buffered write fails", async () => {
    const h = stubTimelineHarness([], { store: failingStore(1) });
    await h.append(messageEntry("a")); // memory update succeeds
    await expect(h.flush()).rejects.toBeInstanceOf(TimelineWriteFailed);
  });

  it("write-through: append surfaces a typed TimelineWriteFailed when the store write fails", async () => {
    const h = stubTimelineHarness([], { store: failingStore(1), writePolicy: "through" });
    // The operation fails with the typed error in its channel; runHarnessProtocol
    // rejects. Assert the tag survives so a session barrier can catchTag it.
    await expect(
      h.append(messageEntry("a")).catch((e) => (e as { _tag?: string })._tag),
    ).resolves.toBe("TimelineWriteFailed");
  });

  it("compact: a failing (e.g. LLM) strategy surfaces a typed CompactHandlerFailed, not a defect", async () => {
    const h = stubTimelineHarness([], { store: new MemoryTimelineStore() });
    await h.append(messageEntry("a"));
    // A model-backed compaction that fails operationally (timeout/rate-limit).
    const tag = await h
      .compact({
        source: "projection",
        run: async () => Promise.reject(new Error("model timeout")),
      })
      .catch((e) => (e as { _tag?: string })._tag);
    expect(tag).toBe("CompactHandlerFailed");
    // The op failed → projection untouched, log intact.
    expect(ids(h.readPersisted())).toEqual(["a"]);
  });
});

describe("timeline.history() — cursored read (#187)", () => {
  it("flushes write-behind, then pages seq-tagged entries", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.append(messageEntry("a"), messageEntry("b"), messageEntry("c"));
    // No explicit flush — history() must flush the write-behind buffer.
    const all = await h.history();
    expect(all.map((t) => t.seq)).toEqual([0, 1, 2]);
    const page = await h.history({ fromSeq: 1, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]!.seq).toBe(1);
  });

  it("throws a clear error when the store lacks cursored reads", async () => {
    const store = new MemoryTimelineStore();
    const bare: TimelineStore = {
      backend: "no-history",
      read: (sid) => store.read(sid),
      append: (sid, e) => store.append(sid, e),
      keys: () => store.keys(),
      delete: (sid) => store.delete(sid),
    };
    const h = stubTimelineHarness([], { store: bare });
    await h.append(messageEntry("a"));
    await expect(h.history()).rejects.toThrow(/does not implement the optional/);
  });
});

describe("turnBoundaries: false opt-out (ADR 53)", () => {
  it("endTurn is a no-op — no boundary rows reach the store", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store, turnBoundaries: false });
    await h.append(messageEntry("m1"));
    await h.endTurn({ executionId: "e1", outcome: "succeeded" });
    await h.flush();
    expect(h.readPersisted().filter((e) => e.kind === "boundary")).toEqual([]);
    const loaded = await store.read(h.id.replace(/^timeline:/, ""));
    expect(loaded.filter((e) => e.kind === "boundary")).toEqual([]);
  });
});
