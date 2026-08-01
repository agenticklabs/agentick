/**
 * Usage → cost: arithmetic, the honesty rule, and per-model rollups.
 *
 * @see docs/proposals/v2/usage-cost.md
 */

import { describe, expect, it } from "vitest";

import {
  foldCost,
  foldModelUsage,
  foldUsageRollup,
  isCost,
  mergeCostRollups,
  mergeUsageStats,
  inSpawnTree,
  modelKey,
  priceUsage,
  rollupTree,
  resolveTickCost,
  type Cost,
  type CostResolverInput,
  type RateCard,
  type UsageStats,
} from "../index.js";

// USD/MTok expressed in micro-units: $3/MTok === 3_000_000.
const SONNET: RateCard = {
  id: "anthropic:claude-sonnet-5@2026-07-01",
  currency: "USD",
  perMTok: {
    input: 3_000_000,
    output: 15_000_000,
    cacheRead: 300_000,
    cacheWrite: 3_750_000,
  },
};

const usage = (u: Partial<UsageStats> & Pick<UsageStats, "inputTokens" | "outputTokens">) => ({
  totalTokens: u.inputTokens + u.outputTokens,
  ...u,
});

/** A `complete` rollup standing in for one already-priced session record. */
const complete = (amountMicros: number, ticks = 1, currency = "USD") =>
  ({ kind: "complete", amountMicros, currency, ticks, rateRefs: ["r@1"] }) as const;

