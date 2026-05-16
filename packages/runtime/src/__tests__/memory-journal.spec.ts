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
});
