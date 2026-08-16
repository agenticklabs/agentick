/**
 * ADR 99 recovery, parameterized for `aisdk()`: an invalid tool input,
 * recovered by a REAL second provider call.
 *
 * The SDK reports it differently per seam, and both must recover the same way.
 * `streamText` reports a failed generation as an error PART rather than by
 * rejecting, so it arrives mid-stream and `finalizeStream` raises it;
 * `generateText` rejects, and `mapProviderError` names the rejection.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import { describe } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { createApp } from "@agentick/app";
import { timelineCompiler } from "@agentick/compiler/testing";
import { runRecoveryConformance } from "@agentick/spec-conformance";
import type { RecoveryFactory, RecoveryStep, RecoveryTickStart } from "@agentick/spec-conformance";

import { aisdk } from "../index.js";

/** The SDK's own shape: an `Error` whose `name` carries the class. */
function invalidToolInputError(): Error {
  const err = new Error("Invalid arguments for tool query: Unexpected end of JSON input");
  err.name = "AI_InvalidToolInputError";
  Object.assign(err, { toolName: "query", toolInput: '{"table":"Alloc' });
  return err;
}

function partsFor(step: RecoveryStep): readonly unknown[] {
  if (step === "malformed") {
    return [
      { type: "stream-start", warnings: [] },
      { type: "error", error: invalidToolInputError() },
      {
        type: "finish",
        finishReason: "error",
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      },
    ];
  }
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "recovered" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
}

const recoveryFactory: RecoveryFactory = async (script) => {
  const requests: unknown[] = [];
  let close = async (): Promise<void> => {};
  const tickStarts: RecoveryTickStart[] = [];

  const model = new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doStream: async (options) => {
      const parts = partsFor(script[requests.length] ?? "ok");
      requests.push({ prompt: options.prompt });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }) as never,
      };
    },
    // `generateText` has no error-part channel — it rejects, and the rejection
    // is what `mapProviderError` names.
    doGenerate: async (options) => {
      const step = script[requests.length] ?? "ok";
      requests.push({ prompt: options.prompt });
      if (step === "malformed") throw invalidToolInputError();
      return {
        content: [{ type: "text" as const, text: "recovered" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });

  return {
    async run({ stream = true, tickFailurePolicy } = {}) {
      const app = await createApp(null, {
        compiler: timelineCompiler(),
        model: aisdk(model),
        ...(tickFailurePolicy !== undefined ? { tickFailurePolicy } : {}),
      });
      close = async () => {
        await app.closeApp();
      };
      app.hook({
        onLoopRunExecutionChunk: {
          observe: (event) => {
            const e = event as unknown as RecoveryTickStart & { kind: string };
            if (e.kind === "tick-start") tickStarts.push(e);
          },
        },
      });
      const { result } = await app.runOnce({
        send: { messages: [{ role: "user", content: "what is on her schedule?" }], stream },
      });
      const tag = (result.stopCause as { error?: { _tag?: string } } | undefined)?.error?._tag;
      return {
        succeeded: result.stopReason === "end",
        ...(tag !== undefined ? { stopCauseTag: tag } : {}),
      };
    },
    providerCalls: () => requests.length,
    providerRequests: () => requests,
    tickStarts: () => tickStarts,
    close: () => close(),
  };
};

describe("aisdk()", () => {
  runRecoveryConformance(recoveryFactory);
});
