/**
 * Malformed model output is a CLASS of failure, and the AI SDK bridge is where
 * it gets named (ADR 99 slice 1).
 *
 * `generateText` rejects with `AI_InvalidToolInputError` when the model emits
 * tool arguments it cannot parse or validate. Reaching a caller as
 * `StreamFailed` — the executor's catch-all — that is indistinguishable from a
 * dropped socket, so no policy can say "that was the model's nondeterministic
 * garbage, go again".
 *
 * Classification is a REFINEMENT: shapes this adapter recognises get their own
 * tag, everything else keeps the executor's own table.
 */

import { describe, expect, it } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { LanguageModelTarget, RenderedTree } from "@agentick/spec";
import { LanguageModelExecutor } from "@agentick/model-executor";

import { aisdk, mapProviderError } from "../ai-sdk-adapter.js";

/** The SDK's own shape: an `Error` whose `name` carries the class. */
function invalidToolInputError(): Error {
  const err = new Error("Invalid arguments for tool knowify__query: Unexpected end of JSON input");
  err.name = "AI_InvalidToolInputError";
  Object.assign(err, { toolName: "knowify__query", toolInput: '{"table":"Alloc' });
  return err;
}

describe("mapProviderError", () => {
  it("names an invalid tool input as MalformedModelOutput", () => {
    const mapped = mapProviderError(invalidToolInputError());
    expect(mapped._tag).toBe("MalformedModelOutput");
    expect(mapped.message).toContain("Unexpected end of JSON input");
  });

  it("carries the tool and the offending text for a recovery policy to read", () => {
    const mapped = mapProviderError(invalidToolInputError());
    if (mapped._tag !== "MalformedModelOutput") throw new Error("expected MalformedModelOutput");
    expect(mapped.toolName).toBe("knowify__query");
    expect(mapped.rawArguments).toBe('{"table":"Alloc');
    // Redacted on the way out — model output may carry user data.
    expect("rawArguments" in mapped.toJSON()).toBe(false);
  });

  it("recognises the SDK 4 spelling too — the class was renamed, the shape was not", () => {
    const err = new Error("Invalid arguments");
    err.name = "AI_InvalidToolArgumentsError";
    expect(mapProviderError(err)._tag).toBe("MalformedModelOutput");
  });

  it("delegates every other shape to the executor's own table", () => {
    // The hook REPLACES classification rather than extending it, so an adapter
    // that only refines must hand the rest back — otherwise adding this hook
    // silently retires abort and status detection for the whole provider.
    expect(
      mapProviderError(Object.assign(new Error("rate limited"), { status: 429 })),
    ).toMatchObject({ _tag: "ProviderRejected", status: 429 });
    expect(mapProviderError(new Error("socket hang up"))._tag).toBe("StreamFailed");
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(mapProviderError(aborted)._tag).toBe("ProviderAborted");
  });
});

// ============================================================================
// The streaming path — where the accumulator, not the SDK, catches it
// ============================================================================

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "x" }] },
      ],
    },
  };
}

/** Streams a tool call whose argument fragments never close the object. */
function truncatedToolCallModel(): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "tool-input-start",
            id: "call_1",
            toolName: "knowify__query",
          });
          controller.enqueue({ type: "tool-input-delta", id: "call_1", delta: '{"table":"Alloc' });
          controller.enqueue({ type: "tool-input-end", id: "call_1" });
          controller.enqueue({
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }) as never,
    }),
  });
}

async function executorOver(scope: string, model: MockLanguageModelV2) {
  const exec = new LanguageModelExecutor(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: aisdk(model) },
  );
  await exec.ready;
  return exec;
}

/** Drain the iterator and settle on `.result` — the caller's whole view. */
function drain(stream: {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  result: Promise<unknown>;
}) {
  return (async () => {
    for await (const _ of stream) void _;
    await stream.result;
  })();
}

describe("a truncated tool call on the streaming path", () => {
  it("fails the execution instead of dispatching the tool with `{}`", async () => {
    const exec = await executorOver("exec-aisdk-malformed", truncatedToolCallModel());
    const target: LanguageModelTarget = exec.target as LanguageModelTarget;
    const projected = await exec.project({ compiled: mkTree(), target, tools: [] });

    const stream = exec.executeStream({ targetInput: projected, target });
    await expect(drain(stream)).rejects.toMatchObject({ _tag: "MalformedModelOutput" });
  });
});

// ============================================================================
// Error PARTS — the SDK's other way of reporting a failed generation
// ============================================================================

/** Streams `error` parts, then finishes normally as `streamText` does. */
function erroringModel(errors: readonly unknown[]): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const error of errors) controller.enqueue({ type: "error", error });
          controller.enqueue({
            type: "finish",
            finishReason: "error",
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          });
          controller.close();
        },
      }) as never,
    }),
  });
}

describe("an error PART on the streaming path", () => {
  /**
   * `streamText` reports a failed generation as a part in the delta stream, not
   * as a rejection — so before finalize raised it, the stream ended "cleanly"
   * with whatever text had arrived and the tick counted as a success.
   */
  it("classifies an invalid tool input as MalformedModelOutput, same as the rejection", async () => {
    const exec = await executorOver(
      "exec-aisdk-error-part",
      erroringModel([invalidToolInputError()]),
    );
    const target: LanguageModelTarget = exec.target as LanguageModelTarget;
    const projected = await exec.project({ compiled: mkTree(), target, tools: [] });

    const stream = exec.executeStream({ targetInput: projected, target });
    await expect(drain(stream)).rejects.toMatchObject({
      _tag: "MalformedModelOutput",
      toolName: "knowify__query",
    });
  });

  it("a generic error part is classified, not swallowed", async () => {
    const exec = await executorOver(
      "exec-aisdk-error-part-generic",
      erroringModel([Object.assign(new Error("upstream exploded"), { status: 503 })]),
    );
    const target: LanguageModelTarget = exec.target as LanguageModelTarget;
    const projected = await exec.project({ compiled: mkTree(), target, tools: [] });

    const stream = exec.executeStream({ targetInput: projected, target });
    await expect(drain(stream)).rejects.toMatchObject({ _tag: "ProviderRejected", status: 503 });
  });

  it("raises the FIRST error when the stream reports several", async () => {
    const exec = await executorOver(
      "exec-aisdk-error-part-first",
      erroringModel([invalidToolInputError(), new Error("secondary noise")]),
    );
    const target: LanguageModelTarget = exec.target as LanguageModelTarget;
    const projected = await exec.project({ compiled: mkTree(), target, tools: [] });

    const stream = exec.executeStream({ targetInput: projected, target });
    await expect(drain(stream)).rejects.toMatchObject({ _tag: "MalformedModelOutput" });
  });

  it("a stream with no error parts is unaffected", async () => {
    const model = new MockLanguageModelV2({
      provider: "mock-aisdk",
      modelId: "mock-1",
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "hello" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }) as never,
      }),
    });
    const exec = await executorOver("exec-aisdk-no-error-part", model);
    const target: LanguageModelTarget = exec.target as LanguageModelTarget;
    const projected = await exec.project({ compiled: mkTree(), target, tools: [] });

    const stream = exec.executeStream({ targetInput: projected, target });
    for await (const _ of stream) void _;
    const normalized = await exec.normalize({ targetOutput: await stream.result, target });
    expect(normalized.output).toEqual([{ type: "text", text: "hello" }]);
  });
});
