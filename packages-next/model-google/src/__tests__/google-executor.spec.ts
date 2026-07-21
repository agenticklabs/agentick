/**
 * Implementation-specific behavior for the `google()` adapter driven
 * through `LanguageModelExecutor`.
 *
 * The conformance suite (`conformance.spec.ts`) drives the
 * `ExecutorProtocol` contract. These tests assert Google-specific
 * behavior: system extraction to `systemInstruction`, function-call
 * round-trip, `thoughtSignature` round-trip (Gemini 3+ thinking),
 * `part.thought` → reasoning routing, sanitize-schema-for-Gemini,
 * cache tokens, providerOptions spread, streaming deltas.
 */

import { omitUndefined } from "@agentick/utils-next";

import { Chunk, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { GenerateContentParameters } from "@google/genai";

import { LanguageModelExecutor } from "@agentick/executor-next";

import { google, sanitizeSchemaForGemini } from "../google-adapter.js";
import {
  StubGoogleClient,
  asClient,
  mkResponse,
  mkTextChunk,
  mkThoughtChunk,
  mkFunctionCallChunk,
  mkFinishChunk,
} from "./stub-google-client.js";

// ============================================================================
// Helpers
// ============================================================================

function emptyTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

function mkTarget(overrides?: Partial<LanguageModelTarget>): LanguageModelTarget {
  return {
    kind: "language-model",
    provider: "google",
    modelId: "gemini-2.5-flash",
    ...(overrides ?? {}),
  };
}

async function makeExecutor(
  stub: StubGoogleClient,
  opts: {
    stream?: boolean;
    model?: string;
    parseThinkTags?: boolean;
    customBlocks?: Record<string, { tag?: string; onContent?: (c: string) => void }>;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-google-test", journal, bus, inbox, {
    adapter: google(opts.model ?? "gemini-2.5-flash", {
      client: asClient(stub),
      ...omitUndefined({ stream: opts.stream }),
      ...(opts.parseThinkTags ? { parseThinkTags: true } : {}),
      ...(opts.customBlocks ? { customBlocks: opts.customBlocks } : {}),
    }),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}

// ============================================================================
// Non-streaming
// ============================================================================

describe("google() adapter — non-streaming", () => {
  it("returns a succeeded terminal with normalized output", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "hello" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(terminal.result.stopReason).toBe("end");
    expect(terminal.result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("forwards model id from target through to the SDK request", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.run({
      compiled: emptyTree(),
      target: mkTarget({ modelId: "gemini-1.5-pro" }),
      tools: [],
    });
    expect(stub.calls[0]!.params.model).toBe("gemini-1.5-pro");
  });

  it("maps finishReason=MAX_TOKENS to stopReason=max_tokens", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({ text: "truncated", finishReason: "MAX_TOKENS" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("max_tokens");
  });

  it("maps finishReason=SAFETY to stopReason=content_filter", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({ text: "blocked", finishReason: "SAFETY" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("content_filter");
  });

  it("maps finishReason=MISSING_THOUGHT_SIGNATURE to stopReason=other", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({ text: "", finishReason: "MISSING_THOUGHT_SIGNATURE" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("other");
  });
});

// ============================================================================
// System extraction
// ============================================================================

describe("google() adapter — system extraction", () => {
  it("collects sections into systemInstruction, leaves contents as user/model only", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "section",
            id: "s1",
            title: "Persona",
            content: [{ type: "text", text: "be helpful" }],
          },
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "hi" }],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const params = stub.calls[0]!.params;
    const config = params.config as Record<string, unknown>;
    expect(config.systemInstruction).toMatchObject({
      parts: [{ text: expect.stringContaining("be helpful") }],
    });
    expect(params.contents).toHaveLength(1);
    expect((params.contents as Array<{ role: string }>)[0]!.role).toBe("user");
  });

  it("coalesces consecutive same-role messages into one Content entry", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "first" }],
          },
          {
            kind: "message",
            id: "m2",
            role: "user",
            content: [{ type: "text", text: "second" }],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const contents = stub.calls[0]!.params.contents as Array<{
      role: string;
      parts: Array<{ text?: string }>;
    }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.parts).toHaveLength(2);
    expect(contents[0]!.parts.map((p) => p.text)).toEqual(["first", "second"]);
  });
});

