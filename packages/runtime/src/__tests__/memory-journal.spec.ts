import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import { runJournalConformance } from "@agentick/spec-conformance";
import { MemoryJournal } from "../substrate/memory-journal.js";

describe("MemoryJournal — conformance", () => runJournalConformance(() => new MemoryJournal()));

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
    const chunk = await Effect.runPromise(Stream.runCollect(j.read({}, "beginning")));
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

    const chunk = await Effect.runPromise(Stream.runCollect(j.read({}, "beginning")));
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
