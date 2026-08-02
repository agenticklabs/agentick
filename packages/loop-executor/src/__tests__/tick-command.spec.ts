/**
 * `loop:tick` command (ADR 89 §3) — the per-tick round is a declared command
 * on the loop harness, minting `onBeforeLoopTick` / `onAfterLoopTick`.
 *
 * Pins the §3 contract the rewrite must hold:
 *   - `onBeforeLoopTick` fires per tick, over the `TickInput` (reads
 *     `tickIndex` / `tickId`); `onAfterLoopTick` fires per tick over the
 *     settled `TickResult`.
 *   - N ticks → N tick commands, IN ORDER (tickIndex 1..N).
 *   - The tick BARRIER: tick k+1's `onBefore` fires only after tick k's
 *     `onAfter` — the next tick starts after this one settles.
 *   - SETTLE is IN the cascade, DECIDE is OUT (ADR 89 §4): the tick-end
 *     settle is an ASYNC `onAfterLoopTick` hook (the session's forwarder),
 *     awaited in the command cascade BEFORE the terminal resolves — so it
 *     completes before the session `notifyTickEnd` (decide), which runs in
 *     the run-execution continuation. This is the ADR-67 order, expressed
 *     entirely through the command hooks + terminal.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  DispatchResult,
  LanguageModelExecutionResult,
  CompilerProtocol,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  TickInput,
  TickResult,
  ToolCall,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";

import { LoopExecutorHarness } from "../harness.js";

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

/** Stub compiler that renders nothing (lifecycle is hook-projected, ADR 89 §4). */
function mkStubCompiler(): CompilerProtocol {
  return {
    fx: {
      use: () => () => {},
      renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "tc-mount", restoredFromSnapshot: false }),
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
      mountId: "tc-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

const noopApplicator: StateApplicator = {
  fx: {
    applyExecutorResult: () => Effect.void,
    applyToolResults: () => Effect.void,
  },
  applyExecutorResult: async () => undefined,
  applyToolResults: async () => undefined,
  appendEntry: async () => undefined,
};

function dispatchOk(call: { name: string; toolCallId: string }): DispatchResult {
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    content: [{ type: "text", text: "ok" }],
    durationMs: 1,
  };
}

function mkFakeToolExecutor(): ToolExecutorProtocol {
  return {
    fx: {
      use: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: (i: { name: string; toolCallId: string }) =>
        Effect.succeed(dispatchOk({ name: i.name, toolCallId: i.toolCallId })),
    },
    replaceCompilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async (i: { name: string; toolCallId: string }) =>
      dispatchOk({ name: i.name, toolCallId: i.toolCallId }),
  } as unknown as ToolExecutorProtocol;
}

const toolUse = (id: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "calling" }],
  stopReason: "tool_use",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [{ id, name: "t", input: {} } as ToolCall],
});
const ended = (): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

interface Ran {
  readonly loop: LoopExecutorHarness;
  readonly order: string[];
  readonly beforeInputs: TickInput[];
  readonly afterOutputs: TickResult[];
}

async function runWithHooks(
  ticks: readonly LanguageModelExecutionResult[],
  maxTicks: number,
): Promise<Ran> {
  const sub = mkSubstrate();
  const loop = new LoopExecutorHarness("tc-loop", sub.journal, sub.bus, sub.inbox);
  await loop.ready;
  const executor = new FakeLanguageModelExecutor("tc-exec", sub.journal, sub.bus, sub.inbox, {
    scripted: ticks.map((result) => ({ result })),
  });
  await executor.ready;

  const order: string[] = [];
  const beforeInputs: TickInput[] = [];
  const afterOutputs: TickResult[] = [];

  loop.hook({
    onBeforeLoopTick: (input) => {
      beforeInputs.push(input);
      order.push(`before-tick:${input.tickIndex}`);
    },
    // The SETTLE emulation (the session's tick-end forwarder, ADR 89 §4):
    // an ASYNC onAfterLoopTick hook with a real macrotask boundary. Its
    // in-cascade await is what the settle-before-decide assertion pins —
    // a fire-and-forget hook would let the DECIDE land first.
    onAfterLoopTick: async (output) => {
      await new Promise((r) => setTimeout(r, 0));
      order.push(`settle:tick-end:${output.tickIndex}`);
      afterOutputs.push(output);
      order.push(`after-tick:${output.tickIndex}`);
    },
  });

  const input: RunExecutionInput = {
    sessionId: "tc-s",
    mountId: "tc-mount",
    compiler: mkStubCompiler(),
    modelExecutor: executor,
    toolExecutor: mkFakeToolExecutor(),
    target: executor.target,
    stateApplicator: noopApplicator,
    executionId: "tc-exec",
    maxTicks,
    notifyTickEnd: () =>
      Effect.promise(async () => {
        order.push("decide");
        return undefined;
      }),
  };

  await loop.runExecution(input);
  return { loop, order, beforeInputs, afterOutputs };
}

describe("loop:tick command (ADR 89 §3)", () => {
  it("N ticks → N tick commands, onBefore/onAfter fire per tick in order", async () => {
    const { beforeInputs, afterOutputs } = await runWithHooks(
      [toolUse("c1"), toolUse("c2"), ended()],
      5,
    );

    // 3 ticks → 3 tick commands.
    expect(beforeInputs.map((i) => i.tickIndex)).toEqual([1, 2, 3]);
    expect(afterOutputs.map((o) => o.tickIndex)).toEqual([1, 2, 3]);

    // onBefore reads the tick identity off TickInput.
    expect(beforeInputs[0]!.tickId).toMatch(/^tick-/);
    expect(beforeInputs[0]!.executionId).toBe("tc-exec");

    // onAfter receives the settled TickResult (executor terminal + toolResults).
    expect(afterOutputs[0]!.executorTerminal.outcome).toBe("succeeded");
    expect(afterOutputs[0]!.toolResults.length).toBe(1); // c1 dispatched
    expect(afterOutputs[2]!.toolResults.length).toBe(0); // ended tick, no tools
    expect(afterOutputs[2]!.stopReason).toBe("end");
  });

  it("the tick BARRIER holds: tick k+1's onBefore only after tick k's onAfter", async () => {
    const { order } = await runWithHooks([toolUse("c1"), toolUse("c2"), ended()], 5);

    const beforeIdx = (n: number) => order.indexOf(`before-tick:${n}`);
    const afterIdx = (n: number) => order.indexOf(`after-tick:${n}`);

    // Each tick's onAfter precedes the next tick's onBefore — the barrier.
    expect(afterIdx(1)).toBeGreaterThan(beforeIdx(1));
    expect(beforeIdx(2)).toBeGreaterThan(afterIdx(1));
    expect(afterIdx(2)).toBeGreaterThan(beforeIdx(2));
    expect(beforeIdx(3)).toBeGreaterThan(afterIdx(2));
    expect(afterIdx(3)).toBeGreaterThan(beforeIdx(3));
  });

  it("SETTLE is IN the cascade, DECIDE is OUT: async onAfter settle < decide (ADR 89 §4)", async () => {
    const { order } = await runWithHooks([ended()], 5);

    const settle = order.indexOf("settle:tick-end:1");
    const after = order.indexOf("after-tick:1");
    const decide = order.indexOf("decide");

    // The ASYNC settle (macrotask inside the onAfterLoopTick hook) completed
    // IN the command cascade — before the terminal resolved and therefore
    // before the DECIDE in the run-execution continuation. Were the hook
    // fire-and-forget, `decide` would precede `settle`.
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(settle);
    expect(decide).toBeGreaterThan(after);
  });
});
