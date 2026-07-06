/**
 * ADR 57 — the `google()` adapter must project the wire-native modality
 * parts (`document`/`audio`/`video`) to Gemini's `inlineData`/`fileData`
 * parts (port of google.ts:454), carry a tree-declared `providerOptions`
 * through to the request config (#176 regression gate), and round-trip a
 * replayed `thoughtSignature` from the INPUT part's `providerOptions`.
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, LanguageModelInput } from "@agentick/spec-next";

import { google } from "../google-adapter.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "google",
  modelId: "gemini-2.0-flash",
};

function userInput(parts: LanguageModelInput["messages"][number]["content"]): LanguageModelInput {
  return { messages: [{ role: "user", content: parts }] };
}

function firstUserParts(params: unknown): unknown[] {
  const contents = (params as { contents?: Array<{ role: string; parts: unknown[] }> }).contents;
  return contents?.find((c) => c.role === "user")?.parts ?? [];
}

describe("google() adapter — ADR 57 multimodal projection", () => {
  const adapter = google("gemini-2.0-flash");

  it("projects a document (base64) to an inlineData part — v1 parity (google.ts:454)", () => {
    const params = adapter.buildParams(
      userInput([
        {
          type: "document",
          source: { type: "base64", data: "JVBERi0=", mimeType: "application/pdf" },
          mediaType: "application/pdf",
        },
      ]),
      target,
    );
    expect(firstUserParts(params)).toContainEqual({
      inlineData: { mimeType: "application/pdf", data: "JVBERi0=" },
    });
  });

  it("projects a document (url) to a fileData part", () => {
    const params = adapter.buildParams(
      userInput([
        {
          type: "document",
          source: { type: "url", url: "https://x/doc.pdf", mimeType: "application/pdf" },
        },
      ]),
      target,
    );
    expect(firstUserParts(params)).toContainEqual({
      fileData: { mimeType: "application/pdf", fileUri: "https://x/doc.pdf" },
    });
  });

  it("projects audio + video to inline/file parts", () => {
    const audio = adapter.buildParams(
      userInput([
        { type: "audio", source: { type: "base64", data: "SUQz", mimeType: "audio/mpeg" } },
      ]),
      target,
    );
    expect(firstUserParts(audio)).toContainEqual({
      inlineData: { mimeType: "audio/mpeg", data: "SUQz" },
    });
    const video = adapter.buildParams(
      userInput([
        {
          type: "video",
          source: { type: "gcs", bucket: "b", object: "clip.mp4", mimeType: "video/mp4" },
        },
      ]),
      target,
    );
    expect(firstUserParts(video)).toContainEqual({
      fileData: { mimeType: "video/mp4", fileUri: "gs://b/clip.mp4" },
    });
  });

  it("round-trips thoughtSignature from the INPUT part's providerOptions.google", () => {
    const params = adapter.buildParams(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "lookup",
                input: { q: "x" },
                providerOptions: { google: { thoughtSignature: "sig-xyz" } },
              },
            ],
          },
        ],
      } as unknown as LanguageModelInput,
      target,
    );
    const contents = (params as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
    const parts = contents.find((c) => c.role === "model")?.parts ?? [];
    const fnCall = parts.find((p) => (p as { functionCall?: unknown }).functionCall) as {
      thoughtSignature?: string;
    };
    expect(fnCall.thoughtSignature).toBe("sig-xyz");
  });

  it("#176 — a request-level providerOptions.google reaches the config", () => {
    const params = adapter.buildParams(
      {
        messages: [],
        providerOptions: { google: { seed: 11 } },
      } as unknown as LanguageModelInput,
      target,
    );
    expect((params as { config?: { seed?: number } }).config?.seed).toBe(11);
  });

  it("#212 — a canonical CacheHint is a deliberate NO-OP: hinted text still projects, no `cachedContent` synthesized", () => {
    // Gemini caching is implicit (automatic prefix, no translation) or
    // explicit (requires a pre-created CachedContent RESOURCE NAME the
    // hint cannot supply). So the inline hint must NOT crash and must NOT
    // fabricate a `cachedContent` — the system text still folds through.
    const params = adapter.buildParams(
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "STABLE PREFIX", cache: { ttl: "1h" } }],
            cache: { ttl: "1h" },
          },
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      } as unknown as LanguageModelInput,
      target,
    );
    const config = (params as { config?: { systemInstruction?: unknown; cachedContent?: unknown } })
      .config;
    // The hint text survives into systemInstruction…
    expect(JSON.stringify(config?.systemInstruction)).toContain("STABLE PREFIX");
    // …but no cachedContent is fabricated from the hint.
    expect(config?.cachedContent).toBeUndefined();
  });

  it("#212 — explicit caching is reachable via the providerOptions.google.cachedContent escape hatch", () => {
    const params = adapter.buildParams(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        providerOptions: { google: { cachedContent: "cachedContents/abc123" } },
      } as unknown as LanguageModelInput,
      target,
    );
    expect((params as { config?: { cachedContent?: string } }).config?.cachedContent).toBe(
      "cachedContents/abc123",
    );
  });
});
