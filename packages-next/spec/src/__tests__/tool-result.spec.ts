/**
 * ADR 70 — `normalizeToolResult` + `toContentBlocks` currency normalizer.
 *
 * @see docs/proposals/v2/blueprint/70-tool-result-currency.md
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock } from "../data/content-blocks.js";
import { toContentBlocks } from "../data/content-blocks.js";
import { isToolResultEnvelope, normalizeToolResult } from "../data/tool-result.js";

describe("toContentBlocks", () => {
  it("wraps a string in exactly one text block", () => {
    expect(toContentBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("passes an array through by reference (identity — allocation-free)", () => {
    const blocks: readonly ContentBlock[] = [{ type: "text", text: "x" }];
    expect(toContentBlocks(blocks)).toBe(blocks);
  });
});

describe("normalizeToolResult", () => {
  it("string → { content: [text] }, no sidecar fields", () => {
    expect(normalizeToolResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("ContentBlock[] → { content } (parity — array identity, no extra fields)", () => {
    const blocks: readonly ContentBlock[] = [{ type: "text", text: "a" }];
    const out = normalizeToolResult(blocks);
    expect(out.content).toBe(blocks);
    expect(out.structuredContent).toBeUndefined();
    expect(out.isError).toBeUndefined();
    expect(out.metadata).toBeUndefined();
  });

  it("envelope → content (string sugar) + structuredContent + isError + metadata", () => {
    expect(
      normalizeToolResult({
        content: "prose",
        structuredContent: { n: 1 },
        isError: true,
        metadata: { k: "v" },
      }),
    ).toEqual({
      content: [{ type: "text", text: "prose" }],
      structuredContent: { n: 1 },
      isError: true,
      metadata: { k: "v" },
    });
  });

  it("envelope with array content is preserved; absent sidecars stay absent", () => {
    const blocks: readonly ContentBlock[] = [{ type: "text", text: "z" }];
    const out = normalizeToolResult({ content: blocks });
    expect(out.content).toBe(blocks);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toBeUndefined();
  });
});

describe("isToolResultEnvelope", () => {
  it("true for objects, false for string / array", () => {
    expect(isToolResultEnvelope({ content: "x" })).toBe(true);
    expect(isToolResultEnvelope("x")).toBe(false);
    expect(isToolResultEnvelope([{ type: "text", text: "x" }])).toBe(false);
  });
});
