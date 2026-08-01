/**
 * Token-kind normalization for the `aisdk()` adapter, and the `rates`
 * construction option.
 *
 * Pricing is where a violated containment rule turns into a wrong
 * number, so the rules in `docs/proposals/v2/usage-cost.md` §2 are
 * pinned here rather than left to inspection:
 *
 *   - `cachedInputTokens` ⊆ `inputTokens`
 *   - `reasoningTokens` ⊆ `outputTokens`
 *   - an unreported kind stays `undefined` — absent ≠ zero
 *
 * The AI SDK already normalizes to these same names with these same
 * semantics, so this adapter maps 1:1 and folds nothing. What is worth
 * pinning is that it maps EVERY kind on BOTH paths — the streaming
 * reconstruction used to drop the cache counters on the floor, the same
 * class of defect as Anthropic's D5.
 */

import { describe, expect, it } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget, LanguageModelTarget, RateCard, RenderedTree } from "@agentick/spec";
import { LanguageModelExecutor } from "@agentick/model-executor";

import { aisdk } from "../ai-sdk-adapter.js";

/**
 * The AI SDK's own usage bag. `cacheCreationTokens` is NOT in
 * `LanguageModelV2Usage` at this SDK version — the adapter duck-types it
 * so a provider that does report it survives the trip, which is what the
 * cast here exercises.
 */
type SdkUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
};

const CARD: RateCard = {
  id: "ai-sdk:mock-1@2026-07-01",
  currency: "USD",
  perMTok: { input: 1_000_000, output: 5_000_000 },
};

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "mock-aisdk", modelId: "mock-1" };
}

function mkModel(usage: SdkUsage): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: "stop",
      usage: usage as never,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage });
          controller.close();
        },
      }) as never,
    }),
  });
}

async function mkExecutor(usage: SdkUsage): Promise<LanguageModelExecutor> {
  const exec = new LanguageModelExecutor(
    "exec-aisdk-usage",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: aisdk(mkModel(usage)) },
  );
  await exec.ready;
  return exec;
}

/** Drive the streaming path end to end: project → executeStream → normalize. */
async function streamedUsage(exec: LanguageModelExecutor) {
  const target = mkTarget();
  const projected = await exec.project({ compiled: mkTree(), target, tools: [] });
  const stream = exec.executeStream({ targetInput: projected, target });
  for await (const _ of stream) {
    /* drain */
  }
  const raw = await stream.result;
  const result = await exec.normalize({ targetOutput: raw, target });
  return result.usage;
}

describe("aisdk() — usage normalization", () => {
  it("maps every reported kind 1:1, adding nothing", async () => {
    const exec = await mkExecutor({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 30,
      cachedInputTokens: 80,
    });
    const t = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({
      inputTokens: 100, // NOT 180 — the SDK's cachedInputTokens is already a subset
      outputTokens: 50, // NOT 80 — the SDK's reasoningTokens is already a subset
      totalTokens: 150,
      reasoningTokens: 30,
      cachedInputTokens: 80,
    });
  });

  it("keeps unreported kinds undefined — absent is not zero", async () => {
    const exec = await mkExecutor({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const t = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(t.result.usage).not.toHaveProperty("reasoningTokens");
    expect(t.result.usage).not.toHaveProperty("cachedInputTokens");
    expect(t.result.usage).not.toHaveProperty("cacheCreationTokens");
  });

  it("carries cache reads and writes through the streaming reconstruction", async () => {
    const usage: SdkUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 30,
      cachedInputTokens: 80,
      cacheCreationTokens: 15,
    };
    expect(await streamedUsage(await mkExecutor(usage))).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 30,
      cachedInputTokens: 80,
      cacheCreationTokens: 15,
    });
  });

  it("streams to the same UsageStats as the non-streaming path", async () => {
    const usage: SdkUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 30,
      cachedInputTokens: 80,
    };
    const t = await (
      await mkExecutor(usage)
    ).run({
      compiled: mkTree(),
      target: mkTarget(),
      tools: [],
    });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(await streamedUsage(await mkExecutor(usage))).toEqual(t.result.usage);
  });
});

describe("aisdk() — rates at construction", () => {
  it("lands the declared card on the derived target", () => {
    const usage: SdkUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    expect(aisdk(mkModel(usage), { rates: CARD }).target.rates).toEqual(CARD);
  });

  it("is absent when no card is declared — the framework ships no prices", () => {
    const usage: SdkUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    expect(aisdk(mkModel(usage)).target.rates).toBeUndefined();
  });

  it("layers over an explicit target rather than being swallowed by it", () => {
    const usage: SdkUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "custom",
      modelId: "custom-proxy",
    };
    const adapter = aisdk(mkModel(usage), { target: explicit, rates: CARD });
    expect(adapter.target.rates).toEqual(CARD);
    expect(adapter.target.modelId).toBe("custom-proxy");
  });

  it("leaves an explicit target's own card alone when no option is passed", () => {
    const usage: SdkUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "custom",
      modelId: "custom-proxy",
      rates: CARD,
    };
    expect(aisdk(mkModel(usage), { target: explicit }).target.rates).toEqual(CARD);
  });
});
