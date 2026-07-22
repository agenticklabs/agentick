/**
 * Bounded tool-output client projection — the pure block bounder (ROADMAP A3).
 *
 * Verifies the seam's default policy, the honest marker, recursion into
 * nested tool results, per-block-type handling, and the override/disable
 * surfaces. The wire-shape frame projection is tested in
 * `@agentick/transport-next` (`client-projection.spec.ts`).
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolResultBlock } from "../data/content-blocks.js";
import {
  BOUNDED_METADATA_KEY,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  defaultToolOutputBounder,
  passthroughToolOutputBounder,
  resolveToolOutputBounder,
  resolveTruncateToolResults,
  type BoundedContentMarker,
} from "../data/tool-output-bound.js";

const big = (bytes: number, ch = "x"): string => ch.repeat(bytes);

function marker(block: ContentBlock): BoundedContentMarker | undefined {
  return block.metadata?.[BOUNDED_METADATA_KEY] as BoundedContentMarker | undefined;
}

describe("resolveToolOutputBounder — default text bounding", () => {
  it("passes a small text block through by reference (no-op)", () => {
    const block: ContentBlock = { type: "text", text: "small" };
    expect(defaultToolOutputBounder.boundOutputBlock(block)).toBe(block);
  });

  it("truncates an oversized text block and stamps an honest marker", () => {
    const original = big(DEFAULT_MAX_TOOL_RESULT_BYTES + 5000);
    const block: ContentBlock = { type: "text", text: original };
    const bounded = defaultToolOutputBounder.boundOutputBlock(block) as {
      type: "text";
      text: string;
    };

    expect(bounded).not.toBe(block);
    // Preview is bounded to the ceiling (plus a short human suffix), never the
    // multi-KB original.
    expect(bounded.text.length).toBeLessThan(original.length);
    expect(bounded.text).toContain("truncated");
    expect(bounded.text).toContain("durable timeline store");

    const m = marker(bounded)!;
    expect(m.truncated).toBe(true);
    expect(m.reason).toBe("text-over-limit");
    expect(m.originalBytes).toBe(original.length);
    expect(m.retainedBytes).toBeLessThanOrEqual(DEFAULT_MAX_TOOL_RESULT_BYTES);
    expect(m.retainedBytes).toBeGreaterThan(0);
    // Honest: the store keeps the full byte count.
    expect(m.originalBytes).toBeGreaterThan(m.retainedBytes);
  });

  it("does NOT mutate its input (the store's copy stays full)", () => {
    const original = big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1);
    const block: ContentBlock = { type: "text", text: original };
    defaultToolOutputBounder.boundOutputBlock(block);
    expect(block.text).toBe(original); // untouched
    expect(block.metadata).toBeUndefined();
  });

  it("bounds code / xml / csv / html / executable_code / code_execution_result", () => {
    const over = big(DEFAULT_MAX_TOOL_RESULT_BYTES + 100);
    const cases: ContentBlock[] = [
      { type: "code", text: over, language: "shell" },
      { type: "xml", text: over },
      { type: "csv", text: over },
      { type: "html", text: over },
      { type: "executable_code", code: over },
      { type: "code_execution_result", output: over },
    ];
    for (const block of cases) {
      const bounded = defaultToolOutputBounder.boundOutputBlock(block);
      expect(bounded).not.toBe(block);
      expect(marker(bounded)?.truncated).toBe(true);
    }
  });
});

describe("resolveToolOutputBounder — json + inline binary", () => {
  it("drops oversized structured JSON data and keeps a textual preview", () => {
    const data = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, v: big(50) })) };
    const block: ContentBlock = { type: "json", data };
    const bounded = defaultToolOutputBounder.boundOutputBlock(block) as {
      type: "json";
      data?: unknown;
      text?: string;
    };
    expect(bounded).not.toBe(block);
    expect(bounded.data).toBeUndefined(); // structured payload dropped
    expect(bounded.text).toContain("truncated");
    expect(marker(bounded)?.reason).toBe("text-over-limit");
  });

  it("strips an oversized inline base64 image entirely and marks it", () => {
    const block: ContentBlock = {
      type: "generated_image",
      data: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1, "A"),
      mimeType: "image/png",
    };
    const bounded = defaultToolOutputBounder.boundOutputBlock(block) as {
      type: "generated_image";
      data: string;
      mimeType: string;
    };
    expect(bounded.data).toBe(""); // partial base64 is useless — stripped
    expect(bounded.mimeType).toBe("image/png"); // shape kept
    const m = marker(bounded)!;
    expect(m.reason).toBe("inline-data-over-limit");
    expect(m.retainedBytes).toBe(0);
  });

  it("strips an oversized base64 media source but keeps a url source", () => {
    const inline: ContentBlock = {
      type: "image",
      source: {
        type: "base64",
        data: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1, "A"),
        mimeType: "image/png",
      },
    };
    const bounded = defaultToolOutputBounder.boundOutputBlock(inline);
    expect((bounded as { source: { data?: string } }).source.data).toBe("");
    expect(marker(bounded)?.reason).toBe("inline-data-over-limit");

    const url: ContentBlock = { type: "image", source: { type: "url", url: "https://x/y.png" } };
    expect(defaultToolOutputBounder.boundOutputBlock(url)).toBe(url); // reference — passthrough
  });

  it("passes non-inline blocks (tool_use w/o result, generated_file) through", () => {
    const toolUse: ContentBlock = { type: "tool_use", toolUseId: "t1", name: "x", input: {} };
    expect(defaultToolOutputBounder.boundOutputBlock(toolUse)).toBe(toolUse);
    const file: ContentBlock = { type: "generated_file", uri: "file://x", mimeType: "text/plain" };
    expect(defaultToolOutputBounder.boundOutputBlock(file)).toBe(file);
  });
});

describe("resolveToolOutputBounder — recursion", () => {
  it("recurses into a tool_result's content", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "t1",
      name: "read_file",
      content: [
        { type: "text", text: "ok" },
        { type: "text", text: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1) },
      ],
    };
    const bounded = defaultToolOutputBounder.boundOutputBlock(block) as ToolResultBlock;
    expect(bounded).not.toBe(block);
    expect(bounded.content[0]).toBe(block.content[0]); // small child untouched
    expect(marker(bounded.content[1]!)?.truncated).toBe(true); // big child bounded
  });

  it("recurses into a tool_use's attached toolResult", () => {
    const block: ContentBlock = {
      type: "tool_use",
      toolUseId: "t1",
      name: "x",
      input: {},
      toolResult: {
        type: "tool_result",
        toolUseId: "t1",
        name: "x",
        content: [{ type: "text", text: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1) }],
      },
    };
    const bounded = defaultToolOutputBounder.boundOutputBlock(block) as {
      toolResult: ToolResultBlock;
    };
    expect(marker(bounded.toolResult.content[0]!)?.truncated).toBe(true);
  });
});

describe("resolveToolOutputBounder — boundMessageContent", () => {
  it("bounds tool_result blocks but leaves plain prose untouched", () => {
    const prose: ContentBlock = { type: "text", text: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1) };
    const toolResult: ContentBlock = {
      type: "tool_result",
      toolUseId: "t1",
      name: "x",
      content: [{ type: "text", text: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1) }],
    };
    const out = defaultToolOutputBounder.boundMessageContent([prose, toolResult]);
    // A huge USER/ASSISTANT text block is NOT tool output — never truncated here.
    expect(out[0]).toBe(prose);
    // The tool_result IS tool output — its content is bounded.
    expect(out[1]).not.toBe(toolResult);
    expect(marker((out[1] as ToolResultBlock).content[0]!)?.truncated).toBe(true);
  });
});

describe("resolveToolOutputBounder — override + disable (seam over setting)", () => {
  it("raises the cap so a previously-bounded block now passes", () => {
    const text = big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1);
    const block: ContentBlock = { type: "text", text };
    const raised = resolveToolOutputBounder({ maxToolResultBytes: text.length + 10 });
    expect(raised.boundOutputBlock(block)).toBe(block); // now under the cap
  });

  it("lowers the cap so a previously-passing block now bounds", () => {
    const block: ContentBlock = { type: "text", text: "hello world" };
    const lowered = resolveToolOutputBounder({ maxToolResultBytes: 4 });
    const bounded = lowered.boundOutputBlock(block);
    expect(bounded).not.toBe(block);
    expect(marker(bounded)?.truncated).toBe(true);
  });

  it("honors a custom boundToolOutput and can delegate to the default", () => {
    const seen: string[] = [];
    const custom = resolveToolOutputBounder({
      boundToolOutput: (block, ctx) => {
        seen.push(block.type);
        if (block.type === "text") return { type: "text", text: "[redacted]" };
        return ctx.bound(block); // delegate to the framework default
      },
    });
    const out = custom.boundOutputBlock({ type: "text", text: "secret" }) as { text: string };
    expect(out.text).toBe("[redacted]");
    expect(seen).toContain("text");
  });

  it("passthrough (disable) returns every block by reference", () => {
    const block: ContentBlock = { type: "text", text: big(1_000_000) };
    expect(passthroughToolOutputBounder.boundOutputBlock(block)).toBe(block);
    const arr = [block];
    expect(passthroughToolOutputBounder.boundOutputBlocks(arr)).toBe(arr);
  });

  it("Infinity ceiling disables bounding", () => {
    const block: ContentBlock = { type: "text", text: big(1_000_000) };
    const off = resolveToolOutputBounder({ maxToolResultBytes: Infinity });
    expect(off.boundOutputBlock(block)).toBe(block);
  });
});

describe("resolveTruncateToolResults — the opt-in switch (off by default)", () => {
  const over = (): ContentBlock => ({
    type: "text",
    text: big(DEFAULT_MAX_TOOL_RESULT_BYTES + 1),
  });

  it("omitted → OFF (undefined bounder — no projection, zero overhead)", () => {
    expect(resolveTruncateToolResults()).toBeUndefined();
  });

  it("false → OFF (undefined bounder)", () => {
    expect(resolveTruncateToolResults(false)).toBeUndefined();
  });

  it("true → ON at the 32 KiB default", () => {
    const bounder = resolveTruncateToolResults(true)!;
    expect(bounder).toBe(defaultToolOutputBounder);
    expect(bounder.maxBytes).toBe(DEFAULT_MAX_TOOL_RESULT_BYTES);
    expect(marker(bounder.boundOutputBlock(over()))?.truncated).toBe(true);
  });

  it("{ maxBytes } → ON, tuned ceiling", () => {
    const bounder = resolveTruncateToolResults({ maxBytes: 4 })!;
    expect(bounder.maxBytes).toBe(4);
    expect(marker(bounder.boundOutputBlock({ type: "text", text: "hello world" }))?.truncated).toBe(
      true,
    );
  });

  it("{ truncate } → ON, per-block bounder replaced (ctx.bound still delegates)", () => {
    const bounder = resolveTruncateToolResults({
      truncate: (block, ctx) =>
        block.type === "text" ? { type: "text", text: "[redacted]" } : ctx.bound(block),
    })!;
    const out = bounder.boundOutputBlock({ type: "text", text: "secret" }) as { text: string };
    expect(out.text).toBe("[redacted]");
  });
});
