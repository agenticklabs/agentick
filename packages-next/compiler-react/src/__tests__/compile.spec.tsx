/**
 * End-to-end smoke for compiler-react-next: JSX → RenderedTree →
 * markdown string. Exercises Phase 1a's compiler-next helpers
 * (useData, intrinsic helpers, format) through a real React-element
 * walker.
 */

import { useData } from "@agentick/compiler-next";
import React from "react";
import { describe, expect, it } from "vitest";

import { compileToTree, render } from "../index.js";

describe("compileToTree — JSX → IR", () => {
  it("renders a single section with inline text", async () => {
    const Template = () => <section id="intro">Hello, world.</section>;
    const tree = await compileToTree(<Template />);
    expect(tree.context.entries).toHaveLength(1);
    expect(tree.context.entries[0]).toMatchObject({
      kind: "section",
      id: "intro",
    });
  });

  it("walks nested function components transparently", async () => {
    const Hi = ({ name }: { name: string }) => <>Hi, {name}.</>;
    const Template = () => (
      <section id="greet">
        <Hi name="World" />
      </section>
    );
    const out = await render(<Template />);
    expect(out).toContain("Hi, World.");
  });

  it("emits a heading via the semantic-IR path (formatter chooses syntax)", async () => {
    const Template = () => (
      <section id="x">
        <h2>Title</h2>
      </section>
    );
    const out = await render(<Template />);
    // Markdown default: `## Title` (formatter handles syntax, NOT the compiler).
    expect(out).toContain("## Title");
  });

  it("emits a code block with language", async () => {
    // `<code>` overlaps with HTML's `<code>`, so `language` isn't
    // typed in JSX — use createElement until uppercase wrappers ship.
    const Template = () => (
      <section id="x">
        {React.createElement("code", { language: "typescript" }, "const x: number = 1;")}
      </section>
    );
    const out = await render(<Template />);
    expect(out).toContain("```typescript");
    expect(out).toContain("const x: number = 1;");
  });

  it("emits a JSON block", async () => {
    const Template = () => (
      <section id="x">
        <json data={{ ok: true, n: 42 }} />
      </section>
    );
    const out = await render(<Template />);
    expect(out).toContain("```json");
    expect(out).toContain('"ok":true');
  });

  it("supports message-role host elements", async () => {
    // Until a shared JSX-intrinsics augmentation lands, use
    // React.createElement directly for the Agentick-specific tags
    // (`system`, `user`, `assistant`). Adopters writing TSX templates
    // will eventually get this via a shared declaration file.
    const Template = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement("system" as never, null, "You are a helpful agent."),
        React.createElement("user" as never, null, "What is 47 × 23?"),
        React.createElement("assistant" as never, null, "47 × 23 = 1081."),
      );
    const tree = await compileToTree(<Template />);
    expect(tree.context.entries).toHaveLength(3);
    expect(tree.context.entries.map((e) => (e as { role?: string }).role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("supports control flow inside templates (.map, conditionals)", async () => {
    const items = ["apple", "banana", "cherry"];
    const Template = ({ showHeader }: { showHeader: boolean }) => (
      <section id="items">
        {showHeader ? <h2>Fruits</h2> : null}
        {items.map((item) => (
          <p key={item}>- {item}</p>
        ))}
      </section>
    );
    const out = await render(<Template showHeader={true} />);
    expect(out).toContain("## Fruits");
    expect(out).toContain("apple");
    expect(out).toContain("banana");
    expect(out).toContain("cherry");
  });

  it("integrates useData — compile-until-stable awaits the fetcher", async () => {
    let fetcherCalls = 0;
    const fetchItems = async () => {
      fetcherCalls++;
      return ["one", "two", "three"];
    };
    const Items = () => {
      const items = useData("items", fetchItems);
      return (
        <section id="items">
          {items.map((i) => (
            <p key={i}>{i}</p>
          ))}
        </section>
      );
    };
    const out = await render(<Items />);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("three");
    expect(fetcherCalls).toBe(1);
  });

  it("propagates a useData rejection through to the caller", async () => {
    const Bad = () => {
      useData("bad", async () => {
        throw new Error("kaboom");
      });
      return <p>unreachable</p>;
    };
    await expect(render(<Bad />)).rejects.toThrow("kaboom");
  });

  it("throws on unknown host elements with a precise error", async () => {
    const Bad = () => React.createElement("unknown-tag" as never, null, "x");
    await expect(render(<Bad />)).rejects.toThrow(/unknown host element/);
  });

  it("supports an explicit formatter override (xml)", async () => {
    const { xmlFormatter } = await import("@agentick/formatters-next");
    const Template = () => (
      <section id="x">
        <h1>Hello</h1>
      </section>
    );
    const out = await render(<Template />, { formatter: xmlFormatter });
    expect(out).toContain("<h1>");
    expect(out).not.toContain("# Hello");
  });

  it("compileToTree returns IR untouched by formatters", async () => {
    const Template = () => (
      <section id="x">
        <h1>Title</h1>
      </section>
    );
    const tree = await compileToTree(<Template />);
    expect(tree.specVersion).toBe("2026-05-08");
    expect(tree.context.entries[0]).toMatchObject({ kind: "section", id: "x" });
    const sec = tree.context.entries[0] as { content: readonly unknown[] };
    expect(sec.content.length).toBeGreaterThan(0);
  });
});
