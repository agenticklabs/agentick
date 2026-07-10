/**
 * CHARACTERIZATION suite (ADR 77, S1) — pins the CURRENT `LoopExecutorHarness`
 * behavior BEFORE the fiber-spine rewrite, so the `Effect.gen` version is
 * provably behavior-preserving, not hopefully so.
 *
 * Focus: the tick-loop CONTROL FLOW + continuation decision (ADR 67) — the
 * behaviors least covered by the existing scenario tests (envelopes,
 * layered-tools, no-dangling) and most at risk under the rewrite:
 *
 *   - tick count / stopReason for end / tool_use / max_ticks
 *   - provisional continuation (tool_use ∧ pending calls)
 *   - the two-tier forward decision (stop-force > continue-force > abstain)
 *     under the maxTicks hard cap
 *   - the ADR 67 order: SETTLE (reconciler tick-end) BEFORE DECIDE (notifyTickEnd)
 *   - abort → canceled terminal
 *   - fire-and-forget lifecycle hooks: a throw must not fail the run
 *
 * These assertions are the invariant the rewrite must satisfy. When the loop
 * moves onto the Effect spine, THIS FILE MUST STAY GREEN UNCHANGED.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ContentBlock,
  DispatchResult,
  LanguageModelExecutionResult,
  ReconcilerProtocol,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  TickEndForwardDecision,
  ToolCall,
  ToolExecutorProtocol,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Scriptable characterization harness
// ============================================================================

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

/** Reconciler that renders nothing and records every notifyLifecycle kind. */
function mkRecordingReconciler(order: string[]): ReconcilerProtocol {
  return {
    mount: async () => ({ mountId: "ch-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    notifyLifecycle: async (i) => {
      order.push(`lifecycle:${i.event.kind}`);
    },
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "ch-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

/** State applicator that records apply-call order. */
function mkRecordingApplicator(order: string[]): StateApplicator {
  return {
    applyExecutorResult: async () => {
      order.push("apply:executor-result");
    },
    applyToolResults: async () => {
      order.push("apply:tool-results");
    },
    appendEntry: async () => undefined,
  };
}

/** A full DispatchResult for a given call — success unless `isError`. */
function dispatchOk(
  call: { name: string; toolCallId: string },
  content: ContentBlock[] = [{ type: "text", text: "ok" }],
): DispatchResult {
  return { toolCallId: call.toolCallId, name: call.name, content, durationMs: 1 };
}

/** Tool executor fake — implements only the three methods the loop calls. */
function mkFakeToolExecutor(
  dispatch: (call: { name: string; toolCallId: string }) => Promise<DispatchResult>,
): ToolExecutorProtocol {
  return {
    replaceReconcilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async (i: { name: string; toolCallId: string }) =>
      dispatch({ name: i.name, toolCallId: i.toolCallId }),
  } as unknown as ToolExecutorProtocol;
}

interface CharConfig {
  /** One scripted model result per tick. */
  readonly ticks: readonly LanguageModelExecutionResult[];
  readonly maxTicks: number;
  /** Optional session continuation authority (ADR 67). */
  readonly notifyTickEnd?: () =>
    | Promise<TickEndForwardDecision | undefined>
    | TickEndForwardDecision
    | undefined;
  /** Optional dispatch outcome (default: success, text "ok"). */
  readonly dispatch?: (call: { name: string; toolCallId: string }) => Promise<DispatchResult>;
  /** Pre-aborted signal, to characterize the cancellation path. */
  readonly signal?: AbortSignal;
}

async function runChar(cfg: CharConfig) {
  const sub = mkSubstrate();
  const loop = new LoopExecutorHarness("loop_ch", sub.journal, sub.bus, sub.inbox);
  await loop.ready;

  const executor = new FakeLanguageModelExecutor("exec_ch", sub.journal, sub.bus, sub.inbox, {
    scripted: cfg.ticks.map((result) => ({ result })),
  });
  await executor.ready;

  const order: string[] = [];
  const events: unknown[] = [];
  const dispatch = cfg.dispatch ?? (async (call): Promise<DispatchResult> => dispatchOk(call));

  const input: RunExecutionInput = {
    sessionId: "s_ch",
    mountId: "ch-mount",
    reconciler: mkRecordingReconciler(order),
    executor,
    toolExecutor: mkFakeToolExecutor(dispatch),
    target: executor.target,
    stateApplicator: mkRecordingApplicator(order),
    executionId: "exec_ch",
    maxTicks: cfg.maxTicks,
    onEvent: (e) => events.push(e),
    ...(cfg.notifyTickEnd
      ? {
          notifyTickEnd: async () => {
            order.push("decide:notifyTickEnd");
            return cfg.notifyTickEnd!();
          },
        }
      : {}),
    ...(cfg.signal ? { signal: cfg.signal } : {}),
  };

  const terminal = await loop.runExecution(input);
  return { terminal, order, events, loop };
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

// ============================================================================
// Continuation control flow
// ============================================================================

describe("LoopExecutorHarness [characterization] — continuation control flow", () => {
  it("single `end` tick → 1 tick, succeeded, stopReason 'end'", async () => {
    const { terminal } = await runChar({ ticks: [ended()], maxTicks: 5 });
    expect(terminal.outcome).toBe("succeeded");
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("end");
  });

  it("tool_use with pending calls → continues; next `end` tick stops (2 ticks)", async () => {
    const { terminal } = await runChar({ ticks: [toolUse("c1"), ended()], maxTicks: 5 });
    expect(terminal.result!.ticks).toBe(2);
    expect(terminal.result!.stopReason).toBe("end");
  });

  it("tool_use with NO tool calls → does NOT continue (1 tick)", async () => {
    const noCalls: LanguageModelExecutionResult = { ...toolUse("x"), toolCalls: [] };
    const { terminal } = await runChar({ ticks: [noCalls, ended()], maxTicks: 5 });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("tool_use");
  });

  it("maxTicks hard cap → stops at the cap with stopReason 'max_ticks'", async () => {
    const { terminal } = await runChar({
      ticks: [toolUse("c1"), toolUse("c2"), toolUse("c3")],
      maxTicks: 2,
    });
    expect(terminal.result!.ticks).toBe(2);
    expect(terminal.result!.stopReason).toBe("max_ticks");
  });
});

// ============================================================================
// The two-tier forward decision (ADR 67)
// ============================================================================

describe("LoopExecutorHarness [characterization] — ADR 67 forward decision", () => {
  it("stop-force: notifyTickEnd 'stop' overrides a would-continue tool_use tick", async () => {
    const { terminal } = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      notifyTickEnd: () => ({ kind: "stop" }),
    });
    expect(terminal.result!.ticks).toBe(1); // stopped despite provisional continue
    expect(terminal.result!.stopReason).toBe("tool_use");
  });

  it("continue-force: notifyTickEnd 'continue' extends a would-stop `end` tick", async () => {
    const { terminal } = await runChar({
      ticks: [ended(), ended()],
      maxTicks: 2,
      notifyTickEnd: () => ({ kind: "continue" }),
    });
    expect(terminal.result!.ticks).toBe(2); // continued past the 'end' stop
    expect(terminal.result!.stopReason).toBe("max_ticks");
  });

  it("abstain: undefined decision leaves the provisional disposition intact", async () => {
    const { terminal } = await runChar({
      ticks: [ended()],
      maxTicks: 5,
      notifyTickEnd: () => undefined,
    });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("end");
  });

  it("maxTicks is the tier-1 hard cap: 'continue' cannot exceed it", async () => {
    const { terminal } = await runChar({
      ticks: [ended(), ended()],
      maxTicks: 1,
      notifyTickEnd: () => ({ kind: "continue" }),
    });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("max_ticks");
  });

  it("SETTLE before DECIDE: reconciler tick-end lifecycle precedes notifyTickEnd (ADR 67)", async () => {
    const { order } = await runChar({
      ticks: [ended()],
      maxTicks: 5,
      notifyTickEnd: () => ({ kind: "stop" }),
    });
    const settle = order.indexOf("lifecycle:tick-end");
    const decide = order.indexOf("decide:notifyTickEnd");
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(decide).toBeGreaterThan(settle);
  });

  it("persistence precedes the decision: applyExecutorResult/ToolResults before notifyTickEnd", async () => {
    const { order } = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      notifyTickEnd: () => undefined,
    });
    const applyExec = order.indexOf("apply:executor-result");
    const applyTools = order.indexOf("apply:tool-results");
    const decide = order.indexOf("decide:notifyTickEnd");
    expect(applyExec).toBeGreaterThanOrEqual(0);
    expect(applyTools).toBeGreaterThan(applyExec);
    expect(decide).toBeGreaterThan(applyTools);
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe("LoopExecutorHarness [characterization] — cancellation", () => {
  it("a pre-aborted signal → 0 ticks, stopReason 'aborted', but outcome 'succeeded'", async () => {
    // CHARACTERIZATION OF A SUBTLETY (preserve exactly; revisit separately):
    // a `signal` abort sets `stopReason: "aborted"` and breaks, but does NOT
    // populate the harness `aborted` map — and `wasAborted` (→ the "canceled"
    // outcome) reads that map. So ONLY `loop.abort()` yields outcome
    // "canceled"; a signal abort yields outcome "succeeded" with an "aborted"
    // stop reason. This divergence is current behavior — the rewrite must keep
    // it identical (whether it's a *desirable* behavior is a separate question).
    const controller = new AbortController();
    controller.abort();
    const { terminal } = await runChar({
      ticks: [ended()],
      maxTicks: 5,
      signal: controller.signal,
    });
    expect(terminal.outcome).toBe("succeeded");
    expect(terminal.result!.ticks).toBe(0);
    expect(terminal.result!.stopReason).toBe("aborted");
  });

  it("abort() before run → canceled terminal carrying the reason", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_ab", sub.journal, sub.bus, sub.inbox);
    await loop.ready;
    const executor = new FakeLanguageModelExecutor("exec_ab", sub.journal, sub.bus, sub.inbox, {
      scripted: { result: ended() },
    });
    await executor.ready;
    const order: string[] = [];

    await loop.abort({ executionId: "exec_ab", reason: "user-stop" });
    const terminal = await loop.runExecution({
      sessionId: "s_ab",
      mountId: "ch-mount",
      reconciler: mkRecordingReconciler(order),
      executor,
      toolExecutor: mkFakeToolExecutor(async (call) => dispatchOk(call, [])),
      target: executor.target,
      stateApplicator: mkRecordingApplicator(order),
      executionId: "exec_ab",
      maxTicks: 5,
    });
    expect(terminal.outcome).toBe("canceled");
    expect(terminal.reason).toBe("user-stop");
  });
});

// ============================================================================
// Awaited lifecycle propagation
// ============================================================================
//
// NOTE: fire-and-forget hook ISOLATION (execution-start/tool-start/tool-end/
// execution-end throws must not fail the run) lives in the reconciler's
// LifecycleStore, NOT the loop — the loop `void`-dispatches those. That
// invariant belongs in an integration test with the real reconciler store.
// Here we pin only what the LOOP owns: the AWAITED tick-start/tick-end hooks
// gate the tick, so a throw in one propagates and fails the run.

describe("LoopExecutorHarness [characterization] — awaited lifecycle propagation", () => {
  it("a throw in the AWAITED tick-start hook fails the run (propagates as an error)", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_aw", sub.journal, sub.bus, sub.inbox);
    await loop.ready;
    const executor = new FakeLanguageModelExecutor("exec_aw", sub.journal, sub.bus, sub.inbox, {
      scripted: { result: ended() },
    });
    await executor.ready;
    const reconciler = mkRecordingReconciler([]);
    reconciler.notifyLifecycle = async (i) => {
      if (i.event.kind === "tick-start") throw new Error("tick-start boom");
    };
    await expect(
      loop.runExecution({
        sessionId: "s_aw",
        mountId: "ch-mount",
        reconciler,
        executor,
        toolExecutor: mkFakeToolExecutor(async (call) => dispatchOk(call, [])),
        target: executor.target,
        stateApplicator: mkRecordingApplicator([]),
        executionId: "exec_aw",
        maxTicks: 3,
      }),
    ).rejects.toThrow(Error);
  });
});
