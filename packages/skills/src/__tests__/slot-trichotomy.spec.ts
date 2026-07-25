/**
 * `withSkills` slot trichotomy — ADR 42 Slice 3 contract.
 *
 * The `withSkills` slot accepts three authoring patterns that all
 * collapse to the same internal {@link WithSkillsOptions} shape via
 * `resolveSlot`:
 *
 *   1. `SkillsRegisterInput[]` — array shorthand → `{ initial }`
 *   2. `Skills` instance — adopter-supplied harness → `{ use }`
 *   3. `WithSkillsOptions` — config object: `initial`/`loaders` (built-in
 *      path) OR `use` (adopter-supplied instance, mutually exclusive
 *      with `initial`/`loaders`)
 *
 * @verifiedBy ADR 42 Slice 3 + `WithSkillsSlot` (extension.ts)
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { SkillsHarness } from "../harness.js";
import { fromArray } from "../loaders.js";
import { resolveSlot, withSkills } from "../extension.js";

describe("resolveSlot — form A: SkillsRegisterInput[] shorthand", () => {
  it("collapses to { initial }", () => {
    const arr = [{ name: "x", description: "x", content: "x" }];
    expect(resolveSlot(arr)).toEqual({ initial: arr });
  });
});

describe("resolveSlot — form B: Skills instance shorthand", () => {
  it("collapses to { use }", async () => {
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(resolveSlot(harness)).toEqual({ use: harness });
    await harness.close();
  });
});

describe("resolveSlot — form C: config object", () => {
  it("passes through { initial } unchanged", () => {
    const cfg = { initial: [{ name: "x", description: "x", content: "x" }] };
    expect(resolveSlot(cfg)).toBe(cfg);
  });

  it("passes through { loaders } unchanged", () => {
    const cfg = {
      loaders: [fromArray([{ name: "x", description: "x", content: "x" }])],
    };
    expect(resolveSlot(cfg)).toBe(cfg);
  });

  it("rejects `use:` mixed with `initial`", async () => {
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(() =>
      resolveSlot({
        use: harness,
        initial: [{ name: "x", description: "x", content: "x" }],
      }),
    ).toThrow(/use.*mutually exclusive/);
    await harness.close();
  });

  it("rejects `use:` mixed with `loaders`", async () => {
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(() =>
      resolveSlot({
        use: harness,
        loaders: [fromArray([{ name: "x", description: "x", content: "x" }])],
      }),
    ).toThrow(/use.*mutually exclusive/);
    await harness.close();
  });
});

describe("withSkills — extension factory accepts every form", () => {
  it("accepts array shorthand", () => {
    const ext = withSkills([{ name: "x", description: "x", content: "x" }]);
    expect(ext.name).toBe("@agentick/skills");
    expect(ext.target).toBe("session");
  });

  it("accepts instance shorthand", async () => {
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    const ext = withSkills(harness);
    expect(ext.target).toBe("session");
    await harness.close();
  });

  it("accepts config object", () => {
    const ext = withSkills({ initial: [{ name: "x", description: "x", content: "x" }] });
    expect(ext.target).toBe("session");
  });

  it("accepts empty default", () => {
    const ext = withSkills();
    expect(ext.target).toBe("session");
  });
});
