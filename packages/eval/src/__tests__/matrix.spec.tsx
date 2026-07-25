/**
 * `.matrix(axes, opts?)` — cartesian-product parameter sweeps.
 *
 *   - product semantics: cells = ∏(axis lengths)
 *   - axes shape: each cell is the resolved override record
 *   - empty-axis behavior: zero cells, passed=true (vacuous)
 *   - empty-axes behavior: one cell (equivalent to myEval())
 *   - concurrency: bounded by opts.concurrency, default 1
 *   - aggregate passed = AND across all cell results
 */

import React from "react";

import { createApp } from "@agentick/app/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { defineEval } from "../index.js";

const Agent = (): React.ReactElement =>
  React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: false },
  };
}

function mkOkExecutor(label: string): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `matrix-exec-${label}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: `ok-${label}` }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ],
    },
  );
}

type Overrides = { executor?: FakeLanguageModelExecutor; tag?: string };

const myEval = defineEval<Overrides>({
  description: "matrix smoke",
  app: (o) =>
    createApp(React.createElement(Agent), {
      modelExecutor: o?.executor ?? mkOkExecutor("default"),
      target: mkTarget(),
    }),
  async test(t) {
    await t.send("hi");
    t.completed();
  },
});

describe("CallableEval.matrix", () => {
  it("runs the cartesian product of axis values", async () => {
    const a = mkOkExecutor("a");
    const b = mkOkExecutor("b");
    const matrix = await myEval.matrix({
      executor: [a, b],
      tag: ["x", "y"],
    });

    // 2 × 2 = 4 cells.
    expect(matrix.cells).toHaveLength(4);

    // Every cell carries its resolved axis values.
    expect(matrix.cells.map((c) => [c.axes.executor, c.axes.tag])).toEqual([
      [a, "x"],
      [a, "y"],
      [b, "x"],
      [b, "y"],
    ]);

    // All cells pass → aggregate passed.
    expect(matrix.passed).toBe(true);
    expect(matrix.cells.every((c) => c.stats.passRate > 0.5)).toBe(true);
  });

  it("empty axes record yields one cell (equivalent to myEval())", async () => {
    const matrix = await myEval.matrix({});
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]!.stats.passRate > 0.5).toBe(true);
    expect(matrix.passed).toBe(true);
  });

  it("trials runs each cell N times and collapses into a distribution", async () => {
    // A fresh executor per call (so each of the N trials is an independent run),
    // one config → `matrix({}, { trials })` is the single-config-N-times form.
    const trialsEval = defineEval<Overrides>({
      description: "trials",
      app: () =>
        createApp(React.createElement(Agent), {
          modelExecutor: mkOkExecutor("t"),
          target: mkTarget(),
        }),
      async test(t) {
        await t.send("hi");
        t.completed();
        t.score("q", 1);
      },
    });

    const matrix = await trialsEval.matrix({}, { trials: 3, k: 2 });
    expect(matrix.cells).toHaveLength(1);
    const cell = matrix.cells[0]!;
    expect(cell.trials).toHaveLength(3); // ran 3 times
    expect(cell.stats.trials).toBe(3);
    expect(cell.stats.passed).toBe(3);
    expect(cell.stats.passRate).toBe(1);
    expect(cell.stats.passAtK).toBe(1); // k set → pass@k present
    expect(cell.stats.scores.q).toMatchObject({ mean: 1, n: 3, stddev: 0 });
  });

  it("axis with empty array yields zero cells (vacuous pass)", async () => {
    const matrix = await myEval.matrix({ executor: [] });
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.passed).toBe(true);
  });

  it("aggregate passed is AND across cells", async () => {
    const failing = defineEval<Overrides>({
      description: "matrix failure",
      app: (o) =>
        createApp(React.createElement(Agent), {
          modelExecutor: o?.executor ?? mkOkExecutor("default"),
          target: mkTarget(),
        }),
      // Assert completed only — but flip the bar by asserting a tool
      // call that never happened, so half the cells fail.
      async test(t) {
        await t.send("hi");
        t.calledTool("never-called");
      },
    });

    const matrix = await failing.matrix({ tag: ["a", "b"] });
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((c) => c.stats.passRate <= 0.5)).toBe(true);
    expect(matrix.passed).toBe(false);
  });

  it("respects opts.concurrency", async () => {
    // Build a fresh executor PER call so each cell uses an
    // independent scripted-output channel.
    const slowEval = defineEval<Overrides>({
      description: "concurrency probe",
      app: (o) =>
        createApp(React.createElement(Agent), {
          modelExecutor: o?.executor ?? mkOkExecutor("c"),
          target: mkTarget(),
        }),
      async test(t) {
        await t.send("hi");
        t.completed();
      },
    });

    const items = [mkOkExecutor("0"), mkOkExecutor("1"), mkOkExecutor("2"), mkOkExecutor("3")];
    const matrix = await slowEval.matrix({ executor: items }, { concurrency: 2 });
    // Smoke: all four cells ran successfully under cap.
    expect(matrix.cells).toHaveLength(4);
    expect(matrix.passed).toBe(true);
  });
});
