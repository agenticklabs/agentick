/**
 * ADR 57 — the `aisdk()` adapter must project the wire-native modality
 * parts (`document`/`audio`/`video`) to AI SDK 5 `file` content parts,
 * and carry a tree-declared `providerOptions` into the projected input
 * (#176 regression gate).
 */

import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";

import type { ExecutionTarget, LanguageModelInput } from "@agentick/spec-next";

import { aisdk } from "../ai-sdk-adapter.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock-aisdk",
  modelId: "mock-1",
};

function mkAdapter() {
  return aisdk(new MockLanguageModelV2({ modelId: "mock-1" }));
}

function userContent(params: ReturnType<ReturnType<typeof aisdk>["prepareRequest"]>): unknown[] {
  const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
  const user = messages.find((m) => m.role === "user");
  return Array.isArray(user?.content) ? (user!.content as unknown[]) : [];
}

describe("aisdk() adapter — ADR 57 multimodal projection", () => {
  it("projects document / audio / video to AI SDK `file` parts", () => {
    const adapter = mkAdapter();
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
              {
                type: "audio",
                source: { type: "url", url: "https://x/a.mp3" },
                mediaType: "audio/mpeg",
              },
            ],
          },
        ],
      },
      target,
    });
    const parts = userContent(params);
    expect(parts).toContainEqual({
      type: "file",
      data: "JVBERi0=",
      mediaType: "application/pdf",
    });
    expect(parts).toContainEqual({
      type: "file",
      data: "https://x/a.mp3",
      mediaType: "audio/mpeg",
    });
  });

  it("#176 — a request-level providerOptions reaches the projected input", () => {
    const adapter = mkAdapter();
    const params = adapter.prepareRequest({
      targetInput: {
        messages: [],
        providerOptions: { openai: { reasoningEffort: "high" } },
      } as unknown as LanguageModelInput,
      target,
    });
    expect((params as { providerOptions?: unknown }).providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("#173 — message-level providerOptions carries onto the projected ModelMessage (AI SDK 1:1)", () => {
    const adapter = mkAdapter();
    const params = adapter.prepareRequest({
      targetInput: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        ],
      } as unknown as LanguageModelInput,
      target,
    });
    const messages = (params as { messages: Array<{ role: string; providerOptions?: unknown }> })
      .messages;
    const user = messages.find((m) => m.role === "user");
    expect(user?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });
});

describe("aisdk() adapter — canonical toolChoice", () => {
  const build = (toolChoice: "auto" | "none" | "required" | { readonly tool: string }) => {
    const params = mkAdapter().prepareRequest({
      targetInput: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        parameters: { toolChoice },
      } as LanguageModelInput,
      target,
    });
    return (params as { generation: Record<string, unknown> }).generation.toolChoice;
  };

  it("translates all four canonical values to AI SDK toolChoice", () => {
    expect(build("auto")).toBe("auto");
    expect(build("none")).toBe("none");
    expect(build("required")).toBe("required");
    expect(build({ tool: "calc" })).toEqual({ type: "tool", toolName: "calc" });
  });

  it("provider escape hatch coexists — providerOptions rides its own field, toolChoice survives", () => {
    // AI SDK exposes `toolChoice` as its OWN canonical call field (not a
    // provider-namespaced knob), and `providerOptions` is a separate call
    // field — the two never collide, so a provider bag rides alongside
    // without clobbering the canonical toolChoice.
    const params = mkAdapter().prepareRequest({
      targetInput: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        parameters: { toolChoice: "required" },
        providerOptions: { openai: { reasoningEffort: "high" } },
      } as LanguageModelInput,
      target,
    });
    expect((params as { generation: Record<string, unknown> }).generation.toolChoice).toBe(
      "required",
    );
    expect((params as { providerOptions?: unknown }).providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });
});
