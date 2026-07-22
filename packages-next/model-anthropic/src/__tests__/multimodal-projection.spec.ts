/**
 * ADR 57 — the `anthropic()` adapter must project a `document` to
 * Anthropic's native document block (port of anthropic.ts:537), carry a
 * tree-declared `providerOptions` into the request (#176 regression
 * gate), and round-trip an extended-thinking block's `signature` through
 * `normalize` → re-projection → the wire (CB-BLOCKER-1: Anthropic
 * requires the signed block replayed verbatim next turn).
 */

import { describe, expect, it } from "vitest";

import type {
  ExecutionTarget,
  LanguageModelInput,
  LanguageModelMessagePart,
  ProjectInput,
  RenderedTree,
} from "@agentick/spec-next";
import { messagePartFromBlock } from "@agentick/model-next";

import { anthropic } from "../anthropic-adapter.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "anthropic",
  modelId: "claude-sonnet-4",
};

function userContent(params: unknown): unknown[] {
  const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
  const user = messages.find((m) => m.role === "user");
  return Array.isArray(user?.content) ? (user!.content as unknown[]) : [];
}

function assistantContent(params: unknown): unknown[] {
  const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
  const a = messages.find((m) => m.role === "assistant");
  return Array.isArray(a?.content) ? (a!.content as unknown[]) : [];
}

describe("anthropic() adapter — ADR 57 multimodal projection", () => {
  const adapter = anthropic("claude-sonnet-4");

  it("projects a document (base64) to a native document block — v1 parity (anthropic.ts:537)", () => {
    const params = adapter.prepareRequest({
      targetInput: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", data: "JVBERi0=", mimeType: "application/pdf" },
                mediaType: "application/pdf",
              },
            ],
          },
        ],
      },
      target,
    });
    expect(userContent(params)).toContainEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
    });
  });

  it("#176 — a request-level providerOptions.anthropic reaches the request body", () => {
    const params = adapter.prepareRequest({
      targetInput: {
        messages: [],
        providerOptions: { anthropic: { top_k: 5 } },
      } as unknown as LanguageModelInput,
      target,
    });
    expect((params as { top_k?: number }).top_k).toBe(5);
  });

  it("round-trips an extended-thinking block's signature: normalize → re-project → wire (CB-BLOCKER-1)", () => {
    // 1. normalize an Anthropic response carrying a signed thinking block.
    const raw = {
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning...", signature: "sig-round-trip" },
        { type: "text", text: "done" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = adapter.normalize(raw as never);
    const reasoning = result.output.find((b) => b.type === "reasoning") as {
      type: "reasoning";
      text: string;
      signature?: string;
    };
    // The signature must survive normalize (previously dropped).
    expect(reasoning.signature).toBe("sig-round-trip");

    // 2. re-project the canonical block → INPUT part (carries signature).
    const part = messagePartFromBlock(reasoning as never) as LanguageModelMessagePart;
    expect(part.type).toBe("reasoning");

    // 3. buildParams emits a `thinking` wire block replaying the signature.
    const params = adapter.prepareRequest({
      targetInput: { messages: [{ role: "assistant", content: [part] }] },
      target,
    });
    expect(assistantContent(params)).toContainEqual({
      type: "thinking",
      thinking: "reasoning...",
      signature: "sig-round-trip",
    });
  });

  it("#216 — stop_reason 'refusal' maps to content_filter (not a clean 'end')", () => {
    const raw = {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stop_reason: "refusal",
      usage: { input_tokens: 5, output_tokens: 0 },
    };
    expect(adapter.normalize(raw as never).stopReason).toBe("content_filter");
  });

  it("#216 — stop_reason 'pause_turn' maps to 'other' (not masked as 'end')", () => {
    const raw = {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stop_reason: "pause_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    expect(adapter.normalize(raw as never).stopReason).toBe("other");
  });

  it("#211 — a config-declared topP/stopSequences reaches the wire params via project → buildParams", () => {
    // The canonical SpecConfig → LanguageModelParameters lift now carries
    // these; Anthropic reuses `buildParameters` in its projection override,
    // so the previously-dead adapter read (top_p / stop_sequences) is live.
    const compiled: RenderedTree = {
      specVersion: "test",
      context: {
        entries: [
          { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
      config: { topP: 0.8, stopSequences: ["STOP"], maxOutputTokens: 64 },
    } as RenderedTree;
    // `project` is optional on the adapter surface; Anthropic overrides it
    // (the per-section cache_control preservation), so it is present here.
    if (!adapter.project) throw new Error("expected anthropic() to override project");
    const projected = adapter.project({ compiled, target, tools: [] } as ProjectInput);
    const params = adapter.prepareRequest({ targetInput: projected, target });
    expect((params as { top_p?: number }).top_p).toBe(0.8);
    expect((params as { stop_sequences?: string[] }).stop_sequences).toEqual(["STOP"]);
  });

  it("round-trips redacted_thinking opaque data through normalize → wire", () => {
    const raw = {
      type: "message",
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "opaque-blob" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const result = adapter.normalize(raw as never);
    const reasoning = result.output.find((b) => b.type === "reasoning") as {
      type: "reasoning";
      providerMetadata?: { anthropic?: { redactedData?: string } };
    };
    expect(reasoning.providerMetadata?.anthropic?.redactedData).toBe("opaque-blob");

    const part = messagePartFromBlock(reasoning as never) as LanguageModelMessagePart;
    const params = adapter.prepareRequest({
      targetInput: { messages: [{ role: "assistant", content: [part] }] },
      target,
    });
    expect(assistantContent(params)).toContainEqual({
      type: "redacted_thinking",
      data: "opaque-blob",
    });
  });
});
