/**
 * Tests for the inline `<think>` tag splitter (G7 parity port).
 *
 * Covers the streaming state machine across:
 *   - tag-free chunks
 *   - complete tags inside a single chunk
 *   - tags split across chunk boundaries (partial-tag-suffix logic)
 *   - flush-at-end behavior for unterminated tags
 *   - the non-streaming `splitThinkTags` convenience.
 */

import { describe, it, expect } from "vitest";

import { ThinkTagSplitter, splitThinkTags } from "../think-tag-splitter.js";

describe("ThinkTagSplitter", () => {
  it("passes plain text through unchanged when no tags appear", () => {
    const s = new ThinkTagSplitter();
    const segs = [...s.feed("hello world"), ...s.flush()];
    expect(segs).toEqual([{ mode: "text", content: "hello world" }]);
  });

  it("extracts a single complete think block in one chunk", () => {
    const s = new ThinkTagSplitter();
    const segs = [
      ...s.feed("Hello <think>I should be careful</think> world"),
      ...s.flush(),
    ];
    expect(segs).toEqual([
      { mode: "text", content: "Hello " },
      { mode: "reasoning", content: "I should be careful" },
      { mode: "text", content: " world" },
    ]);
  });

  it("handles a think block split across two chunks", () => {
    const s = new ThinkTagSplitter();
    const first = s.feed("Hello <think>I am think");
    const second = s.feed("ing</think> world");
    const flush = s.flush();
    expect([...first, ...second, ...flush]).toEqual([
      { mode: "text", content: "Hello " },
      { mode: "reasoning", content: "I am think" },
      { mode: "reasoning", content: "ing" },
      { mode: "text", content: " world" },
    ]);
  });

  it("buffers a partial open tag at the end of a chunk", () => {
    const s = new ThinkTagSplitter();
    // First chunk ends with `<thin` — partial prefix of `<think>`.
    const first = s.feed("Hello <thin");
    // Second chunk completes the tag.
    const second = s.feed("k>reasoning</think> done");
    const flush = s.flush();
    expect([...first, ...second, ...flush]).toEqual([
      { mode: "text", content: "Hello " },
      { mode: "reasoning", content: "reasoning" },
      { mode: "text", content: " done" },
    ]);
  });

  it("buffers a partial close tag at the end of a chunk", () => {
    const s = new ThinkTagSplitter();
    const first = s.feed("<think>reasoning</thin");
    const second = s.feed("k> text after");
    const flush = s.flush();
    expect([...first, ...second, ...flush]).toEqual([
      { mode: "reasoning", content: "reasoning" },
      { mode: "text", content: " text after" },
    ]);
  });

  it("flushes unterminated reasoning content as reasoning at stream end", () => {
    const s = new ThinkTagSplitter();
    const fed = s.feed("text <think>incomplete reasoning");
    const flush = s.flush();
    expect([...fed, ...flush]).toEqual([
      { mode: "text", content: "text " },
      { mode: "reasoning", content: "incomplete reasoning" },
    ]);
  });

  it("handles back-to-back think blocks", () => {
    const s = new ThinkTagSplitter();
    const segs = [
      ...s.feed("<think>a</think><think>b</think>"),
      ...s.flush(),
    ];
    expect(segs).toEqual([
      { mode: "reasoning", content: "a" },
      { mode: "reasoning", content: "b" },
    ]);
  });

  it("ignores zero-length feed chunks", () => {
    const s = new ThinkTagSplitter();
    expect(s.feed("")).toEqual([]);
  });
});

describe("splitThinkTags (non-streaming convenience)", () => {
  it("partitions a complete document in one call", () => {
    const segs = splitThinkTags("Hi <think>secret</think> bye");
    expect(segs).toEqual([
      { mode: "text", content: "Hi " },
      { mode: "reasoning", content: "secret" },
      { mode: "text", content: " bye" },
    ]);
  });

  it("returns a single text segment for tag-free input", () => {
    expect(splitThinkTags("just text")).toEqual([
      { mode: "text", content: "just text" },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(splitThinkTags("")).toEqual([]);
  });
});
