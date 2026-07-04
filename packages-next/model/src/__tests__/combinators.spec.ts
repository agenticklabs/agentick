/**
 * Adapter combinators (#183): withRetry / withFallback / tapModel,
 * driven through generate()/generateStream() so the full fold
 * exercises the delegation (buildParams → call/openStream → mapChunk →
 * reconstruct → normalize).
 */

import { describe, expect, it } from "vitest";

import type { AdapterDelta, ExecutionTarget } from "@agentick/spec-next";

import { generate, generateStream } from "../generate.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "../language-model-adapter.js";
import { isTransientProviderError, tapModel, withFallback, withRetry } from "../combinators.js";

const MESSAGES = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

function mkTarget(provider: string): ExecutionTarget {
  return {
    kind: "language-model",
    provider,
    modelId: `${provider}-v1`,
    capabilities: { supportsTools: false, supportsStreaming: true },
  };
}

/** Scripted adapter: fails `failures` times (call AND stream open), then serves `text`. */
function flaky(
  provider: string,
  text: string,
  failures: number,
  cause: () => unknown = () => Object.assign(new Error("rate limited"), { status: 429 }),
): LanguageModelAdapter<{ text: string }, string> & { calls: () => number } {
  let n = 0;
  return {
    provider,
    target: mkTarget(provider),
    calls: () => n,
    buildParams: (input) => input,
    call: async () => {
      if (n++ < failures) throw cause();
      return { text };
    },
    openStream: async function* (): AsyncIterable<string> {
      if (n++ < failures) throw cause();
      yield text.slice(0, 2);
      yield text.slice(2);
    } as unknown as LanguageModelAdapter<{ text: string }, string>["openStream"],
    mapChunk: (chunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk },
    ],
    reconstructRaw: (accum) => ({ text: accum.totalText() }),
    normalize: (raw) => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: `${provider}:${raw.text}` }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  };
}

describe("withRetry", () => {
  it("retries transient failures then succeeds (non-streaming)", async () => {
    const inner = flaky("p", "pong", 2);
    const result = await generate({
      model: withRetry(inner, { attempts: 3, backoffMs: 0 }),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "p:pong" });
    expect(inner.calls()).toBe(3);
  });

  it("does not retry non-transient failures", async () => {
    const inner = flaky("p", "x", 5, () => new Error("bad request: schema"));
    await expect(
      generate({ model: withRetry(inner, { attempts: 3, backoffMs: 0 }), messages: MESSAGES }),
    ).rejects.toThrow("bad request");
    expect(inner.calls()).toBe(1);
  });

  it("gives up after `attempts` and rethrows the last transient cause", async () => {
    const inner = flaky("p", "x", 99);
    await expect(
      generate({ model: withRetry(inner, { attempts: 2, backoffMs: 0 }), messages: MESSAGES }),
    ).rejects.toMatchObject({ status: 429 });
    expect(inner.calls()).toBe(2);
  });

  it("retries the stream OPEN, then the stream serves", async () => {
    const inner = flaky("p", "pong", 1);
    const handle = generateStream({
      model: withRetry(inner, { attempts: 2, backoffMs: 0 }),
      messages: MESSAGES,
    });
    for await (const _ of handle.stream) void _;
    expect((await handle.result).output[0]).toMatchObject({ text: "p:pong" });
  });
});

describe("withFallback", () => {
  it("secondary serves when the primary's call fails — normalize is the SERVING adapter's", async () => {
    const primary = flaky("alpha", "a", 99);
    const secondary = flaky("beta", "b", 0);
    const result = await generate({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "beta:b" });
  });

  it("primary serves when healthy — secondary untouched", async () => {
    const primary = flaky("alpha", "a", 0);
    const secondary = flaky("beta", "b", 0);
    const result = await generate({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "alpha:a" });
    expect(secondary.calls()).toBe(0);
  });

  it("streaming failover: secondary's chunks flow through ITS mapChunk/reconstruct", async () => {
    const primary = flaky("alpha", "aaaa", 99);
    const secondary = flaky("beta", "pong", 0);
    const handle = generateStream({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    let text = "";
    for await (const d of handle.stream) if (d.type === "content-delta") text += d.delta;
    expect(text).toBe("pong");
    expect((await handle.result).output[0]).toMatchObject({ text: "beta:pong" });
  });

  it("never falls back on abort", async () => {
    const ac = new AbortController();
    ac.abort();
    const primary = flaky("alpha", "a", 99, () => new Error("aborted"));
    const secondary = flaky("beta", "b", 0);
    await expect(
      generate({
        model: withFallback(primary, secondary),
        messages: MESSAGES,
        signal: ac.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(secondary.calls()).toBe(0);
  });

  it("exhausted chain rethrows the last cause", async () => {
    await expect(
      generate({
        model: withFallback(flaky("a", "x", 99), flaky("b", "y", 99)),
        messages: MESSAGES,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("composes with withRetry (retry per adapter, then fail over)", async () => {
    const primary = flaky("alpha", "a", 99);
    const secondary = flaky("beta", "b", 1);
    const result = await generate({
      model: withFallback(
        withRetry(primary, { attempts: 2, backoffMs: 0 }),
        withRetry(secondary, { attempts: 2, backoffMs: 0 }),
      ),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "beta:b" });
    expect(primary.calls()).toBe(2);
  });
});

describe("tapModel", () => {
  it("observes call/result/deltas without altering behavior; tap errors are swallowed", async () => {
    const seen = { calls: 0, results: 0, deltas: 0 };
    const model = tapModel(flaky("p", "pong", 0), {
      onCall: () => {
        seen.calls++;
      },
      onResult: () => {
        seen.results++;
        throw new Error("tap explodes — must be swallowed");
      },
      onDelta: () => {
        seen.deltas++;
      },
    });
    const handle = generateStream({ model, messages: MESSAGES });
    for await (const _ of handle.stream) void _;
    expect((await handle.result).output[0]).toMatchObject({ text: "p:pong" });
    expect(seen.calls).toBe(1);
    expect(seen.results).toBe(1);
    expect(seen.deltas).toBeGreaterThan(0);
  });
});

describe("isTransientProviderError", () => {
  it("classifies 429/5xx/network as transient; 4xx/plain as not", () => {
    expect(isTransientProviderError({ status: 429 })).toBe(true);
    expect(isTransientProviderError({ statusCode: 503 })).toBe(true);
    expect(isTransientProviderError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientProviderError({ status: 400 })).toBe(false);
    expect(isTransientProviderError(new Error("plain"))).toBe(false);
  });
});
