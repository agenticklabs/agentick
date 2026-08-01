/**
 * Token-kind normalization for the `anthropic()` adapter, and the
 * `rates` construction option.
 *
 * Pricing is where a violated containment rule turns into a wrong
 * number, so the rules in `docs/proposals/v2/usage-cost.md` §2 are
 * pinned here rather than left to inspection:
 *
 *   - `cachedInputTokens` ⊆ `inputTokens` (cache READS)
 *   - `cacheCreationTokens` ⊆ `inputTokens` (cache WRITES, 1.25× input)
 *   - `reasoningTokens` ⊆ `outputTokens`
 *   - an unreported kind stays `undefined` — absent ≠ zero
 *
 * Anthropic reports both cache counters DISJOINT from `input_tokens`, so
 * the adapter folds them in. The streaming path used to fold only reads
 * and never emit `cacheCreationTokens` at all (D5), which reported a
 * streamed call's cache writes as zero.
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, RateCard } from "@agentick/spec";

import { anthropic } from "../anthropic-adapter.js";
import {
  StubAnthropicClient,
  emptyTree,
  makeExecutor,
  mkContentBlockStartText,
  mkContentBlockStop,
  mkMessage,
  mkMessageDelta,
  mkMessageStartEvent,
  mkMessageStop,
  mkTarget,
  mkTextDelta,
} from "./stub-anthropic-client.js";

const CARD: RateCard = {
  id: "anthropic:claude-sonnet-5@2026-07-01",
  currency: "USD",
  perMTok: { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
};

describe("anthropic() — usage normalization (non-streaming)", () => {
  it("folds BOTH cache counters into inputTokens and reports each kind", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({
          text: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({
      inputTokens: 220, // 100 fresh + 80 read + 40 write
      outputTokens: 20,
      totalTokens: 240,
      cachedInputTokens: 80,
      cacheCreationTokens: 40,
    });
  });

  it("keeps unreported cache kinds undefined — absent is not zero", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({ text: "ok", usage: { input_tokens: 10, output_tokens: 5 } }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(t.result.usage).not.toHaveProperty("cachedInputTokens");
    expect(t.result.usage).not.toHaveProperty("cacheCreationTokens");
  });
});

describe("anthropic() — usage normalization (streaming)", () => {
  it("reports cache WRITES on the streaming path (D5)", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 100, cacheRead: 80, cacheCreation: 40 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "ok"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 20),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage?.cacheCreationTokens).toBe(40);
    expect(t.result.usage?.cachedInputTokens).toBe(80);
    expect(t.result.usage?.inputTokens).toBe(220);
  });

  it("produces UsageStats identical to non-streaming for the same wire numbers", async () => {
    const streaming = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 100, cacheRead: 80, cacheCreation: 40 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "ok"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 20),
          mkMessageStop(),
        ],
      },
    ]);
    const nonStreaming = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({
          text: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      },
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

  it("keeps unreported cache kinds undefined on the streaming path too", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 10 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "ok"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 5),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });
});

describe("anthropic() — rates at construction", () => {
  it("lands the declared card on the self-described target", () => {
    expect(anthropic("claude-sonnet-5", { rates: CARD }).target.rates).toEqual(CARD);
  });

  it("is absent when no card is declared — the framework ships no prices", () => {
    expect(anthropic("claude-sonnet-5").target.rates).toBeUndefined();
  });

  it("layers over an explicit target rather than being swallowed by it", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "anthropic",
      modelId: "custom-proxy",
    };
    const adapter = anthropic("claude-sonnet-5", { target: explicit, rates: CARD });
    expect(adapter.target.rates).toEqual(CARD);
    expect(adapter.target.modelId).toBe("custom-proxy");
  });

  it("leaves an explicit target's own card alone when no option is passed", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "anthropic",
      modelId: "custom-proxy",
      rates: CARD,
    };
    expect(anthropic("claude-sonnet-5", { target: explicit }).target.rates).toEqual(CARD);
  });
});
