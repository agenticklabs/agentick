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
import { LanguageModelExecutor } from "@agentick/executor-next";
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
