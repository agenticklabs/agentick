/**
 * Implementation-specific behavior for `OpenAIExecutor`.
 *
 * The conformance suite (`conformance.spec.ts`) drives the protocol
 * contract. These tests assert OpenAI-specific behavior — message
 * conversion, finish_reason mapping, abort propagation through the
 * SDK's signal option, streaming delta emission.
 */

import { Chunk, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { OpenAIExecutor } from "../openai-executor.js";
import {
  StubOpenAIClient,
  asClient,
  mkCompletion,
  mkContentChunk,
  mkFinishChunk,
} from "./stub-openai-client.js";

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

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "openai", modelId: "gpt-4o-mini" };
}

async function makeExecutor(
  stub: StubOpenAIClient,
  opts: { stream?: boolean; model?: string } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new OpenAIExecutor("exec-openai-test", journal, bus, inbox, {
    client: asClient(stub),
    model: opts.model ?? "gpt-4o-mini",
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}

describe("OpenAIExecutor — non-streaming", () => {
  it("returns a succeeded terminal with normalized output", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "hello" }) },
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

  it("forwards the model id from constructor options", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const { exec } = await makeExecutor(stub, { model: "gpt-5-mini" });
    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    expect(stub.calls[0]!.params.model).toBe("gpt-5-mini");
  });

  it("maps finish_reason=length to stopReason=max_tokens", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({ text: "...", finishReason: "length" }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.stopReason).toBe("max_tokens");
  });
});

describe("OpenAIExecutor — tool-use round-trip", () => {
  it("extracts toolCalls and emits tool_use ContentBlocks", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 2, b: 3 } }],
          finishReason: "tool_calls",
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.stopReason).toBe("tool_use");
    expect(terminal.result.toolCalls).toHaveLength(1);
    expect(terminal.result.toolCalls![0]).toMatchObject({
      id: "call_1",
      name: "calculator",
      input: { a: 2, b: 3 },
    });
    expect(terminal.result.output.find((b) => b.type === "tool_use")).toBeDefined();
  });

  it("threads tool_result messages back to the provider in subsequent calls", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "done" }) },
    ]);
    const { exec } = await makeExecutor(stub);

    const treeWithToolRoundtrip: RenderedTree = {
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

    await exec.run({ compiled: treeWithToolRoundtrip, target: mkTarget() });
    const sent = stub.calls[0]!.params.messages;
    // The tool_result must arrive as a `role: "tool"` entry with matching id.
    const toolMessage = sent.find(
      (m) =>
        (m as { role?: string }).role === "tool" &&
        (m as { tool_call_id?: string }).tool_call_id === "call_1",
    );
    expect(toolMessage).toBeDefined();
    // The assistant message that requested the call must carry tool_calls.
    const assistantMsg = sent.find((m) => (m as { role?: string }).role === "assistant") as
      | { tool_calls?: ReadonlyArray<{ id: string }> }
      | undefined;
    expect(assistantMsg?.tool_calls?.[0]?.id).toBe("call_1");
  });
});

describe("OpenAIExecutor — abort", () => {
  it("abort flips the next run to outcome 'canceled'", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "x" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const id = "exec-abort-openai";
    await exec.abort({ executionId: id });
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
      scope: { executionId: id },
    });
    expect(terminal.outcome).toBe("canceled");
  });
});

describe("OpenAIExecutor — streaming", () => {
  it("emits one executor:delta envelope per content chunk", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "streaming",
        chunks: [
          mkContentChunk({ delta: "a" }),
          mkContentChunk({ delta: "b" }),
          mkContentChunk({ delta: "c" }),
          mkFinishChunk({
            finishReason: "stop",
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
        ],
      },
    ]);
    const { exec, bus } = await makeExecutor(stub, { stream: true });

    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "executor", phase: "delta" }), 4)),
    );
    await new Promise((r) => setImmediate(r));

    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({
      type: "text",
      text: "abc",
    });
    expect(terminal.result.usage?.totalTokens).toBe(7);

    const collected = await Effect.runPromise(Fiber.join(fiber));
    const deltas = Array.from(Chunk.toReadonlyArray(collected));
    expect(deltas).toHaveLength(4);
  });
});

