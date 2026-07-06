/**
 * ADR 57 — the `openai()` adapter must project the wire-native modality
 * parts (`document`/`audio`) to OpenAI Chat Completions' native content
 * parts, carry a tree-declared `providerOptions` through to the request
 * body (#176 regression gate), and never dump a `generated_image`'s
 * base64 into a text token (CB token-bomb regression).
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, LanguageModelInput } from "@agentick/spec-next";

import { openai } from "../openai-adapter.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "openai",
  modelId: "gpt-4o-mini",
};

function userInput(parts: LanguageModelInput["messages"][number]["content"]): LanguageModelInput {
  return { messages: [{ role: "user", content: parts }] };
}

function userContent(params: unknown): unknown[] {
  const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
  const msg = messages.find((m) => m.role === "user");
  return Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
}

describe("openai() adapter — ADR 57 multimodal projection", () => {
  const adapter = openai("gpt-4o-mini");

  it("projects a document (base64) to a `file` part — v1 parity (openai.ts:565)", () => {
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
    const parts = userContent(params);
    expect(parts).toContainEqual({
      type: "file",
      file: {
        filename: "document.pdf",
        file_data: "data:application/pdf;base64,JVBERi0=",
      },
    });
  });

  it("projects a document (Files API reference) to a `file` part by file_id", () => {
    const params = adapter.buildParams(
      userInput([{ type: "document", source: { type: "reference", fileId: "file-123" } }]),
      target,
    );
    expect(userContent(params)).toContainEqual({ type: "file", file: { file_id: "file-123" } });
  });

  it("projects audio (base64) to an `input_audio` part", () => {
    const params = adapter.buildParams(
      userInput([
        { type: "audio", source: { type: "base64", data: "SUQz", mimeType: "audio/mpeg" } },
      ]),
      target,
    );
    expect(userContent(params)).toContainEqual({
      type: "input_audio",
      input_audio: { data: "SUQz", format: "mp3" },
    });
  });

  it("#176 — a request-level providerOptions.openai reaches the request body", () => {
    const params = adapter.buildParams(
      {
        messages: [],
        providerOptions: { openai: { seed: 7, store: true } },
      } as unknown as LanguageModelInput,
      target,
    );
    expect((params as { seed?: number }).seed).toBe(7);
    expect((params as { store?: boolean }).store).toBe(true);
  });

  it("#214 — target.modelId (per-tick <Model> override, ADR 56) wins over the construction-time default", () => {
    const params = adapter.buildParams(userInput([{ type: "text", text: "hi" }]), {
      ...target,
      modelId: "gpt-4o",
    });
    expect((params as { model: string }).model).toBe("gpt-4o");
  });

  it("#214 — falls back to the construction-time default when the target names no model", () => {
    const params = adapter.buildParams(userInput([{ type: "text", text: "hi" }]), {
      kind: "language-model",
      provider: "openai",
    } as ExecutionTarget);
    // adapter was constructed with openai("gpt-4o-mini").
    expect((params as { model: string }).model).toBe("gpt-4o-mini");
  });

  it("#217 — surfaces usage.completion_tokens_details.reasoning_tokens as reasoningTokens", () => {
    const raw = {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "done", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 40,
        total_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    };
    const result = adapter.normalize(raw as never);
    expect(result.usage?.reasoningTokens).toBe(32);
  });

  it("a generated_image is NOT a base64 text bomb — projects to image_url data URI", () => {
    const bigData = "A".repeat(2048);
    const params = adapter.buildParams(
      userInput([{ type: "image", imageUrl: `data:image/png;base64,${bigData}` }]),
      target,
    );
    const parts = userContent(params);
    // The canonical projection maps generated_image → image; at the wire
    // it is an image_url part, never a text part carrying raw base64.
    expect(parts).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${bigData}` },
    });
    for (const p of parts) {
      if ((p as { type?: string }).type === "text") {
        expect((p as { text: string }).text).not.toContain(bigData);
      }
    }
  });
});
