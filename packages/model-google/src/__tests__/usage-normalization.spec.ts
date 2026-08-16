/**
 * Token-kind normalization for the `google()` adapter, and the `rates`
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
 * Gemini reports `promptTokenCount` already INCLUDING
 * `cachedContentTokenCount`, so input needs no folding. It reports
 * `candidatesTokenCount` EXCLUDING `thoughtsTokenCount` while billing
 * thinking at the output rate (D6) — so the adapter folds thoughts into
 * `outputTokens`, which is also what Anthropic and OpenAI already
 * report. `totalTokenCount` always counted thoughts, which is why input
 * + output used to disagree with it.
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, RateCard } from "@agentick/spec";

import { google } from "../google-adapter.js";
import {
  StubGoogleClient,
  mkFinishChunk,
  mkResponse,
  mkTarget,
  mkTextChunk,
} from "../testing/index.js";
import { emptyTree, makeExecutor } from "./executor-harness.js";

const CARD: RateCard = {
  id: "google:gemini-2.5-flash@2026-07-01",
  currency: "USD",
  perMTok: { input: 300_000, output: 2_500_000, cacheRead: 75_000 },
};

describe("google() — usage normalization", () => {
  it("folds thoughts into outputTokens, keeping reasoningTokens as a subset (D6)", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
            totalTokenCount: 150,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50, // 20 candidates + 30 thoughts
      totalTokens: 150,
      reasoningTokens: 30,
    });
  });

  it("makes input + output agree with Gemini's own totalTokenCount", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
            // What Gemini actually reports: prompt + candidates + thoughts.
            totalTokenCount: 150,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    const u = t.result.usage!;
    expect(u.inputTokens + u.outputTokens).toBe(150);
    expect(u.totalTokens).toBe(150);
  });

  it("treats cached content as a subset of input, not an addition", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 60,
            totalTokenCount: 120,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage?.inputTokens).toBe(100);
    expect(t.result.usage?.cachedInputTokens).toBe(60);
  });

  it("keeps unreported kinds undefined — absent is not zero", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(t.result.usage).not.toHaveProperty("reasoningTokens");
    expect(t.result.usage).not.toHaveProperty("cachedInputTokens");
    // Gemini has no cache-WRITE charge, so the kind is absent, not zero.
    expect(t.result.usage).not.toHaveProperty("cacheCreationTokens");
  });

  it("streams to the same UsageStats as the non-streaming path", async () => {
    const usage = {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
      cachedContentTokenCount: 60,
      totalTokenCount: 150,
    };
    const streaming = new StubGoogleClient([
      { kind: "streaming", chunks: [mkTextChunk("ok"), mkFinishChunk({ usage })] },
    ]);
    const nonStreaming = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok", usage }) },
    ]);
    const { exec: a } = await makeExecutor(streaming, { stream: true });
    const { exec: b } = await makeExecutor(nonStreaming);
    const ta = await a.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const tb = await b.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (ta.outcome !== "succeeded" || tb.outcome !== "succeeded") {
      throw new Error("expected success");
    }
    expect(ta.result.usage).toEqual(tb.result.usage);
    expect(ta.result.usage?.outputTokens).toBe(50);
  });
});

describe("google() — rates at construction", () => {
  it("lands the declared card on the self-described target", () => {
    expect(google("gemini-2.5-flash", { rates: CARD }).target.rates).toEqual(CARD);
  });

  it("is absent when no card is declared — the framework ships no prices", () => {
    expect(google("gemini-2.5-flash").target.rates).toBeUndefined();
  });

  it("layers over an explicit target rather than being swallowed by it", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "google",
      modelId: "custom-proxy",
    };
    const adapter = google("gemini-2.5-flash", { target: explicit, rates: CARD });
    expect(adapter.target.rates).toEqual(CARD);
    expect(adapter.target.modelId).toBe("custom-proxy");
  });

  it("leaves an explicit target's own card alone when no option is passed", () => {
    const explicit: ExecutionTarget = {
      kind: "language-model",
      provider: "google",
      modelId: "custom-proxy",
      rates: CARD,
    };
    expect(google("gemini-2.5-flash", { target: explicit }).target.rates).toEqual(CARD);
  });
});
