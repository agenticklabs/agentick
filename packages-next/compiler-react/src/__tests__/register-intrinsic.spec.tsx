/**
 * `registerIntrinsic(tag, handler)` — adopter-defined intrinsic
 * dispatch. Verifies:
 *  - Register, walker uses it, unregister removes it
 *  - Custom registration OVERRIDES a built-in (registry wins)
 *  - Multiple unrelated registrations coexist
 *  - Unknown tag still throws after unregister (no leak)
 *  - Handler can recurse children via the `walk` callback
 *
 * Each test cleans up via `clearRegisteredIntrinsics()` in afterEach
 * — the registry is module-level singleton.
 */

import { textBlock } from "@agentick/compiler-next";
import { clearRegisteredIntrinsics } from "@agentick/compiler-react-next/testing";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { compileToTree, getRegisteredIntrinsic, registerIntrinsic, render } from "../index.js";

afterEach(() => {
  clearRegisteredIntrinsics();
});

describe("registerIntrinsic", () => {
  it("registers a custom intrinsic that the walker dispatches to", async () => {
    registerIntrinsic("recipe-card", (props) => ({
      entries: [],
      blocks: [textBlock(`Recipe: ${String(props.title ?? "untitled")}`)],
    }));

    const Tpl = () =>
      React.createElement(
        "section" as never,
        { id: "x" },
        React.createElement("recipe-card" as never, { title: "Pancakes" }),
      );
    const out = await render(<Tpl />);
    expect(out).toContain("Recipe: Pancakes");
  });

  it("unregister removes the handler — subsequent walks throw on the tag", async () => {
    const unregister = registerIntrinsic("recipe-card", () => ({
      entries: [],
      blocks: [textBlock("registered")],
    }));
    unregister();

    const Tpl = () =>
      React.createElement(
        "section" as never,
        { id: "x" },
        React.createElement("recipe-card" as never, null, "x"),
      );
    await expect(render(<Tpl />)).rejects.toThrow(/unknown host element <recipe-card>/);
  });

  it("custom registration OVERRIDES a built-in (registry wins)", async () => {
    // Override <section> with a custom handler that emits a different
    // entry. The walker should use the custom handler instead of the
    // built-in section dispatch.
    registerIntrinsic("section", (_props) => ({
      entries: [],
      blocks: [textBlock("[custom section override]")],
    }));

    const Tpl = () =>
      React.createElement("section" as never, { id: "x" }, "this should NOT appear");
    const tree = await compileToTree(<Tpl />);
    // No section entry — the built-in path is bypassed.
    expect(tree.context.entries).toHaveLength(0);
    // Custom text is in tree.content (root-level blocks).
    const out = await render(<Tpl />);
    expect(out).toContain("[custom section override]");
    expect(out).not.toContain("this should NOT appear");
  });

  it("handler can recurse children via the `walk` callback", async () => {
    // Wrap children with a marker prefix/suffix; recurse to render
    // them as normal.
    registerIntrinsic("brackets", (_props, children, walk) => {
      const inner = walk(children);
      return {
        entries: inner.entries,
        blocks: [textBlock("["), ...inner.blocks, textBlock("]")],
      };
    });

    const Tpl = () =>
      React.createElement(
        "section" as never,
        { id: "x" },
        React.createElement("brackets" as never, null, "wrapped"),
      );
    const out = await render(<Tpl />);
    expect(out).toContain("[wrapped]");
  });

  it("multiple unrelated registrations coexist", async () => {
    registerIntrinsic("foo", () => ({ entries: [], blocks: [textBlock("FOO")] }));
    registerIntrinsic("bar", () => ({ entries: [], blocks: [textBlock("BAR")] }));

    const Tpl = () =>
      React.createElement(
        "section" as never,
        { id: "x" },
        React.createElement("foo" as never),
        React.createElement("bar" as never),
      );
    const out = await render(<Tpl />);
    expect(out).toContain("FOO");
    expect(out).toContain("BAR");
  });

  it("re-registering the same tag replaces the previous handler", async () => {
    registerIntrinsic("ping", () => ({ entries: [], blocks: [textBlock("first")] }));
    registerIntrinsic("ping", () => ({ entries: [], blocks: [textBlock("second")] }));

    const Tpl = () =>
      React.createElement("section" as never, { id: "x" }, React.createElement("ping" as never));
    const out = await render(<Tpl />);
    expect(out).toContain("second");
    expect(out).not.toContain("first");
  });

  it("unregister only undoes its OWN write — later writes are not touched", async () => {
    const undoFirst = registerIntrinsic("ping", () => ({
      entries: [],
      blocks: [textBlock("first")],
    }));
    registerIntrinsic("ping", () => ({ entries: [], blocks: [textBlock("second")] }));
    // Try to undo the first registration; the second should remain.
    undoFirst();

    const Tpl = () =>
      React.createElement("section" as never, { id: "x" }, React.createElement("ping" as never));
    const out = await render(<Tpl />);
    expect(out).toContain("second");
  });

  it("unregister of an override restores the built-in", async () => {
    const undo = registerIntrinsic("section", () => ({
      entries: [],
      blocks: [textBlock("override"), textBlock("X")],
    }));
    undo();

    const Tpl = () => React.createElement("section" as never, { id: "x" }, "restored");
    const tree = await compileToTree(<Tpl />);
    // Built-in section handler is back → produces a section entry.
    expect(tree.context.entries).toHaveLength(1);
    expect((tree.context.entries[0] as { id: string }).id).toBe("x");
  });

  it("getRegisteredIntrinsic returns the handler for registered tags", () => {
    expect(getRegisteredIntrinsic("never-registered")).toBeUndefined();
    const handler = () => ({ entries: [], blocks: [] });
    registerIntrinsic("query-result", handler);
    expect(getRegisteredIntrinsic("query-result")).toBe(handler);
  });

  it("registrations persist across multiple render() invocations", async () => {
    let calls = 0;
    registerIntrinsic("counter", () => {
      calls++;
      return { entries: [], blocks: [textBlock(`call#${calls}`)] };
    });

    const Tpl = () =>
      React.createElement("section" as never, { id: "x" }, React.createElement("counter" as never));
    const out1 = await render(<Tpl />);
    const out2 = await render(<Tpl />);
    const out3 = await render(<Tpl />);
    expect(out1).toContain("call#1");
    expect(out2).toContain("call#2");
    expect(out3).toContain("call#3");
    expect(calls).toBe(3);
  });
});

describe("registerIntrinsic — input validation", () => {
  it("throws on empty-string tag", () => {
    expect(() => registerIntrinsic("", () => ({ entries: [], blocks: [] }))).toThrow(
      /non-empty string/,
    );
  });

  it("throws on whitespace-only tag", () => {
    expect(() => registerIntrinsic("   ", () => ({ entries: [], blocks: [] }))).toThrow(
      /non-empty string/,
    );
  });

  it("throws when handler is not a function", () => {
    // @ts-expect-error - intentional misuse
    expect(() => registerIntrinsic("x", "not a function")).toThrow(/must be a function/);
  });
});
