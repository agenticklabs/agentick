/**
 * ADR 99 recovery, parameterized for `google()`: a REAL
 * `MALFORMED_FUNCTION_CALL` — prose, no `functionCall` part, the whole
 * diagnostic in `finishMessage` — recovered by a REAL second provider call.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import React from "react";
import { describe } from "vitest";

import { runRecoveryConformance } from "@agentick/spec-conformance";
import type { RecoveryFactory, RecoveryStep, RecoveryTickStart } from "@agentick/spec-conformance";

import { createApp } from "@agentick/app/react";

import { google } from "../index.js";
import {
  StubGoogleClient,
  asClient,
  mkFinishChunk,
  mkResponse,
  mkTextChunk,
  type CannedResponse,
} from "../testing/index.js";

type GoogleResponse = Extract<CannedResponse, { kind: "non-streaming" }>["response"];

function Agent(): React.ReactElement {
  return React.createElement("section" as never, { id: "system" }, "You are a helpful agent.");
}

function malformed(): GoogleResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Now, I'm pulling up her schedule." }] },
        finishReason: "MALFORMED_FUNCTION_CALL",
        finishMessage: "Malformed function call: print(default_api.query(table='Allocations'))",
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  } as unknown as GoogleResponse;
}

function canned(step: RecoveryStep, stream: boolean): CannedResponse {
  if (stream) {
    return step === "malformed"
      ? { kind: "streaming", chunks: [malformed()] }
      : { kind: "streaming", chunks: [mkTextChunk("recovered"), mkFinishChunk({})] };
  }
  return {
    kind: "non-streaming",
    response: step === "malformed" ? malformed() : mkResponse({ text: "recovered" }),
  };
}

const recoveryFactory: RecoveryFactory = async (script) => {
  let stub = new StubGoogleClient([]);
  let close = async (): Promise<void> => {};
  const tickStarts: RecoveryTickStart[] = [];

  return {
    async run({ stream = true, tickFailurePolicy } = {}) {
      stub = new StubGoogleClient(script.map((step) => canned(step, stream)));
      const app = await createApp(React.createElement(Agent), {
        model: google("gemini-2.5-flash", { client: asClient(stub) }),
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

describe("google()", () => {
  runRecoveryConformance(recoveryFactory);
});
