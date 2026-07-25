/**
 * `withPrompts` slot trichotomy — ADR 42 Slice 3 contract.
 *
 * The `withPrompts` slot accepts three authoring patterns that all
 * collapse to the same internal {@link WithPromptsOptions} shape via
 * `resolveSlot`:
 *
 *   1. `PromptsRegisterInput[]` — array shorthand → `{ initial }`
 *   2. `Prompts` instance — adopter-supplied harness → `{ use }`
 *   3. `WithPromptsOptions` — config object: `initial`/`loaders`/
 *      `renderers` (built-in path) OR `use` (adopter-supplied
 *      instance, mutually exclusive with the built-in fields)
 *
 * @verifiedBy ADR 42 Slice 3 + `WithPromptsSlot` (extension.ts)
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { PromptsHarness } from "../harness.js";
import { fromArray } from "../loaders.js";
import { resolveSlot, withPrompts } from "../extension.js";

describe("resolveSlot — form A: PromptsRegisterInput[] shorthand", () => {
  it("collapses to { initial }", () => {
    const arr = [{ declaration: { name: "x", description: "x", template: "hello" } }];
    expect(resolveSlot(arr)).toEqual({ initial: arr });
  });
});

describe("resolveSlot — form B: Prompts instance shorthand", () => {
  it("collapses to { use }", async () => {
    const harness = new PromptsHarness(
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
    const cfg = {
      initial: [{ declaration: { name: "x", description: "x", template: "hi" } }],
    };
    expect(resolveSlot(cfg)).toBe(cfg);
  });

  it("passes through { loaders } unchanged", () => {
    const cfg = {
      loaders: [fromArray([{ declaration: { name: "x", description: "x", template: "hi" } }])],
    };
    expect(resolveSlot(cfg)).toBe(cfg);
  });

  it("rejects `use:` mixed with `initial`", async () => {
    const harness = new PromptsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(() =>
      resolveSlot({
        use: harness,
        initial: [{ declaration: { name: "x", description: "x", template: "hi" } }],
      }),
    ).toThrow(/use.*mutually exclusive/);
    await harness.close();
  });

  it("rejects `use:` mixed with `loaders`", async () => {
    const harness = new PromptsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(() =>
      resolveSlot({
        use: harness,
        loaders: [fromArray([])],
      }),
    ).toThrow(/use.*mutually exclusive/);
    await harness.close();
  });

  it("rejects `use:` mixed with `renderers`", async () => {
    const harness = new PromptsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(() =>
      resolveSlot({
        use: harness,
        renderers: [{ name: "noop", handles: () => false, render: async () => [] }],
      }),
    ).toThrow(/use.*mutually exclusive/);
    await harness.close();
  });
});

describe("withPrompts — extension factory accepts every form", () => {
  it("accepts array shorthand", () => {
    const ext = withPrompts([{ declaration: { name: "x", description: "x", template: "hi" } }]);
    expect(ext.name).toBe("@agentick/prompts");
    expect(ext.target).toBe("session");
  });

  it("accepts instance shorthand", async () => {
    const harness = new PromptsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    const ext = withPrompts(harness);
    expect(ext.target).toBe("session");
    await harness.close();
  });

  it("accepts config object", () => {
    const ext = withPrompts({
      initial: [{ declaration: { name: "x", description: "x", template: "hi" } }],
    });
    expect(ext.target).toBe("session");
  });

  it("accepts empty default", () => {
    const ext = withPrompts();
    expect(ext.target).toBe("session");
  });
});