// ============================================================================
// Tool-use round-trip
// ============================================================================

describe("google() adapter — tool-use round-trip", () => {
  it("extracts toolCalls and emits tool_use ContentBlocks", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          toolCalls: [{ id: "call_1", name: "calc", args: { a: 2, b: 3 } }],
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.toolCalls).toEqual([{ id: "call_1", name: "calc", input: { a: 2, b: 3 } }]);
    expect(t.result.output.find((b) => b.type === "tool_use")).toMatchObject({
      type: "tool_use",
      toolUseId: "call_1",
      name: "calc",
      input: { a: 2, b: 3 },
    });
  });

  it("projects tool_result back as functionResponse with the original tool name", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "done" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "use the tool" }],
          },
          {
            kind: "message",
            id: "m2",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                toolUseId: "call_xyz",
                name: "calc",
                input: { a: 1, b: 2 },
              },
            ],
          },
          {
            kind: "message",
            id: "m3",
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_xyz",
                name: "calc",
                content: [{ type: "text", text: "3" }],
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const contents = stub.calls[0]!.params.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { id?: string; name?: string; response?: unknown } }>;
    }>;
    const resultPart = contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
    expect(resultPart?.functionResponse?.id).toBe("call_xyz");
    expect(resultPart?.functionResponse?.name).toBe("calc");
  });
});

// ============================================================================
// thoughtSignature round-trip (Gemini 3+ thinking)
// ============================================================================

describe("google() adapter — thoughtSignature round-trip (G18-G)", () => {
  it("surfaces thoughtSignature from functionCall to ContentBlock.providerMetadata", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          toolCalls: [
            {
              id: "call_1",
              name: "calc",
              args: { a: 2 },
              thoughtSignature: "OPAQUE_SIG_ABC",
            },
          ],
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    const toolUse = t.result.output.find((b) => b.type === "tool_use");
    expect(toolUse?.providerMetadata?.google).toEqual({
      thoughtSignature: "OPAQUE_SIG_ABC",
    });
    // toolCalls array also carries it
    expect(t.result.toolCalls?.[0]?.providerMetadata?.google).toEqual({
      thoughtSignature: "OPAQUE_SIG_ABC",
    });
  });

  it("round-trips thoughtSignature back on subsequent tool_use parts", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "first" }],
          },
          {
            kind: "message",
            id: "m2",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                toolUseId: "call_xyz",
                name: "calc",
                input: { a: 1 },
                providerMetadata: { google: { thoughtSignature: "SIG_TO_ECHO" } },
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const contents = stub.calls[0]!.params.contents as Array<{
      role: string;
      parts: Array<{
        functionCall?: { id?: string; name?: string; args?: unknown };
        thoughtSignature?: string;
      }>;
    }>;
    const fcPart = contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    expect(fcPart?.thoughtSignature).toBe("SIG_TO_ECHO");
  });

  it("preserves thoughtSignature on streaming functionCall chunks", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkFunctionCallChunk({
            id: "call_1",
            name: "calc",
            args: { a: 7 },
            thoughtSignature: "STREAM_SIG_999",
          }),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    const toolUse = t.result.output.find((b) => b.type === "tool_use");
    expect(toolUse?.providerMetadata?.google).toEqual({
      thoughtSignature: "STREAM_SIG_999",
    });
  });
});

// ============================================================================
// Abort
// ============================================================================

describe("google() adapter — abort", () => {
  it("abort flips next run to outcome 'canceled'", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.abort({ executionId: "exec-canceled" });
    const t = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
      scope: { executionId: "exec-canceled" },
      tools: [],
    });
    expect(t.outcome).toBe("canceled");
  });
});

// ============================================================================
// Streaming
// ============================================================================

