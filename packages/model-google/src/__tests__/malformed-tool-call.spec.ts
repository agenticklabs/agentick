/**
 * `MALFORMED_FUNCTION_CALL` is a typed `MalformedModelOutput`, and the
 * provider's explanation survives.
 *
 * Gemini emits this family when the model tried to call a tool and produced
 * something the provider rejected. It first folded into `"other"` (a clean stop,
 * so the loop ended the execution), then into a distinct `malformed_tool_call`
 * stop reason — still a SUCCESS, still unrecoverable. Now that failed ticks
 * reach the session's decide fold (ADR 99 slice 2), it is raised on the error
 * channel where a retry policy can read its `_tag`.
 *
 * Observed in production as *"the model keeps stopping without calling
 * anything"*. The capture below is the REAL `finishMessage` from that run:
 * Gemini had written the tool call as Python source — importing `datetime`,
 * computing a week range, and wrapping the call in `print(default_api.…)` —
 * then aborted its own turn. That text is the entire diagnostic.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 * @see docs/proposals/v2/blueprint/95-explicit-surfacing.md — the same run
 */

import { describe, expect, it } from "vitest";
import type { GenerateContentResponse } from "@google/genai";

import { google } from "../google-adapter.js";
import { StubGoogleClient, emptyTree, makeExecutor, mkTarget } from "./stub-google-client.js";

/** Verbatim from the round-trip capture that surfaced this. */
const FINISH_MESSAGE =
  "Malformed function call: from datetime import date, timedelta\n\n" +
  "today = date.today()\nstart_of_week = today - timedelta(days=today.weekday())\n" +
  'print(default_api.knowify__query(\n    _summary="Retrieving schedule",\n' +
  '    table="Allocations",\n))';

const adapter = google("gemini-2.5-flash");

function malformedResponse(reason = "MALFORMED_FUNCTION_CALL"): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Now, I'm pulling up her schedule." }] },
        finishReason: reason,
        finishMessage: FINISH_MESSAGE,
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  } as unknown as GenerateContentResponse;
}

describe("MALFORMED_FUNCTION_CALL — the adapter", () => {
  it("raises MalformedModelOutput from normalize instead of returning a stop reason", () => {
    expect(() => adapter.normalize(malformedResponse())).toThrowError(
      expect.objectContaining({ _tag: "MalformedModelOutput" }),
    );
  });

  it("carries the provider's explanation as the error message", () => {
    try {
      adapter.normalize(malformedResponse());
    } catch (err) {
      // The offending text is the point — it is what tells you the model wrote
      // Python instead of a function call.
      expect((err as Error).message).toBe(FINISH_MESSAGE);
      expect((err as Error).message).toContain("default_api.knowify__query");
      return;
    }
    throw new Error("expected normalize to raise");
  });

  it("a clean stop still normalizes to a result", () => {
    const clean = {
      candidates: [
        { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 },
      ],
      modelVersion: "gemini-2.5-flash",
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    } as unknown as GenerateContentResponse;
    const result = adapter.normalize(clean);
    expect(result.stopReason).toBe("end");
    expect(result.stopMessage).toBeUndefined();
  });

  it("the sibling tool-call rejections raise the same way", () => {
    for (const reason of [
      "UNEXPECTED_TOOL_CALL",
      "TOO_MANY_TOOL_CALLS",
      "MISSING_THOUGHT_SIGNATURE",
    ]) {
      let tag: string | undefined;
      try {
        adapter.normalize(malformedResponse(reason));
      } catch (err) {
        tag = (err as { _tag?: string })._tag;
      }
      // Labelled so a failure names WHICH reason regressed rather than just
      // reporting a bare string mismatch.
      expect(`${reason}=${tag}`).toBe(`${reason}=MalformedModelOutput`);
    }
  });
});

// ============================================================================
// End-to-end through the REAL LanguageModelExecutor — the path recovery reads
// ============================================================================

describe("MALFORMED_FUNCTION_CALL — through the executor", () => {
  it("streaming: rejects the execution with MalformedModelOutput carrying the diagnostic", async () => {
    const stub = new StubGoogleClient([{ kind: "streaming", chunks: [malformedResponse()] }]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const projected = await exec.project({
      compiled: emptyTree(),
      target: mkTarget(),
      tools: [],
    });

    const stream = exec.executeStream({ targetInput: projected, target: mkTarget() });
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* drain */
        }
        await stream.result;
      })(),
    ).rejects.toMatchObject({ _tag: "MalformedModelOutput", message: FINISH_MESSAGE });
  });

  it("non-streaming: run() fails the terminal with MalformedModelOutput, not NormalizationFailed", async () => {
    // A terminal, not a rejection: `run` is the `stream: false` path into the
    // loop, and only a terminal reaches the decide fold that can retry it.
    const stub = new StubGoogleClient([{ kind: "non-streaming", response: malformedResponse() }]);
    const { exec } = await makeExecutor(stub);
    const terminal = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    expect(terminal).toMatchObject({
      outcome: "failed",
      error: { _tag: "MalformedModelOutput", message: FINISH_MESSAGE },
    });
  });
});
