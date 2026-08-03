/**
 * `MALFORMED_FUNCTION_CALL` is a DISTINCT stop reason, and the provider's
 * explanation survives.
 *
 * Gemini emits this when the model tried to call a tool and produced something
 * the provider rejected. It used to fold into `"other"` — the old comment said
 * the underlying reason was "recoverable from raw if needed" and nothing ever
 * recovered it, so a loop could not tell this from a clean stop and simply
 * ended the execution.
 *
 * Observed in production as *"the model keeps stopping without calling
 * anything"*. The capture below is the REAL `finishMessage` from that run:
 * Gemini had written the tool call as Python source — importing `datetime`,
 * computing a week range, and wrapping the call in `print(default_api.…)` —
 * then aborted its own turn. That text is the entire diagnostic, and we were
 * discarding it.
 *
 * @see docs/proposals/v2/blueprint/95-explicit-surfacing.md — the same run
 */

import { describe, expect, it } from "vitest";
import type { GenerateContentResponse } from "@google/genai";

import { google } from "../google-adapter.js";

/** Verbatim from the round-trip capture that surfaced this. */
const FINISH_MESSAGE =
  "Malformed function call: from datetime import date, timedelta\n\n" +
  "today = date.today()\nstart_of_week = today - timedelta(days=today.weekday())\n" +
  'print(default_api.knowify__query(\n    _summary="Retrieving schedule",\n' +
  '    table="Allocations",\n))';

const adapter = google("gemini-2.5-flash");

function malformedResponse(): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Now, I'm pulling up her schedule." }] },
        finishReason: "MALFORMED_FUNCTION_CALL",
        finishMessage: FINISH_MESSAGE,
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  } as unknown as GenerateContentResponse;
}

describe("MALFORMED_FUNCTION_CALL", () => {
  it("normalizes to its own stop reason, NOT `other`", () => {
    const result = adapter.normalize(malformedResponse());
    expect(result.stopReason).toBe("malformed_tool_call");
    // The regression: folded to "other" it is indistinguishable from a clean
    // stop, and a loop ends the execution instead of re-ticking.
    expect(result.stopReason).not.toBe("other");
    expect(result.stopReason).not.toBe("end");
  });

  it("carries the provider's explanation on `stopMessage`", () => {
    const result = adapter.normalize(malformedResponse());
    expect(result.stopMessage).toBe(FINISH_MESSAGE);
    // The offending text is the point — it is what tells you the model wrote
    // Python instead of a function call.
    expect(result.stopMessage).toContain("default_api.knowify__query");
  });

  it("a clean stop carries no stopMessage", () => {
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

  it("the sibling tool-call rejections map the same way", () => {
    for (const reason of [
      "UNEXPECTED_TOOL_CALL",
      "TOO_MANY_TOOL_CALLS",
      "MISSING_THOUGHT_SIGNATURE",
    ]) {
      const raw = {
        candidates: [
          { content: { role: "model", parts: [{ text: "x" }] }, finishReason: reason, index: 0 },
        ],
        modelVersion: "gemini-2.5-flash",
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      } as unknown as GenerateContentResponse;
      // Labelled so a failure names WHICH reason regressed rather than just
      // reporting a bare string mismatch.
      expect(`${reason}=${adapter.normalize(raw).stopReason}`).toBe(
        `${reason}=malformed_tool_call`,
      );
    }
  });
});
