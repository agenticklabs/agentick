/**
 * Spine telemetry parity (ADR 64/78) — the COMPILER half.
 *
 * The app's shared spine harnesses (loop / model executor / compiler) are
 * constructed before the app's async `telemetry` switch resolves, so they miss
 * the construction-time provider a per-session harness gets.
 * `BaseHarness.adoptTelemetry` late-binds the resolved provider; this proves a
 * compiler-surface harness honors it: an interceptor on a REAL compiler op
 * (`compiler:mount`) emits a `ctx.metrics` count that reaches the wired meter
 * carrying the ambient `{ app, op }` labels.
 *
 * Driven through a `defineCompiler` `CallbackCompiler` — a genuine
 * `BaseHarness<"compiler">` whose `mount()` routes through `runOperation`, so
 * the interceptor cascade + facet landing run exactly as they do in the bundled
 * React `CompilerHarness` (the mechanism lives in `BaseHarness`, identical
 * across compiler impls).
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";

import type { MountResult, RenderTreeResult } from "@agentick/spec";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  type TelemetryProvider,
} from "@agentick/runtime";
import { spyTelemetryProvider } from "@agentick/runtime/testing";

import { defineCompiler } from "../define-compiler.js";
import { fakeBridges } from "../testing/fake-bridges.js";

/** The BaseHarness surface a spine harness exposes for interception + late-bind. */
type SpineCompiler = {
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
};

const mountInput = () =>
  ({ mountId: "m_1", sessionId: "test-session", element: null, bridges: fakeBridges() }) as const;

const fakeRenderTreeResult = (): RenderTreeResult => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: { context: { entries: [] }, declarations: {} } as any,
  diagnostics: [],
  iterations: 1,
});

describe("defineCompiler CallbackCompiler — spine telemetry parity (adoptTelemetry)", () => {
  it("an interceptor on compiler:mount emits ctx.metrics reaching the meter with { app, op }", async () => {
    const spy = spyTelemetryProvider();
    const compiler = defineCompiler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }) as MountResult,
      unmount: async () => {},
      renderTree: async () => fakeRenderTreeResult(),
    })({
      scopeId: "compiler-parity",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    }) as unknown as SpineCompiler & {
      mount(i: ReturnType<typeof mountInput>): Promise<MountResult>;
    };

    // Constructed with NO provider (the spine's real state). Late-bind exactly
    // as the app does once telemetry resolves — provider + app-identity label.
    compiler.adoptTelemetry(spy, { app: "acme" });

    compiler.use((input, next, ctx) => {
      if (ctx.op === "CompilerMount") ctx.metrics.count("mount.hits", 1);
      return next(input);
    });

    await compiler.mount(mountInput());

    expect(spy.metrics).toContainEqual({
      kind: "count",
      name: "agentick.mount.hits",
      value: 1,
      labels: { app: "acme", op: "CompilerMount" },
    });
  });
});
