/**
 * Token estimation over a projected request.
 *
 * Most of these name a thing the previous implementation counted as ZERO. It
 * concatenated `part.text` across messages and divided by four, so tool
 * schemas, images, audio, video and tool-call arguments — all billed, some of
 * them the largest single item in a request — contributed nothing at all. An
 * estimate that is 20% low is a tuning problem; one that is structurally blind
 * to whole content types cannot be corrected by a caller who does not know.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelInput, LanguageModelMessagePart } from "@agentick/spec";

import { DEFAULT_MEDIA_TOKENS, estimateTokenBreakdown, estimateTokens } from "../token-estimate.js";
import { effectiveModelInfo } from "../model-info.js";

const user = (...content: LanguageModelMessagePart[]): LanguageModelInput => ({
  messages: [{ role: "user", content }],
});

const text = (t: string): LanguageModelMessagePart => ({ type: "text", text: t });

const image = (): LanguageModelMessagePart => ({
  type: "image",
  source: { type: "url", url: "https://example.test/a.png" },
});

describe("text", () => {
  it("is char/4 over a bare string", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("is char/4 across every message", () => {
    const input: LanguageModelInput = {
      messages: [
        { role: "user", content: [text("aaaa")] },
        { role: "assistant", content: [text("bbbbbbbb")] },
      ],
    };
    expect(estimateTokens(input)).toBe(3);
  });

  it("counts reasoning, which is billed like any other text", () => {
    expect(estimateTokens(user({ type: "reasoning", text: "abcd" }))).toBe(1);
  });
});

describe("tools", () => {
  const withTools = (): LanguageModelInput => ({
    messages: [{ role: "user", content: [text("hi")] }],
    tools: [
      {
        name: "search",
        description: "Search the knowledge base",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  });

  it("are counted — a schema is input the provider bills for", () => {
    // The defect: `tools` lives beside `messages` on LanguageModelInput and the
    // old walk only visited `messages`. An agent advertising a dozen MCP tools
    // was undercounted by tens of thousands of tokens on EVERY call.
    const bare = estimateTokens({ messages: [{ role: "user", content: [text("hi")] }] });
    expect(estimateTokens(withTools())).toBeGreaterThan(bare);
  });

  it("are reported apart from messages, because compaction cannot fold them", () => {
    // A trigger that counts tool schemas against a ceiling it can only relieve
    // by folding the conversation folds forever without ever getting under it.
    const { messages, tools, total } = estimateTokenBreakdown(withTools());
    expect(tools).toBeGreaterThan(0);
    expect(messages).toBeLessThan(tools);
    expect(total).toBe(messages + tools);
  });

  it("count the output schema too when a tool declares one", () => {
    const one = estimateTokenBreakdown(withTools()).tools;
    const withOutput: LanguageModelInput = {
      messages: [],
      tools: [
        {
          ...withTools().tools![0]!,
          outputSchema: { type: "object", properties: { hits: { type: "number" } } },
        },
      ],
    };
    expect(estimateTokenBreakdown(withOutput).tools).toBeGreaterThan(one);
  });
});

describe("media", () => {
  it("costs something — every image used to score zero", () => {
    expect(estimateTokenBreakdown(user(image())).messages).toBe(DEFAULT_MEDIA_TOKENS.image);
  });

  it("is priced per modality, not per byte of its URL", () => {
    // The source is a pointer; its length says nothing about the cost. A
    // char-based walk over media would be worse than useless — it would look
    // like a real number.
    const short = user({ type: "video", source: { type: "url", url: "a://b" } });
    const long = user({
      type: "video",
      source: { type: "url", url: `a://${"b".repeat(4000)}` },
    });
    expect(estimateTokenBreakdown(short).messages).toBe(estimateTokenBreakdown(long).messages);
  });

  it("takes per-modality rates from the caller, which is how adapters correct it", () => {
    const estimate = estimateTokenBreakdown(user(image()), { media: { image: 258 } });
    expect(estimate.messages).toBe(258);
  });

  it("adds media to the text alongside it rather than replacing it", () => {
    const both = estimateTokenBreakdown(user(text("abcd"), image())).messages;
    expect(both).toBe(DEFAULT_MEDIA_TOKENS.image + 1);
  });
});

describe("tool calls", () => {
  it("count their arguments — a large tool input is a large prompt", () => {
    const call = user({
      type: "tool_use",
      id: "t1",
      name: "n",
      input: { query: "x".repeat(400) },
    });
    expect(estimateTokenBreakdown(call).messages).toBeGreaterThan(100);
  });

  it("descend into tool results, where the bulk of an agent's context lives", () => {
    const result = user({
      type: "tool_result",
      toolUseId: "t1",
      content: [text("y".repeat(400))],
    });
    expect(estimateTokenBreakdown(result).messages).toBe(100);
  });

  it("count media returned by a tool", () => {
    const screenshot = user({
      type: "tool_result",
      toolUseId: "t1",
      content: [image()],
    });
    expect(estimateTokenBreakdown(screenshot).messages).toBe(DEFAULT_MEDIA_TOKENS.image);
  });
});

describe("rates come from the target, not from a table here", () => {
  const priceOf = (mediaTokens: { image: number }): number =>
    estimateTokenBreakdown(user(image()), {
      info: effectiveModelInfo({
        provider: "acme",
        modelId: "acme-1",
        capabilities: { contextWindow: 1000 },
        mediaTokens,
      }),
    }).messages;

  it("lets a target state its own — including one from an adapter outside this repo", () => {
    // The reason a central provider table was wrong: it could only ever hold
    // rows for adapters shipped here. A third-party adapter states its rates on
    // the target it derives, exactly as it already states `pricing`.
    expect(priceOf({ image: 765 })).toBe(765);
    expect(priceOf({ image: 1_365 })).toBe(1_365);
  });

  it("resolves adopter registry > target > seed, the ladder pricing uses", () => {
    const info = effectiveModelInfo(
      {
        provider: "google",
        modelId: "gemini-3.6-flash",
        capabilities: { contextWindow: 1000 },
        mediaTokens: { image: 1_032 },
      },
      { "google/gemini-3.6-flash": { mediaTokens: { image: 7 } } },
    );
    expect(estimateTokenBreakdown(user(image()), { info }).messages).toBe(7);
  });

  it("falls back to the shared floor when the target states none", () => {
    // An undescribed target scores something rather than nothing — the whole
    // failure being corrected is media costing zero.
    const info = effectiveModelInfo({
      provider: "ai-sdk",
      modelId: "whatever",
      capabilities: { contextWindow: 1000 },
    });
    expect(estimateTokenBreakdown(user(image()), { info }).messages).toBe(
      DEFAULT_MEDIA_TOKENS.image,
    );
  });

  it("stay absent when no layer describes the model — rates do not fabricate one", () => {
    expect(effectiveModelInfo({ provider: "google", modelId: "gemini-99" })).toBeUndefined();
  });
});

describe("the adapter override", () => {
  it("wins outright — only the adapter knows its provider's real rates", () => {
    expect(estimateTokens("ignored", { tokenEstimator: () => 777 })).toBe(777);
  });

  it("may report the split, and a bare number is read as the whole request", () => {
    const split = estimateTokenBreakdown("x", {
      info: { tokenEstimator: () => ({ messages: 10, tools: 5, total: 15 }) },
    });
    expect(split).toEqual({ messages: 10, tools: 5, total: 15 });

    expect(estimateTokenBreakdown("x", { info: { tokenEstimator: () => 42 } })).toEqual({
      messages: 42,
      tools: 0,
      total: 42,
    });
  });
});