describe("priceUsage", () => {
  it("prices fresh input and output at their kind rates", () => {
    // 1M input @ $3 + 1M output @ $15 = $18 = 18_000_000 micros.
    const cost = priceUsage(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), SONNET);
    expect(cost).toEqual({
      amountMicros: 18_000_000,
      currency: "USD",
      rateRef: SONNET.id,
    });
  });

  it("does NOT double-charge cache reads — they are a subset of inputTokens", () => {
    // 1M input of which 800k were cache reads: 200k fresh @ $3 + 800k @ $0.30.
    const cost = priceUsage(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 0 }),
      SONNET,
    );
    expect(cost.amountMicros).toBe(200_000 * 3 + 800_000 * 0.3);

    // The naive reading — full input rate PLUS a cache-read rate — is the
    // bug this asserts against.
    const doubleCharged = 1_000_000 * 3 + 800_000 * 0.3;
    expect(cost.amountMicros).not.toBe(doubleCharged);
  });

  it("does NOT double-charge cache writes", () => {
    // 1M input = 500k fresh + 300k read + 200k write.
    const cost = priceUsage(
      usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 300_000,
        cacheCreationTokens: 200_000,
        outputTokens: 0,
      }),
      SONNET,
    );
    expect(cost.amountMicros).toBe(500_000 * 3 + 300_000 * 0.3 + 200_000 * 3.75);
  });

  it("never lets the fresh remainder go negative when a provider over-reports", () => {
    const cost = priceUsage(
      usage({ inputTokens: 100, cachedInputTokens: 900, outputTokens: 0 }),
      SONNET,
    );
    // Fresh input clamps at 0; the cache read is still charged.
    expect(cost.amountMicros).toBe(Math.round((900 * 300_000) / 1_000_000));
  });

  it("falls back to the input rate when no cache rate is declared", () => {
    const flat: RateCard = {
      id: "flat@1",
      currency: "USD",
      perMTok: { input: 3_000_000, output: 15_000_000 },
    };
    const cost = priceUsage(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 }),
      flat,
    );
    // No discount: the whole 1M is charged at input rate.
    expect(cost.amountMicros).toBe(3_000_000);
  });

  it("prices reasoning at the output rate when no reasoning rate exists", () => {
    // reasoningTokens is a SUBSET of outputTokens (normative), so with no
    // reasoning rate the output rate covers all of it and no split occurs.
    const withReasoning = priceUsage(
      usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 400_000 }),
      SONNET,
    );
    const without = priceUsage(usage({ inputTokens: 0, outputTokens: 1_000_000 }), SONNET);
    expect(withReasoning.amountMicros).toBe(without.amountMicros);
  });

  it("splits output when a reasoning rate IS declared", () => {
    const card: RateCard = {
      id: "split@1",
      currency: "USD",
      perMTok: { input: 0, output: 15_000_000, reasoning: 30_000_000 },
    };
    const cost = priceUsage(
      usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 400_000 }),
      card,
    );
    // 600k non-reasoning @ $15 + 400k reasoning @ $30.
    expect(cost.amountMicros).toBe(600_000 * 15 + 400_000 * 30);
  });

  it("adds a flat per-call fee once", () => {
    const card: RateCard = { ...SONNET, perCallMicros: 5_000 };
    const cost = priceUsage(usage({ inputTokens: 1_000_000, outputTokens: 0 }), card);
    expect(cost.amountMicros).toBe(3_000_000 + 5_000);
  });

  it("charges the flat fee even when the call reported zero tokens", () => {
    const card: RateCard = { ...SONNET, perCallMicros: 5_000 };
    expect(priceUsage(usage({ inputTokens: 0, outputTokens: 0 }), card).amountMicros).toBe(5_000);
  });

  it("rounds once at the end, not per kind", () => {
    // Each kind alone rounds to 0 micros; summed exactly they are 1 micro
    // and a half. Per-kind rounding would report 0.
    const card: RateCard = {
      id: "tiny@1",
      currency: "USD",
      perMTok: { input: 500_000, output: 500_000, cacheRead: 500_000 },
    };
    const cost = priceUsage(usage({ inputTokens: 2, cachedInputTokens: 1, outputTokens: 1 }), card);
    // (1 + 1 + 1) tokens x 500_000 / 1_000_000 = 1.5 -> 2, not 0.
    expect(cost.amountMicros).toBe(2);
  });

  it("is order-independent across kinds", () => {
    const a = priceUsage(
      usage({
        inputTokens: 999_983,
        cachedInputTokens: 333_331,
        cacheCreationTokens: 111_117,
        outputTokens: 777_773,
      }),
      SONNET,
    );
    const b = priceUsage(
      usage({
        outputTokens: 777_773,
        cacheCreationTokens: 111_117,
        cachedInputTokens: 333_331,
        inputTokens: 999_983,
      }),
      SONNET,
    );
    expect(a.amountMicros).toBe(b.amountMicros);
  });

  it("stamps the rate card's id as rateRef", () => {
    expect(priceUsage(usage({ inputTokens: 1, outputTokens: 1 }), SONNET).rateRef).toBe(
      "anthropic:claude-sonnet-5@2026-07-01",
    );
  });
});

