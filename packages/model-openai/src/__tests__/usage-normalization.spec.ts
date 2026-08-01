/**
 * Token-kind normalization for the `openai()` adapter, and the `rates`
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
 * OpenAI needs NO folding: `prompt_tokens` already includes
 * `prompt_tokens_details.cached_tokens`, and `completion_tokens` already
 * includes `completion_tokens_details.reasoning_tokens`. That is a fact
 * about the wire format, not a property of this adapter's code, so it is
 * asserted rather than assumed — a future pass-through that starts
 * adding instead of passing through fails here.
 *
 * OpenAI has no cache-WRITE charge, so `cacheCreationTokens` is always
 * absent. Absent, not zero: zero would claim the model did no cache
 * writes, which is a different statement from "this provider has no such
 * concept".
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, RateCard } from "@agentick/spec";

import { openai } from "../openai-adapter.js";
import {
  StubOpenAIClient,
  emptyTree,
  makeExecutor,
  mkCompletion,
  mkContentChunk,
  mkFinishChunk,
  mkTarget,
} from "./stub-openai-client.js";

const CARD: RateCard = {
  id: "openai:gpt-4o-mini@2026-07-01",
  currency: "USD",
  perMTok: { input: 150_000, output: 600_000, cacheRead: 75_000 },
};

describe("openai() — usage normalization", () => {
  it("passes prompt/completion counters through — cached and reasoning are already subsets", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: "ok",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 80 },
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({
      inputTokens: 100, // NOT 180 — cached_tokens is already inside prompt_tokens
      outputTokens: 50, // NOT 80 — reasoning_tokens is already inside completion_tokens
      totalTokens: 150,
      cachedInputTokens: 80,
      reasoningTokens: 30,
    });
  });

  it("keeps unreported kinds undefined — absent is not zero", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: "ok",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(t.result.usage).not.toHaveProperty("cachedInputTokens");
    expect(t.result.usage).not.toHaveProperty("reasoningTokens");
  });

  it("never reports cacheCreationTokens — OpenAI has no cache-write charge", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: "ok",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 90 },
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).not.toHaveProperty("cacheCreationTokens");
  });

  it("streams to the same UsageStats as the non-streaming path", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 30 },
    };
    const streaming = new StubOpenAIClient([
      {
        kind: "streaming",
        chunks: [mkContentChunk({ delta: "ok" }), mkFinishChunk({ usage })],
      },
    ]);
    const nonStreaming = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok", usage }) },
    ]);
    const { exec: a } = await makeExecutor(streaming, { stream: true });
    const { exec: b } = await makeExecutor(nonStreaming);
    const ta = await a.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const tb = await b.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (ta.outcome !== "succeeded" || tb.outcome !== "succeeded") {
      throw new Error("expected success");
    }
    expect(ta.result.usage).toEqual(tb.result.usage);
  });
});

describe("openai() — rates at construction", () => {
  it("lands the declared card on the self-described target", () => {
    expect(openai("gpt-4o-mini", { rates: CARD }).target.rates).toEqual(CARD);
  });

  it("is absent when no card is declared — the framework ships no prices", () => {
    expect(openai("gpt-4o-mini").target.rates).toBeUndefined();
  });

  it("layers over an explicit target rather than being swallowed by it", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "openai",
      modelId: "custom-proxy",
    };
    const adapter = openai("gpt-4o-mini", { target: explicit, rates: CARD });
    expect(adapter.target.rates).toEqual(CARD);
    expect(adapter.target.modelId).toBe("custom-proxy");
  });

  it("leaves an explicit target's own card alone when no option is passed", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "openai",
      modelId: "custom-proxy",
      rates: CARD,
    };
    expect(openai("gpt-4o-mini", { target: explicit }).target.rates).toEqual(CARD);
  });
});
