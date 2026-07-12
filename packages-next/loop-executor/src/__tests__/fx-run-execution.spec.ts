/**
 * `LoopExecutorHarness.fx.runExecution` — the dual-typed edge on the loop
 * (ADR 77 Stage 2). Like the executor, the loop's `runExecution` is not a
 * registry command (its input carries live object refs, ADR 51 §1.2), so
 * `.fx` hand-exposes the `runOperation(op, body)` Effect the facade already
 * builds — un-run — rather than being `fxProxy`-derived.
 *
 * Proves the twin composes as an Effect and produces the SAME terminal as
 * the Promise facade. The internal tick body is still Promise-shaped — the
 * `Effect.gen` rewrite is Stage 3 (behind the characterization diff); this
 * is the additive, behavior-neutral seam.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  LanguageModelExecutionResult,
  ReconcilerProtocol,
  RenderedTree,
  RunExecutionInput,
  ToolExecutorProtocol,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";

import { LoopExecutorHarness } from "../harness.js";
import { NoopStateApplicator } from "../noop-state-applicator.js";

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

const okResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "hi" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const stubReconciler = (): ReconcilerProtocol =>
  ({
    mount: async () => ({ mountId: "fx-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    notifyLifecycle: async () => undefined,
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "fx-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  }) as unknown as ReconcilerProtocol;

const stubToolExecutor = (): ToolExecutorProtocol =>
  ({
    replaceReconcilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async () => ({ toolCallId: "t", name: "n", content: [], isError: false }),
  }) as unknown as ToolExecutorProtocol;

async function makeLoopAndInput(
  executionId: string,
): Promise<{ loop: LoopExecutorHarness; input: RunExecutionInput }> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const loop = new LoopExecutorHarness("loop_fx", journal, bus, inbox);
  await loop.ready;
  const executor = new FakeLanguageModelExecutor("exec_fx", journal, bus, inbox, {
    scripted: [{ result: okResult }],
  });
  await executor.ready;

  const input: RunExecutionInput = {
    sessionId: "s_fx",
    mountId: "fx-mount",
    reconciler: stubReconciler(),
    executor,
    toolExecutor: stubToolExecutor(),
    target: executor.target,
    stateApplicator: new NoopStateApplicator(),
    executionId,
    maxTicks: 2,
  };
  return { loop, input };
}

describe("LoopExecutorHarness — .fx.runExecution dual-typed edge", () => {
  it("fx.runExecution returns a composable Effect (not a Promise)", async () => {
    const { loop, input } = await makeLoopAndInput("e1");
    const eff = loop.fx.runExecution(input);

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const terminal = await Effect.runPromise(eff);
    expect(terminal.outcome).toBe("succeeded");
  });

  it("the plain runExecution() is the Promise facade", async () => {
    const { loop, input } = await makeLoopAndInput("e2");
    const p = loop.runExecution(input);

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);

    const terminal = await p;
    expect(terminal.outcome).toBe("succeeded");
  });

  it("both surfaces drive the same Operation → identical terminal outcome + ticks", async () => {
    const viaFx = await makeLoopAndInput("via-fx");
    const viaPromise = await makeLoopAndInput("via-promise");

    const fromFx = await Effect.runPromise(viaFx.loop.fx.runExecution(viaFx.input));
    const fromPromise = await viaPromise.loop.runExecution(viaPromise.input);

    expect(fromFx.outcome).toBe(fromPromise.outcome);
    expect(fromFx.result?.ticks).toBe(fromPromise.result?.ticks);
    expect(fromFx.result?.output).toEqual(fromPromise.result?.output);
  });
});
