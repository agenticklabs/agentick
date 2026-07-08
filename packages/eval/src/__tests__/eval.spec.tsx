/**
 * @agentick/eval — matrix math + one end-to-end run against the core
 * test adapter (real createApp/session/tool flow, no live model).
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, createTool, Model, System, Timeline } from "@agentick/core";
import { createTestAdapter } from "@agentick/core/testing";

import { cartesian, defineEval, mapConcurrent } from "../define-eval.js";

describe("cartesian", () => {
  it("empty axes → one empty cell", () => {
    expect(cartesian({})).toEqual([{}]);
  });

  it("one axis → one cell per value", () => {
    expect(cartesian({ model: ["a", "b"] })).toEqual([{ model: "a" }, { model: "b" }]);
  });

  it("two axes → full product", () => {
    const cells = cartesian({ model: ["a", "b"], doc: [1, 2] });
    expect(cells).toHaveLength(4);
    expect(cells).toContainEqual({ model: "b", doc: 2 });
  });

  it("an empty axis → zero cells", () => {
    expect(cartesian({ model: [] })).toEqual([]);
  });
});

describe("mapConcurrent", () => {
  it("preserves order and respects the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("defineEval — end-to-end against the test adapter", () => {
  function makeApp(response = "done") {
    const model = createTestAdapter({ defaultResponse: response });
    model.respondWith([{ tool: { name: "submit", input: { total: 42 } } }]);

    const Submit = createTool({
      name: "submit",
      description: "submit a result",
      input: z.object({ total: z.number() }),
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <Submit />
      </>
    );
    return createApp(Agent, { maxTicks: 4 });
  }

  it("runs, observes tool calls, records assertions", async () => {
    const myEval = defineEval({
      description: "submits a result",
      app: () => makeApp(),
      test: async (t) => {
        await t.send("go");
        t.completed();
        t.calledTool("submit", { input: { total: 42 } });
        t.notCalledTool("delete_everything");
        t.noFailedActions();
        const call = t.lastToolCall("submit");
        t.expect("total is 42", (call?.input as { total: number })?.total === 42, {
          details: call?.input,
        });
      },
    });

    const result = await myEval();
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(5);
    expect(result.toolCalls.some((c) => c.name === "submit")).toBe(true);
  });

  it("failed assertions mark the result failed without throwing", async () => {
    const myEval = defineEval({
      description: "wrong expectations",
      app: () => makeApp(),
      test: async (t) => {
        await t.send("go");
        t.calledTool("nonexistent_tool");
      },
    });

    const result = await myEval();
    expect(result.passed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.assertions[0]!.passed).toBe(false);
  });

  it("matrix runs one cell per axis value", async () => {
    const myEval = defineEval<{ label?: string }>({
      description: "matrix",
      app: () => makeApp(),
      test: async (t) => {
        await t.send("go");
        t.calledTool("submit");
      },
    });

    const sweep = await myEval.matrix({ label: ["a", "b"] });
    expect(sweep.cells).toHaveLength(2);
    expect(sweep.passed).toBe(true);
    expect(sweep.cells.map((c) => c.axes.label)).toEqual(["a", "b"]);
  });
});
