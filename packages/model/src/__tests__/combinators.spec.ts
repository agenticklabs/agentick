/**
 * Adapter combinators (#183): withRetry / withFallback / tapModel,
 * driven through generate()/generateStream() so the full fold
 * exercises the delegation (buildParams → call/openStream → mapChunk →
 * reconstruct → normalize).
 */

import { describe, expect, it } from "vitest";
import type { EmbeddingModelAdapter, ImageModelAdapter } from "@agentick/spec";

import { generate, generateStream } from "../generate.js";
import { scriptedAdapter } from "../testing/index.js";
import { isTransientProviderError, tapModel, withFallback, withRetry } from "../combinators.js";

const MESSAGES = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

describe("withRetry", () => {
  it("retries transient failures then succeeds (non-streaming)", async () => {
    const inner = scriptedAdapter("pong", { provider: "p", failures: 2, tagOutput: true });
    const result = await generate({
      model: withRetry(inner, { attempts: 3, backoffMs: 0 }),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "p:pong" });
    expect(inner.calls()).toBe(3);
  });

  it("does not retry non-transient failures", async () => {
    const inner = scriptedAdapter("x", {
      provider: "p",
      failures: 5,
      cause: () => new Error("bad request: schema"),
      tagOutput: true,
    });
    await expect(
      generate({ model: withRetry(inner, { attempts: 3, backoffMs: 0 }), messages: MESSAGES }),
    ).rejects.toThrow("bad request");
    expect(inner.calls()).toBe(1);
  });

  it("gives up after `attempts` and rethrows the last transient cause", async () => {
    const inner = scriptedAdapter("x", { provider: "p", failures: 99, tagOutput: true });
    await expect(
      generate({ model: withRetry(inner, { attempts: 2, backoffMs: 0 }), messages: MESSAGES }),
    ).rejects.toMatchObject({ status: 429 });
    expect(inner.calls()).toBe(2);
  });

  it("retries the stream OPEN, then the stream serves", async () => {
    const inner = scriptedAdapter("pong", { provider: "p", failures: 1, tagOutput: true });
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
    const primary = scriptedAdapter("a", { provider: "alpha", failures: 99, tagOutput: true });
    const secondary = scriptedAdapter("b", { provider: "beta", failures: 0, tagOutput: true });
    const result = await generate({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "beta:b" });
  });

  it("a degraded call stamps `fallback` finishMetadata; a healthy one stamps nothing", async () => {
    const primary = scriptedAdapter("a", { provider: "alpha", failures: 99, tagOutput: true });
    const secondary = scriptedAdapter("b", { provider: "beta", failures: 0, tagOutput: true });
    const degraded = await generate({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    expect(degraded.finishMetadata?.["fallback"]).toMatchObject({ provider: "beta" });

    const healthyPrimary = scriptedAdapter("a", {
      provider: "alpha",
      failures: 0,
      tagOutput: true,
    });
    const healthy = await generate({
      model: withFallback(healthyPrimary, secondary),
      messages: MESSAGES,
    });
    expect(healthy.finishMetadata?.["fallback"]).toBeUndefined();
  });

  it("primary serves when healthy — secondary untouched", async () => {
    const primary = scriptedAdapter("a", { provider: "alpha", failures: 0, tagOutput: true });
    const secondary = scriptedAdapter("b", { provider: "beta", failures: 0, tagOutput: true });
    const result = await generate({
      model: withFallback(primary, secondary),
      messages: MESSAGES,
    });
    expect(result.output[0]).toMatchObject({ text: "alpha:a" });
    expect(secondary.calls()).toBe(0);
  });

  it("streaming failover: secondary's chunks flow through ITS mapChunk/reconstruct", async () => {
    const primary = scriptedAdapter("aaaa", { provider: "alpha", failures: 99, tagOutput: true });
    const secondary = scriptedAdapter("pong", { provider: "beta", failures: 0, tagOutput: true });
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
    const primary = scriptedAdapter("a", {
      provider: "alpha",
      failures: 99,
      cause: () => new Error("aborted"),
      tagOutput: true,
    });
    const secondary = scriptedAdapter("b", { provider: "beta", failures: 0, tagOutput: true });
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
        model: withFallback(
          scriptedAdapter("x", { provider: "a", failures: 99, tagOutput: true }),
          scriptedAdapter("y", { provider: "b", failures: 99, tagOutput: true }),
        ),
        messages: MESSAGES,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("composes with withRetry (retry per adapter, then fail over)", async () => {
    const primary = scriptedAdapter("a", { provider: "alpha", failures: 99, tagOutput: true });
    const secondary = scriptedAdapter("b", { provider: "beta", failures: 1, tagOutput: true });
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
    const model = tapModel(
      scriptedAdapter("pong", { provider: "p", failures: 0, tagOutput: true }),
      {
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
      },
    );
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

describe("modality families — withRetry / withFallback (ADR 105)", () => {
  const SPEC = "2026-05-08";
  const transient = () => Object.assign(new Error("rate limited"), { status: 429 });

  function imageAdapter(modelId: string, failures: number) {
    let calls = 0;
    const adapter: ImageModelAdapter = {
      provider: "stub",
      target: { kind: "image-model", provider: "stub", modelId },
      async generate() {
        calls++;
        if (calls <= failures) throw transient();
        return { specVersion: SPEC, output: [], images: [{ data: "AA==", mimeType: "image/png" }] };
      },
    };
    return { adapter, calls: () => calls };
  }

  it("withRetry retries a transient image call, then serves", async () => {
    const inner = imageAdapter("img", 2);
    const result = await withRetry(inner.adapter, { attempts: 3, backoffMs: 0 }).generate({
      prompt: "x",
    });
    expect(result.images).toHaveLength(1);
    expect(inner.calls()).toBe(3);
  });

  it("withFallback serves the secondary and stamps finishMetadata.fallback; a healthy primary stamps nothing", async () => {
    const primary = imageAdapter("imagen-4", 99);
    const secondary = imageAdapter("imagen-3", 0);
    const degraded = await withFallback(primary.adapter, secondary.adapter).generate({
      prompt: "x",
    });
    expect(degraded.finishMetadata).toMatchObject({
      fallback: { provider: "stub", modelId: "imagen-3", primary: "imagen-4" },
    });

    const healthy = imageAdapter("imagen-4", 0);
    const fine = await withFallback(healthy.adapter, secondary.adapter).generate({ prompt: "x" });
    expect(fine.finishMetadata?.["fallback"]).toBeUndefined();
  });

  it("embedding adapters get the same combinators", async () => {
    let calls = 0;
    const adapter: EmbeddingModelAdapter = {
      provider: "stub",
      target: { kind: "embedding-model", provider: "stub", modelId: "emb" },
      async embed({ input }) {
        calls++;
        if (calls === 1) throw transient();
        return { specVersion: SPEC, output: [], embeddings: input.map(() => [1]), dimensions: 1 };
      },
    };
    const result = await withRetry(adapter, { backoffMs: 0 }).embed({ input: ["a"] });
    expect(result.embeddings).toEqual([[1]]);
    expect(calls).toBe(2);
  });
});
