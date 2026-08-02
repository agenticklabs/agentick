/**
 * `StreamAccumulator.toContentBlocks` — the canonical assistant-message assembly.
 *
 * This function decides what a turn LOOKS like once the stream is over, and it had
 * three defects that no test noticed: reasoning discarded, every text block fused
 * into one, and tool calls appended after text regardless of when they happened.
 * All three were invisible because nothing asserted the shape — the suite checked
 * that text survived, and text did.
 *
 * The defects were shared: all four adapters route thinking into the reasoning
 * channel, and all four assembled through here, so a Gemini turn and an Anthropic
 * turn lost their reasoning identically.
 */

import { describe, expect, it } from "vitest";

import { StreamAccumulator } from "../stream-accumulator.js";

/** Drive the accumulator the way an adapter does: open a block, fill it, close it. */
function text(accum: StreamAccumulator, blockIndex: number, delta: string): void {
  // `content-delta`, not `text-delta`: the text channel is named for CONTENT
  // (`content-start` / `content-delta` / `content-end`) while the reasoning channel
  // is named for reasoning. Easy to get wrong from memory, which is why the helper
  // exists once here instead of inline per test.
  accum.apply({ type: "content-start", blockIndex, contentType: "text" });
  accum.apply({ type: "content-delta", blockIndex, delta });
  accum.apply({ type: "content-end", blockIndex });
}

function reasoning(accum: StreamAccumulator, blockIndex: number, delta: string): void {
  accum.apply({ type: "reasoning-start", blockIndex });
  accum.apply({ type: "reasoning-delta", blockIndex, delta });
  accum.apply({ type: "reasoning-end", blockIndex });
}

function toolCall(accum: StreamAccumulator, blockIndex: number, callId: string): void {
  accum.apply({ type: "tool-call-start", blockIndex, callId, name: "a_tool" });
  accum.apply({ type: "tool-call", callId, name: "a_tool", input: { x: 1 } });
}

describe("toContentBlocks", () => {
  it("emits reasoning as its own block rather than discarding it", () => {
    // The headline defect. Reasoning reached the accumulator and died there, so no
    // reasoning block was ever stored or sent — and a client cannot choose to hide
    // what it never received. Delivery is not visibility.
    const accum = new StreamAccumulator();
    reasoning(accum, 0, "the user wants last quarter");
    text(accum, 1, "Here are the numbers.");

    expect(accum.toContentBlocks()).toEqual([
      { type: "reasoning", text: "the user wants last quarter" },
      { type: "text", text: "Here are the numbers." },
    ]);
  });

  it("never fuses reasoning into the text block beside it", () => {
    // The symptom in the transcript: an answer that opens with the model's own
    // thinking — "what was the result of that last query?The last query
    // successfully executed…" — one text block, two different kinds of content.
    const accum = new StreamAccumulator();
    reasoning(accum, 0, "what was the result of that last query?");
    text(accum, 1, "The last query returned 767 rows.");

    const blocks = accum.toContentBlocks();
    const textBlocks = blocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toEqual({ type: "text", text: "The last query returned 767 rows." });
  });

  it("keeps one block per text block instead of concatenating", () => {
    const accum = new StreamAccumulator();
    text(accum, 0, "Let me check that.");
    text(accum, 1, "Found it.");

    expect(accum.toContentBlocks()).toEqual([
      { type: "text", text: "Let me check that." },
      { type: "text", text: "Found it." },
    ]);
  });

  it("orders every channel by block index, so a tool call keeps its place", () => {
    // Tool calls used to be appended LAST. A model that calls a tool and then
    // explains the result produced the explanation first and the call after it —
    // the turn read backwards.
    const accum = new StreamAccumulator();
    text(accum, 0, "Checking the report.");
    toolCall(accum, 1, "call_1");
    text(accum, 2, "It returned nothing.");

    expect(accum.toContentBlocks().map((b) => b.type)).toEqual(["text", "tool_use", "text"]);
  });

  it("interleaves reasoning, text and tool calls in arrival order", () => {
    // The realistic Gemini shape: think, narrate, call, think again, answer.
    const accum = new StreamAccumulator();
    reasoning(accum, 0, "need the schema first");
    text(accum, 1, "Let me read the schema.");
    toolCall(accum, 2, "call_1");
    reasoning(accum, 3, "now I can query");
    text(accum, 4, "Here you go.");

    expect(accum.toContentBlocks().map((b) => b.type)).toEqual([
      "reasoning",
      "text",
      "tool_use",
      "reasoning",
      "text",
    ]);
  });

  it("drops empty blocks from either prose channel", () => {
    // An opened-then-unused block is noise, not content: a renderer would draw an
    // empty bubble for it.
    const accum = new StreamAccumulator();
    accum.apply({ type: "content-start", blockIndex: 0, contentType: "text" });
    accum.apply({ type: "content-end", blockIndex: 0 });
    accum.apply({ type: "reasoning-start", blockIndex: 1 });
    accum.apply({ type: "reasoning-end", blockIndex: 1 });
    text(accum, 2, "Real content.");

    expect(accum.toContentBlocks()).toEqual([{ type: "text", text: "Real content." }]);
  });

  it("leaves totalText / totalReasoning flattening the whole channel", () => {
    // Still the right tool for a caller that wants the string; the wrong default for
    // assembling content, which is what it had become.
    const accum = new StreamAccumulator();
    reasoning(accum, 0, "think ");
    text(accum, 1, "one ");
    text(accum, 2, "two");
    reasoning(accum, 3, "more");

    expect(accum.totalText()).toBe("one two");
    expect(accum.totalReasoning()).toBe("think more");
  });
});
