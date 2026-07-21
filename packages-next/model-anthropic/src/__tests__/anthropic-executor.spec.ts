/**
 * Implementation-specific behavior for the `anthropic()` adapter driven
 * through `LanguageModelExecutor`.
 *
 * The conformance suite (`conformance.spec.ts`) drives the protocol
 * contract. These tests assert Anthropic-specific behavior — system
 * extraction, alternation coalescing, native `thinking` reasoning,
 * cache token plumbing, providerOptions spread, streaming deltas.
 */

import { omitUndefined } from "@agentick/utils-next";

import { Chunk, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  Message as AnthropicMessage,
  MessageCreateParams,
} from "@anthropic-ai/sdk/resources/messages";

import { LanguageModelExecutor } from "@agentick/executor-next";

import { anthropic } from "../anthropic-adapter.js";
import {
  StubAnthropicClient,
  asClient,
  mkMessage,
  mkMessageStartEvent,
  mkContentBlockStartText,
  mkContentBlockStartThinking,
  mkContentBlockStartToolUse,
  mkTextDelta,
  mkThinkingDelta,
  mkInputJsonDelta,
  mkContentBlockStop,
  mkMessageDelta,
  mkMessageStop,
} from "./stub-anthropic-client.js";

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
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-latest",
    ...(overrides ?? {}),
  };
}

async function makeExecutor(
  stub: StubAnthropicClient,
  opts: {
    stream?: boolean;
    model?: string;
    maxTokens?: number;
    parseThinkTags?: boolean;
    customBlocks?: Record<string, { tag?: string; onContent?: (c: string) => void }>;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-anthropic-test", journal, bus, inbox, {
    adapter: anthropic(opts.model ?? "claude-3-5-sonnet-latest", {
      client: asClient(stub),
      ...omitUndefined({ stream: opts.stream, maxTokens: opts.maxTokens }),
      ...(opts.parseThinkTags ? { parseThinkTags: true } : {}),
      ...(opts.customBlocks ? { customBlocks: opts.customBlocks } : {}),
    }),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}

describe("anthropic() adapter — non-streaming", () => {
  it("returns a succeeded terminal with normalized output", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "hello" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
      tools: [],
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(terminal.result.stopReason).toBe("end");
    expect(terminal.result.usage?.totalTokens).toBe(12);
  });

  it("forwards model id from constructor options", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub, { model: "claude-3-opus-latest" });
    await exec.run({
      compiled: emptyTree(),
      target: mkTarget({ modelId: "claude-3-opus-latest" }),
      tools: [],
    });
    expect(stub.calls[0]!.params.model).toBe("claude-3-opus-latest");
  });

  it("maps stop_reason=max_tokens to stopReason=max_tokens", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({ text: "...", stopReason: "max_tokens" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("max_tokens");
  });

  it("maps stop_reason=stop_sequence to stopReason=stop_sequence", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({ text: "x", stopReason: "stop_sequence" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("stop_sequence");
  });
});

describe("anthropic() adapter — system extraction + alternation", () => {
  it("extracts system messages to top-level `system` param", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "section",
            id: "sec1",
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
    expect(typeof params.system).toBe("string");
    expect(params.system as string).toContain("Persona");
    // No `system` role in messages.
    expect(params.messages.find((m) => (m as { role: string }).role === "system")).toBeUndefined();
  });

  it("coalesces consecutive same-role messages into a single message", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
            content: [{ type: "text", text: "hi" }],
          },
          {
            kind: "message",
            id: "m2",
            role: "user",
            content: [{ type: "text", text: "again" }],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
    expect((msgs[0]!.content as Array<{ type: string }>).length).toBe(2);
  });
});

