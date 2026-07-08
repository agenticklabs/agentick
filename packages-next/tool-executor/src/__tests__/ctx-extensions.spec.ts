/**
 * ADR 66 — generic, harness-agnostic `ctx` extension seam.
 *
 * The executor takes ONE opaque `ctxExtensions` construction option and
 * spreads it onto every handler's `ctx`. It never imports or inspects
 * the values — their types come from `ToolHandlerCtxExtensions`
 * augmentations, their values from the wiring layer. These tests prove
 * the mechanics with a plain record (no sandbox dependency here — that's
 * the whole point of the layering):
 *
 *   - present  → the record's keys surface as top-level `ctx.<key>`,
 *   - fresh    → reads hit the LIVE object, not a render-time snapshot,
 *   - absent   → keys are `undefined` when nothing is injected,
 *   - safe     → an extension key never shadows a universal ctx field.
 */

import { describe, expect, it } from "vitest";
import type { ToolHandlerCtx, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { createTestHarness } from "../testing/index.js";

function probeReg(name = "probe"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "probe ctx",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

describe("ToolExecutorHarness — ctxExtensions seam (ADR 66)", () => {
  it("spreads injected extension values onto ctx as top-level fields", async () => {
    const injected = { tag: "the-bridge" };
    let seen: ToolHandlerCtx | undefined;
    const { harness } = await createTestHarness({
      tools: [probeReg()],
      ctxExtensions: { sandbox: injected },
      handlers: [
        {
          handlerRef: "h.probe",
          handler: async (_input, { ctx }) => {
            seen = ctx;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const result = await harness.dispatch({
      toolCallId: "c1",
      name: "probe",
      input: {},
      context: { via: "dispatch" },
    });

    expect(result.succeeded).toBe(true);
    // The exact same reference the wiring layer injected — opaque spread,
    // not a copy.
    expect((seen as unknown as { sandbox: unknown }).sandbox).toBe(injected);
  });

  it("reads hit the live object — fresh per dispatch, not a render capture", async () => {
    // A single stable record reference injected once at construction,
    // holding a mutable field. Mutating it between dispatches must be
    // visible to the handler — this is the distinction from the old
    // render-captured `use` bag (which froze the value at render time).
    const live = { generation: 1 };
    const { harness } = await createTestHarness({
      tools: [probeReg()],
      ctxExtensions: { sandbox: live },
      handlers: [
        {
          handlerRef: "h.probe",
          handler: async (_input, { ctx }) => {
            const s = (ctx as unknown as { sandbox: { generation: number } }).sandbox;
            return [{ type: "text", text: String(s.generation) }];
          },
        },
      ],
    });

    const first = await harness.dispatch({
      toolCallId: "c1",
      name: "probe",
      input: {},
      context: { via: "dispatch" },
    });
    expect(first.content).toEqual([{ type: "text", text: "1" }]);

    live.generation = 2;

    const second = await harness.dispatch({
      toolCallId: "c2",
      name: "probe",
      input: {},
      context: { via: "dispatch" },
    });
    expect(second.content).toEqual([{ type: "text", text: "2" }]);
  });

  it("leaves extension fields undefined when none are injected", async () => {
    let seen: ToolHandlerCtx | undefined;
    const { harness } = await createTestHarness({
      tools: [probeReg()],
      handlers: [
        {
          handlerRef: "h.probe",
          handler: async (_input, { ctx }) => {
            seen = ctx;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    await harness.dispatch({
      toolCallId: "c1",
      name: "probe",
      input: {},
      context: { via: "dispatch" },
    });

    expect((seen as unknown as { sandbox?: unknown }).sandbox).toBeUndefined();
  });

  it("never lets an extension key shadow a universal ctx field", async () => {
    let seen: ToolHandlerCtx | undefined;
    const { harness } = await createTestHarness({
      tools: [probeReg()],
      // Malicious/accidental collision — the universal field must win.
      ctxExtensions: { toolCallId: "HIJACKED", transport: "mcp" },
      handlers: [
        {
          handlerRef: "h.probe",
          handler: async (_input, { ctx }) => {
            seen = ctx;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    await harness.dispatch({
      toolCallId: "real-id",
      name: "probe",
      input: {},
      context: { via: "dispatch" },
    });

    expect(seen?.toolCallId).toBe("real-id");
    expect(seen?.transport).toBe("in-process");
  });
});
