/**
 * Usage → cost spine (#186): longest-prefix resolution, subset-semantics
 * cost math, honest undefined for unknown models, pure usage merge.
 */

import { describe, expect, it } from "vitest";

import { estimateCost, mergePricing, mergeUsageStats, resolvePricing } from "../pricing.js";

describe("resolvePricing", () => {
  it("longest prefix wins (gpt-4o-mini over gpt-4o)", () => {
    const p = resolvePricing({ provider: "openai", modelId: "gpt-4o-mini-2024-07-18" });
    expect(p?.inputPerMTok).toBe(0.15);
    const q = resolvePricing({ provider: "openai", modelId: "gpt-4o-2024-11-20" });
    expect(q?.inputPerMTok).toBe(2.5);
  });

  it("unknown model / provider → undefined, never fabricated", () => {
    expect(resolvePricing({ provider: "openai", modelId: "gpt-99" })).toBeUndefined();
    expect(resolvePricing({ provider: "nobody", modelId: "x" })).toBeUndefined();
    expect(
      estimateCost(
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        { provider: "nobody", modelId: "x" },
      ),
    ).toBeUndefined();
  });
});

describe("estimateCost — subset semantics", () => {
  it("splits fresh / cached-read / cache-write at their rates", () => {
    // 1M input of which 400k cached reads + 100k cache writes; 200k out.
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        totalTokens: 1_200_000,
        cachedInputTokens: 400_000,
        cacheCreationTokens: 100_000,
      },
      { provider: "anthropic", modelId: "claude-sonnet-5" },
    )!;
    expect(cost.inputUSD).toBeCloseTo(0.5 * 3); // 500k fresh @ $3
    expect(cost.cachedInputUSD).toBeCloseTo(0.4 * 0.3); // 400k @ $0.30
    expect(cost.cacheWriteUSD).toBeCloseTo(0.1 * 3.75); // 100k @ $3.75
    expect(cost.outputUSD).toBeCloseTo(0.2 * 15); // 200k @ $15
    expect(cost.totalUSD).toBeCloseTo(1.5 + 0.12 + 0.375 + 3);
  });

  it("defaults cached/write rates to the input rate when unpriced", () => {
    const table = { p: { m: { inputPerMTok: 10, outputPerMTok: 20 } } };
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        cachedInputTokens: 500_000,
      },
      { provider: "p", modelId: "m" },
      table,
    )!;
    expect(cost.totalUSD).toBeCloseTo(10); // no discount, no surcharge
  });
});

describe("mergePricing / mergeUsageStats", () => {
  it("adopter overrides layer over the seed per provider", () => {
    const merged = mergePricing(
      { openai: { "gpt-4o": { inputPerMTok: 1, outputPerMTok: 2 } } },
      { openai: { "gpt-4o": { inputPerMTok: 9, outputPerMTok: 9 } } },
    );
    expect(resolvePricing({ provider: "openai", modelId: "gpt-4o" }, merged)?.inputPerMTok).toBe(9);
  });

  it("mergeUsageStats sums and preserves optional-field absence", () => {
    const sum = mergeUsageStats(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 1 },
    );
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      totalTokens: 17,
      cachedInputTokens: 1,
    });
    const bare = mergeUsageStats(
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    );
    expect("cachedInputTokens" in bare).toBe(false);
  });
});
