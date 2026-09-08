/**
 * `google.images()` / `google.embeddings()` over an injected fake client:
 * prompt-only generation is Imagen; references route to the Gemini image
 * model as an edit; embeddings map dimensions + task to the SDK's config.
 */

import { describe, expect, it, vi } from "vitest";

import { google } from "../index.js";
import type { GoogleModalityClient } from "../google-modalities.js";

function fakeClient() {
  const generateImages = vi.fn(async () => ({
    generatedImages: [
      { image: { imageBytes: "AAA=", mimeType: "image/png" }, enhancedPrompt: "a vivid red door" },
    ],
  }));
  const generateContent = vi.fn(async () => ({
    candidates: [
      {
        content: {
          parts: [{ text: "here" }, { inlineData: { data: "BBB=", mimeType: "image/png" } }],
        },
      },
    ],
  }));
  const embedContent = vi.fn(async ({ contents }: { contents: unknown[] }) => ({
    embeddings: contents.map((_, i) => ({ values: [i, 1] })),
  }));
  const client = {
    models: { generateImages, generateContent, embedContent },
  } as unknown as GoogleModalityClient;
  return { client, generateImages, generateContent, embedContent };
}

describe("google.images", () => {
  it("a prompt-only call is Imagen generateImages, bytes projected to GeneratedImage + image blocks", async () => {
    const { client, generateImages } = fakeClient();
    const adapter = google.images("imagen-4.0-generate-001", { client });

    const result = await adapter.generate({ prompt: "a red door", aspectRatio: "16:9", count: 1 });

    expect(generateImages).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "imagen-4.0-generate-001",
        prompt: "a red door",
        config: expect.objectContaining({
          numberOfImages: 1,
          aspectRatio: "16:9",
          outputMimeType: "image/png",
        }),
      }),
    );
    expect(result.images).toEqual([
      { data: "AAA=", mimeType: "image/png", enhancedPrompt: "a vivid red door" },
    ]);
    expect(result.output[0]).toMatchObject({
      type: "image",
      source: { type: "base64", data: "AAA=" },
    });
    expect(adapter.target).toMatchObject({ kind: "image-model", provider: "google" });
  });

  it("references route the call to the Gemini image model as an edit", async () => {
    const { client, generateImages, generateContent } = fakeClient();
    const adapter = google.images(undefined, { client });

    const result = await adapter.generate({
      prompt: "make the door blue",
      references: [{ type: "base64", data: "AAA=", mimeType: "image/png" }],
    });

    expect(generateImages).not.toHaveBeenCalled();
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-flash-image",
        config: expect.objectContaining({ responseModalities: ["IMAGE", "TEXT"] }),
      }),
    );
    expect(result.images).toEqual([{ data: "BBB=", mimeType: "image/png" }]);
  });
});

describe("google.embeddings", () => {
  it("gemini-embedding-2 takes one content per call: a batch fans out in parallel, vectors in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const embedContent = vi.fn(
      async ({ contents }: { contents: { parts: { text: string }[] }[] }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return { embeddings: contents.map((c) => ({ values: [Number(c.parts[0]!.text), 1] })) };
      },
    );
    const client = { models: { embedContent } } as unknown as GoogleModalityClient;
    const adapter = google.embeddings("gemini-embedding-2", { client, concurrency: 3 });

    const texts = Array.from({ length: 10 }, (_unused, i) => String(i));
    const result = await adapter.embed({ input: texts, dimensions: 2 });

    expect(embedContent).toHaveBeenCalledTimes(10);
    for (const call of embedContent.mock.calls) expect(call[0].contents).toHaveLength(1);
    expect(peak).toBe(3);
    expect(result.embeddings.map((v) => v[0])).toEqual(texts.map(Number));
  });

  it("other models keep the whole batch in one call", async () => {
    const { client, embedContent } = fakeClient();
    const adapter = google.embeddings("gemini-embedding-001", { client });
    await adapter.embed({ input: ["a", "b", "c"] });
    expect(embedContent).toHaveBeenCalledTimes(1);
  });

  it("maps dimensions + task onto embedContent and returns one vector per input", async () => {
    const { client, embedContent } = fakeClient();
    const adapter = google.embeddings("gemini-embedding-001", { client });

    const result = await adapter.embed({ input: ["x", "y"], dimensions: 2, task: "query" });

    expect(embedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-embedding-001",
        config: expect.objectContaining({ outputDimensionality: 2, taskType: "RETRIEVAL_QUERY" }),
      }),
    );
    expect(result.embeddings).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(result.dimensions).toBe(2);
    expect(adapter.target.kind).toBe("embedding-model");
  });
});
