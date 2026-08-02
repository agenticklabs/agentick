/**
 * `reactPromptRenderer` — JSX → MessageEntry[].
 *
 * Pins:
 *  - `<message role="...">` JSX → MessageEntry passthrough
 *  - free-floating `<section>` JSX → its own `grounding` MessageEntry (ADR 94)
 *  - section title lowers to a leading `# title` line in the section's block
 *  - authoring order is preserved entry-for-entry
 *  - `handles()` predicate accepts React-shaped content; rejects strings? no — strings ARE ReactNode
 *  - end-to-end via PromptsHarness with `withReactPrompts`-equivalent wiring
 */

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { PromptsHarness } from "@agentick/prompts";

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
  it("loose section → single grounding MessageEntry", async () => {
    const node = createElement("section" as never, { id: "intro" }, "Hello, world.");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    // ADR 94: a free-floating section is no longer re-roled to `system` by
    // this renderer — the compiler gives it `grounding` at its own position.
    expect(messages[0]!.role).toBe("grounding");
    expect(
      messages[0]!.content.some((b) => b.type === "text" && b.text.includes("Hello, world.")),
    ).toBe(true);
  });

  it("section with title → '# title' leads the section's coalesced text block", async () => {
    const node = createElement("section" as never, { id: "x", title: "Greeting" }, "Hi.");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content;
    // ADR 94: title + text runs coalesce into ONE block — one block is one
    // projected message part.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", text: "# Greeting\nHi." });
  });

  it("hands back wire-shape blocks — no sidecar reaches a consumer", async () => {
    // What this renderer returns goes STRAIGHT to a wire: MCP `prompts/get`
    // maps these entries to protocol messages with no formatter in between.
    // So `compileTemplate` runs the formatter pass, and a semantic-HTML body
    // arrives as rendered text rather than as an empty block with its content
    // hiding in a `semanticNode` tree.
    const node = createElement(
      "section" as never,
      { id: "x", title: "Rules" },
      createElement("strong" as never, null, "Be terse."),
    );
    const [message] = await reactPromptRenderer.render(node, {});
    expect(message!.content).toEqual([
      { type: "text", text: "# Rules\n**Be terse.**", id: "x", metadata: { section: "x" } },
    ]);
  });

  it("explicit <message> → passthrough preserves role", async () => {
    const node = createElement("message" as never, { role: "user" }, "ping");
    const messages = await reactPromptRenderer.render(node, {});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("section then message → grounding entry first, message follows", async () => {
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
    expect(messages[0]!.role).toBe("grounding");
    expect(messages[1]!.role).toBe("user");
    // Suppress unused
    void node;
  });

  it("multiple sections → one grounding message each, in authoring order", async () => {
    const fragment = [
      createElement("section" as never, { id: "a", key: "a" }, "alpha"),
      createElement("section" as never, { id: "b", key: "b" }, "beta"),
    ];
    const messages = await reactPromptRenderer.render(fragment, {});
    // ADR 94: adjacent sections are no longer merged into one leading system
    // message — position is canonical, so each keeps its own entry + id.
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(["grounding", "grounding"]);
    expect(messages.map((m) => m.id)).toEqual(["a", "b"]);
    const text = messages
      .flatMap((m) => m.content)
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
    const result = await h.render({ name: "weekly_status", args: { week: "2026-06-28" } });
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
    const result = await h.render({ name: "qa", args: { q: "What is 2+2?" } });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe("grounding");
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
