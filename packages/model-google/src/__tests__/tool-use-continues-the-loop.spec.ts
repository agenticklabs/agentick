/**
 * Gemini has NO tool-use finish reason.
 *
 * A candidate carrying `functionCall` parts still reports `finishReason: "STOP"`,
 * and `STOP` maps to the canonical `"end"` — which reads as "the model answered".
 * The loop's continuation disposition used to be
 * `stopReason === "tool_use" && toolResults.length > 0`, so on Google every tool
 * call ENDED its execution: the tool ran, the result was appended, and no model
 * ever saw it. The user had to send another message to make the agent look at
 * what it had just fetched.
 *
 * anthropic (native `tool_use`), openai (`tool_calls`) and ai-sdk (`tool-calls`)
 * all report it, so the break was Google-only and no provider-agnostic test could
 * see it. Both halves are now fixed — the loop keys on the CALLS rather than the
 * provider's finish word, and this adapter reports the canonical stop reason
 * truthfully. These tests pin the adapter half, in both paths.
 */

import { describe, expect, it } from "vitest";

import {
  StubGoogleClient,
  emptyTree,
  makeExecutor,
  mkFinishChunk,
  mkFunctionCallChunk,
  mkResponse,
  mkTarget,
} from "./stub-google-client.js";

describe("google() adapter — a candidate with functionCall parts stops for TOOL USE", () => {
  it("reports tool_use, not end, when the non-streaming candidate carries a call", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        // Exactly what Gemini sends: a function call AND finishReason STOP.
        response: mkResponse({
          toolCalls: [{ id: "call_1", name: "resource_read", args: { uri: "user://me" } }],
          finishReason: "STOP",
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.stopReason).toBe("tool_use");
    expect(t.result.toolCalls?.[0]?.name).toBe("resource_read");
  });

  it("reports tool_use on the STREAMING path too", async () => {
    const stub = new StubGoogleClient([
      {
        kind: "streaming",
        chunks: [
          mkFunctionCallChunk({ id: "call_1", name: "resource_read", args: { uri: "user://me" } }),
          mkFinishChunk({ finishReason: "STOP" }),
        ],
      },
    ]);
    const { exec } = await makeExecutor(stub, { stream: true });
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.stopReason).toBe("tool_use");
  });

  it("still reports end when STOP arrives with no call", async () => {
    // The correction must not fire on an ordinary answered turn.
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "done", finishReason: "STOP" }) },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.stopReason).toBe("end");
  });

  it("does NOT overwrite a non-STOP finish reason that came with a call", async () => {
    // MAX_TOKENS with a partial call is a truncation, not a clean tool stop —
    // reporting `tool_use` there would hide that the call may be incomplete.
    const stub = new StubGoogleClient([
      {
        kind: "non-streaming",
        response: mkResponse({
          toolCalls: [{ id: "call_1", name: "resource_read", args: { uri: "user://me" } }],
          finishReason: "MAX_TOKENS",
        }),
      },
    ]);
    const { exec } = await makeExecutor(stub);
    const t = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    if (t.outcome !== "succeeded") throw new Error("expected success");

    expect(t.result.stopReason).toBe("max_tokens");
  });
});
