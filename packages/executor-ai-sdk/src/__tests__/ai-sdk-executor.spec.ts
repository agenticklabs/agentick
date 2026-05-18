/**
 * Smoke tests for the AI SDK bridge.
 *
 * Uses `MockLanguageModelV2` from `ai/test` to canned-response the
 * model layer. The executor harness around it should produce the
 * canonical LanguageModelExecutionResult shape regardless of provider.
 */

import { describe, expect, it } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import type { RenderedTree, LanguageModelTarget } from "@agentick/spec";
import { isExecutorFactory } from "@agentick/spec";

import { AISDKExecutor } from "../ai-sdk-executor.js";
import { aisdk } from "../aisdk-factory.js";

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

function mkExecutor(model: MockLanguageModelV2): AISDKExecutor {
  return new AISDKExecutor(
    "test-aisdk",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { model },
  );
}

describe("AISDKExecutor — basic", () => {
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
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget() });
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
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget() });
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
    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget() });
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
    });
    expect(terminal.outcome).toBe("canceled");
  });
});

describe("aisdk() factory", () => {
  it("returns an ExecutorFactory the spec helper recognizes", () => {
    const f = aisdk({ model: mkMockModel("x") });
    expect(isExecutorFactory(f)).toBe(true);
  });

  it("standalone invocation constructs a self-describing executor", async () => {
    const f = aisdk({ model: mkMockModel("x") });
    const exec = f();
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target.provider).toBe("mock-aisdk");
  });

  it("accepts a target override", async () => {
    const f = aisdk({
      model: mkMockModel("x"),
      target: {
        kind: "language-model",
        provider: "custom",
        modelId: "v2",
        capabilities: { supportsTools: false, contextWindow: 1_000 },
      },
    });
    const exec = f();
    await exec.ready;
    expect(exec.target.capabilities?.contextWindow).toBe(1_000);
  });
});