describe("anthropic() adapter — tool-use round-trip", () => {
  it("extracts toolCalls and emits tool_use ContentBlocks", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({
          toolCalls: [{ id: "call_1", name: "calculator", input: { a: 2, b: 3 } }],
          stopReason: "tool_use",
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("tool_use");
    expect(t.result.toolCalls).toHaveLength(1);
    expect(t.result.toolCalls![0]).toMatchObject({
      id: "call_1",
      name: "calculator",
      input: { a: 2, b: 3 },
    });
    expect(t.result.output.find((b) => b.type === "tool_use")).toBeDefined();
  });

  it("threads tool_result back as user-role tool_result block", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "done" }) },
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
            content: [{ type: "text", text: "compute" }],
          },
          {
            kind: "message",
            id: "m2",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                toolUseId: "call_1",
                name: "calculator",
                input: { a: 2, b: 3 },
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
                toolUseId: "call_1",
                name: "calculator",
                content: [{ type: "text", text: "5" }],
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const sent = stub.calls[0]!.params.messages;
    // Last message must be user with tool_result block.
    const lastIdx = sent.length - 1;
    expect(sent[lastIdx]!.role).toBe("user");
    const lastContent = sent[lastIdx]!.content as Array<{ type: string; tool_use_id?: string }>;
    expect(lastContent.some((b) => b.type === "tool_result" && b.tool_use_id === "call_1")).toBe(
      true,
    );
    // Assistant tool_use block present.
    const assistant = sent.find((m) => (m as { role: string }).role === "assistant") as
      | { content: Array<{ type: string; id?: string }> }
      | undefined;
    expect(assistant?.content.some((b) => b.type === "tool_use" && b.id === "call_1")).toBe(true);
  });

  it("inserts placeholder text for empty tool_result content", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "message",
            id: "m1",
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_x",
                name: "noop",
                content: [],
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const sent = stub.calls[0]!.params.messages;
    const content = sent[0]!.content as Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const tr = content.find((b) => b.type === "tool_result");
    expect(tr?.content?.[0]).toMatchObject({ type: "text", text: "Done" });
  });
});

describe("anthropic() adapter — abort", () => {
  it("abort flips next run to outcome 'canceled'", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "x" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const id = "exec-abort-anthropic";
    await exec.abort({ executionId: id });
    const t = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
      scope: { executionId: id },
      tools: [],
    });
    expect(t.outcome).toBe("canceled");
  });
});

describe("anthropic() adapter — streaming", () => {
  it("emits one executor:delta envelope per emit() call", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "a"),
          mkTextDelta(0, "b"),
          mkTextDelta(0, "c"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 3),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec, bus } = await makeExecutor(stub, { stream: true });

    // Subscribe before run. Take a slice of envelopes.
    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "executor", phase: "delta" }), 3)),
    );
    await new Promise((r) => setImmediate(r));

    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.output[0]).toMatchObject({ type: "text", text: "abc" });

    const collected = await Effect.runPromise(Fiber.join(fiber));
    const deltas = Array.from(Chunk.toReadonlyArray(collected));
    expect(deltas.length).toBeGreaterThanOrEqual(3);
  });

  it("equivalent final result to non-streaming path", async () => {
    const streaming = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "hello"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 1),
          mkMessageStop(),
        ],
      },
    ]);
    const nonStreaming = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "hello" }) },
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