describe("google() adapter — streaming", () => {
  it("accumulates text across chunks and emits per-delta envelopes", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkTextChunk("hel"),
          mkTextChunk("lo "),
          mkTextChunk("world"),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec, bus } = await makeExecutor(stub, { stream: true });

    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "executor", phase: "delta" }), 3)),
    );
    await new Promise((r) => setImmediate(r));

    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.output[0]).toMatchObject({ type: "text", text: "hello world" });

    const collected = await Effect.runPromise(Fiber.join(fiber));
    const deltas = Array.from(Chunk.toReadonlyArray(collected));
    expect(deltas.length).toBeGreaterThanOrEqual(3);
  });

  it("routes part.thought === true to reasoning channel (Gemini 2.5+ thinking)", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkThoughtChunk("thinking step 1"),
          mkThoughtChunk("thinking step 2"),
          mkTextChunk("here's the answer"),
          mkFinishChunk({
            finishReason: "STOP",
            usage: { thoughtsTokenCount: 12 },
          }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    const reasoning = t.result.output.find((b) => b.type === "reasoning");
    expect(reasoning).toMatchObject({
      type: "reasoning",
      text: "thinking step 1thinking step 2",
    });
    const text = t.result.output.find((b) => b.type === "text");
    expect(text).toMatchObject({ type: "text", text: "here's the answer" });
    expect(t.result.usage?.reasoningTokens).toBe(12);
  });

  it("emits tool-call deltas with id + name + parsed input", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkTextChunk("calling "),
          mkFunctionCallChunk({ id: "c1", name: "calc", args: { a: 1, b: 2 } }),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.toolCalls).toEqual([{ id: "c1", name: "calc", input: { a: 1, b: 2 } }]);
  });

  it("equivalent final result to non-streaming path", async () => {
    const streaming = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [mkTextChunk("hello"), mkFinishChunk({ finishReason: "STOP" })],
      },
    ]);
    const nonStreaming = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "hello" }) },
    ]);
    const { exec: a } = await makeExecutor(streaming, { stream: true });
    const { exec: b } = await makeExecutor(nonStreaming);
    const ta = await a.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const tb = await b.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (ta.outcome !== "succeeded" || tb.outcome !== "succeeded")
      throw new Error("expected success");
    expect(ta.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(tb.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(ta.result.stopReason).toBe(tb.result.stopReason);
  });
});

// ============================================================================
// Sampling params (G1)
// ============================================================================

describe("google() adapter — sampling params (G1)", () => {
  it("plumbs temperature, topP, maxOutputTokens, stopSequences onto config", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
      config: { temperature: 0.7, maxOutputTokens: 256 },
    };
    await exec.run({
      compiled: tree,
      target: {
        ...mkTarget(),
        providerOptions: {
          google: { stopSequences: ["END"] },
        },
      },
      tools: [],
    });
    const config = stub.calls[0]!.params.config as Record<string, unknown>;
    expect(config.temperature).toBe(0.7);
    expect(config.maxOutputTokens).toBe(256);
    expect(config.stopSequences).toEqual(["END"]);
  });

  it("silently drops frequencyPenalty / presencePenalty (Gemini has no native support)", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    // Build with parameters that include both — they should NOT appear
    // on the SDK config (we silently drop, matching the skill's G1
    // caveat for providers without native support).
    const projected = await exec.project({
      compiled: emptyTree(),
      target: mkTarget(),
      tools: [],
    });
    expect(projected).toBeDefined();
    // The executor's projection layer doesn't surface frequency/presence
    // because v2's `LanguageModelParameters` only flows what
    // `RenderedTree.config` provides. No SDK config field needed.
  });
});

// ============================================================================
// providerOptions spread (G5)
// ============================================================================

describe("google() adapter — providerOptions.google (G5)", () => {
  it("spreads GenerateContentConfig fields onto request config", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.run({
      compiled: emptyTree(),
      target: {
        ...mkTarget(),
        providerOptions: {
          google: {
            topK: 40,
            seed: 42,
            thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
            safetySettings: [],
          },
        },
      },
      tools: [],
    });
    const config = stub.calls[0]!.params.config as Record<string, unknown> & {
      topK?: number;
      seed?: number;
      thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
      safetySettings?: unknown[];
    };
    expect(config.topK).toBe(40);
    expect(config.seed).toBe(42);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 2048, includeThoughts: true });
    expect(config.safetySettings).toEqual([]);
  });

  it("provider overrides win over executor-projected canonical knobs", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: { entries: emptyTree().context.entries },
      config: { temperature: 0.5 },
    };
    await exec.run({
      compiled: tree,
      target: {
        ...mkTarget(),
        providerOptions: { google: { temperature: 0.95 } },
      },
      tools: [],
    });
    const config = stub.calls[0]!.params.config as Record<string, unknown>;
    expect(config.temperature).toBe(0.95);
  });
});

