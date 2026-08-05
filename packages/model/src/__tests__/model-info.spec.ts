/**
 * ModelInfo registry (#204): longest-prefix resolution, adopter/self/seed
 * precedence in `effectiveModelInfo`, ratio-form utilization, char/4
 * estimation, and SEED_PRICING⇄SEED_MODELS single-source parity.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelInput } from "@agentick/spec";

import {
  contextUtilization,
  effectiveModelInfo,
  estimateTokens,
  mergeRegistry,
  resolveModelInfo,
  SEED_MODELS,
  type ModelRegistry,
} from "../model-info.js";
import { resolvePricing, SEED_PRICING } from "../pricing.js";

describe("resolveModelInfo", () => {
  it("longest prefix wins (gpt-4o-mini over gpt-4o)", () => {
    const mini = resolveModelInfo({ provider: "openai", modelId: "gpt-4o-mini-2024-07-18" });
    expect(mini?.pricing?.inputPerMTok).toBe(0.15);
    expect(mini?.contextWindow).toBe(128000);

    const full = resolveModelInfo({ provider: "openai", modelId: "gpt-4o-2024-11-20" });
    expect(full?.pricing?.inputPerMTok).toBe(2.5);
    expect(full?.maxOutputTokens).toBe(16384);
  });

  it("flash-lite is not billed as flash — the gemini prefix collision", () => {
    // `gemini-3.5-flash` is a strict prefix of `gemini-3.5-flash-lite`, so a
    // first-match resolver would bill Lite at 5x its input and 3.6x its output.
    const lite = resolveModelInfo({ provider: "google", modelId: "gemini-3.5-flash-lite" });
    expect(lite?.pricing).toEqual({
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
      cachedInputPerMTok: 0.03,
    });

    const flash = resolveModelInfo({ provider: "google", modelId: "gemini-3.5-flash" });
    expect(flash?.pricing?.inputPerMTok).toBe(1.5);
    // Every Gemini 3.x flash row is sized — an absent window silently disables
    // utilization-driven rendering, so the seed states it or states nothing.
    for (const id of ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"]) {
      const info = resolveModelInfo({ provider: "google", modelId: id });
      expect(info?.contextWindow).toBe(1048576);
      expect(info?.maxOutputTokens).toBe(65536);
    }
    // A dated suffix still resolves to the base row.
    expect(
      resolveModelInfo({ provider: "google", modelId: "gemini-3.5-flash-002" })?.pricing
        ?.outputPerMTok,
    ).toBe(9);
  });

  it("unknown model / provider → undefined, never fabricated", () => {
    expect(resolveModelInfo({ provider: "openai", modelId: "gpt-99" })).toBeUndefined();
    expect(resolveModelInfo({ provider: "nobody", modelId: "x" })).toBeUndefined();
    expect(resolveModelInfo({ provider: "openai" })).toBeUndefined();
  });
});

describe("mergeRegistry", () => {
  it("adopter rows layer over the base per provider", () => {
    const merged = mergeRegistry(SEED_MODELS, {
      openai: {
        "gpt-4o": { contextWindow: 999999, pricing: { inputPerMTok: 9, outputPerMTok: 9 } },
      },
    });
    const info = resolveModelInfo({ provider: "openai", modelId: "gpt-4o" }, merged);
    expect(info?.contextWindow).toBe(999999);
    expect(info?.pricing?.inputPerMTok).toBe(9);
    // untouched sibling row survives the merge
    expect(
      resolveModelInfo({ provider: "anthropic", modelId: "claude-opus-4" }, merged)
        ?.maxOutputTokens,
    ).toBe(32000);
  });
});

describe("effectiveModelInfo — precedence: adopter > target self > seed", () => {
  it("target self-description overrides seed", () => {
    const info = effectiveModelInfo({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      capabilities: { contextWindow: 1_000_000 },
      pricing: { inputPerMTok: 99, outputPerMTok: 99 },
    });
    expect(info?.contextWindow).toBe(1_000_000); // self wins over seed 200000
    expect(info?.pricing?.inputPerMTok).toBe(99); // self wins over seed 3
    // seed fills fields the target didn't self-describe
    expect(info?.maxOutputTokens).toBe(16384);
    expect(info?.capabilities?.supportsVision).toBe(true);
  });

  it("adopter registry overrides both target self and seed", () => {
    const registry: ModelRegistry = {
      anthropic: { "claude-sonnet": { contextWindow: 500000, maxOutputTokens: 42 } },
    };
    const info = effectiveModelInfo(
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        capabilities: { contextWindow: 1_000_000 },
      },
      registry,
    );
    expect(info?.contextWindow).toBe(500000); // adopter wins over self (1M) and seed
    expect(info?.maxOutputTokens).toBe(42);
  });

  it("falls back to seed when neither adopter nor self describe the model", () => {
    const info = effectiveModelInfo({ provider: "openai", modelId: "gpt-4o" });
    expect(info?.contextWindow).toBe(128000);
    expect(info?.pricing?.inputPerMTok).toBe(2.5);
  });

  it("returns undefined when no layer knows the model", () => {
    expect(effectiveModelInfo({ provider: "nobody", modelId: "x" })).toBeUndefined();
  });

  it("target self-description alone is enough (no seed row)", () => {
    const info = effectiveModelInfo({
      provider: "nobody",
      modelId: "custom-1",
      capabilities: { contextWindow: 4096 },
    });
    expect(info?.contextWindow).toBe(4096);
  });
});

describe("contextUtilization — ratio 0..1", () => {
  it("used / window as a ratio", () => {
    const info = resolveModelInfo({ provider: "openai", modelId: "gpt-4o" });
    expect(contextUtilization(64000, info)).toBeCloseTo(0.5); // 64k / 128k
  });

  it("clamps to [0, 1]", () => {
    const info = { contextWindow: 1000 };
    expect(contextUtilization(2000, info)).toBe(1);
    expect(contextUtilization(0, info)).toBe(0);
  });

  it("undefined when no window is known", () => {
    expect(contextUtilization(100)).toBeUndefined();
    expect(
      contextUtilization(100, { pricing: { inputPerMTok: 1, outputPerMTok: 1 } }),
    ).toBeUndefined();
  });
});

describe("estimateTokens", () => {
  it("char/4 default over a string", () => {
    expect(estimateTokens("12345678")).toBe(2); // 8 / 4
  });

  it("char/4 default over LanguageModelInput text parts", () => {
    const input: LanguageModelInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "aaaa" } as never] },
        { role: "assistant", content: [{ type: "text", text: "bbbbbbbb" } as never] },
      ],
    };
    expect(estimateTokens(input)).toBe(3); // (4 + 8) / 4
  });

  it("uses info.tokenEstimator when present", () => {
    expect(estimateTokens("ignored", { tokenEstimator: () => 777 })).toBe(777);
  });
});

describe("SEED_PRICING is the pricing projection of SEED_MODELS (single source)", () => {
  it("every priced seed model resolves identically through both surfaces", () => {
    for (const [provider, models] of Object.entries(SEED_MODELS)) {
      for (const prefix of Object.keys(models)) {
        const viaRegistry = resolveModelInfo({ provider, modelId: prefix })?.pricing;
        const viaPricing = resolvePricing({ provider, modelId: prefix });
        expect(viaPricing).toEqual(viaRegistry);
      }
    }
    expect(SEED_PRICING.openai?.["gpt-4o"]?.inputPerMTok).toBe(2.5);
  });
});

describe("indirect providers — same model, different serving-provider specs (#204)", () => {
  // Bedrock/Vertex/OpenRouter re-serve other authors' models with their
  // OWN pricing (markup/cut), model-id strings, and sometimes windows.
  // The registry keys on the SERVING provider, so each is a distinct row.
  const indirect: ModelRegistry = {
    anthropic: {
      "claude-sonnet-4": {
        contextWindow: 200_000,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
    },
    bedrock: {
      // AWS model-id scheme + markup.
      "anthropic.claude-sonnet-4": {
        contextWindow: 200_000,
        pricing: { inputPerMTok: 3.3, outputPerMTok: 16.5 },
      },
    },
    openrouter: {
      // OpenRouter's unified scheme + their cut.
      "anthropic/claude-sonnet-4": {
        contextWindow: 200_000,
        pricing: { inputPerMTok: 3.15, outputPerMTok: 15.75 },
      },
    },
  };

  it("the same underlying model resolves to distinct pricing per serving provider", () => {
    const direct = resolveModelInfo(
      { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      indirect,
    );
    const viaBedrock = resolveModelInfo(
      { provider: "bedrock", modelId: "anthropic.claude-sonnet-4-v1:0" },
      indirect,
    );
    const viaOpenRouter = resolveModelInfo(
      { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
      indirect,
    );
    expect(direct?.pricing?.inputPerMTok).toBe(3);
    expect(viaBedrock?.pricing?.inputPerMTok).toBe(3.3);
    expect(viaOpenRouter?.pricing?.inputPerMTok).toBe(3.15);
    // Author != serving provider: Bedrock's Claude is NOT the anthropic row.
    expect(viaBedrock).not.toBe(direct);
  });

  it("an adopter layers an indirect-provider table over the seed via mergeRegistry", () => {
    const merged = mergeRegistry(SEED_MODELS, {
      openrouter: {
        "openai/gpt-4o": {
          contextWindow: 128_000,
          pricing: { inputPerMTok: 2.6, outputPerMTok: 10.4 },
        },
      },
    });
    // Seed rows (direct openai) survive; the new serving provider resolves independently.
    expect(
      resolveModelInfo({ provider: "openai", modelId: "gpt-4o" }, merged)?.pricing?.inputPerMTok,
    ).toBe(2.5);
    expect(
      resolveModelInfo({ provider: "openrouter", modelId: "openai/gpt-4o" }, merged)?.pricing
        ?.inputPerMTok,
    ).toBe(2.6);
  });
});
