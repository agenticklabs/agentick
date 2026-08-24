/**
 * `ctx.responseFormat` — the send's bound output shape, readable at dispatch.
 *
 * An EXPOSURE, not a mechanism: the executor carries the shape from the
 * dispatch context onto the handler ctx and does nothing else with it. No
 * validation, no completion tool — an app builds those on top.
 *
 * @verifiedBy this suite
 */

import { describe, expect, it } from "vitest";
import type { ResponseFormat, ToolHandlerCtx, ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { createTestHarness } from "../testing/index.js";

const format: ResponseFormat = {
  type: "json_schema",
  name: "answer",
  schema: { type: "object", properties: { verdict: { type: "string" } } },
};

function reg(name: string): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: `the ${name} tool`,
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

async function dispatchCapturingCtx(
  context: Parameters<
    Awaited<ReturnType<typeof createTestHarness>>["harness"]["dispatch"]
  >[0]["context"],
): Promise<ToolHandlerCtx> {
  let seen: ToolHandlerCtx | undefined;
  const { harness } = await createTestHarness({
    tools: [reg("done")],
    handlers: [
      {
        handlerRef: "h.done",
        handler: async (_input, { ctx }) => {
          seen = ctx;
          return [{ type: "text", text: "ok" }];
        },
      },
    ],
  });
  await harness.dispatch({ toolCallId: "c1", name: "done", input: { query: "x" }, context });
  if (seen === undefined) throw new Error("handler never ran");
  return seen;
}

describe("dispatchBody — ctx.responseFormat", () => {
  it("surfaces the execution's bound shape to the handler", async () => {
    const ctx = await dispatchCapturingCtx({ via: "model", responseFormat: format });
    expect(ctx.responseFormat).toEqual(format);
  });

  it("is absent when the send carried no responseFormat", async () => {
    const ctx = await dispatchCapturingCtx({ via: "model" });
    expect(ctx.responseFormat).toBeUndefined();
    expect(ctx).not.toHaveProperty("responseFormat");
  });

  it("reaches the host door too — the shape is the execution's, not the door's", async () => {
    const ctx = await dispatchCapturingCtx({ via: "dispatch", responseFormat: format });
    expect(ctx.responseFormat).toEqual(format);
  });

  it("does not leak into the handler's INPUT", async () => {
    let received: unknown;
    const { harness } = await createTestHarness({
      tools: [reg("done")],
      handlers: [
        {
          handlerRef: "h.done",
          handler: async (input) => {
            received = input;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });
    await harness.dispatch({
      toolCallId: "c1",
      name: "done",
      input: { query: "x" },
      context: { via: "model", responseFormat: format },
    });
    expect(received).toEqual({ query: "x" });
  });
});
