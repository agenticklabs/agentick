import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import { runJournalConformance } from "@agentick/spec-conformance";
import { MemoryJournal } from "../substrate/memory-journal.js";

describe("MemoryJournal — conformance", () => {
  runJournalConformance(() => new MemoryJournal());
});

describe("MemoryJournal — capacity & overflow", () => {
  it("drops oldest events when capacity exceeded", async () => {
    const j = new MemoryJournal({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(
        j.append({
          id: `e${i}`,
          surface: "session",
          name: "session:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    const chunk = await Effect.runPromise(Stream.runCollect(j.readByQuery({}, "beginning")));
    const out = Array.from(Chunk.toReadonlyArray(chunk)).map((e) => e.id);
    expect(out).toEqual(["e2", "e3", "e4"]);
    expect(j.totalAppended()).toBe(5);
  });

  it("L7 — evicts idempotency keys when their event drops from the ring", async () => {
    const j = new MemoryJournal({ capacity: 2 });
    const mkReq = (opId: string) => ({
      id: `evt-${opId}`,
      opId,
      surface: "session" as const,
      name: "session:command:send",
      phase: "requested" as const,
      timestamp: Date.now(),
      scope: {},
    });

    await Effect.runPromise(j.append(mkReq("op-1")));
    await Effect.runPromise(j.append(mkReq("op-2")));
    // Push op-1 out of the ring and out of appendedKeys.
    await Effect.runPromise(j.append(mkReq("op-3")));
    await Effect.runPromise(j.append(mkReq("op-4")));

    // Re-append op-1's lifecycle — should succeed because the key was
    // released alongside its evicted event. Pre-L7 this was a silent
    // no-op (appendedKeys grew unbounded).
    await Effect.runPromise(
      j.append({
        id: "evt-op-1-replay",
        opId: "op-1",
        surface: "session",
        name: "session:command:send",
        phase: "requested",
        timestamp: Date.now(),
        scope: {},
      }),
    );

    const chunk = await Effect.runPromise(Stream.runCollect(j.readByQuery({}, "beginning")));
    const out = Array.from(Chunk.toReadonlyArray(chunk)).map((e) => e.id);
    expect(out).toContain("evt-op-1-replay");
  });

  it("L7 — evicts terminals + inFlight maps with their events", async () => {
    const j = new MemoryJournal({ capacity: 2 });
    const evt = (opId: string, phase: "requested" | "terminal", id: string) =>
      ({
        id,
        opId,
        surface: "session" as const,
        name: "session:command:send",
        phase,
        timestamp: Date.now(),
        scope: {},
        ...(phase === "terminal" ? { outcome: "succeeded" as const } : {}),
      }) as const;

    await Effect.runPromise(j.append(evt("op-A", "requested", "a1")));
    await Effect.runPromise(j.append(evt("op-A", "terminal", "a2")));

    const beforeEvict = await Effect.runPromise(j.lookupTerminal("op-A"));
    expect(beforeEvict.some).toBe(true);

    // Push op-A out of the ring entirely.
    await Effect.runPromise(j.append(evt("op-B", "requested", "b1")));
    await Effect.runPromise(j.append(evt("op-C", "requested", "c1")));

    const afterEvict = await Effect.runPromise(j.lookupTerminal("op-A"));
    expect(afterEvict.some).toBe(false);
  });
});

describe("MemoryJournal — cursor protocol (Phase C)", () => {
  it("read(cursor: 0, matcher) replays all retained events", async () => {
    const j = new MemoryJournal({ capacity: 10 });
    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(
        j.append({
          id: `e${i}`,
          surface: "tool",
          name: "tool:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    const chunk = await Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          j.read({ value: 0 }, () => true),
          5,
        ),
      ),
    );
    expect(Array.from(Chunk.toReadonlyArray(chunk)).map((e) => e.id)).toEqual([
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("read from cursor at head tails new appends only", async () => {
    const j = new MemoryJournal({ capacity: 10 });
    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(
        j.append({
          id: `pre-${i}`,
          surface: "tool",
          name: "tool:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(
          j.read({ value: j.totalAppended() }, () => true),
          2,
        ),
      ),
    );
    await new Promise((r) => setImmediate(r));
    await Effect.runPromise(
      j.append({
        id: "live-1",
        surface: "tool",
        name: "tool:test",
        phase: "delta",
        timestamp: Date.now(),
        scope: {},
      }),
    );
    await Effect.runPromise(
      j.append({
        id: "live-2",
        surface: "tool",
        name: "tool:test",
        phase: "delta",
        timestamp: Date.now(),
        scope: {},
      }),
    );
    const chunk = await Effect.runPromise(fiber.await);
    expect(chunk._tag).toBe("Success");
    if (chunk._tag === "Success") {
      expect(Array.from(Chunk.toReadonlyArray(chunk.value)).map((e) => e.id)).toEqual([
        "live-1",
        "live-2",
      ]);
    }
  });

  it("read past retention fails with CursorEvictedError", async () => {
    const j = new MemoryJournal({ capacity: 2 });
    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(
        j.append({
          id: `e${i}`,
          surface: "tool",
          name: "tool:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    const result = await Effect.runPromise(
      Effect.either(
        Stream.runCollect(
          Stream.take(
            j.read({ value: 0 }, () => true),
            5,
          ),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CursorEvictedError");
    }
  });
});

describe("MemoryJournal — metrics", () => {
  it("retentionEvents reflects the live ring size", async () => {
    const j = new MemoryJournal({ capacity: 5 });
    expect(j.metrics().retentionEvents).toBe(0);
    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(
        j.append({
          id: `e${i}`,
          surface: "tool",
          name: "tool:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    expect(j.metrics().retentionEvents).toBe(3);
  });

  it("dropRate increases as capacity overflows", async () => {
    const j = new MemoryJournal({ capacity: 2 });
    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(
        j.append({
          id: `e${i}`,
          surface: "tool",
          name: "tool:test",
          phase: "delta",
          timestamp: Date.now(),
          scope: {},
        }),
      );
    }
    // 5 appended, 3 dropped → 0.6
    expect(j.metrics().dropRate).toBeCloseTo(3 / 5, 5);
  });
});
