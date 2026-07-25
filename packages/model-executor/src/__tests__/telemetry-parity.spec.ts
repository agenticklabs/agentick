/**
 * Spine telemetry parity (ADR 64/78) — the MODEL executor half.
 *
 * The app's shared spine harnesses (loop / model executor / compiler) are
 * constructed before the app's async `telemetry` switch resolves, so they miss
 * the construction-time provider a per-session harness (tool executor, session)
 * gets. `BaseHarness.adoptTelemetry` late-binds the resolved provider; this
 * proves the model executor honors it: an interceptor on a REAL model op
 * (`model:generate`, driven via `execute()`) emits a `ctx.metrics` count that
 * reaches the wired meter carrying the ambient `{ app, op }` labels.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  ProjectInput,
  RenderedTree,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { spyTelemetryProvider } from "@agentick/runtime/testing";

import { LanguageModelExecutor } from "../language-model-executor.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

interface StubRaw {
  readonly text: string;
}

const TARGET: ExecutionTarget = { kind: "language-model", provider: "stub", modelId: "stub-v1" };

function stubAdapter(): LanguageModelAdapter<StubRaw, never> {
  return {
    provider: "stub",
    target: TARGET,
    streamByDefault: false,
    prepareRequest: () => ({}),
    send: () => Promise.resolve({ text: "ok" }),
    async *openStream(): AsyncIterable<never> {},
    mapChunk: () => [] as readonly AdapterDelta[],
    reconstructRaw: (_accum: StreamAccumulatorView): StubRaw => ({ text: "ok" }),
    normalize: (raw: StubRaw): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  };
}

const emptyTree = (): RenderedTree => ({ specVersion: "2026-05-08", context: { entries: [] } });
const projectInput = (): ProjectInput => ({ compiled: emptyTree(), target: TARGET, tools: [] });
const executeInput = (targetInput: LanguageModelInput): ExecuteInput<LanguageModelInput> => ({
  targetInput,
  target: TARGET,
});

describe("LanguageModelExecutor — spine telemetry parity (adoptTelemetry)", () => {
  it("an interceptor on model:generate emits ctx.metrics reaching the meter with { app, op }", async () => {
    const spy = spyTelemetryProvider();
    const exec = new LanguageModelExecutor<StubRaw, never>(
      "exec-parity",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { adapter: stubAdapter() },
    );
    await exec.ready;

    // Constructed with NO provider (the spine's real state). Late-bind exactly
    // as the app does once telemetry resolves — provider + app-identity label.
    exec.adoptTelemetry(spy, { app: "acme" });

    // An interceptor on this harness's ops. It fires on project + generate; emit
    // the metric only from generate so the assertion is unambiguous.
    exec.use((input, next, ctx) => {
      if (ctx.op === "ModelGenerate") ctx.metrics.count("generate.hits", 1);
      return next(input);
    });

    const projected = await exec.project(projectInput());
    await exec.execute(executeInput(projected));

    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.generate.hits",
      value: 1,
      labels: { app: "acme", op: "ModelGenerate" },
    });

    await exec.close();
  });
});
