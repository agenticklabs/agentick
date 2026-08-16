/**
 * ADR 99 end-to-end: a REAL Gemini malformed generation recovered by a REAL
 * second provider call.
 *
 * Every link in this chain is proven on its own elsewhere — the adapter's
 * classification (`model-google/malformed-tool-call.spec.ts`), the loop's fold
 * (`loop-executor/tick-failure-recovery.spec.ts`), the session's policy
 * (`session/tick-failure-recovery.spec.tsx`), the app option
 * (`tick-failure-policy.spec.tsx`). None of them composes the pieces: those all
 * inject the failure at a seam. Here the failure enters where production put it
 * — a `MALFORMED_FUNCTION_CALL` on the wire — and the assertion that matters is
 * `stub.calls`, because a retry that never reaches the provider is not a retry.
 *
 * The clean-timeline invariant is asserted at the PROVIDER boundary: byte-equal
 * request params across the two calls. That is the strongest form of the claim
 * ADR 99 rests on — a failed tick persists nothing, so the retry is not merely
 * a second attempt but the SAME request.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { google } from "../index.js";
import {
  StubGoogleClient,
  asClient,
  mkFinishChunk,
  mkResponse,
  mkTextChunk,
  type CannedResponse,
} from "../testing/index.js";
import type { TickFailurePolicy } from "@agentick/spec";

import { createApp } from "@agentick/app/react";

/** The provider response type the canned sequence carries. */
type GoogleResponse = Extract<CannedResponse, { kind: "non-streaming" }>["response"];

function Agent(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system" }, "You are a helpful agent."),
  );
}

/**
 * What Gemini sends when the model tried to call a tool and the provider
 * refused the result: prose, no `functionCall` part, and the whole diagnostic
 * in `finishMessage`.
 */
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

const streamingMalformed: CannedResponse = { kind: "streaming", chunks: [malformed()] };
const streamingGood: CannedResponse = {
  kind: "streaming",
  chunks: [mkTextChunk("recovered"), mkFinishChunk({})],
};
const nonStreamingMalformed: CannedResponse = { kind: "non-streaming", response: malformed() };
const nonStreamingGood: CannedResponse = {
  kind: "non-streaming",
  response: mkResponse({ text: "recovered" }),
};

interface TickStart {
  readonly kind: string;
  readonly tickIndex: number;
  readonly retryOfTick?: number;
}

async function mkApp(
  sequence: readonly CannedResponse[],
  options: { readonly tickFailurePolicy?: TickFailurePolicy } = {},
) {
  const stub = new StubGoogleClient(sequence);
  const app = await createApp(React.createElement(Agent), {
    model: google("gemini-2.5-flash", { client: asClient(stub) }),
    ...(options.tickFailurePolicy !== undefined
      ? { tickFailurePolicy: options.tickFailurePolicy }
      : {}),
  });

  const tickStarts: TickStart[] = [];
  app.hook({
    onLoopRunExecutionChunk: {
      observe: (event) => {
        const e = event as unknown as TickStart;
        if (e.kind === "tick-start") tickStarts.push(e);
      },
    },
  });

  return { app, stub, tickStarts };
}

/** The full request the adapter put on the wire, for byte-comparison. */
const requestOf = (stub: StubGoogleClient, i: number): string =>
  JSON.stringify(stub.calls[i]!.params);

describe("ADR 99 end-to-end — a real malformed generation, a real retry", () => {
  it("streaming: the default policy recovers on a second provider call", async () => {
    const { app, stub, tickStarts } = await mkApp([streamingMalformed, streamingGood]);

    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "what is on her schedule?" }], stream: true },
    });

    expect(result.stopReason).toBe("end");
    expect(result.response).toBe("recovered");
    expect(result.ticks).toBe(2);

    // The load-bearing assertion: the retry went to the PROVIDER, twice.
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.every((c) => c.streaming)).toBe(true);

    // And it was the same request — the failed tick persisted nothing.
    expect(requestOf(stub, 1)).toEqual(requestOf(stub, 0));

    expect(tickStarts.map((e) => e.tickIndex)).toEqual([1, 2]);
    expect(tickStarts[0]!.retryOfTick).toBeUndefined();
    expect(tickStarts[1]!.retryOfTick).toBe(1);

    await app.closeApp();
  });

  it("streaming: a model that stays malformed spends the budget and stops", async () => {
    const { app, stub } = await mkApp([streamingMalformed, streamingMalformed]);

    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }], stream: true },
    });

    expect(result.stopReason).toBe("executor_failed");
    expect(result.stopCause).toMatchObject({
      kind: "failed",
      error: { _tag: "MalformedModelOutput" },
    });
    // The bundled policy retries ONCE — two attempts, not three.
    expect(stub.calls).toHaveLength(2);

    await app.closeApp();
  });

  it("non-streaming: the same recovery through run(), not executeStream()", async () => {
    const { app, stub } = await mkApp([nonStreamingMalformed, nonStreamingGood]);

    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }], stream: false },
    });

    expect(result.stopReason).toBe("end");
    expect(result.response).toBe("recovered");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.every((c) => c.streaming)).toBe(false);
    expect(requestOf(stub, 1)).toEqual(requestOf(stub, 0));

    await app.closeApp();
  });

  it("a supplied policy rules — a zero budget never reaches the provider twice", async () => {
    const { app, stub } = await mkApp([streamingMalformed, streamingGood], {
      tickFailurePolicy: { MalformedModelOutput: 0 },
    });

    const { result } = await app.runOnce({
      send: { messages: [{ role: "user", content: "x" }], stream: true },
    });

    expect(result.stopReason).toBe("executor_failed");
    expect(stub.calls).toHaveLength(1);

    await app.closeApp();
  });
});