describe("anthropic() adapter — cache tokens (G2)", () => {
  it("surfaces cache_read_input_tokens as cachedInputTokens", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({
          text: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.usage?.cachedInputTokens).toBe(80);
    expect(t.result.usage?.cacheCreationTokens).toBe(20);
  });

  it("stamps cache_control on system block via per-section providerMetadata", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
            metadata: {
              providerMetadata: {
                anthropic: { cacheControl: { type: "ephemeral" } },
              },
            },
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
    const sys = stub.calls[0]!.params.system as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[sys.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("stamps cache_control on a tool via tool.providerOptions.anthropic", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
            content: [{ type: "text", text: "hi" }],
          },
        ],
      },
    };
    await exec.run({
      compiled: tree,
      target: mkTarget(),
      tools: [
        {
          id: "calc",
          name: "calc",
          description: "calculator",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          providerOptions: {
            anthropic: { cache_control: { type: "ephemeral" } },
          },
        },
      ],
    });
    const tools = stub.calls[0]!.params.tools as Array<{
      name: string;
      cache_control?: { type: string };
    }>;
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("stamps cache_control on a per-message text block via providerMetadata", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
                type: "text",
                text: "remember this turn",
                providerMetadata: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages as Array<{
      role: string;
      content: Array<{ type: string; cache_control?: { type: string } }>;
    }>;
    const lastTextBlock = msgs[msgs.length - 1]!.content.find((b) => b.type === "text");
    expect(lastTextBlock?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("anthropic() adapter — reasoning (G3 native thinking blocks)", () => {
  it("extracts ReasoningBlock from non-streaming thinking content block", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({ thinking: "step by step", text: "Answer: 42" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.output[0]).toMatchObject({ type: "reasoning", text: "step by step" });
    expect(t.result.output[1]).toMatchObject({ type: "text", text: "Answer: 42" });
  });

  it("emits reasoning-start/delta/end on streaming thinking blocks", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartThinking(0),
          mkThinkingDelta(0, "thinking..."),
          mkContentBlockStop(0),
          mkContentBlockStartText(1),
          mkTextDelta(1, "answer"),
          mkContentBlockStop(1),
          mkMessageDelta("end_turn", 2),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const projected = await exec.project({
      compiled: emptyTree(),
      target: mkTarget(),
      tools: [],
    });
    const stream = exec.executeStream({
      targetInput: projected,
      target: mkTarget(),
    });
    const seen: string[] = [];
    for await (const ev of stream) {
      seen.push(ev.type);
    }
    expect(seen).toContain("reasoning-start");
    expect(seen).toContain("reasoning-delta");
    expect(seen).toContain("reasoning-end");
    expect(seen).toContain("reasoning");
    expect(seen).toContain("content-delta");
  });
});

describe("anthropic() adapter — sampling params (G1)", () => {
  it("plumbs temperature/topP/stopSequences/maxOutputTokens to SDK params", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
            content: [{ type: "text", text: "hi" }],
          },
        ],
      },
      config: {
        temperature: 0.42,
        maxOutputTokens: 200,
        topP: 0.9,
        stopSequences: ["STOP"],
        frequencyPenalty: 0.5, // must be dropped — Anthropic has no native support
        presencePenalty: 0.5, // must be dropped
      },
    };
    // #211 — topP/stopSequences/penalties now live in tree.config and flow
    // through the canonical projection; no manual parameter injection.
    const projected = await exec.project({ compiled: tree, target: mkTarget(), tools: [] });
    await exec.execute({ targetInput: projected, target: mkTarget() });
    const p = stub.calls[0]!.params as MessageCreateParams & {
      frequency_penalty?: number;
      presence_penalty?: number;
    };
    expect(p.temperature).toBe(0.42);
    expect(p.top_p).toBe(0.9);
    expect(p.max_tokens).toBe(200);
    expect(p.stop_sequences).toEqual(["STOP"]);
    expect(p.frequency_penalty).toBeUndefined();
    expect(p.presence_penalty).toBeUndefined();
  });

  it("defaults max_tokens to 4096 when not supplied", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    expect(stub.calls[0]!.params.max_tokens).toBe(4096);
  });

  it("honors executor option maxTokens default", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub, { maxTokens: 2048 });
    await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    expect(stub.calls[0]!.params.max_tokens).toBe(2048);
  });
});

describe("anthropic() adapter — providerOptions spread (G5)", () => {
  it("spreads anthropic providerOptions onto SDK request", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.run({
      compiled: emptyTree(),
      target: {
        ...mkTarget(),
        providerOptions: {
          anthropic: {
            top_k: 40,
            metadata: { user_id: "u_123" },
            tool_choice: { type: "any" },
            thinking: { type: "enabled", budget_tokens: 2048 },
          },
        },
      },
      tools: [],
    });
    const p = stub.calls[0]!.params as MessageCreateParams & {
      top_k?: number;
      metadata?: { user_id?: string };
      tool_choice?: { type: string };
      thinking?: { type: string; budget_tokens?: number };
    };
    expect(p.top_k).toBe(40);
    expect(p.metadata?.user_id).toBe("u_123");
    expect(p.tool_choice?.type).toBe("any");
    expect(p.thinking?.type).toBe("enabled");
    expect(p.thinking?.budget_tokens).toBe(2048);
  });
});

describe("anthropic() adapter — parseThinkTags (G7)", () => {
  it("routes <think> in text channel to reasoning deltas (streaming)", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "<think>"),
          mkTextDelta(0, "deep thought"),
          mkTextDelta(0, "</think>"),
          mkTextDelta(0, "Answer"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 2),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true, parseThinkTags: true });
    const projected = await exec.project({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const stream = exec.executeStream({ targetInput: projected, target: mkTarget() });
    const seen: string[] = [];
    for await (const ev of stream) {
      seen.push(ev.type);
    }
    expect(seen).toContain("reasoning-start");
    expect(seen).toContain("reasoning-delta");
    expect(seen).toContain("content-delta");
  });
});