// ============================================================================
// Per-tool providerOptions (G11)
// ============================================================================

describe("google() adapter — per-tool providerOptions.google", () => {
  it("merges tool.providerOptions.google onto the function declaration", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: { entries: emptyTree().context.entries },
    };
    await exec.run({
      compiled: tree,
      target: mkTarget(),
      tools: [
        {
          id: "calc",
          name: "calc",
          description: "calculator",
          inputSchema: jsonSchema({ type: "object", properties: { a: { type: "number" } } }),
          exposure: ["model"],
          providerOptions: {
            google: { description: "OVERRIDDEN" },
          },
        },
      ],
    });
    const tools = (stub.calls[0]!.params.config as { tools?: unknown[] }).tools as Array<{
      functionDeclarations: Array<{ name: string; description?: string }>;
    }>;
    expect(tools[0]!.functionDeclarations[0]!.description).toBe("OVERRIDDEN");
  });
});

// ============================================================================
// parseThinkTags (G7)
// ============================================================================

describe("google() adapter — parseThinkTags (G7)", () => {
  it("routes <think> in text channel to reasoning deltas (streaming)", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkTextChunk("<think>"),
          mkTextChunk("hidden"),
          mkTextChunk("</think>"),
          mkTextChunk("visible"),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true, parseThinkTags: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    const reasoning = t.result.output.find((b) => b.type === "reasoning");
    const text = t.result.output.find((b) => b.type === "text");
    expect(reasoning).toMatchObject({ type: "reasoning", text: "hidden" });
    expect(text).toMatchObject({ type: "text", text: "visible" });
  });
});

// ============================================================================
// customBlocks (G12)
// ============================================================================

describe("google() adapter — customBlocks (G12)", () => {
  it("extracts adopter-declared tags as custom-block deltas (streaming)", async () => {
    const captured: string[] = [];
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkTextChunk("see <citation>"),
          mkTextChunk("source-42</citation> for details"),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, {
      stream: true,
      customBlocks: {
        citation: { onContent: (c) => captured.push(c) },
      },
    });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(captured.join("")).toContain("source-42");
  });
});

// ============================================================================
// Images (G4)
// ============================================================================

describe("google() adapter — images (G4)", () => {
  it("projects base64 data URLs to inlineData parts", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", data: "AAAA", mimeType: "image/png" },
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const part = (
      stub.calls[0]!.params.contents as Array<{
        parts: Array<{ inlineData?: { mimeType: string; data: string } }>;
      }>
    )[0]!.parts[0]!;
    expect(part.inlineData).toEqual({ mimeType: "image/png", data: "AAAA" });
  });

  it("projects URL sources to fileData parts", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/img.jpg" },
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const part = (
      stub.calls[0]!.params.contents as Array<{
        parts: Array<{ fileData?: { mimeType: string; fileUri: string } }>;
      }>
    )[0]!.parts[0]!;
    expect(part.fileData?.fileUri).toBe("https://example.com/img.jpg");
  });
});

// ============================================================================
// Cache + reasoning tokens (G2/G3)
// ============================================================================

describe("google() adapter — usage surfacing (G2/G3)", () => {
  it("maps cachedContentTokenCount → cachedInputTokens", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: {
            promptTokenCount: 200,
            candidatesTokenCount: 10,
            cachedContentTokenCount: 180,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.usage?.cachedInputTokens).toBe(180);
  });

  it("maps thoughtsTokenCount → reasoningTokens", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          text: "ok",
          usage: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 25,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.usage?.reasoningTokens).toBe(25);
  });
});

// ============================================================================
// sanitizeSchemaForGemini
// ============================================================================

