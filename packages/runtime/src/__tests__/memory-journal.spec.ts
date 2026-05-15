import { describe, expect, it } from "vitest";
import { runJournalConformance } from "@agentick/spec-conformance";
import { MemoryJournal } from "../substrate/memory-journal.js";

describe("MemoryJournal — conformance", () => runJournalConformance(() => new MemoryJournal()));

describe("MemoryJournal — capacity & overflow", () => {
  it("drops oldest events when capacity exceeded", async () => {
    const j = new MemoryJournal({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      await j.append({
        id: `e${i}`,
        surface: "session",
        name: "session:test",
        phase: "delta",
        timestamp: Date.now(),
        scope: {},
      });
    }
    const out: string[] = [];
    for await (const e of j.read({}, "beginning")) out.push(e.id);
    expect(out).toEqual(["e2", "e3", "e4"]);
    expect(j.totalAppended()).toBe(5);
  });
});
