/**
 * `defineExecutor` smoke tests.
 *
 * The factory + callback bundle should produce a working
 * `LanguageModelExecutor` without subclassing `BaseHarness`. Verifies:
 *   - self-described `target` exposed as a property
 *   - factory marker present (consumable by `isExecutorFactory`)
 *   - end-to-end `run()` happy path returns a succeeded terminal
 *   - aborted execution returns canceled
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
  RenderedTree,
} from "@agentick/spec-next";
import { isExecutorFactory } from "@agentick/spec-next";

import { defineExecutor } from "../define-executor.js";

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "callback", modelId: "demo-v1" };
}

const mkResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: "2026-05-08",
  output: [{ type: "text", text }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

describe("defineExecutor()", () => {
  it("returns an ExecutorFactory marker that isExecutorFactory recognizes", () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("ok") });
    expect(isExecutorFactory(f)).toBe(true);
  });

  it("constructs a self-describing executor when called", async () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("ok") });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target.modelId).toBe("demo-v1");
  });

  it("invokes the run callback on executor.run() and returns the terminal", async () => {
    let calls = 0;
    let receivedInput: LanguageModelInput | undefined;
    const f = defineExecutor({
      target: mkTarget(),
      async run(input) {
        calls++;
        receivedInput = input;
        return mkResult("computed");
      },
    });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;

    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] });
    expect(calls).toBe(1);
    expect(receivedInput?.messages.length).toBeGreaterThan(0);
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({ type: "text", text: "computed" });
  });

  it("returns outcome=canceled after abort()", async () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("never") });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    await exec.abort({ executionId: "exec-1" });
    const terminal = await exec.run({
      compiled: mkTree(),
      target: mkTarget(),
      scope: { executionId: "exec-1" },
      tools: [],
    });
    expect(terminal.outcome).toBe("canceled");
  });

  it("translates a thrown callback into ProviderRejected", async () => {
    const f = defineExecutor({
      target: mkTarget(),
      async run() {
        throw new Error("upstream blew up");
      },
    });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    await expect(
      exec.run({ compiled: mkTree(), target: mkTarget(), tools: [] }),
    ).rejects.toMatchObject({
      _tag: "ProviderRejected",
    });
  });
});

describe("defineExecutor() — executeStream", () => {
  it("yields emitted AdapterDeltas in order; .result resolves with the final value", async () => {
    const f = defineExecutor({
      target: mkTarget(),
      async run(_input, { emit }) {
        emit({ type: "message-start", role: "assistant" });
        emit({ type: "content-start", blockIndex: 0, blockType: "text" });
        emit({ type: "content-delta", blockIndex: 0, delta: "Hello" });
        emit({ type: "content-delta", blockIndex: 0, delta: " world" });
        emit({ type: "content-end", blockIndex: 0 });
        emit({
          type: "content",
          blockIndex: 0,
          content: { type: "text", text: "Hello world" },
        });
        emit({
          type: "message-end",
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
        return mkResult("Hello world");
      },
    });
    const exec = f({
      scopeId: "stream-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;

    const stream = exec.executeStream!({
      targetInput: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] },
      target: mkTarget(),
    });

    const deltaTypes: string[] = [];
    for await (const d of stream) deltaTypes.push(d.type);
    const result = (await stream.result) as LanguageModelExecutionResult;

    expect(deltaTypes).toEqual([
      "message-start",
      "content-start",
      "content-delta",
      "content-delta",
      "content-end",
      "content",
      "message-end",
    ]);
    expect(result.output[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("non-streaming run (no emit calls) — iterator completes empty; .result still resolves", async () => {
    const f = defineExecutor({
      target: mkTarget(),
      async run() {
        return mkResult("non-stream");
      },
    });
    const exec = f({
      scopeId: "stream-2",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    const stream = exec.executeStream!({
      targetInput: { messages: [] },
      target: mkTarget(),
    });
    const deltas: unknown[] = [];
    for await (const d of stream) deltas.push(d);
    const result = (await stream.result) as LanguageModelExecutionResult;
    expect(deltas).toEqual([]);
    expect(result.output[0]).toMatchObject({ type: "text", text: "non-stream" });
  });

  it("abort() interrupts the stream — .result rejects", async () => {
    const f = defineExecutor({
      target: mkTarget(),
      async run(_input, { signal }) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
        return mkResult("unreachable");
      },
    });
    const exec = f({
      scopeId: "stream-3",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    const stream = exec.executeStream!({
      targetInput: { messages: [] },
      target: mkTarget(),
    });
    // Abort after a microtask so the run handler has registered its listener.
    await new Promise<void>((r) => setImmediate(r));
    stream.abort("test");
    await expect(stream.result).rejects.toBeDefined();
  });
});