describe("resolveTickCost", () => {
  const input = (over: Partial<CostResolverInput> = {}): CostResolverInput => ({
    target: { kind: "language-model", provider: "anthropic", modelId: "claude-sonnet-5" },
    usage: usage({ inputTokens: 1_000_000, outputTokens: 0 }),
    sessionId: "sess:1",
    executionId: "exec:1",
    tickId: "tick:1",
    ...over,
  });

  it("prices from the target's declared rates when no resolver is given", () => {
    const cost = resolveTickCost(input({ target: { kind: "language-model", rates: SONNET } }));
    expect(cost?.amountMicros).toBe(3_000_000);
  });

  it("returns undefined — UNPRICED — when neither resolver nor rates supply a card", () => {
    expect(resolveTickCost(input())).toBeUndefined();
  });

  it("lets the resolver WIN over declared rates", () => {
    const tenant: RateCard = { id: "tenant-a@1", currency: "USD", perMTok: { input: 1_000_000 } };
    const cost = resolveTickCost(
      input({ target: { kind: "language-model", rates: SONNET } }),
      () => tenant,
    );
    expect(cost).toEqual({ amountMicros: 1_000_000, currency: "USD", rateRef: "tenant-a@1" });
  });

  it("falls through to declared rates when the resolver returns undefined", () => {
    const cost = resolveTickCost(
      input({ target: { kind: "language-model", rates: SONNET } }),
      () => undefined,
    );
    expect(cost?.rateRef).toBe(SONNET.id);
  });

  it("uses a resolver-returned Cost verbatim, without re-running arithmetic", () => {
    const flat: Cost = { amountMicros: 42, currency: "EUR", rateRef: "marketplace:seat@1" };
    const cost = resolveTickCost(
      input({ target: { kind: "language-model", rates: SONNET } }),
      () => flat,
    );
    expect(cost).toBe(flat);
  });

  it("hands the resolver the tick's identity and resolved target", () => {
    let seen: CostResolverInput | undefined;
    resolveTickCost(input(), (i) => {
      seen = i;
      return undefined;
    });
    expect(seen?.tickId).toBe("tick:1");
    expect(seen?.target.modelId).toBe("claude-sonnet-5");
  });

  it("discriminates a Cost from a RateCard structurally", () => {
    expect(isCost({ amountMicros: 1, currency: "USD", rateRef: "x" })).toBe(true);
    expect(isCost(SONNET)).toBe(false);
  });
});

describe("foldCost — the honesty rule", () => {
  const cost = (amountMicros: number, rateRef = "a@1", currency = "USD"): Cost => ({
    amountMicros,
    currency,
    rateRef,
  });

  it("folds priced ticks into a complete total", () => {
    const rollup = foldCost(foldCost(undefined, cost(100)), cost(50));
    expect(rollup).toEqual({
      kind: "complete",
      amountMicros: 150,
      currency: "USD",
      ticks: 2,
      rateRefs: ["a@1"],
    });
  });

  it("collects every distinct rateRef, deduplicated", () => {
    const rollup = foldCost(
      foldCost(foldCost(undefined, cost(1, "a@1")), cost(1, "b@1")),
      cost(1, "a@1"),
    );
    expect(rollup.rateRefs).toEqual(["a@1", "b@1"]);
  });

  it("rolls an unpriced tick up as UNPRICED, never as zero", () => {
    const rollup = foldCost(undefined, undefined);
    expect(rollup).toEqual({
      kind: "partial",
      amountMicros: 0,
      currency: "",
      pricedTicks: 0,
      unpricedTicks: 1,
      rateRefs: [],
    });
    // The defect this exists to prevent: a confident zero.
    expect(rollup.kind).not.toBe("complete");
  });

  it("degrades a complete total to partial as soon as one tick is unpriced", () => {
    const rollup = foldCost(foldCost(undefined, cost(100)), undefined);
    expect(rollup.kind).toBe("partial");
    expect(rollup.amountMicros).toBe(100);
    if (rollup.kind === "partial") {
      expect(rollup.pricedTicks).toBe(1);
      expect(rollup.unpricedTicks).toBe(1);
    }
  });

  it("keeps the total partial once degraded, even if later ticks are priced", () => {
    const rollup = foldCost(foldCost(foldCost(undefined, undefined), cost(100)), cost(50));
    expect(rollup.kind).toBe("partial");
    // The amount is a LOWER BOUND — only the priced subset.
    expect(rollup.amountMicros).toBe(150);
  });

  it("counts a foreign-currency tick as unpriced in this total", () => {
    const rollup = foldCost(
      foldCost(undefined, cost(100, "usd@1", "USD")),
      cost(90, "eur@1", "EUR"),
    );
    expect(rollup.kind).toBe("partial");
    expect(rollup.amountMicros).toBe(100);
    expect(rollup.currency).toBe("USD");
    if (rollup.kind === "partial") expect(rollup.unpricedTicks).toBe(1);
    // Summing across currencies is the lie this prevents.
    expect(rollup.amountMicros).not.toBe(190);
  });
});

