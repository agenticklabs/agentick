/**
 * Tests for the shared XML-tag stream parser (G12 + refactored G7).
 *
 * The parser is the primitive used by BOTH `parseThinkTags` (think →
 * reasoning route) and the adopter-declared `customBlocks` config.
 * Behavior tested here is provider-agnostic; integration with the
 * OpenAI executor lives in `openai-executor.spec.ts`.
 */

import { describe, it, expect, vi } from "vitest";

import { StreamTagParser, type StreamTagEvent } from "../stream-tag-parser.js";

function process(parser: StreamTagParser, chunks: string[]): StreamTagEvent[] {
  const out: StreamTagEvent[] = [];
  for (const c of chunks) out.push(...parser.process(c));
  out.push(...parser.flush());
  return out;
}

describe("StreamTagParser — basic passthrough", () => {
  it("emits text for content with no tags", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    expect(process(p, ["hello world"])).toEqual([{ type: "text", content: "hello world" }]);
  });

  it("ignores unregistered tags (passes them through as text)", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["<unknown>hello</unknown>"]);
    expect(events).toEqual([{ type: "text", content: "<unknown>hello</unknown>" }]);
  });

  it("buffers across empty chunks", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    expect(p.process("")).toEqual([]);
  });
});

describe("StreamTagParser — single tag extraction", () => {
  it("extracts a complete tag with content in one chunk", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["before <citation>quoted</citation> after"]);
    expect(events).toEqual([
      { type: "text", content: "before " },
      { type: "block-start", tag: "citation", attrs: {} },
      { type: "block-delta", tag: "citation", delta: "quoted" },
      { type: "block-end", tag: "citation" },
      { type: "block", tag: "citation", content: "quoted", attrs: {} },
      { type: "text", content: " after" },
    ]);
  });

  it("extracts attributes from opening tag", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, [`<citation source="wiki" year="2025">x</citation>`]);
    expect(events).toEqual([
      {
        type: "block-start",
        tag: "citation",
        attrs: { source: "wiki", year: "2025" },
      },
      { type: "block-delta", tag: "citation", delta: "x" },
      { type: "block-end", tag: "citation" },
      {
        type: "block",
        tag: "citation",
        content: "x",
        attrs: { source: "wiki", year: "2025" },
      },
    ]);
  });

  it("handles single-quoted attribute values", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, [`<citation source='wiki'>x</citation>`]);
    const startEvent = events.find((e) => e.type === "block-start");
    expect(startEvent).toEqual({
      type: "block-start",
      tag: "citation",
      attrs: { source: "wiki" },
    });
  });

  it("handles boolean attributes", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, [`<citation primary>x</citation>`]);
    const startEvent = events.find((e) => e.type === "block-start");
    expect(startEvent).toEqual({
      type: "block-start",
      tag: "citation",
      attrs: { primary: "" },
    });
  });
});

describe("StreamTagParser — self-closing tags", () => {
  it("emits a block summary for self-closing tags with no attrs", () => {
    const p = new StreamTagParser({ tags: { done: {} } });
    const events = process(p, ["text <done/> more"]);
    expect(events).toEqual([
      { type: "text", content: "text " },
      {
        type: "block",
        tag: "done",
        content: "",
        attrs: {},
        selfClosing: true,
      },
      { type: "text", content: " more" },
    ]);
  });

  it("emits attrs on self-closing tags", () => {
    const p = new StreamTagParser({ tags: { done: {} } });
    const events = process(p, [`<done reason="ok"/>`]);
    expect(events).toEqual([
      {
        type: "block",
        tag: "done",
        content: "",
        attrs: { reason: "ok" },
        selfClosing: true,
      },
    ]);
  });

  it("calls onSelfClosing handler", () => {
    const handler = vi.fn();
    const p = new StreamTagParser({
      tags: { done: { onSelfClosing: handler } },
    });
    process(p, [`<done reason="ok"/>`]);
    expect(handler).toHaveBeenCalledWith({ reason: "ok" });
  });
});

