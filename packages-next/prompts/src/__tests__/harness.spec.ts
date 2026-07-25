/**
 * `PromptsHarness` — basic conformance.
 *
 * Pins for the core (non-framework) surface:
 *  - register / has / list / get round-trip
 *  - typed error on duplicate register / unknown name
 *  - argument validation: missing required, schema mismatch, passthrough of unknowns
 *  - native content dispatch: string → system message; MessageEntry[] passthrough
 *  - custom renderer dispatch via `renderers` array
 *  - PromptRenderFailed when no renderer matches
 *  - PromptMissingContent when neither template nor render
 *  - get() vs invoke() both return PromptsGetResult
 *  - snapshot round-trip carries names/arguments but drops template/render
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";

import { PromptsHarness } from "../harness.js";
import type { PromptRenderer } from "../renderer.js";

async function makeHarness(renderers: PromptRenderer[] = []): Promise<PromptsHarness> {
  const harness = new PromptsHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { renderers },
  );
  await harness.ready;
  return harness;
}

describe("PromptsHarness — registration", () => {
  it("register + get + list round-trips", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "greet",
        description: "Greet the user",
        template: "Hello, world.",
      },
    });
    expect(h.has("greet")).toBe(true);
    expect(h.get("greet")?.description).toBe("Greet the user");
    expect(h.list()).toHaveLength(1);
  });

  it("duplicate register fails with PromptAlreadyExists", async () => {
    const h = await makeHarness();
    await h.register({ declaration: { name: "x", description: "x", template: "t" } });
    await expect(
      h.register({ declaration: { name: "x", description: "x2", template: "t2" } }),
    ).rejects.toMatchObject({ _tag: "PromptAlreadyExists", promptName: "x" });
  });

  it("update merges fields", async () => {
    const h = await makeHarness();
    await h.register({ declaration: { name: "x", description: "old", template: "t" } });
    const updated = await h.update({ name: "x", declaration: { description: "new" } });
    expect(updated.description).toBe("new");
    expect(updated.template).toBe("t");
  });

  it("remove is idempotent", async () => {
    const h = await makeHarness();
    await h.remove({ name: "never-registered" });
    expect(h.has("never-registered")).toBe(false);
  });
});

describe("PromptsHarness — invoke + native content", () => {
  it("string content → single system message", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: { name: "greet", description: "Greet", template: "Hello, world." },
    });
    const result = await h.render({ name: "greet" });
    expect(result.description).toBe("Greet");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "Hello, world." }]);
  });

  it("render(args) string → system message", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "summarize",
        description: "Summarize",
        arguments: [{ name: "docId", required: true }],
        render: (args) => `Summarize doc ${String(args.docId)}.`,
      },
    });
    const result = await h.render({ name: "summarize", args: { docId: "42" } });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "Summarize doc 42." }]);
  });

  it("MessageEntry[] content → passthrough", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "multi",
        description: "Multi-turn",
        render: () => [
          {
            kind: "message" as const,
            role: "system" as const,
            content: [{ type: "text" as const, text: "You are helpful." }],
          },
          {
            kind: "message" as const,
            role: "user" as const,
            content: [{ type: "text" as const, text: "Hi" }],
          },
        ],
      },
    });
    const result = await h.render({ name: "multi" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("PromptNotFound on unknown name", async () => {
    const h = await makeHarness();
    await expect(h.render({ name: "nope" })).rejects.toMatchObject({
      _tag: "PromptNotFound",
      promptName: "nope",
    });
  });

  it("PromptMissingContent when neither template nor render", async () => {
    const h = await makeHarness();
    await h.register({ declaration: { name: "empty", description: "empty" } });
    await expect(h.render({ name: "empty" })).rejects.toMatchObject({
      _tag: "PromptMissingContent",
      promptName: "empty",
    });
  });

  it("render() that throws → PromptRenderFailed", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "boom",
        description: "boom",
        render: () => {
          throw new Error("kaboom");
        },
      },
    });
    await expect(h.render({ name: "boom" })).rejects.toMatchObject({
      _tag: "PromptRenderFailed",
      promptName: "boom",
    });
  });
});

describe("PromptsHarness — argument validation", () => {
  it("missing required arg → PromptArgumentMissing", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        arguments: [{ name: "x", required: true }],
        render: (args) => `got ${String(args.x)}`,
      },
    });
    await expect(h.render({ name: "p" })).rejects.toMatchObject({
      _tag: "PromptArgumentMissing",
      promptName: "p",
      argument: "x",
    });
  });

  it("optional arg can be omitted", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        arguments: [{ name: "x" /* required undefined → false */ }],
        render: (args) => `got ${String(args.x ?? "default")}`,
      },
    });
    const result = await h.render({ name: "p" });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "got default" }]);
  });

  it("schema validation passes valid values", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        arguments: [
          {
            name: "n",
            schema: {
              "~standard": {
                vendor: "test",
                version: 1,
                validate: (v) =>
                  typeof v === "number" ? { value: v } : { issues: [{ message: "not a number" }] },
              },
            },
          },
        ],
        render: (args) => `got ${String(args.n)}`,
      },
    });
    const result = await h.render({ name: "p", args: { n: 42 } });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "got 42" }]);
  });

  it("schema validation rejects invalid → PromptArgumentInvalid", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        arguments: [
          {
            name: "n",
            schema: {
              "~standard": {
                vendor: "test",
                version: 1,
                validate: (v) =>
                  typeof v === "number" ? { value: v } : { issues: [{ message: "not a number" }] },
              },
            },
          },
        ],
        render: (args) => `got ${String(args.n)}`,
      },
    });
    await expect(h.render({ name: "p", args: { n: "oops" } })).rejects.toMatchObject({
      _tag: "PromptArgumentInvalid",
      promptName: "p",
      argument: "n",
    });
  });
});

describe("PromptsHarness — custom renderer dispatch", () => {
  it("registered renderer handles its content shape", async () => {
    const customRenderer: PromptRenderer = {
      name: "test-marker",
      handles: (c) =>
        typeof c === "object" && c !== null && (c as { __marker?: boolean }).__marker === true,
      async render(_content, args) {
        return [
          {
            kind: "message",
            role: "user",
            content: [{ type: "text", text: `rendered ${String(args.x)}` }],
          },
        ];
      },
    };
    const h = await makeHarness([customRenderer]);
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        arguments: [{ name: "x", required: true }],
        render: () => ({ __marker: true }) as unknown,
      },
    });
    const result = await h.render({ name: "p", args: { x: "hello" } });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "rendered hello" }]);
  });

  it("PromptRenderFailed when no renderer matches non-native content", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "p",
        description: "p",
        render: () => ({ unknown: "shape" }) as unknown,
      },
    });
    await expect(h.render({ name: "p" })).rejects.toMatchObject({
      _tag: "PromptRenderFailed",
      promptName: "p",
    });
  });
});

describe("PromptsHarness — snapshot round-trip", () => {
  it("export + import preserves names + arguments + description (drops template/render)", async () => {
    const h1 = await makeHarness();
    await h1.register({
      declaration: {
        name: "p",
        description: "p-desc",
        arguments: [{ name: "x", required: true }],
        template: "hi",
      },
    });
    const snapshot = h1.exportSnapshot();

    const h2 = await makeHarness();
    h2.importSnapshot(snapshot);
    const decl = h2.get("p");
    expect(decl?.name).toBe("p");
    expect(decl?.description).toBe("p-desc");
    expect(decl?.arguments).toEqual([{ name: "x", required: true }]);
    // template + render not preserved
    expect(decl?.template).toBeUndefined();
    expect(decl?.render).toBeUndefined();
  });
});