describe("mergeCostRollups", () => {
  const complete = (amountMicros: number, ticks: number, rateRefs: string[], currency = "USD") =>
    ({ kind: "complete", amountMicros, currency, ticks, rateRefs }) as const;

  it("is the identity on an absent side", () => {
    const a = complete(10, 1, ["a@1"]);
    expect(mergeCostRollups(a, undefined)).toBe(a);
    expect(mergeCostRollups(undefined, a)).toBe(a);
    expect(mergeCostRollups(undefined, undefined)).toBeUndefined();
  });

  it("merges two complete rollups into a complete one", () => {
    const merged = mergeCostRollups(complete(10, 1, ["a@1"]), complete(5, 2, ["b@1"]));
    expect(merged).toEqual({
      kind: "complete",
      amountMicros: 15,
      currency: "USD",
      ticks: 3,
      rateRefs: ["a@1", "b@1"],
    });
  });

  it("degrades when either side is partial", () => {
    const partial = foldCost(undefined, undefined);
    const merged = mergeCostRollups(complete(10, 1, ["a@1"]), partial);
    expect(merged?.kind).toBe("partial");
    expect(merged?.amountMicros).toBe(10);
  });

  it("counts the foreign side's ticks as unpriced rather than summing currencies", () => {
    const merged = mergeCostRollups(complete(10, 1, ["a@1"]), complete(90, 2, ["e@1"], "EUR"));
    expect(merged?.kind).toBe("partial");
    expect(merged?.amountMicros).toBe(10);
    if (merged?.kind === "partial") expect(merged.unpricedTicks).toBe(2);
  });
});

