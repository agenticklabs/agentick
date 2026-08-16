/**
 * ADR 99 recovery, parameterized for `anthropic()`: a streamed `tool_use`
 * whose argument fragments never close the object, recovered by a REAL second
 * provider call.
 *
 * `translateEvent` withholds the summary `tool-call` delta when the buffer does
 * not parse, so the accumulator's `toolCallInput` reads the buffer and raises
 * — rather than the tick succeeding with an empty-input tool call, which is the
 * silent-wrong dispatch ADR 99 slice 4a removed from the shared accumulator.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import { describe } from "vitest";

import { createApp } from "@agentick/app";
import { timelineCompiler } from "@agentick/compiler/testing";
import { runRecoveryConformance } from "@agentick/spec-conformance";
import type { RecoveryFactory, RecoveryStep, RecoveryTickStart } from "@agentick/spec-conformance";

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

const recoveryFactory: RecoveryFactory = async (script) => {
  let stub = new StubAnthropicClient([]);
  let close = async (): Promise<void> => {};
  const tickStarts: RecoveryTickStart[] = [];

  return {
    async run({ stream = true, tickFailurePolicy } = {}) {
      stub = new StubAnthropicClient(script.map(canned));
      const app = await createApp(null, {
        compiler: timelineCompiler(),
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
