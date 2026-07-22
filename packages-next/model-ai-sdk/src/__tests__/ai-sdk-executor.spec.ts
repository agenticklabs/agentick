/**
 * Smoke tests for the AI SDK bridge.
 *
 * Uses `MockLanguageModelV2` from `ai/test` to canned-response the
 * model layer. The `aisdk()` adapter driven through
 * `LanguageModelExecutor` should produce the canonical
 * LanguageModelExecutionResult shape regardless of provider.
 */

import { describe, expect, it } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { RenderedTree, LanguageModelTarget } from "@agentick/spec-next";
import { LanguageModelExecutor } from "@agentick/model-executor-next";
import { isLanguageModelAdapter } from "@agentick/model-next";

import { aisdk } from "../ai-sdk-adapter.js";

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        {
          kind: "message",
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "mock-aisdk", modelId: "mock-1" };
}

function mkMockModel(text: string): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      warnings: [],
    }),
  });
}

function mkExecutor(model: MockLanguageModelV2): LanguageModelExecutor {
  return new LanguageModelExecutor(
    "test-aisdk",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: aisdk(model) },
  );
}

describe("aisdk() adapter — basic", () => {
  it("derives target from the model's provider + modelId", async () => {
    const exec = mkExecutor(mkMockModel("hi"));
    await exec.ready;
    expect(exec.target).toMatchObject({
      kind: "language-model",
      provider: "mock-aisdk",
      modelId: "mock-1",
    });
  });

  it("run() returns succeeded terminal with normalized output", async () => {
    const exec = mkExecutor(mkMockModel("hello back"));
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({
      type: "text",
      text: "hello back",
    });
    expect(terminal.result.stopReason).toBe("end");
    expect(terminal.result.usage?.totalTokens).toBe(5);
  });

  it("maps finishReason='length' to stopReason='max_tokens'", async () => {
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doGenerate: async () => ({
        content: [{ type: "text", text: "..." }],
        finishReason: "length",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
    });
    const exec = mkExecutor(model);
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.stopReason).toBe("max_tokens");
  });

  it("extracts tool calls into toolCalls + tool_use ContentBlocks", async () => {
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "calculator",
            input: JSON.stringify({ a: 2, b: 3 }),
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        warnings: [],
      }),
    });
    const exec = mkExecutor(model);
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.stopReason).toBe("tool_use");
    expect(terminal.result.toolCalls).toHaveLength(1);
    expect(terminal.result.toolCalls![0]).toMatchObject({
      id: "call_1",
      name: "calculator",
      input: { a: 2, b: 3 },
    });
  });

  it("#213/#217 — surfaces a reasoning ContentBlock and reasoningTokens (v1 parity)", async () => {
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doGenerate: async () => ({
        content: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "the answer" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20, reasoningTokens: 7 },
        warnings: [],
      }),
    });
    const exec = mkExecutor(model);
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    // Reasoning rides before text (#213).
    expect(terminal.result.output[0]).toMatchObject({ type: "reasoning", text: "let me think" });
    expect(terminal.result.output[1]).toMatchObject({ type: "text", text: "the answer" });
    // reasoningTokens surfaced (#217).
    expect(terminal.result.usage?.reasoningTokens).toBe(7);
  });

  it("abort() flips the next run to outcome 'canceled'", async () => {
    const exec = mkExecutor(mkMockModel("never"));
    await exec.ready;
    await exec.abort({ executionId: "abort-target" });
    const terminal = await exec.run({
      compiled: mkTree(),
      target: mkTarget(),
      scope: { executionId: "abort-target" },
      tools: [],
    });
    expect(terminal.outcome).toBe("canceled");
  });
});

describe("aisdk() factory", () => {
  it("returns a LanguageModelAdapter the structural guard recognizes", () => {
    expect(isLanguageModelAdapter(aisdk(mkMockModel("x")))).toBe(true);
  });

  it("derives a self-describing target from the model handle", () => {
    const adapter = aisdk(mkMockModel("x"));
    expect(adapter.provider).toBe("ai-sdk");
    expect(adapter.target.provider).toBe("mock-aisdk");
  });

  it("accepts a target override", () => {
    const adapter = aisdk(mkMockModel("x"), {
      target: {
        kind: "language-model",
        provider: "custom",
        modelId: "v2",
        capabilities: { supportsTools: false, contextWindow: 1_000 },
      },
    });
    expect(adapter.target.capabilities?.contextWindow).toBe(1_000);
  });
});

