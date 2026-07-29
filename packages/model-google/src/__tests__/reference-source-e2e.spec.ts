import { describe, expect, it } from "vitest";
import type { ContentBlock, ExecutionTarget, LanguageModelInput } from "@agentick/spec";
import { messagePartFromBlock } from "@agentick/model";
import { google } from "../index.js";

const REF: ContentBlock = {
  type: "image",
  source: { type: "reference", fileId: "019faa2c-5506-7000-b8ea-3c63628e4c89" },
  mimeType: "image/png",
} as ContentBlock;

const GCS: ContentBlock = {
  type: "image",
  source: { type: "url", url: "gs://knowify-media/llm/x.webp", mimeType: "image/webp" },
} as ContentBlock;

const target = {
  kind: "language-model",
  provider: "google",
  modelId: "gemini-2.5-flash",
  capabilities: {},
} as ExecutionTarget;
const req = (block: ContentBlock) => {
  const adapter = google("gemini-2.5-flash", { client: {} as never });
  return adapter.prepareRequest!({
    target,
    targetInput: {
      messages: [{ role: "user", content: [messagePartFromBlock(block)] }],
    } as LanguageModelInput,
  } as never) as { contents: Array<{ parts: unknown[] }> };
};

describe("reference sources reach the adapter intact", () => {
  it("the canonical part carries the SOURCE, not a flattened id", () => {
    const part = messagePartFromBlock(REF);
    expect(part.type).toBe("image");
    if (part.type !== "image") return;
    expect(part.source).toEqual({
      type: "reference",
      fileId: "019faa2c-5506-7000-b8ea-3c63628e4c89",
    });
  });

  it("Google DECLINES it rather than emitting an invalid fileUri", () => {
    // The whole request, stringified: the adopter's file id must appear NOWHERE. This
    // is the assertion that would have caught the original bug, which sent it as
    // `fileData: { fileUri: "019faa2c-…" }` and drew a deterministic 400 from Vertex.
    const request = req(REF);
    expect(JSON.stringify(request)).not.toContain("019faa2c");
    // A message whose ONLY part was declined carries nothing, so it is dropped rather
    // than sent empty. Text in the same message still survives — see below.
    expect(request.contents.length).toBe(0);
  });

  it("declining the image does NOT take the user's text with it", () => {
    // The realistic shape: "what is that?" plus an attachment. Losing the question
    // along with the unprojectable image would be a far worse failure than losing the
    // image — the model would answer a message it never received.
    const adapter = google("gemini-2.5-flash", { client: {} as never });
    const request = adapter.prepareRequest!({
      target,
      targetInput: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "what is that?" }, messagePartFromBlock(REF)],
          },
        ],
      } as LanguageModelInput,
    } as never) as { contents: Array<{ parts: Array<{ text?: string }> }> };

    expect(request.contents[0]!.parts).toEqual([{ text: "what is that?" }]);
    expect(JSON.stringify(request)).not.toContain("019faa2c");
  });

  it("a gcs source (what a resolver produces) becomes gs:// — zero bytes moved", () => {
    const parts = req(GCS).contents[0]!.parts as Array<{ fileData?: { fileUri: string } }>;
    expect(parts[0]!.fileData!.fileUri).toBe("gs://knowify-media/llm/x.webp");
  });
});
