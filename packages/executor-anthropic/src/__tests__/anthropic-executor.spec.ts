/**
 * Implementation-specific behavior for `AnthropicExecutor`.
 *
 * The conformance suite (`conformance.spec.ts`) drives the protocol
 * contract. These tests assert Anthropic-specific behavior — system
 * extraction, alternation coalescing, native `thinking` reasoning,
 * cache token plumbing, providerOptions spread, streaming deltas.
 */

import { Chunk, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type {
  LanguageModelTarget,
  RenderedTree,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";

import { AnthropicExecutor } from "../anthropic-executor.js";
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
  const exec = new AnthropicExecutor("exec-anthropic-test", journal, bus, inbox, {
    client: asClient(stub),
    model: opts.model ?? "claude-3-5-sonnet-latest",
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.parseThinkTags ? { parseThinkTags: true } : {}),
    ...(opts.customBlocks ? { customBlocks: opts.customBlocks } : {}),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}

describe("AnthropicExecutor — non-streaming", () => {
  it("returns a succeeded terminal with normalized output", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "hello" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
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
    await exec.run({ compiled: emptyTree(), target: mkTarget({ modelId: "claude-3-opus-latest" }) });
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
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
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
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.stopReason).toBe("stop_sequence");
  });
});

describe("AnthropicExecutor — system extraction + alternation", () => {
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
    await exec.run({ compiled: tree, target: mkTarget() });
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
    await exec.run({ compiled: tree, target: mkTarget() });
    const msgs = stub.calls[0]!.params.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
    expect((msgs[0]!.content as Array<{ type: string }>).length).toBe(2);
  });
});

describe("AnthropicExecutor — tool-use round-trip", () => {
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
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
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
    await exec.run({ compiled: tree, target: mkTarget() });
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
    await exec.run({ compiled: tree, target: mkTarget() });
    const sent = stub.calls[0]!.params.messages;
    const content = sent[0]!.content as Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const tr = content.find((b) => b.type === "tool_result");
    expect(tr?.content?.[0]).toMatchObject({ type: "text", text: "Done" });
  });
});

describe("AnthropicExecutor — abort", () => {
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
    });
    expect(t.outcome).toBe("canceled");
  });
});

describe("AnthropicExecutor — streaming", () => {
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

    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
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
    const ta = await a.run({ compiled: emptyTree(), target: mkTarget() });
    const tb = await b.run({ compiled: emptyTree(), target: mkTarget() });
    if (ta.outcome !== "succeeded" || tb.outcome !== "succeeded")
      throw new Error("expected success");
    expect(ta.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(tb.result.output[0]).toMatchObject({ type: "text", text: "hello" });
    expect(ta.result.stopReason).toBe(tb.result.stopReason);
  });
});

describe("AnthropicExecutor — cache tokens (G2)", () => {
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
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
    if (t.outcome !== "succeeded") throw new Error("expected success");
    expect(t.result.usage?.cachedInputTokens).toBe(80);
    expect(t.result.usage?.cacheCreationTokens).toBe(20);
  });

  it("stamps cache_control on system block when cacheControl includes 'system'", async () => {
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
    await exec.run({
      compiled: tree,
      target: {
        ...mkTarget(),
        providerOptions: { anthropic: { cacheControl: ["system"] } },
      },
    });
    const sys = stub.calls[0]!.params.system as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[sys.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("stamps cache_control on last tool when cacheControl includes 'tools'", async () => {
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
      declarations: {
        tools: [
          {
            id: "calc",
            name: "calc",
            description: "calculator",
            inputSchema: { type: "object" },
            exposure: ["model"],
          },
        ],
      },
    };
    await exec.run({
      compiled: tree,
      target: {
        ...mkTarget(),
        providerOptions: { anthropic: { cacheControl: ["tools"] } },
      },
    });
    const tools = stub.calls[0]!.params.tools as Array<{
      name: string;
      cache_control?: { type: string };
    }>;
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("AnthropicExecutor — reasoning (G3 native thinking blocks)", () => {
  it("extracts ReasoningBlock from non-streaming thinking content block", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "non-streaming",
        message: mkMessage({ thinking: "step by step", text: "Answer: 42" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
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

describe("AnthropicExecutor — sampling params (G1)", () => {
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
      },
    };
    await exec.project({ compiled: tree, target: mkTarget() });
    const projected = await exec.project({ compiled: tree, target: mkTarget() });
    // Manually call execute since stopSequences/topP aren't in tree.config schema.
    await exec.execute({
      targetInput: {
        ...projected,
        parameters: {
          ...(projected.parameters ?? {}),
          temperature: 0.42,
          maxOutputTokens: 200,
          topP: 0.9,
          stopSequences: ["STOP"],
          frequencyPenalty: 0.5, // must be dropped
          presencePenalty: 0.5, // must be dropped
        },
      },
      target: mkTarget(),
    });
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
    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    expect(stub.calls[0]!.params.max_tokens).toBe(4096);
  });

  it("honors executor option maxTokens default", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub, { maxTokens: 2048 });
    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    expect(stub.calls[0]!.params.max_tokens).toBe(2048);
  });
});

describe("AnthropicExecutor — providerOptions spread (G5)", () => {
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

  it("does NOT spread cacheControl into the SDK request body", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    await exec.run({
      compiled: emptyTree(),
      target: {
        ...mkTarget(),
        providerOptions: { anthropic: { cacheControl: ["system"] } },
      },
    });
    const p = stub.calls[0]!.params as unknown as Record<string, unknown>;
    expect(p.cacheControl).toBeUndefined();
  });
});

describe("AnthropicExecutor — parseThinkTags (G7)", () => {
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
    const projected = await exec.project({ compiled: emptyTree(), target: mkTarget() });
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

describe("AnthropicExecutor — customBlocks (G12)", () => {
  it("extracts adopter-declared tags as custom-block deltas (streaming)", async () => {
    const stub = new StubAnthropicClient([
      {
        kind: "streaming",
        events: [
          mkMessageStartEvent({ inputTokens: 4 }),
          mkContentBlockStartText(0),
          mkTextDelta(0, 'Found '),
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
    const projected = await exec.project({ compiled: emptyTree(), target: mkTarget() });
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

describe("AnthropicExecutor — tool input json round-trip (streaming)", () => {
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
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget() });
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

describe("AnthropicExecutor — base64 image (G4)", () => {
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
    await exec.run({ compiled: tree, target: mkTarget() });
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
    await exec.run({ compiled: tree, target: mkTarget() });
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

describe("AnthropicExecutor — journaled lifecycle", () => {
  it("run produces requested + terminal envelopes on the journal", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const { exec, journal } = await makeExecutor(stub);
    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    const chunk = await Effect.runPromise(
      Stream.runCollect(journal.read({ surface: "executor" }, "beginning")),
    );
    const events = Array.from(Chunk.toReadonlyArray(chunk));
    const names = new Set(events.map((e) => `${e.name}.${e.phase}`));
    expect(names.has("executor:command:run.requested")).toBe(true);
    expect([...names].some((n) => n.startsWith("executor:command:run.terminal"))).toBe(true);
  });
});