describe("anthropic() adapter — customBlocks (G12)", () => {
  it("extracts adopter-declared tags as custom-block deltas (streaming)", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, "Found "),
          mkTextDelta(0, '<citation source="wiki">Paris</citation>'),
          mkTextDelta(0, " in docs"),
          mkContentBlockStop(0),
          mkMessageDelta("end_turn", 3),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, {
      stream: true,
      customBlocks: { citation: {} },
    });
    const projected = await exec.project({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const stream = exec.executeStream({ targetInput: projected, target: mkTarget() });
    const events: Array<{ type: string; tag?: string; attrs?: Record<string, string> }> = [];
    for await (const ev of stream) {
      events.push(ev as never);
    }
    const cbStart = events.find((e) => e.type === "custom-block-start");
    expect(cbStart).toMatchObject({ tag: "citation", attrs: { source: "wiki" } });
    expect(events.find((e) => e.type === "custom-block")).toMatchObject({ tag: "citation" });
  });
});

describe("anthropic() adapter — tool input json round-trip (streaming)", () => {
  it("accumulates input_json_delta and parses on block_stop", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartToolUse(0, "call_xyz", "calc"),
          mkInputJsonDelta(0, '{"a":'),
          mkInputJsonDelta(0, "2,"),
          mkInputJsonDelta(0, '"b":3}'),
          mkContentBlockStop(0),
          mkMessageDelta("tool_use", 5),
          mkMessageStop(),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("tool_use");
    expect(t.result.toolCalls).toHaveLength(1);
    expect(t.result.toolCalls![0]).toMatchObject({
      id: "call_xyz",
      name: "calc",
      input: { a: 2, b: 3 },
    });
  });
});

describe("anthropic() adapter — base64 image (G4)", () => {
  it("converts data: URLs to Anthropic base64 source", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
                mimeType: "image/png",
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages;
    const content = msgs[0]!.content as Array<{
      type: string;
      source?: { type: string; data?: string; media_type?: string };
    }>;
    const img = content.find((b) => b.type === "image")!;
    expect(img.source?.type).toBe("base64");
    expect(img.source?.data).toBe("AAAA");
    expect(img.source?.media_type).toBe("image/png");
  });

  it("converts plain URLs to Anthropic url source", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
                source: { type: "url", url: "https://example.com/x.png" },
                mimeType: "image/png",
              },
            ],
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages;
    const content = msgs[0]!.content as Array<{
      type: string;
      source?: { type: string; url?: string };
    }>;
    const img = content.find((b) => b.type === "image")!;
    expect(img.source?.type).toBe("url");
    expect(img.source?.url).toBe("https://example.com/x.png");
  });
});

describe("anthropic() adapter — journaled lifecycle", () => {
  it("run produces requested + terminal envelopes on the journal", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec, journal } = await makeExecutor(stub);
    await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const chunk = await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({ surface: "executor" }, "beginning")),
    );
    const events = Array.from(Chunk.toReadonlyArray(chunk));
    const names = new Set(events.map((e) => `${e.name}.${e.phase}`));
    expect(names.has("executor:command:run.requested")).toBe(true);
    expect([...names].some((n) => n.startsWith("executor:command:run.terminal"))).toBe(true);
  });
});

describe("anthropic() adapter — canonical CacheHint translation (#185)", () => {
  it("section metadata.cache → cache_control with ttl on the system block", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          {
            kind: "section",
            id: "s1",
            content: [{ type: "text", text: "stable persona" }],
            metadata: { cache: { ttl: "1h" } },
          },
          { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const sys = stub.calls[0]!.params.system as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("message metadata.cache → cache_control on the message's LAST block", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
              { type: "text", text: "part one" },
              { type: "text", text: "part two" },
            ],
            metadata: { cache: {} },
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages as Array<{
      content: Array<{ cache_control?: unknown }>;
    }>;
    expect(msgs[0]!.content[0]!.cache_control).toBeUndefined();
    expect(msgs[0]!.content[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("explicit per-block providerMetadata wins over the canonical hint", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
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
                type: "text",
                text: "explicit",
                providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
              },
            ],
            metadata: { cache: { ttl: "1h" } },
          },
        ],
      },
    };
    await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
    const msgs = stub.calls[0]!.params.messages as Array<{
      content: Array<{ cache_control?: unknown }>;
    }>;
    // Explicit block-level control (no ttl) beats the canonical 1h hint.
    expect(msgs[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

// ============================================================================
// Pass D — provider-executed tools (request-half)
// ============================================================================

describe("anthropic() adapter — provider tools (Pass D request-half)", () => {
  it("maps the anthropic provider-tool slice onto params.tools, keeps function tools, drops other providers", () => {
    const adapter = anthropic("claude-3-5-sonnet-latest");
    const params = adapter.buildParams(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "calc", description: "calculator", inputSchema: { type: "object" } }],
        providerTools: [
          {
            provider: "anthropic",
            type: "web_search_20250305",
            name: "web_search",
            config: { max_uses: 5 },
          },
          // Non-matching provider — must be filtered out.
          { provider: "openai", type: "web_search_preview", name: "web_search_preview" },
        ],
      },
      mkTarget(),
    ) as { tools?: unknown[] };
    const tools = params.tools ?? [];
    // Function tool survives with its native `input_schema` shape.
    expect(tools).toContainEqual({
      name: "calc",
      description: "calculator",
      input_schema: { type: "object" },
    });
    // Anthropic server tool mapped to the native `{ type, name, ...config }` shape.
    expect(tools).toContainEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    });
    // OpenAI slice excluded — never leaks into Anthropic's tools array.
    expect(JSON.stringify(tools)).not.toContain("web_search_preview");
  });
});

