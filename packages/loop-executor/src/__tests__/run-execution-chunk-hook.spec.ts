/**
 * `onLoopRunExecutionChunk` — the free per-chunk observability that falls out
 * of making `loop:run-execution` a `commandStream` (streaming-up, ADR 51 §2 +
 * ADR 80 Phase 2).
 *
 * Because the run's events ARE the command's chunks, the derived
 * `onLoopRunExecutionChunk` interceptor taps every `LoopExecutionEvent` a run
 * produces — the run body's bookends (`execution-start` / `tick-end` / `tick` /
 * `execution-end`) AND each `loop:tick`'s events (`tick-start`, model deltas,
 * tool-dispatch lifecycle), in emission order, on the run's own fiber. The tap
 * fires on the drain-only Promise facade too (an `observe` stage runs before
 * the no-op downstream sink), so an observer needs NO event sink of its own.
 * This is the payoff: observability with zero wiring, from the same machinery
 * `model:generate_stream` already uses.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  LanguageModelExecutionResult,
  LoopExecutionEvent,
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

const endResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const stubCompiler = (): CompilerProtocol =>
  ({
    fx: {
      use: () => () => {},
      renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "chunk-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    unmount: async () => undefined,
  }) as unknown as CompilerProtocol;

const stubToolExecutor = (): ToolExecutorProtocol =>
  ({
    fx: {
      use: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ toolCallId: "t", name: "n", content: [], isError: false }),
    },
  }) as unknown as ToolExecutorProtocol;

async function makeLoopAndInput(
  executionId: string,
): Promise<{ loop: LoopExecutorHarness; input: RunExecutionInput }> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const loop = new LoopExecutorHarness("loop_chunk", journal, bus, inbox);
  await loop.ready;
  const executor = new FakeLanguageModelExecutor("exec_chunk", journal, bus, inbox, {
    scripted: [{ result: endResult }],
  });
  await executor.ready;

  const input: RunExecutionInput = {
    sessionId: "s_chunk",
    mountId: "chunk-mount",
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

describe("onLoopRunExecutionChunk — free execution-event observability", () => {
  it("a chunk observer sees the run's events (on the drain-only facade path)", async () => {
    const { loop, input } = await makeLoopAndInput("e_chunk_1");
    const seen: LoopExecutionEvent[] = [];
    loop.hook({
      onLoopRunExecutionChunk: {
        observe: (e) => {
          seen.push(e);
        },
      },
    });

    // The FACADE path (no caller sink) — proves the observer taps chunks even
    // when nothing downstream drains them.
    const terminal = await loop.runExecution(input);
    expect(terminal.outcome).toBe("succeeded");

    const kinds = seen.map((e) => e.kind);
    // Run-body bookends + tick-body events all reach the observer.
    for (const k of ["execution-start", "tick-start", "tick-end", "tick", "execution-end"]) {
      expect(kinds).toContain(k);
    }
    // Emission ORDER is preserved: the run brackets the tick.
    expect(kinds.indexOf("execution-start")).toBeLessThan(kinds.indexOf("tick-start"));
    expect(kinds.indexOf("tick-start")).toBeLessThan(kinds.indexOf("tick-end"));
    expect(kinds.indexOf("tick-end")).toBeLessThan(kinds.indexOf("execution-end"));
  });

  it("unsubscribing the chunk observer stops the taps", async () => {
    const { loop, input } = await makeLoopAndInput("e_chunk_2");
    const seen: LoopExecutionEvent[] = [];
    const off = loop.hook({
      onLoopRunExecutionChunk: {
        observe: (e) => {
          seen.push(e);
        },
      },
    });
    off();

    await loop.runExecution(input);
    expect(seen).toHaveLength(0);
  });
});
