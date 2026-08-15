/**
 * Conformance suite invocation for `LanguageModelExecutor` + the
 * `aisdk()` adapter.
 *
 * The factory builds a `MockLanguageModelV2` configured to return a
 * canned `doGenerate` response matching the suite's scripted
 * `LanguageModelExecutionResult`. The same protocol invariants the
 * mock + OpenAI executors satisfy must hold here too — proving the
 * bridge is a true `LanguageModelExecutor` and not a special case.
 */

import { describe } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";

import { LanguageModelExecutor } from "@agentick/model-executor";

import { aisdk } from "../ai-sdk-adapter.js";

/**
 * Reverse-engineer a MockLanguageModelV2 from the scripted result so
 * the bridge normalizes back to an equivalent shape.
 */
function modelFor(scripted: LanguageModelExecutionResult | undefined): MockLanguageModelV2 {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  const toolBlocks = scripted?.output.filter(
    (
      b,
    ): b is {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    } => b.type === "tool_use",
  );
  const toolCalls = (toolBlocks ?? []).map((b) => ({
    type: "tool-call" as const,
    toolCallId: b.toolUseId,
    toolName: b.name,
    input: JSON.stringify(b.input),
  }));
  const finishReason =
    scripted?.stopReason === "tool_use"
      ? ("tool-calls" as const)
      : scripted?.stopReason === "max_tokens"
        ? ("length" as const)
        : ("stop" as const);

  const usage = {
    inputTokens: scripted?.usage?.inputTokens ?? 0,
    outputTokens: scripted?.usage?.outputTokens ?? 0,
    totalTokens: scripted?.usage?.totalTokens ?? 0,
  };
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doGenerate: async () => ({
      content: toolCalls.length > 0 ? toolCalls : ([{ type: "text", text }] as const),
      finishReason,
      usage,
      warnings: [],
    }),
    // Drives the executeStream path -- emits a minimal but symmetric
    // event sequence so the executor's stream loop can extract a
    // result equivalent to the doGenerate output.
    doStream: async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (text.length > 0) {
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: text });
            controller.enqueue({ type: "text-end", id: "0" });
          }
          for (const tc of toolCalls) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
            });
          }
          controller.enqueue({
            type: "finish",
            finishReason,
            usage,
          });
          controller.close();
        },
      });
      return { stream };
    },
  });
}

/** A model whose every call rejects with the supplied provider-native error. */
function throwingModel(cause: unknown): MockLanguageModelV2 {
  const raise = async (): Promise<never> => {
    throw cause;
  };
  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doGenerate: raise,
    doStream: raise,
  });
}

/** The SDK's own shape: an `Error` whose `name` carries the class. */
function invalidToolInput(name: string): Error {
  const err = new Error("Invalid arguments for tool knowify__query: Unexpected end of JSON input");
  err.name = name;
  Object.assign(err, { toolName: "knowify__query", toolInput: '{"table":"Alloc' });
  return err;
}

describe("aisdk() adapter — ExecutorProtocol conformance", () => {
  runExecutorConformance(
    async ({ harnessId, scripted, throws }) => {
      const journal = new MemoryJournal();
      const bus = new LocalEventBus();
      const inbox = new LocalInbox();
      const exec = new LanguageModelExecutor(harnessId, journal, bus, inbox, {
        adapter: aisdk(throws !== undefined ? throwingModel(throws) : modelFor(scripted)),
      });
      await exec.ready;
      return { executor: exec, bus };
    },
    {
      // Both spellings — the SDK renamed the class between 4 and 5, the shape
      // is unchanged, and a deployment can be on either.
      MalformedModelOutput: [
        invalidToolInput("AI_InvalidToolInputError"),
        invalidToolInput("AI_InvalidToolArgumentsError"),
      ],
      ProviderRejected: [Object.assign(new Error("rate limited"), { status: 429 })],
      ProviderAborted: [
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      ],
      StreamFailed: [new Error("socket hang up")],
      // The SDK surfaces a timeout as an aborted request, not a class of its own.
      ProviderTimeout: "not-applicable",
    },
  );
});