// ============================================================================
// Pass D — provider-executed tools (request-half DELIBERATELY not mapped)
// ============================================================================

describe("aisdk() adapter — provider tools (Pass D request-half)", () => {
  it("does NOT forward input.providerTools onto the AI SDK input (no correct passthrough seam)", () => {
    // The AI SDK constructs provider-executed tools via provider-specific
    // factories (openai.tools.webSearchPreview(), …) that this opaque-handle
    // adapter cannot reconstruct from `{ provider, type, config }`. So the
    // request-half is a deliberate no-op (TODO(pass-d) in toAISDKInput) — a
    // wrong mapping the SDK would reject at runtime is worse than an honest
    // gap. This test pins the no-leak invariant: provider tools never appear
    // in the projected input.
    const adapter = aisdk(mkMockModel("x"));
    const input = adapter.prepareRequest({
      targetInput: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        providerTools: [
          { provider: "openai", type: "web_search_preview", name: "web_search_preview" },
          { provider: "ai-sdk", type: "web_search_preview", name: "web_search_preview" },
        ],
      },
      target: adapter.target,
    }) as { tools?: unknown };
    // Provider tools are not projected into the AI SDK `ToolSet`.
    expect(input.tools).toBeUndefined();
    // And nothing about them leaks into the projected input at all.
    expect(JSON.stringify(input)).not.toContain("web_search_preview");
  });
});

describe("aisdk() adapter — provenance-half (Pass D provider sources)", () => {
  it("maps GenerateTextResult.sources onto the assistant text block's Citation[]", async () => {
    // `source` content parts are SDK-typed `LanguageModelV2Content` — a
    // wrong-shaped source FAILS typecheck. `generateText` folds them into
    // `result.sources`, which the adapter maps to whole-block citations.
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Paris is the capital of France." },
          {
            type: "source",
            sourceType: "url",
            id: "src-1",
            url: "https://example.com/france",
            title: "France — Overview",
          },
        ],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        warnings: [],
      }),
    });
    const exec = mkExecutor(model);
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    const textBlock = terminal.result.output.find((b) => b.type === "text");
    // Normalized model: the citation references a Source by id (no `range` —
    // the AI SDK gives no char span); the Source rides the block's `sources`.
    expect(textBlock?.sources).toEqual([
      { id: "s0", url: "https://example.com/france", title: "France — Overview" },
    ]);
    expect(textBlock?.citations).toEqual([{ sourceId: "s0" }]);
    // Resolution holds: the cited sourceId is present in block.sources.
    const ids = new Set(textBlock?.sources?.map((s) => s.id));
    for (const c of textBlock?.citations ?? []) expect(ids.has(c.sourceId)).toBe(true);
  });

  it("interns one Source when the same url is surfaced twice (shared turn-stable id)", async () => {
    // Two url sources with the same url → the per-turn interner mints ONE
    // Source with ONE id; both citations reference it and block.sources holds
    // it once.
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Paris is the capital of France." },
          {
            type: "source",
            sourceType: "url",
            id: "src-1",
            url: "https://example.com/france",
            title: "France — Overview",
          },
          {
            type: "source",
            sourceType: "url",
            id: "src-2",
            url: "https://example.com/france",
            title: "France — Overview",
          },
        ],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        warnings: [],
      }),
    });
    const exec = mkExecutor(model);
    await exec.ready;
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    const textBlock = terminal.result.output.find((b) => b.type === "text");
    // One deduped Source; both citations reference it.
    expect(textBlock?.sources).toEqual([
      { id: "s0", url: "https://example.com/france", title: "France — Overview" },
    ]);
    expect(textBlock?.citations).toEqual([{ sourceId: "s0" }, { sourceId: "s0" }]);
  });
});
