/**
 * Canonical projection — `messagePartFromBlock` and friends drive how
 * a {@link ContentBlock} surfaces on the model-facing
 * {@link LanguageModelMessagePart} boundary. Provider adapters then
 * project this further, so the projections defined here are the
 * framework's load-bearing wire contracts.
 */

import { describe, expect, it } from "vitest";

import type {
  ContentBlock,
  ExecutionTarget,
  ProjectInput,
  RenderedTree,
  TaskRefBlock,
} from "@agentick/spec-next";

import {
  buildMessages,
  buildParameters,
  defaultProject,
  messagePartFromBlock,
} from "../canonical-projection.js";

describe("messagePartFromBlock — task_ref drop-in projection (#160)", () => {
  it("projects a task_ref block to a text part carrying the legacy `_kind: 'session_task_ref'` JSON shape", async () => {
    // Adopters that already parse the JSON-in-text envelope MUST keep
    // working with no changes. The first-class block-type discriminator
    // lives ABOVE this boundary; once we cross into
    // `LanguageModelMessagePart` territory (model wire), the projection
    // collapses to text-JSON so every provider adapter handles it
    // uniformly.
    const block: TaskRefBlock = {
      type: "task_ref",
      taskId: "task:abc",
      status: "working",
      statusMessage: "deploying",
      ttl: 60_000,
      pollInterval: 1_000,
    };
    const part = messagePartFromBlock(block);
    expect(part.type).toBe("text");
    if (part.type !== "text") return; // narrow for TS
    const parsed = JSON.parse(part.text) as {
      _kind: string;
      taskId: string;
      status: string;
      statusMessage?: string;
      ttl?: number;
      pollInterval?: number;
    };
    expect(parsed).toEqual({
      _kind: "session_task_ref",
      taskId: "task:abc",
      status: "working",
      statusMessage: "deploying",
      ttl: 60_000,
      pollInterval: 1_000,
    });
  });

  it("omits optional fields from the projected JSON when the block doesn't carry them", async () => {
    const block: TaskRefBlock = {
      type: "task_ref",
      taskId: "task:min",
      status: "pending",
    };
    const part = messagePartFromBlock(block);
    expect(part.type).toBe("text");
    if (part.type !== "text") return;
    const parsed = JSON.parse(part.text) as Record<string, unknown>;
    expect(parsed).toEqual({
      _kind: "session_task_ref",
      taskId: "task:min",
      status: "pending",
    });
    expect(Object.keys(parsed)).not.toContain("statusMessage");
    expect(Object.keys(parsed)).not.toContain("ttl");
    expect(Object.keys(parsed)).not.toContain("pollInterval");
  });

  it("projects the block's providerMetadata onto the INPUT part's providerOptions (ADR 57 §2)", async () => {
    // Round-trip data + adopter-stamped per-block knobs live on the
    // canonical block's `providerMetadata` (its only knob channel). On
    // the SEND path they must land on the part's `providerOptions` —
    // that is where every adapter now reads them (cacheControl,
    // thoughtSignature). The part's own `providerMetadata` is reserved
    // for what `normalize` writes back.
    const block: ContentBlock = {
      type: "task_ref",
      taskId: "task:meta",
      status: "working",
      providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    const part = messagePartFromBlock(block);
    expect((part as { providerOptions?: unknown }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});

describe("messagePartFromBlock — wire-native modalities (ADR 57)", () => {
  it("projects a document block to a document part carrying the MediaSource (no JSON.stringify bomb)", () => {
    const block: ContentBlock = {
      type: "document",
      source: { type: "base64", data: "JVBERi0=", mimeType: "application/pdf" },
      mimeType: "application/pdf",
    };
    const part = messagePartFromBlock(block);
    expect(part.type).toBe("document");
    if (part.type !== "document") return;
    expect(part.source).toEqual({
      type: "base64",
      data: "JVBERi0=",
      mimeType: "application/pdf",
    });
    expect(part.mediaType).toBe("application/pdf");
  });

  it("projects audio and video blocks to their native parts", () => {
    const audio = messagePartFromBlock({
      type: "audio",
      source: { type: "base64", data: "AAAA", mimeType: "audio/mpeg" },
    } as ContentBlock);
    expect(audio.type).toBe("audio");
    const video = messagePartFromBlock({
      type: "video",
      source: { type: "url", url: "https://x/y.mp4" },
    } as ContentBlock);
    expect(video.type).toBe("video");
  });

  it("projects a reasoning block to a reasoning part carrying the signature", () => {
    const part = messagePartFromBlock({
      type: "reasoning",
      text: "step by step",
      signature: "sig-abc",
    } as ContentBlock);
    expect(part.type).toBe("reasoning");
    if (part.type !== "reasoning") return;
    expect(part.text).toBe("step by step");
    expect(part.signature).toBe("sig-abc");
  });

  it("a generated_image reuses the image variant — NOT a JSON.stringify base64 text bomb (regression)", () => {
    // The old `default` case emitted `JSON.stringify(block)` — for a
    // generated_image that dumped the entire base64 payload into a text
    // token. It must now project to an image part (data URI).
    const bigData = "A".repeat(4096);
    const part = messagePartFromBlock({
      type: "generated_image",
      data: bigData,
      mimeType: "image/png",
    } as ContentBlock);
    expect(part.type).toBe("image");
    if (part.type !== "image") return;
    expect(part.imageUrl).toBe(`data:image/png;base64,${bigData}`);
    // Belt-and-suspenders: no text part anywhere carrying the raw base64.
    expect((part as { text?: string }).text).toBeUndefined();
  });
});

describe("messagePartFromBlock — resource projection (ADR 62)", () => {
  it("inlines a text resource's content as a text part (not the {type,resource} wrapper JSON)", () => {
    const part = messagePartFromBlock({
      type: "resource",
      resource: { uri: "config://app", mimeType: "application/json", text: '{"k":1}' },
    } as unknown as ContentBlock);
    expect(part.type).toBe("text");
    expect((part as { text: string }).text).toBe('{"k":1}');
    // Regression: NOT a JSON.stringify of the whole wrapper.
    expect((part as { text: string }).text).not.toContain('"type":"resource"');
  });

  it("surfaces a blob resource as a uri+mimeType descriptor (no binary text-dump)", () => {
    const part = messagePartFromBlock({
      type: "resource",
      resource: { uri: "file://x.png", mimeType: "image/png", blob: "QUFBQQ==" },
    } as unknown as ContentBlock);
    expect(part.type).toBe("text");
    const text = (part as { text: string }).text;
    expect(text).toContain("file://x.png");
    expect(text).toContain("image/png");
    expect(text).not.toContain("QUFBQQ=="); // blob is not dumped as text
  });
});

describe("defaultProject — #176 providerOptions fold", () => {
  const emptyTarget: ExecutionTarget = { kind: "language-model", modelId: "m" } as ExecutionTarget;

  function projectFor(
    tree: Partial<RenderedTree>,
    target: ExecutionTarget = emptyTarget,
  ): ReturnType<typeof defaultProject> {
    const compiled: RenderedTree = {
      specVersion: "test",
      context: { entries: [] },
      ...tree,
    } as RenderedTree;
    const input: ProjectInput = { compiled, target, tools: [] };
    return defaultProject(input);
  }

  it("folds tree.providerOptions over target.providerOptions (tree wins) onto input.providerOptions", () => {
    const target = {
      ...emptyTarget,
      providerOptions: { openai: { seed: 1, store: true }, anthropic: { thinking: "off" } },
    } as ExecutionTarget;
    const out = projectFor(
      { providerOptions: { openai: { seed: 42 } } as RenderedTree["providerOptions"] },
      target,
    );
    expect(out.providerOptions).toEqual({
      // tree's seed wins; target's store survives; anthropic untouched.
      openai: { seed: 42, store: true },
      anthropic: { thinking: "off" },
    });
  });

  it("omits providerOptions entirely when neither tree nor target declares any", () => {
    const out = projectFor({});
    expect(out.providerOptions).toBeUndefined();
  });
});

describe("defaultProject — Pass D providerTools projection", () => {
  const emptyTarget: ExecutionTarget = { kind: "language-model", modelId: "m" } as ExecutionTarget;

  function projectWith(
    providerTools: ProjectInput["providerTools"],
    tools: ProjectInput["tools"] = [],
  ): ReturnType<typeof defaultProject> {
    const compiled: RenderedTree = {
      specVersion: "test",
      context: { entries: [] },
    } as RenderedTree;
    const input: ProjectInput = { compiled, target: emptyTarget, tools, providerTools };
    return defaultProject(input);
  }

  it("projects providerTools onto LanguageModelInput.providerTools, resolving name ?? type", () => {
    const out = projectWith([
      { provider: "openai", type: "web_search_preview", config: { maxResults: 5 } },
      { provider: "anthropic", type: "web_search_20250305", name: "web_search" },
    ]);
    expect(out.providerTools).toEqual([
      {
        provider: "openai",
        type: "web_search_preview",
        name: "web_search_preview",
        config: { maxResults: 5 },
      },
      { provider: "anthropic", type: "web_search_20250305", name: "web_search" },
    ]);
  });

  it("dedupes by provider + resolved name, last-wins", () => {
    const out = projectWith([
      { provider: "openai", type: "web_search_preview", config: { maxResults: 5 } },
      // same provider + resolved name (name ?? type) → replaces the first
      { provider: "openai", type: "web_search_preview", config: { maxResults: 10 } },
      // same type but DIFFERENT provider → distinct key, survives
      { provider: "anthropic", type: "web_search_preview" },
    ]);
    expect(out.providerTools).toEqual([
      {
        provider: "openai",
        type: "web_search_preview",
        name: "web_search_preview",
        config: { maxResults: 10 },
      },
      { provider: "anthropic", type: "web_search_preview", name: "web_search_preview" },
    ]);
  });

  it("omits the slot entirely when providerTools is empty or absent", () => {
    expect(projectWith([]).providerTools).toBeUndefined();
    expect(projectWith(undefined).providerTools).toBeUndefined();
  });

  it("keeps provider tools OUT of the function tools list and never narrates them", () => {
    // A provider tool must not leak into `tools[]` (function tools) and
    // must never receive the injected `_summary` narration field — it
    // carries no schema and bypasses the executor.
    const out = projectWith(
      [{ provider: "openai", type: "code_interpreter" }],
      [], // no function tools
    );
    expect(out.tools).toBeUndefined(); // no function tools emitted
    expect(out.providerTools).toEqual([
      { provider: "openai", type: "code_interpreter", name: "code_interpreter" },
    ]);
    // The provider-tool wire shape carries no inputSchema / _summary.
    for (const pt of out.providerTools ?? []) {
      expect(pt).not.toHaveProperty("inputSchema");
      expect(JSON.stringify(pt)).not.toContain("_summary");
    }
  });
});

describe("buildParameters — SpecConfig generation params (#211)", () => {
  function paramsFor(config: RenderedTree["config"]) {
    const tree: RenderedTree = {
      specVersion: "test",
      context: { entries: [] },
      config,
    } as RenderedTree;
    return buildParameters(tree);
  }

  it("lifts topP/frequencyPenalty/presencePenalty/stopSequences off tree.config (previously unreachable — dead adapter reads)", () => {
    // Before #211 these lived on `LanguageModelParameters` and every
    // adapter read them, but `SpecConfig` never carried them, so
    // `input.parameters.topP` was ALWAYS undefined on the canonical path
    // (anthropic-executor.spec.ts:626 smoking gun). They must now land.
    const params = paramsFor({
      temperature: 0.5,
      maxOutputTokens: 128,
      topP: 0.9,
      frequencyPenalty: 0.25,
      presencePenalty: -0.1,
      stopSequences: ["STOP", "END"],
    });
    expect(params).toEqual({
      temperature: 0.5,
      maxOutputTokens: 128,
      topP: 0.9,
      frequencyPenalty: 0.25,
      presencePenalty: -0.1,
      stopSequences: ["STOP", "END"],
    });
  });

  it("omits the params object entirely when tree.config carries none of them", () => {
    expect(paramsFor({})).toBeUndefined();
  });

  it("lifts SpecConfig.toolChoice onto parameters.toolChoice — string forms", () => {
    expect(paramsFor({ toolChoice: "auto" })).toEqual({ toolChoice: "auto" });
    expect(paramsFor({ toolChoice: "none" })).toEqual({ toolChoice: "none" });
    expect(paramsFor({ toolChoice: "required" })).toEqual({ toolChoice: "required" });
  });

  it("lifts SpecConfig.toolChoice onto parameters.toolChoice — forced-tool form", () => {
    expect(paramsFor({ toolChoice: { tool: "submit_result" } })).toEqual({
      toolChoice: { tool: "submit_result" },
    });
  });
});

describe("buildMessages — message-level providerMetadata carry (#173)", () => {
  it("projects MessageEntry.metadata.providerMetadata onto the message's INPUT-channel providerOptions", () => {
    // Entry-level provider knobs were silently dropped at the executor
    // boundary — LanguageModelMessage had no slot. Now carried onto
    // `providerOptions` (send channel, ADR 57 §2), mirroring how a
    // block's `providerMetadata` projects onto a part's `providerOptions`.
    const messages = buildMessages({
      specVersion: "test",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            metadata: {
              providerMetadata: { openai: { reasoningEffort: "high" } },
            },
          },
        ],
      },
    } as RenderedTree);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
  });

  it("omits providerOptions when the entry carries no providerMetadata", () => {
    const messages = buildMessages({
      specVersion: "test",
      context: {
        entries: [
          { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
    } as RenderedTree);
    expect(messages[0]).not.toHaveProperty("providerOptions");
  });
});