describe("mergeUsageStats", () => {
  it("adds the always-present counters", () => {
    expect(
      mergeUsageStats(
        usage({ inputTokens: 1, outputTokens: 2 }),
        usage({ inputTokens: 3, outputTokens: 4 }),
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  it("leaves an optional kind ABSENT until some sample reports it (absent != zero)", () => {
    const merged = mergeUsageStats(
      usage({ inputTokens: 1, outputTokens: 1 }),
      usage({ inputTokens: 1, outputTokens: 1 }),
    );
    expect("cacheCreationTokens" in merged).toBe(false);
  });

  it("treats a reporting sample's counterpart as zero once the kind appears", () => {
    const merged = mergeUsageStats(
      usage({ inputTokens: 1, outputTokens: 1 }),
      usage({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 5 }),
    );
    expect(merged.cachedInputTokens).toBe(5);
  });
});

describe("per-model rollups", () => {
  const anthropicTarget = { provider: "anthropic", modelId: "claude-sonnet-5" };
  const openaiTarget = { provider: "openai", modelId: "gpt-4o" };

  it("keys a breakdown by provider/modelId", () => {
    expect(modelKey(anthropicTarget)).toBe("anthropic/claude-sonnet-5");
  });

  it('keys an anonymous target as "unknown"', () => {
    expect(modelKey(undefined)).toBe("unknown");
    expect(modelKey({})).toBe("unknown");
  });

  it("partitions usage across two models and keeps the flat total equal to their sum", () => {
    let rollup = foldUsageRollup(
      undefined,
      anthropicTarget,
      usage({ inputTokens: 100, outputTokens: 10 }),
      { amountMicros: 5, currency: "USD", rateRef: "a@1" },
    );
    rollup = foldUsageRollup(rollup, openaiTarget, usage({ inputTokens: 200, outputTokens: 20 }), {
      amountMicros: 7,
      currency: "USD",
      rateRef: "o@1",
    });
    rollup = foldUsageRollup(rollup, anthropicTarget, usage({ inputTokens: 1, outputTokens: 1 }), {
      amountMicros: 1,
      currency: "USD",
      rateRef: "a@1",
    });

    expect(Object.keys(rollup.byModel).sort()).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-4o",
    ]);
    expect(rollup.byModel["anthropic/claude-sonnet-5"]?.usage.inputTokens).toBe(101);
    expect(rollup.byModel["anthropic/claude-sonnet-5"]?.ticks).toBe(2);
    expect(rollup.byModel["openai/gpt-4o"]?.usage.inputTokens).toBe(200);

    // The flat bag still sums correctly — it is just not priceable.
    expect(rollup.usage.inputTokens).toBe(301);
    expect(rollup.usage.outputTokens).toBe(31);
    expect(rollup.cost).toEqual({
      kind: "complete",
      amountMicros: 13,
      currency: "USD",
      ticks: 3,
      rateRefs: ["a@1", "o@1"],
    });
  });

  it("carries provider and modelId onto each bucket", () => {
    const byModel = foldModelUsage(
      {},
      anthropicTarget,
      usage({ inputTokens: 1, outputTokens: 1 }),
      undefined,
    );
    expect(byModel["anthropic/claude-sonnet-5"]).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("keeps a per-model bucket priced even when the run total went partial", () => {
    // The priced model stays complete in its own bucket; only the run
    // total degrades. This is what a multi-currency or partly-unpriced
    // consumer reads instead of the top-level number.
    let rollup = foldUsageRollup(
      undefined,
      anthropicTarget,
      usage({ inputTokens: 1, outputTokens: 1 }),
      {
        amountMicros: 5,
        currency: "USD",
        rateRef: "a@1",
      },
    );
    rollup = foldUsageRollup(
      rollup,
      openaiTarget,
      usage({ inputTokens: 1, outputTokens: 1 }),
      undefined,
    );

    expect(rollup.cost?.kind).toBe("partial");
    expect(rollup.byModel["anthropic/claude-sonnet-5"]?.cost?.kind).toBe("complete");
    expect(rollup.byModel["openai/gpt-4o"]?.cost?.kind).toBe("partial");
  });

  it("attributes an agent tree at QUERY time, at any depth", () => {
    // root ← child ← grandchild. `parentSessionId` would stop at `child`
    // and silently lose the grandchild's money.
    const tree = rollupTree(
      [
        { id: "root", usage: usage({ inputTokens: 10, outputTokens: 1 }), cost: complete(100) },
        {
          id: "child",
          spawnPath: ["root"],
          usage: usage({ inputTokens: 20, outputTokens: 2 }),
          cost: complete(200),
        },
        {
          id: "grandchild",
          spawnPath: ["root", "child"],
          usage: usage({ inputTokens: 40, outputTokens: 4 }),
          cost: complete(400),
        },
        // A sibling tree that must NOT be swept in.
        { id: "other", usage: usage({ inputTokens: 999, outputTokens: 9 }), cost: complete(9_999) },
      ],
      "root",
    );
    expect(tree?.usage.inputTokens).toBe(70);
    expect(tree?.cost).toMatchObject({ kind: "complete", amountMicros: 700, ticks: 3 });
  });

  it("scopes to a SUBTREE when the caller picks an interior root", () => {
    const records = [
      { id: "root", usage: usage({ inputTokens: 10, outputTokens: 1 }), cost: complete(100) },
      {
        id: "child",
        spawnPath: ["root"],
        usage: usage({ inputTokens: 20, outputTokens: 2 }),
        cost: complete(200),
      },
      {
        id: "grandchild",
        spawnPath: ["root", "child"],
        usage: usage({ inputTokens: 40, outputTokens: 4 }),
        cost: complete(400),
      },
    ];
    // The same records, a different question — which is the whole reason
    // this is a query and not a frozen write-time number.
    expect(rollupTree(records, "child")?.cost?.amountMicros).toBe(600);
    expect(rollupTree(records, "grandchild")?.cost?.amountMicros).toBe(400);
  });

  it("degrades the tree to partial when a descendant carries NO cost at all", () => {
    // The trap: mergeCostRollups(x, undefined) returns x, so a naive fold
    // would report `complete` while a whole branch went unpriced.
    const tree = rollupTree(
      [
        { id: "root", usage: usage({ inputTokens: 10, outputTokens: 1 }), cost: complete(100) },
        { id: "child", spawnPath: ["root"], usage: usage({ inputTokens: 20, outputTokens: 2 }) },
      ],
      "root",
    );
    expect(tree?.cost?.kind).toBe("partial");
    expect(tree?.cost?.amountMicros).toBe(100);
    expect(tree?.cost).not.toMatchObject({ kind: "complete" });
  });

  it("degrades the tree when a descendant's own rollup is already partial", () => {
    const tree = rollupTree(
      [
        { id: "root", usage: usage({ inputTokens: 10, outputTokens: 1 }), cost: complete(100) },
        {
          id: "child",
          spawnPath: ["root"],
          usage: usage({ inputTokens: 20, outputTokens: 2 }),
          cost: foldCost(undefined, undefined),
        },
      ],
      "root",
    );
    expect(tree?.cost?.kind).toBe("partial");
  });

  it("does not treat a zero-usage descendant as unpriced", () => {
    // A session that never generated is not an unpriced session — there is
    // nothing to price and nothing to hide.
    const tree = rollupTree(
      [
        { id: "root", usage: usage({ inputTokens: 10, outputTokens: 1 }), cost: complete(100) },
        { id: "child", spawnPath: ["root"], usage: usage({ inputTokens: 0, outputTokens: 0 }) },
      ],
      "root",
    );
    expect(tree?.cost?.kind).toBe("complete");
  });

  it("merges per-model buckets across the whole tree", () => {
    const tree = rollupTree(
      [
        {
          id: "root",
          usage: usage({ inputTokens: 10, outputTokens: 1 }),
          byModel: {
            "anthropic/opus": { usage: usage({ inputTokens: 10, outputTokens: 1 }), ticks: 1 },
          },
        },
        {
          id: "child",
          spawnPath: ["root"],
          usage: usage({ inputTokens: 20, outputTokens: 2 }),
          byModel: {
            "anthropic/opus": { usage: usage({ inputTokens: 20, outputTokens: 2 }), ticks: 2 },
            "openai/gpt-4o": { usage: usage({ inputTokens: 5, outputTokens: 1 }), ticks: 1 },
          },
        },
      ],
      "root",
    );
    expect(Object.keys(tree!.byModel).sort()).toEqual(["anthropic/opus", "openai/gpt-4o"]);
    expect(tree!.byModel["anthropic/opus"]).toMatchObject({ ticks: 3 });
    expect(tree!.byModel["anthropic/opus"]?.usage.inputTokens).toBe(30);
  });

  it("returns undefined when no record matches the root", () => {
    expect(
      rollupTree([{ id: "other", usage: usage({ inputTokens: 1, outputTokens: 1 }) }], "root"),
    ).toBeUndefined();
  });

  it("matches the root itself, not only its descendants", () => {
    expect(inSpawnTree({ id: "root" }, "root")).toBe(true);
    expect(inSpawnTree({ id: "child", spawnPath: ["root"] }, "root")).toBe(true);
    expect(inSpawnTree({ id: "other" }, "root")).toBe(false);
    expect(inSpawnTree({ id: "other", spawnPath: ["elsewhere"] }, "root")).toBe(false);
  });

  it("does not mutate the accumulator it folds into", () => {
    const first = foldUsageRollup(
      undefined,
      anthropicTarget,
      usage({ inputTokens: 1, outputTokens: 1 }),
      undefined,
    );
    const before = JSON.stringify(first);
    foldUsageRollup(first, openaiTarget, usage({ inputTokens: 9, outputTokens: 9 }), undefined);
    expect(JSON.stringify(first)).toBe(before);
  });
});
