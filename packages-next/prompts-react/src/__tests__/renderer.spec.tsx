/**
 * `reactPromptRenderer` — JSX → MessageEntry[].
 *
 * Pins:
 *  - `<message role="...">` JSX → MessageEntry passthrough
 *  - `<section>` JSX → buffered into a system MessageEntry
 *  - section title prepended as `# title` text block
 *  - explicit messages flush the section buffer (preserve authoring order)
 *  - `handles()` predicate accepts React-shaped content; rejects strings? no — strings ARE ReactNode
 *  - end-to-end via PromptsHarness with `withReactPrompts`-equivalent wiring
 */

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import { PromptsHarness } from "@agentick/prompts-next";

import { reactPromptRenderer, createReactPromptRenderer } from "../renderer.js";

async function makeHarness(): Promise<PromptsHarness> {
  const harness = new PromptsHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { renderers: [reactPromptRenderer] },
  );
  await harness.ready;
  return harness;
}

describe("reactPromptRenderer — direct render()", () => {
  it("loose section → single system MessageEntry", async () => {
    const node = createElement("section" as never, { id: "intro" }, "Hello, world.");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    expect(
      messages[0]!.content.some((b) => b.type === "text" && b.text.includes("Hello, world.")),
    ).toBe(true);
  });

  it("section with title → leading '# title' text block", async () => {
    const node = createElement("section" as never, { id: "x", title: "Greeting" }, "Hi.");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content;
    expect(blocks[0]).toEqual({ type: "text", text: "# Greeting" });
  });

  it("explicit <message> → passthrough preserves role", async () => {
    const node = createElement("message" as never, { role: "user" }, "ping");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("section then message → buffer flushes, message follows", async () => {
    const node = createElement(
      "fragment" as never,
      null,
      createElement("section" as never, { id: "ctx" }, "context"),
      createElement("message" as never, { role: "user" }, "question"),
    );
    // Use React fragment via array-children
    const fragment = [
      createElement("section" as never, { id: "ctx", key: "s" }, "context"),
      createElement("message" as never, { role: "user", key: "m" }, "question"),
    ];
    const messages = await reactPromptRenderer.render(fragment, {});
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    // Suppress unused
    void node;
  });

  it("multiple sections → concatenated into single system message (parts)", async () => {
    const fragment = [
      createElement("section" as never, { id: "a", key: "a" }, "alpha"),
      createElement("section" as never, { id: "b", key: "b" }, "beta"),
    ];
    const messages = await reactPromptRenderer.render(fragment, {});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    const text = messages[0]!.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });
});

describe("reactPromptRenderer — handles predicate", () => {
  it("accepts React elements", () => {
    const el = createElement("section" as never, { id: "x" }, "y");
    expect(reactPromptRenderer.handles(el)).toBe(true);
  });
  it("accepts arrays of nodes", () => {
    expect(reactPromptRenderer.handles([createElement("section" as never, { id: "x" }, "y")])).toBe(
      true,
    );
  });
  it("accepts strings (valid ReactNode)", () => {
    expect(reactPromptRenderer.handles("loose text")).toBe(true);
  });
  it("rejects null/undefined", () => {
    expect(reactPromptRenderer.handles(null)).toBe(false);
    expect(reactPromptRenderer.handles(undefined)).toBe(false);
  });
});

describe("reactPromptRenderer — end-to-end via PromptsHarness", () => {
  it("renders a React-JSX prompt at invoke time", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "weekly_status",
        description: "Weekly status template",
        arguments: [{ name: "week", required: true }],
        render: (args) =>
          createElement(
            "message" as never,
            { role: "user" },
            `Generate the weekly status report for week ${String(args.week)}.`,
          ),
      },
    });
    const result = await h.get({ name: "weekly_status", args: { week: "2026-06-28" } });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(
      result.messages[0]!.content.some((b) => b.type === "text" && b.text.includes("2026-06-28")),
    ).toBe(true);
  });

  it("renders a mixed JSX template (section + explicit message) via harness", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: {
        name: "qa",
        description: "Q&A",
        arguments: [{ name: "q", required: true }],
        render: (args) => [
          createElement(
            "section" as never,
            { id: "sys", title: "System", key: "s" },
            "You are helpful.",
          ),
          createElement("message" as never, { role: "user", key: "m" }, String(args.q)),
        ],
      },
    });
    const result = await h.get({ name: "qa", args: { q: "What is 2+2?" } });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[1]!.role).toBe("user");
  });
});

describe("createReactPromptRenderer — custom options", () => {
  it("narrowed handles predicate is respected", () => {
    const r = createReactPromptRenderer({ handles: (c) => typeof c === "string" });
    expect(r.handles("yes")).toBe(true);
    expect(r.handles(createElement("section" as never, { id: "x" }, "y"))).toBe(false);
  });
});