describe("OpenAIExecutor — parseThinkTags preset", () => {
  it("routes inline <think> blocks to reasoning on non-streaming response", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: "<think>step by step</think>Answer: 42",
        }),
      },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new OpenAIExecutor("exec-think-1", journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
      parseThinkTags: true,
    });
    await exec.ready;

    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    // ReasoningBlock should arrive before the text block.
    expect(terminal.result.output[0]).toMatchObject({
      type: "reasoning",
      text: "step by step",
    });
    expect(terminal.result.output[1]).toMatchObject({
      type: "text",
      text: "Answer: 42",
    });
  });

  it("streams <think> as reasoning deltas through the typed stream", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "streaming",
        chunks: [
          mkContentChunk({ delta: "<think>" }),
          mkContentChunk({ delta: "thinking" }),
          mkContentChunk({ delta: "</think>" }),
          mkContentChunk({ delta: "Answer" }),
          mkFinishChunk({
            finishReason: "stop",
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
        ],
      },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new OpenAIExecutor("exec-think-2", journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
      parseThinkTags: true,
    });
    await exec.ready;

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

describe("OpenAIExecutor — customBlocks", () => {
  it("extracts adopter-declared tags as custom-block deltas (streaming)", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "streaming",
        chunks: [
          mkContentChunk({ delta: 'Found ' }),
          mkContentChunk({ delta: '<citation source="wiki">Paris</citation>' }),
          mkContentChunk({ delta: " in the docs" }),
          mkFinishChunk({
            finishReason: "stop",
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
        ],
      },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new OpenAIExecutor("exec-cb-1", journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
      customBlocks: { citation: {} },
    });
    await exec.ready;

    const projected = await exec.project({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    const stream = exec.executeStream({
      targetInput: projected,
      target: mkTarget(),
    });
    const events: Array<{ type: string; tag?: string; attrs?: Record<string, string> }> = [];
    for await (const ev of stream) {
      events.push(ev as never);
    }
    const cbStart = events.find((e) => e.type === "custom-block-start");
    expect(cbStart).toMatchObject({ tag: "citation", attrs: { source: "wiki" } });
    expect(events.find((e) => e.type === "custom-block")).toMatchObject({
      tag: "citation",
    });
  });

  it("invokes per-tag handlers on tag close (non-streaming)", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: 'before <citation source="wiki">cited</citation> after',
        }),
      },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const captured: Array<{ content: string; attrs: Record<string, string> }> = [];
    const exec = new OpenAIExecutor("exec-cb-2", journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
      customBlocks: {
        citation: {
          onContent(content, attrs) {
            captured.push({ content, attrs: { ...attrs } });
          },
        },
      },
    });
    await exec.ready;

    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    expect(captured).toEqual([{ content: "cited", attrs: { source: "wiki" } }]);
  });

  it("supports parseThinkTags + customBlocks simultaneously", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "non-streaming",
        completion: mkCompletion({
          text: "<think>reason</think>see <citation>src</citation> done",
        }),
      },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const onContent = (content: string) => {
      captured.push(content);
    };
    const captured: string[] = [];
    const exec = new OpenAIExecutor("exec-cb-3", journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
      parseThinkTags: true,
      customBlocks: { citation: { onContent } },
    });
    await exec.ready;

    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
    });
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    // Reasoning block extracted from <think>.
    expect(terminal.result.output[0]).toMatchObject({
      type: "reasoning",
      text: "reason",
    });
    // Text contains "see  done" with the citation stripped.
    expect(terminal.result.output[1]).toMatchObject({
      type: "text",
      text: "see  done",
    });
    // Custom block handler fired.
    expect(captured).toEqual(["src"]);
  });
});

describe("OpenAIExecutor — journaled lifecycle", () => {
  it("run produces requested + terminal envelopes on the journal", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const { exec, journal } = await makeExecutor(stub);
    await exec.run({ compiled: emptyTree(), target: mkTarget() });
    const chunk = await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({ surface: "executor" }, "beginning")),
    );
    const events = Array.from(Chunk.toReadonlyArray(chunk));
    const names = new Set(events.map((e) => `${e.name}.${e.phase}`));
    expect(names.has("executor:command:run.requested")).toBe(true);
    expect([...names].some((n) => n.startsWith("executor:command:run.terminal"))).toBe(true);
  });
});
