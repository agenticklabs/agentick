/**
 * `LoopExecutorHarness.fx.runExecution` — the dual-typed edge on the loop
 * (ADR 77 Stage 2). Streaming-up (ADR 51 §2): `loop:run-execution` is a
 * `commandStream`, so `.fx` is its sink-fold face (`fx(input, sink)`) and the
 * Promise `runExecution(input)` facade is its `.run` face (drain with a no-op
 * sink). Both drive the SAME streaming command.
 *
 * Proves the twin composes as an Effect and produces the SAME terminal as
 * the Promise facade (the event sink is a no-op here — event drainage is
 * covered by `run-execution-chunk-hook.spec.ts` + the characterization suite).
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  LanguageModelExecutionResult,
  CompilerProtocol,
  RenderedTree,
  RunExecutionInput,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";

import { LoopExecutorHarness } from "../harness.js";
import { NoopStateApplicator } from "../noop-state-applicator.js";

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

const okResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "hi" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const stubCompiler = (): CompilerProtocol =>
  ({
    fx: {
      use: () => () => {},
      guard: () => () => {},
      renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "fx-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "fx-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  }) as unknown as CompilerProtocol;

const stubToolExecutor = (): ToolExecutorProtocol =>
  ({
    fx: {
      use: () => () => {},
      guard: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ toolCallId: "t", name: "n", content: [], isError: false }),
    },
    replaceCompilerTools: async () => undefined,
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
    compiler: stubCompiler(),
    modelExecutor: executor,
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
    const eff = loop.fx.runExecution(input, () => Effect.void);

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

    const fromFx = await Effect.runPromise(
      viaFx.loop.fx.runExecution(viaFx.input, () => Effect.void),
    );
    const fromPromise = await viaPromise.loop.runExecution(viaPromise.input);

    expect(fromFx.outcome).toBe(fromPromise.outcome);
    expect(fromFx.result?.ticks).toBe(fromPromise.result?.ticks);
    expect(fromFx.result?.output).toEqual(fromPromise.result?.output);
  });
});