describe("anthropic() adapter — provenance-half (Pass D document citations)", () => {
  it("maps SDK TextBlock.citations (char_location) onto normalized Citation[] + block.sources", () => {
    const adapter = anthropic("claude-3-5-sonnet-latest");
    // Fixture typed against `@anthropic-ai/sdk`'s Message — a wrong-shaped
    // citation FAILS typecheck (HARD RULE: no untyped `as any` fixtures).
    const raw: AnthropicMessage = {
      id: "msg_cite",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-latest",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      content: [
        {
          type: "text",
          text: "The sky is blue due to Rayleigh scattering.",
          citations: [
            {
              type: "char_location",
              cited_text: "Rayleigh scattering makes the sky blue",
              document_index: 2,
              document_title: "Optics 101",
              start_char_index: 4,
              end_char_index: 11,
            },
          ],
        },
      ],
    };

    const result = adapter.normalize(raw);
    const textBlock = result.output.find((b) => b.type === "text");
    // Normalized model: citation references a Source by id; the referenced
    // Source rides the block's `sources` (so the citation resolves in isolation).
    expect(textBlock?.sources).toEqual([{ id: "s0", documentIndex: 2, title: "Optics 101" }]);
    expect(textBlock?.citations).toEqual([
      {
        sourceId: "s0",
        citedText: "Rayleigh scattering makes the sky blue",
        range: { start: 4, end: 11 },
      },
    ]);
    // Resolution holds: every cited sourceId is present in block.sources.
    const ids = new Set(textBlock?.sources?.map((s) => s.id));
    for (const c of textBlock?.citations ?? []) expect(ids.has(c.sourceId)).toBe(true);
  });

  it("omits `citations` on text blocks the provider returned with none", () => {
    const adapter = anthropic("claude-3-5-sonnet-latest");
    const raw: AnthropicMessage = {
      id: "msg_plain",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-latest",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      content: [{ type: "text", text: "No citations here.", citations: null }],
    };
    const result = adapter.normalize(raw);
    const textBlock = result.output.find((b) => b.type === "text");
    expect(textBlock?.citations).toBeUndefined();
    expect(textBlock?.sources).toBeUndefined();
  });

  it("interns one Source across two citing text blocks (same doc → one turn-stable id)", () => {
    const adapter = anthropic("claude-3-5-sonnet-latest");
    // Two separate text blocks both cite document_index 2 — the per-turn
    // interner mints ONE Source with ONE id, shared by both blocks' `sources`.
    const raw: AnthropicMessage = {
      id: "msg_dedupe",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-latest",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      content: [
        {
          type: "text",
          text: "First claim.",
          citations: [
            {
              type: "char_location",
              cited_text: "supporting snippet A",
              document_index: 2,
              document_title: "Optics 101",
              start_char_index: 0,
              end_char_index: 5,
            },
          ],
        },
        {
          type: "text",
          text: "Second claim.",
          citations: [
            {
              type: "char_location",
              cited_text: "supporting snippet B",
              document_index: 2,
              document_title: "Optics 101",
              start_char_index: 0,
              end_char_index: 6,
            },
          ],
        },
      ],
    };
    const result = adapter.normalize(raw);
    const textBlocks = result.output.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(2);
    // Both blocks reference the SAME turn-stable id.
    expect(textBlocks[0]?.citations?.[0]?.sourceId).toBe("s0");
    expect(textBlocks[1]?.citations?.[0]?.sourceId).toBe("s0");
    expect(textBlocks[0]?.sources).toEqual([{ id: "s0", documentIndex: 2, title: "Optics 101" }]);
    expect(textBlocks[1]?.sources).toEqual([{ id: "s0", documentIndex: 2, title: "Optics 101" }]);
  });
});