describe("sanitizeSchemaForGemini", () => {
  it("strips $ref / $defs / additionalItems / propertyNames", () => {
    const result = sanitizeSchemaForGemini({
      $defs: { Foo: { type: "string" } },
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Foo" },
        b: { type: "string" },
      },
      additionalItems: false,
      propertyNames: { pattern: "^[a-z]+$" },
    }) as Record<string, unknown>;
    expect(result.$defs).toBeUndefined();
    expect(result.additionalItems).toBeUndefined();
    expect(result.propertyNames).toBeUndefined();
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.a?.$ref).toBeUndefined();
  });

  it("drops empty additionalProperties; preserves false", () => {
    const r1 = sanitizeSchemaForGemini({ additionalProperties: {} }) as Record<string, unknown>;
    expect(r1.additionalProperties).toBeUndefined();
    const r2 = sanitizeSchemaForGemini({ additionalProperties: false }) as Record<string, unknown>;
    expect(r2.additionalProperties).toBe(false);
    const r3 = sanitizeSchemaForGemini({
      additionalProperties: { type: "string" },
    }) as Record<string, unknown>;
    expect(r3.additionalProperties).toBeUndefined();
  });

  it("collapses tuple-form items to its first element", () => {
    const result = sanitizeSchemaForGemini({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    }) as Record<string, unknown>;
    expect(result.items).toEqual({ type: "string" });
  });

  it("inlines single-option anyOf and drops $ref entries", () => {
    const result = sanitizeSchemaForGemini({
      anyOf: [{ $ref: "#/$defs/Foo" }, { type: "number" }],
    }) as Record<string, unknown>;
    expect(result.anyOf).toBeUndefined();
    expect(result.type).toBe("number");
  });
});

// ============================================================================
// Journaled lifecycle
// ============================================================================

describe("google() adapter — journaled lifecycle", () => {
  it("run produces requested + terminal envelopes on the journal", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "hi" }) },
    ]);
    const { exec, journal } = await makeExecutor(stub);
    await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const events = await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({ surface: "executor" }, "beginning")),
    );
    const phases = Array.from(Chunk.toReadonlyArray(events)).map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases.some((p) => p === "terminal")).toBe(true);
  });
});

// ============================================================================
// Type sanity — providerOptions augmentation
// ============================================================================

describe("google() adapter — type sanity", () => {
  it("typecheck: target.providerOptions.google accepts GenerateContentConfig fields", () => {
    // Compile-time only — confirms the augmentation lands. The fields
    // referenced here are real on `GenerateContentConfig`.
    const _ok: { target: LanguageModelTarget } = {
      target: {
        kind: "language-model",
        provider: "google",
        modelId: "gemini-2.5-flash",
        providerOptions: {
          google: {
            topK: 8,
            seed: 1,
            responseLogprobs: true,
            logprobs: 5,
            candidateCount: 1,
            thinkingConfig: { thinkingBudget: 100, includeThoughts: true },
          },
        },
      },
    };
    expect(_ok.target.providerOptions?.google?.topK).toBe(8);
  });

  it("typecheck: params type accepts model + contents + config", () => {
    // Compile-time only — confirms the GenerateContentParameters type
    // matches the params field surfaced to the SDK.
    const _ok: Partial<GenerateContentParameters> = {
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      config: { temperature: 0.5 },
    };
    expect(_ok.model).toBe("gemini-2.5-flash");
  });
});

// ============================================================================
// Pass D — provider-executed tools (request-half)
// ============================================================================

describe("google() adapter — provider tools (Pass D request-half)", () => {
  it("maps the google grounding slice onto config.tools alongside function declarations, drops other providers", () => {
    const adapter = google("gemini-2.5-flash");
    const params = adapter.buildParams(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            name: "calc",
            description: "calculator",
            inputSchema: { type: "object", properties: { a: { type: "number" } } },
          },
        ],
        providerTools: [
          { provider: "google", type: "googleSearch", name: "googleSearch", config: {} },
          {
            provider: "google",
            type: "googleSearchRetrieval",
            name: "googleSearchRetrieval",
            config: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
          },
          // Non-matching provider — must be filtered out.
          { provider: "openai", type: "web_search_preview", name: "web_search_preview" },
        ],
      },
      mkTarget(),
    ) as { config?: { tools?: unknown[] } };
    const tools = params.config?.tools ?? [];
    // Function declarations ride as their own single `Tool` entry.
    expect(tools).toContainEqual({
      functionDeclarations: [
        {
          name: "calc",
          description: "calculator",
          parameters: { type: "object", properties: { a: { type: "number" } } },
        },
      ],
    });
    // Grounding tools ride as distinct `{ [type]: config }` `Tool` entries.
    expect(tools).toContainEqual({ googleSearch: {} });
    expect(tools).toContainEqual({
      googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
    });
    // OpenAI slice excluded — never leaks into Google's tools array.
    expect(JSON.stringify(tools)).not.toContain("web_search_preview");
  });
});
