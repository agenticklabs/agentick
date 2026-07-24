/**
 * Spine telemetry parity (ADR 64/78) — the LOOP half.
 *
 * The app's shared spine harnesses (loop / model executor / compiler) are
 * constructed before the app's async `telemetry` switch resolves, so they miss
 * the construction-time provider a per-session harness gets.
 * `BaseHarness.adoptTelemetry` late-binds the resolved provider; this proves a
 * loop-surface harness honors it: an interceptor on a REAL loop op
 * (`loop:run-execution`) emits a `ctx.metrics` count that reaches the wired
 * meter carrying the ambient `{ app, op }` labels.
 *
 * Driven through a `defineLoop` `CallbackLoop` — a genuine `BaseHarness<"loop">`
 * whose `runExecution()` routes through `runOperation`, so the interceptor
 * cascade + facet landing run exactly as they do in the bundled
 * `LoopExecutorHarness` (the mechanism lives in `BaseHarness`, identical across
 * loop impls).
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTerminal, RunExecutionInput } from "@agentick/spec-next";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  type TelemetryProvider,
} from "@agentick/runtime-next";
import { spyTelemetryProvider } from "@agentick/runtime-next/testing";

import { defineLoop } from "../define-loop.js";

/** The BaseHarness surface a spine harness exposes for interception + late-bind. */
type SpineLoop = {
  use(
    mw: (
      input: unknown,
      next: (i: unknown) => unknown,
      ctx: { op?: string; metrics: { count(name: string, n?: number): void } },
    ) => unknown,
  ): () => void;
  adoptTelemetry(
    provider: TelemetryProvider | undefined,
    defaultLabels?: Readonly<Record<string, string>>,
  ): void;
  runExecution(input: RunExecutionInput): Promise<ExecutionTerminal>;
};

function fakeInput(executionId: string, sessionId = "s_1"): RunExecutionInput {
  // The callback ignores these — cast to satisfy the type while exercising the
  // op wrapping (interceptor cascade + facet landing).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = {} as any;
  return {
    executionId,
    sessionId,
    compiler: stub,
    mountId: "m_1",
    modelExecutor: stub,
    target: { kind: "language-model", provider: "test", modelId: "x" },
    toolExecutor: stub,
    stateApplicator: stub,
    maxTicks: 1,
  };
}

describe("defineLoop CallbackLoop — spine telemetry parity (adoptTelemetry)", () => {
  it("an interceptor on loop:run-execution emits ctx.metrics reaching the meter with { app, op }", async () => {
    const spy = spyTelemetryProvider();
    const loop = defineLoop({
      runExecution: async () => ({ outcome: "succeeded" }) as ExecutionTerminal,
    })({
      scopeId: "loop-parity",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    }) as unknown as SpineLoop;

    // Constructed with NO provider (the spine's real state). Late-bind exactly
    // as the app does once telemetry resolves — provider + app-identity label.
    loop.adoptTelemetry(spy, { app: "acme" });

    loop.use((input, next, ctx) => {
      if (ctx.op === "LoopRunExecution") ctx.metrics.count("loop.hits", 1);
      return next(input);
    });

    await loop.runExecution(fakeInput("e_1"));

    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.loop.hits",
      value: 1,
      labels: { app: "acme", op: "LoopRunExecution" },
    });
  });
});