describe("StreamTagParser — split across chunks", () => {
  it("opens tag spanning two chunks", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["before <cit", "ation>quoted</citation> after"]);
    expect(events).toEqual([
      { type: "text", content: "before " },
      { type: "block-start", tag: "citation", attrs: {} },
      { type: "block-delta", tag: "citation", delta: "quoted" },
      { type: "block-end", tag: "citation" },
      { type: "block", tag: "citation", content: "quoted", attrs: {} },
      { type: "text", content: " after" },
    ]);
  });

  it("close tag spanning two chunks", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["<citation>quoted</cita", "tion> tail"]);
    expect(events.find((e) => e.type === "block-end")).toEqual({
      type: "block-end",
      tag: "citation",
    });
    expect(events.find((e) => e.type === "text" && e.content === " tail")).toBeDefined();
  });

  it("content chunked across multiple deltas accumulates correctly", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["<citation>part1 ", "part2 ", "part3</citation>"]);
    const deltas = events.filter((e) => e.type === "block-delta");
    expect(deltas.map((d) => (d as { delta: string }).delta).join("")).toBe("part1 part2 part3");
    const summary = events.find((e) => e.type === "block");
    expect((summary as { content: string }).content).toBe("part1 part2 part3");
  });
});

describe("StreamTagParser — handler callbacks", () => {
  it("calls onStart with parsed attrs", () => {
    const onStart = vi.fn();
    const p = new StreamTagParser({ tags: { citation: { onStart } } });
    process(p, [`<citation source="wiki">x</citation>`]);
    expect(onStart).toHaveBeenCalledWith({ source: "wiki" });
  });

  it("calls onContent with accumulated content at close", () => {
    const onContent = vi.fn();
    const p = new StreamTagParser({ tags: { citation: { onContent } } });
    process(p, [`<citation source="wiki">the body</citation>`]);
    expect(onContent).toHaveBeenCalledWith("the body", { source: "wiki" });
  });
});

describe("StreamTagParser — non-matching close tags", () => {
  it("keeps non-matching close tag as content", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    const events = process(p, ["<citation>nested </other></citation>"]);
    const summary = events.find((e) => e.type === "block");
    expect((summary as { content: string }).content).toBe("nested </other>");
  });
});

describe("StreamTagParser — multiple registered tags", () => {
  it("intercepts each registered tag independently", () => {
    const p = new StreamTagParser({ tags: { citation: {}, done: {} } });
    const events = process(p, ["first <citation>x</citation> mid <done/> end"]);
    const blocks = events.filter((e) => e.type === "block");
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { tag: string }).tag).toBe("citation");
    expect((blocks[1] as { tag: string }).tag).toBe("done");
  });
});

describe("StreamTagParser — flush behavior", () => {
  it("flushes empty when nothing is buffered", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    expect(p.process("hello")).toEqual([{ type: "text", content: "hello" }]);
    expect(p.flush()).toEqual([]);
  });

  it("flushes incomplete tag as text", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    p.process("<cit");
    const flushed = p.flush();
    expect(flushed).toEqual([{ type: "text", content: "<cit" }]);
  });

  it("flushes unclosed tag content as a best-effort block", () => {
    const p = new StreamTagParser({ tags: { citation: {} } });
    p.process("<citation>open");
    const flushed = p.flush();
    expect(flushed.find((e) => e.type === "block")).toBeDefined();
  });
});

describe("StreamTagParser — think-tag use case", () => {
  it("extracts <think> block (the parseThinkTags preset case)", () => {
    const p = new StreamTagParser({ tags: { think: {} } });
    const events = process(p, ["Hi <think>thinking</think> world"]);
    const blockEvents = events.filter((e) => e.type !== "text");
    expect(blockEvents.map((e) => e.type)).toEqual([
      "block-start",
      "block-delta",
      "block-end",
      "block",
    ]);
  });

  it("handles <think> split across chunks", () => {
    const p = new StreamTagParser({ tags: { think: {} } });
    const events = process(p, ["Hi <thin", "k>secret</think> bye"]);
    const summary = events.find((e) => e.type === "block");
    expect((summary as { content: string }).content).toBe("secret");
  });
});
