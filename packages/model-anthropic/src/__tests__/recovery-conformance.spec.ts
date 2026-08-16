/**
 * ADR 99 recovery, parameterized for `anthropic()`: a streamed `tool_use`
 * whose argument fragments never close the object, recovered by a REAL second
 * provider call.
 *
 * SKIPPED, and the parameterization is kept armed so un-skipping is the whole
 * change: `translateEvent` coerces an unparseable `input_json_delta` buffer to
 * `{}` at `content_block_stop` and emits it as the summary `tool-call` delta,
 * which is what the accumulator's `toolCallInput` reads instead of the buffer.
 * So the tick SUCCEEDS with an empty-input tool call — the exact silent-wrong
 * dispatch ADR 99 slice 4a removed from the shared accumulator — and there is
 * no malformed generation for a policy to recover from.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import React from "react";
import { describe } from "vitest";

import { runRecoveryConformance } from "@agentick/spec-conformance";
import type { RecoveryFactory, RecoveryStep, RecoveryTickStart } from "@agentick/spec-conformance";

import { createApp } from "@agentick/app/react";

import { anthropic } from "../index.js";
import {
  StubAnthropicClient,
  asClient,
  mkContentBlockStartText,
  mkContentBlockStartToolUse,
  mkContentBlockStop,
  mkInputJsonDelta,
  mkMessageDelta,
  mkMessageStartEvent,
  mkMessageStop,
  mkTextDelta,
  type CannedResponse,
} from "./stub-anthropic-client.js";

function canned(step: RecoveryStep): CannedResponse {
  if (step === "malformed") {
    return {
      kind: "streaming",
      events: [
        mkMessageStartEvent({}),
        mkContentBlockStartToolUse(0, "toolu_1", "query"),
        mkInputJsonDelta(0, '{"table":"Alloc'),
        mkContentBlockStop(0),
        mkMessageDelta("tool_use", 3),
        mkMessageStop(),
      ],
    };
  }
  return {
    kind: "streaming",
    events: [
      mkMessageStartEvent({}),
      mkContentBlockStartText(0),
      mkTextDelta(0, "recovered"),
      mkContentBlockStop(0),
      mkMessageDelta("end_turn", 3),
      mkMessageStop(),
    ],
  };
}

function Agent(): React.ReactElement {
  return React.createElement("section" as never, { id: "system" }, "You are a helpful agent.");
}

const recoveryFactory: RecoveryFactory = async (script) => {
  let stub = new StubAnthropicClient([]);
  let close = async (): Promise<void> => {};
  const tickStarts: RecoveryTickStart[] = [];

  return {
    async run({ stream = true, tickFailurePolicy } = {}) {
      stub = new StubAnthropicClient(script.map(canned));
      const app = await createApp(React.createElement(Agent), {
        model: anthropic("claude-3-5-sonnet-latest", { client: asClient(stub) }),
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

// Non-streaming stays skipped for a different reason than streaming ever was:
// `messages.create` returns `tool_use.input` server-parsed, so an unparseable
// argument buffer cannot occur on that seam.
describe("anthropic()", () => {
  runRecoveryConformance(recoveryFactory, { nonStreaming: false });
});
