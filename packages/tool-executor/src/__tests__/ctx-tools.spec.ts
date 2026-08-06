/**
 * `ctx.tools` (#273 phase 1) — the session's ToolsHandle as a substrate
 * primitive on handler ctx. A handler composes sibling tools through the same
 * journaled host door and the same `"dispatch"` exposure gate as any host-side
 * caller; nothing weaker rides on ctx.
 */

import { describe, expect, it } from "vitest";
import type { ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

function reg(name: string, exposure: readonly ("model" | "dispatch")[]): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: `tool ${name}`,
      inputSchema: jsonSchema({ type: "object" }),
      exposure,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

describe("ToolExecutorHarness — ctx.tools (#273)", () => {
  it("a handler dispatches a sibling tool through ctx.tools and gets its blocks", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("outer", ["model", "dispatch"]), reg("inner", ["dispatch"])],
      handlers: [
        {
          handlerRef: "h.outer",
          handler: async (_input, { ctx }) => {
            const [block] = await ctx.tools!.dispatch("inner", { from: "outer" });
            const text = block?.type === "text" ? block.text : "no text block";
            return [{ type: "text", text: `inner said: ${text}` }];
          },
        },
        {
          handlerRef: "h.inner",
          handler: async (input) => [{ type: "text", text: `echo:${JSON.stringify(input)}` }],
        },
      ],
    });

    const result = await harness.dispatch({
      toolCallId: "c1",
      name: "outer",
      input: {},
      context: { via: "dispatch" },
    });

    expect(result.isError ?? false).toBe(false);
    const [block] = result.content as readonly { type: string; text: string }[];
    expect(block.text).toContain('echo:{"from":"outer"}');
  });

  it("the dispatch exposure gate holds through ctx.tools — a model-only sibling rejects", async () => {
    let innerRan = false;
    const { harness } = await createTestHarness({
      tools: [reg("outer", ["model", "dispatch"]), reg("model-only", ["model"])],
      handlers: [
        {
          handlerRef: "h.outer",
          handler: async (_input, { ctx }) => {
            await expect(ctx.tools!.dispatch("model-only", {})).rejects.toThrow(/not exposed/);
            return [{ type: "text", text: "gate held" }];
          },
        },
        {
          handlerRef: "h.model-only",
          handler: async () => {
            innerRan = true;
            return [{ type: "text", text: "should never run" }];
          },
        },
      ],
    });

    const result = await harness.dispatch({
      toolCallId: "c2",
      name: "outer",
      input: {},
      context: { via: "dispatch" },
    });

    expect(result.isError ?? false).toBe(false);
    expect(JSON.stringify(result.content)).toContain("gate held");
    expect(innerRan).toBe(false);
  });

  it("ctx.tools reads the live registry from inside a handler", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("outer", ["model", "dispatch"]), reg("inner", ["dispatch"])],
      handlers: [
        {
          handlerRef: "h.outer",
          handler: async (_input, { ctx }) => {
            const names = ctx
              .tools!.list()
              .map((info) => info.name)
              .sort();
            return [{ type: "text", text: names.join(",") }];
          },
        },
        { handlerRef: "h.inner", handler: async () => [{ type: "text", text: "unused" }] },
      ],
    });

    const result = await harness.dispatch({
      toolCallId: "c3",
      name: "outer",
      input: {},
      context: { via: "dispatch" },
    });

    expect(JSON.stringify(result.content)).toContain("inner,outer");
  });
});
