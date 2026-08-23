/**
 * TimelineHarness × TimelineStore — durability wiring (ADR 49).
 *
 * The persisted tier is store-backed; memory stays authoritative with a
 * write-behind pump and a `flush()` barrier. These tests pin:
 *   - write-behind drains to the store at the flush barrier, in order;
 *   - write-through persists synchronously with each append;
 *   - hydrate() loads the durable log into memory (the resume path);
 *   - close() flushes buffered writes (session-close barrier);
 *   - compaction APPENDS what it produced and rewrites nothing;
 *   - a store-write failure surfaces (flush rejects / write-through throws).
 */

import { describe, expect, it } from "vitest";
import { TimelineWriteFailed, type TimelineEntry, type TimelineStore } from "@agentick/spec";

import { stubStoreCtx } from "@agentick/store";

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
    read: (s, ctx) => inner.read(s, ctx),
    keys: (ctx) => inner.keys(ctx),
    delete: (s, ctx) => inner.delete(s, ctx),
    append: (s, entries, ctx) => {
      appends += 1;
      if (appends >= failOnAppend) return Promise.reject(new Error("store append boom"));
      return inner.append(s, entries, ctx);
    },
    query: (q, ctx) => inner.query(q, ctx),
    mutate: (m, ctx) => inner.mutate(m, ctx),
  };
}

describe("TimelineHarness — write-behind (default)", () => {
  it("drains appended entries to the store at the flush barrier, in order", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });

    await h.append(messageEntry("a"), messageEntry("b"));
    await h.append(messageEntry("c"));
    // Memory is authoritative immediately.
    expect(ids(h.read().entries)).toEqual(["a", "b", "c"]);

    await h.flush();
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a", "b", "c"]);
  });

  it("flush() is idempotent and a no-op when nothing is buffered", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.flush(); // nothing appended yet
    await h.append(messageEntry("a"));
    await h.flush();
    await h.flush(); // already drained
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a"]);
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
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a"]);
    await h.append(messageEntry("b"));
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a", "b"]);
  });
});

describe("TimelineHarness — hydrate (resume path)", () => {
  it("loads the durable log into both tiers", async () => {
    const store = new MemoryTimelineStore();
    // Simulate a prior process that persisted this session.
    await store.append("stub-session", [messageEntry("x"), messageEntry("y")], stubStoreCtx());

    // New harness bound to the same store + same session id.
    const h = stubTimelineHarness([], { store });
    // Override: stubTimelineHarness generates its own id, so hydrate reads
    // from the harness's own id. Seed under that id instead.
    await store.delete("stub-session", stubStoreCtx());
    await store.append(h.id, [messageEntry("x"), messageEntry("y")], stubStoreCtx());

    expect(ids(h.read().entries)).toEqual([]); // nothing loaded yet
    await h.hydrate();
    expect(ids(h.read().entries)).toEqual(["x", "y"]);
    expect(ids(h.read().entries)).toEqual(["x", "y"]);
  });
});

describe("TimelineHarness — close flushes", () => {
  it("drains buffered write-behind entries on close()", async () => {
    const store = new MemoryTimelineStore();
    const h = stubTimelineHarness([], { store });
    await h.append(messageEntry("a"), messageEntry("b"));
    await h.close();
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a", "b"]);
  });
});

describe("TimelineHarness — compaction appends, never rewrites", () => {
  it("what the fold produced reaches the store; what was there is untouched", async () => {
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
    // …and the store still holds the original three, in order, with the
    // summary appended after them. A summary that lived only in the projection
    // evaporated on restart, which is what pushed adopters into a side table.
    expect(ids(await store.read(h.id, stubStoreCtx()))).toEqual(["a", "b", "c", "summary"]);
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
    expect(ids(h.read().entries)).toEqual(["a"]);
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
      read: (sid, ctx) => store.read(sid, ctx),
      append: (sid, e, ctx) => store.append(sid, e, ctx),
      keys: (ctx) => store.keys(ctx),
      delete: (sid, ctx) => store.delete(sid, ctx),
      query: (q, ctx) => store.query(q, ctx),
      mutate: (m, ctx) => store.mutate(m, ctx),
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
    expect(h.read().entries.filter((e) => e.kind === "boundary")).toEqual([]);
    const loaded = await store.read(h.id.replace(/^timeline:/, ""), stubStoreCtx());
    expect(loaded.filter((e) => e.kind === "boundary")).toEqual([]);
  });
});
