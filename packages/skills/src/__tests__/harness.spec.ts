/**
 * SkillsHarness — conformance + impl-specific tests.
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";

import { SkillsHarness } from "../harness.js";
import { runSkillsHarnessConformance } from "../conformance.js";
import { stubSkillsHarness } from "../testing/index.js";

describe("SkillsHarness — conformance", () => {
  runSkillsHarnessConformance({
    make: async () => {
      const harness = new SkillsHarness(
        `conformance:${ulid()}`,
        new MemoryJournal({ capacity: 1024 }),
        new LocalEventBus(),
        new LocalInbox(),
      );
      await harness.ready;
      return harness;
    },
  });
});

describe("SkillsHarness — impl-specific", () => {
  it("seeds via stubSkillsHarness({initial})", async () => {
    const h = await stubSkillsHarness([
      { name: "a", description: "A", content: "..." },
      { name: "b", description: "B", content: "..." },
    ]);
    expect(h.list().map((s) => s.name)).toEqual(["a", "b"]);
    await h.close();
  });

  it("mutation envelopes flow on the bus surface 'skills'", async () => {
    const journal = new MemoryJournal({ capacity: 1024 });
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const harness = new SkillsHarness(`obs:${ulid()}`, journal, bus, inbox);
    await harness.ready;

    const observed: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "skills" }), (e) =>
        Effect.sync(() => {
          observed.push(e);
        }),
      ),
    );
    // Let the subscriber attach.
    await new Promise((r) => setImmediate(r));

    await harness.register({ name: "skill_a", description: "A", content: "..." });
    await harness.update({ name: "skill_a", description: "A2" });
    await harness.remove({ name: "skill_a" });

    // Let the bus deliver — wait a tick.
    await new Promise((r) => setTimeout(r, 20));

    const terminalNames = observed.filter((e) => e.phase === "terminal").map((e) => e.name);
    expect(terminalNames).toContain("skills:command:register");
    expect(terminalNames).toContain("skills:command:update");
    expect(terminalNames).toContain("skills:command:remove");

    void fiber;
    await harness.close();
  });
});

/**
 * `Skill.version` — the adopter's own revision string, promoted out of the
 * metadata bag so the run's provenance stamp can carry it. Declared, never
 * computed: the framework copies it and nothing else.
 *
 * @see docs/proposals/v2/materialization-provenance.md §3
 */
describe("SkillsHarness — declared version rides the record", () => {
  const mk = async (): Promise<SkillsHarness> => {
    const h = new SkillsHarness(
      `ver:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await h.ready;
    return h;
  };

  it("survives register → get → list → snapshot → import", async () => {
    const h = await mk();
    await h.register({ name: "s", description: "d", content: "body", version: "1.4.0" });

    expect(h.get("s")?.version).toBe("1.4.0");
    expect(h.list()[0]?.version).toBe("1.4.0");

    const snapshot = h.exportSnapshot();
    expect(snapshot.s?.version).toBe("1.4.0");

    const restored = await mk();
    restored.importSnapshot(snapshot);
    expect(restored.get("s")?.version).toBe("1.4.0");

    await h.close();
    await restored.close();
  });

  it("is absent when undeclared, patchable, and untouched by a silent patch", async () => {
    const h = await mk();
    await h.register({ name: "s", description: "d", content: "body" });
    expect(h.get("s")).not.toHaveProperty("version");

    expect((await h.update({ name: "s", version: "2" })).version).toBe("2");
    expect((await h.update({ name: "s", description: "d2" })).version).toBe("2");

    await h.close();
  });
});
