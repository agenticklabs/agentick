/**
 * ADR 99 recovery, parameterized for `openai()`: a streamed tool call whose
 * argument fragments never close the object, which the shared accumulator
 * raises as `MalformedModelOutput` at finalize — recovered by a REAL second
 * provider call.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import React from "react";
import { describe } from "vitest";

import { runRecoveryConformance } from "@agentick/spec-conformance";
import type { RecoveryFactory, RecoveryStep, RecoveryTickStart } from "@agentick/spec-conformance";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources/chat/completions";

import { createApp } from "@agentick/app/react";

import { openai } from "../index.js";
import {
  StubOpenAIClient,
  asClient,
  mkCompletion,
  mkContentChunk,
  mkFinishChunk,
  type CannedResponse,
} from "./stub-openai-client.js";

function truncatedToolCallChunk(): ChatCompletionChunk {
  return {
    id: "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "query", arguments: '{"table":"Alloc' },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as ChatCompletionChunk;
}

function truncatedToolCallCompletion(): ChatCompletion {
  const completion = mkCompletion({
    toolCalls: [{ id: "call_1", name: "query", arguments: {} }],
  });
  const call = completion.choices[0].message.tool_calls![0] as { function: { arguments: string } };
  call.function.arguments = '{"table":"Alloc';
  return completion;
}

function canned(step: RecoveryStep, stream: boolean): CannedResponse {
  if (!stream) {
    return step === "malformed"
      ? { kind: "non-streaming", completion: truncatedToolCallCompletion() }
      : { kind: "non-streaming", completion: mkCompletion({ text: "recovered" }) };
  }
  return step === "malformed"
    ? {
        kind: "streaming",
        chunks: [truncatedToolCallChunk(), mkFinishChunk({ finishReason: "tool_calls" })],
      }
    : {
        kind: "streaming",
        chunks: [mkContentChunk({ delta: "recovered" }), mkFinishChunk({})],
      };
}

function Agent(): React.ReactElement {
  return React.createElement("section" as never, { id: "system" }, "You are a helpful agent.");
}

const recoveryFactory: RecoveryFactory = async (script) => {
  let stub = new StubOpenAIClient([]);
  let close = async (): Promise<void> => {};
  const tickStarts: RecoveryTickStart[] = [];

  return {
    async run({ stream = true, tickFailurePolicy } = {}) {
      stub = new StubOpenAIClient(script.map((s) => canned(s, stream)));
      const app = await createApp(React.createElement(Agent), {
        model: openai("gpt-4o-mini", { client: asClient(stub) }),
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
    providerCalls: () => stub.calls.length,
    providerRequests: () => stub.calls.map((c) => c.params),
    tickStarts: () => tickStarts,
    close: () => close(),
  };
};

describe("openai()", () => {
  runRecoveryConformance(recoveryFactory);
});
