/**
 * An argument buffer that does not parse is a FAILURE, not an empty object
 * (ADR 99 slice 4a).
 *
 * `toolCallInput` used to swallow the parse error and return `{}`. Under
 * `fromStandardSchema` that produced a validation error against arguments the
 * model never sent; under `permissiveValidator` — the validator bridged MCP
 * tools get — the tool RAN, with empty input, and nothing anywhere said so.
 *
 * The raise happens at finalize, where the stream becomes a result: there is no
 * faithful `tool_use` block to persist, so the recovery available to this class
 * is a retry, not feedback (ADR 99 §"retry when there is nothing coherent to
 * show the model").
 */

import { describe, expect, it } from "vitest";
import { MalformedModelOutput } from "@agentick/spec";

import { defaultFinalizeStream } from "../language-model-adapter.js";
import { StreamAccumulator } from "../stream-accumulator.js";

/** Drive the accumulator the way a streaming adapter does — name, then fragments. */
function streamToolCall(accum: StreamAccumulator, callId: string, ...fragments: string[]): void {
  accum.apply({ type: "tool-call-start", blockIndex: 0, callId, name: "knowify__query" });
  for (const delta of fragments) accum.apply({ type: "tool-call-delta", callId, delta });
}

describe("unparseable tool arguments", () => {
  it("fails the finalize instead of dispatching `{}`", () => {
    const accum = new StreamAccumulator();
    // The production shape: the model stopped mid-object, so the buffer is a
    // JSON prefix. `{}` would be a DIFFERENT, valid-looking call.
    streamToolCall(accum, "call_1", '{"table":"Alloc');

    expect(() => defaultFinalizeStream(accum)).toThrow(MalformedModelOutput);
  });

  it("names the tool and keeps the offending text on the error", () => {
    const accum = new StreamAccumulator();
    streamToolCall(accum, "call_1", '{"table":"Alloc');

    try {
      accum.toolCallInput("call_1");
      expect.unreachable("toolCallInput must raise on an unparseable buffer");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedModelOutput);
      expect((err as MalformedModelOutput).toolName).toBe("knowify__query");
      expect((err as MalformedModelOutput).rawArguments).toBe('{"table":"Alloc');
    }
  });

  it("is raised through content assembly too — no `{}` reaches a tool_use block", () => {
    const accum = new StreamAccumulator();
    streamToolCall(accum, "call_1", "print(default_api.knowify__query(");

    expect(() => accum.toContentBlocks()).toThrow(MalformedModelOutput);
  });

  it("an EMPTY buffer is still legal and still means `{}`", () => {
    // A no-argument tool call streams no fragments. That is not malformation.
    const accum = new StreamAccumulator();
    streamToolCall(accum, "call_1");

    expect(accum.toolCallInput("call_1")).toEqual({});
    expect(defaultFinalizeStream(accum).some((d) => d.type === "tool-call")).toBe(true);
  });

  it("the summary-set input path is untouched — a parsed input wins over the buffer", () => {
    // Providers that deliver the parsed object (`tool-call` with `input`) never
    // reach the parse at all, whatever the buffer happens to hold.
    const accum = new StreamAccumulator();
    streamToolCall(accum, "call_1", "{ not json");
    accum.apply({ type: "tool-call", callId: "call_1", name: "knowify__query", input: { a: 1 } });

    expect(accum.toolCallInput("call_1")).toEqual({ a: 1 });
    expect(() => defaultFinalizeStream(accum)).not.toThrow();
  });
});
