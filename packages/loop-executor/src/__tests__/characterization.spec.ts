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
 *   - the ADR 67 order: SETTLE (compiler tick-end) BEFORE DECIDE (notifyTickEnd)
 *   - abort → canceled terminal
 *   - fire-and-forget lifecycle hooks: a throw must not fail the run
 *
 * These assertions are the invariant the rewrite must satisfy. When the loop
 * moves onto the Effect spine, THIS FILE MUST STAY GREEN UNCHANGED.
 *
 * ONE exception has since been ratified (2026-07-27): the two cancellation
 * cases below no longer characterize the `signal`-abort / `abort()` divergence
 * in the terminal `outcome` — that divergence was a bug, not an invariant, and
 * both paths now report `canceled`. The cases still document the behavior they
 * replaced. Everything else here is untouched characterization.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ContentBlock,
  DispatchResult,
  ExecutionTerminal,
  LanguageModelExecutionResult,
  LoopExecutorProtocol,
  CompilerProtocol,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  TickEndForwardDecision,
  ToolCall,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor, type MockScriptedRun } from "@agentick/model-executor";
import { omitUndefined } from "@agentick/utils";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Scriptable characterization harness
// ============================================================================

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

/**
 * Stub compiler that renders nothing. Lifecycle is NOT a compiler
 * concern anymore (ADR 89 §4) — the settle rides the loop's own
 * `onAfterLoopTick` command hook (see {@link runChar}, which emulates the
 * session's forwarder).
 */
function mkStubCompiler(): CompilerProtocol {
  return {
    fx: {
      use: () => () => {},
      renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "ch-mount", restoredFromSnapshot: false }),
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
    // Record on BOTH edges — the Stage-3 loop composes `fx.apply*`; the
    // characterization diff must stay byte-identical across the rewrite.
    fx: {
      applyExecutorResult: () =>
        Effect.sync(() => {
          order.push("apply:executor-result");
        }),
      applyToolResults: () =>
        Effect.sync(() => {
          order.push("apply:tool-results");
        }),
    },
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
    // fx twins the Stage-3 loop composes. `dispatch` rides `Effect.tryPromise`
    // so a hard throw lands on the E channel (→ the loop's `Effect.either`
    // tool-error path), matching the facade's rejection.
    fx: {
      use: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: (i: { name: string; toolCallId: string }) =>
        Effect.tryPromise({
          try: () => dispatch({ name: i.name, toolCallId: i.toolCallId }),
          catch: (e) => e,
        }),
    },
    replaceCompilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async (i: { name: string; toolCallId: string }) =>
      dispatch({ name: i.name, toolCallId: i.toolCallId }),
  } as unknown as ToolExecutorProtocol;
}

/**
 * MITIGATION SEAM #1 — differential testing. `runChar` builds the loop via a
 * factory (default: the current `LoopExecutorHarness`). When the composed
 * `Effect.gen` loop lands, these SAME scenarios run against it by passing a
 * `makeLoop` that constructs it — the rewrite is validated by *diffing every
 * scenario's observable trace*, not by hope. The edge stays Promise-returning,
 * so the factory return is uniform across both implementations.
 */
type CharLoop = LoopExecutorProtocol & { readonly ready: Promise<void> };
const defaultMakeLoop = (
  scopeId: string,
  journal: ReturnType<typeof mkSubstrate>["journal"],
  bus: ReturnType<typeof mkSubstrate>["bus"],
  inbox: ReturnType<typeof mkSubstrate>["inbox"],
): CharLoop => new LoopExecutorHarness(scopeId, journal, bus, inbox);

interface CharConfig {
  /** One scripted model result per tick (success). Sugar over `scripted`. */
  readonly ticks?: readonly LanguageModelExecutionResult[];
  /** Full scripted runs — carries per-tick `outcome` for failure/cancel/veto paths. */
  readonly scripted?: readonly MockScriptedRun[];
  readonly maxTicks: number;
  /** Request the streaming path (`executeStream`) when the executor supports it. */
  readonly stream?: boolean;
  /** Optional session continuation authority (ADR 67). */
  readonly notifyTickEnd?: () =>
    | Promise<TickEndForwardDecision | undefined>
    | TickEndForwardDecision
    | undefined;
  /** Optional dispatch outcome (default: success, text "ok"). */
  readonly dispatch?: (call: { name: string; toolCallId: string }) => Promise<DispatchResult>;
  /** Pre-aborted signal, to characterize the cancellation path. */
  readonly signal?: AbortSignal;
  /** Differential seam — the loop factory (default: LoopExecutorHarness). */
  readonly makeLoop?: (
    scopeId: string,
    journal: ReturnType<typeof mkSubstrate>["journal"],
    bus: ReturnType<typeof mkSubstrate>["bus"],
    inbox: ReturnType<typeof mkSubstrate>["inbox"],
  ) => CharLoop;
}

interface CharTrace {
  readonly terminal: ExecutionTerminal;
  readonly order: string[];
  readonly events: LoopEvent[];
  readonly loop: CharLoop;
}

/** A minimal shape over the events the loop emits, for sequence assertions. */
interface LoopEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}

async function runChar(cfg: CharConfig): Promise<CharTrace> {
  const sub = mkSubstrate();
  const loop = (cfg.makeLoop ?? defaultMakeLoop)("loop_ch", sub.journal, sub.bus, sub.inbox);
  await loop.ready;

  const scripted = cfg.scripted ?? (cfg.ticks ?? []).map((result) => ({ result }));
  const executor = new FakeLanguageModelExecutor("exec_ch", sub.journal, sub.bus, sub.inbox, {
    scripted,
  });
  await executor.ready;

  const order: string[] = [];
  const events: LoopEvent[] = [];
  const dispatch = cfg.dispatch ?? (async (call): Promise<DispatchResult> => dispatchOk(call));

  // ADR 89 §4 — emulate the SESSION's lifecycle forwarders: the tick-end
  // SETTLE is an `onAfterLoopTick` hook, AWAITED in the `loop:tick`
  // command cascade (before the terminal → before the DECIDE). The real
  // async boundary below is load-bearing: were the hook fire-and-forget,
  // the DECIDE marker would land first and the settle-before-decide
  // characterization would fail. Registered only on the real harness
  // (the differential seam's alternative loops may not expose `.hook`).
  const hookable = loop as Partial<Pick<LoopExecutorHarness, "hook">>;
  hookable.hook?.({
    onAfterLoopTick: async () => {
      await new Promise((r) => setTimeout(r, 0));
      order.push("lifecycle:tick-end");
    },
    // Streaming-up (ADR 51 §2): `loop:run-execution` is a `commandStream`, so
    // its events ARE the chunks. Capturing them via the minted
    // `onLoopRunExecutionChunk` observer (free Phase-2 observability) taps the
    // SAME sink the run + tick bodies emit through — on the drain-only facade
    // path too (`observe` fires before the no-op downstream). This replaces the
    // retired `RunExecutionInput.onEvent` push-callback the trace used to read.
    onLoopRunExecutionChunk: {
      observe: (e) => {
        events.push(e as unknown as LoopEvent);
      },
    },
  });

  const input: RunExecutionInput = {
    sessionId: "s_ch",
    mountId: "ch-mount",
    compiler: mkStubCompiler(),
    modelExecutor: executor,
    toolExecutor: mkFakeToolExecutor(dispatch),
    target: executor.target,
    stateApplicator: mkRecordingApplicator(order),
    executionId: "exec_ch",
    maxTicks: cfg.maxTicks,
    ...omitUndefined({ stream: cfg.stream, signal: cfg.signal }),
    ...(cfg.notifyTickEnd
      ? {
          notifyTickEnd: async () => {
            order.push("decide:notifyTickEnd");
            return cfg.notifyTickEnd!();
          },
        }
      : {}),
  };

  const terminal = await loop.runExecution(input);
  return { terminal, order, events, loop };
}

/**
 * MITIGATION SEAM #2 — invariant assertions. Structural properties that MUST
 * hold regardless of implementation. Called at the end of representative
 * scenarios so the rewrite is caught on whole *classes* of drift (bounds,
 * defined outcome, monotone usage, no-dangling) — not just single values.
 */
function assertLoopInvariants(trace: CharTrace, maxTicks: number): void {
  const r = trace.terminal.result;
  expect(r).toBeDefined();
  // Bounds: never exceed the hard cap.
  expect(r!.ticks).toBeGreaterThanOrEqual(0);
  expect(r!.ticks).toBeLessThanOrEqual(maxTicks);
  // Terminal always carries a defined outcome + stop reason.
  expect(["succeeded", "canceled", "failed"]).toContain(trace.terminal.outcome);
  expect(typeof r!.stopReason).toBe("string");
  expect(r!.stopReason.length).toBeGreaterThan(0);
  // Usage is non-negative (accumulation never underflows).
  expect(r!.usage.totalTokens).toBeGreaterThanOrEqual(0);
  // No dangling tool_use: every tool result persisted rode a tool-results apply.
  if (r!.toolResults.length > 0) {
    expect(trace.order).toContain("apply:tool-results");
  }
}

/** A model result carrying a scripted failure `outcome` (the `result` is a
 *  placeholder the fake ignores on non-success outcomes). */
const failRun = (outcome: "failed" | "vetoed" | "canceled"): MockScriptedRun => ({
  result: ended(),
  outcome,
});

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

  it("SETTLE before DECIDE: the in-cascade onAfterLoopTick settle precedes notifyTickEnd (ADR 67 / 89 §4)", async () => {
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
  it("a pre-aborted signal → 0 ticks, stopReason 'aborted', outcome 'canceled'", async () => {
    // RATIFIED SEMANTICS (2026-07-27). Both cancellation entry points — a
    // caller-supplied `signal` abort and `loop.abort()` — report
    // `outcome: "canceled"`. The cancellation SOURCE is not part of the
    // terminal contract; only the fact of cancellation is.
    //
    // This REPLACES a characterization of the prior divergence: `wasAborted`
    // (the "canceled" discriminant) read ONLY the harness `aborted` map, which
    // the signal path never populates — so a signal abort landed
    // `outcome: "succeeded"` with `stopReason: "aborted"`, an
    // internally-contradictory terminal that made every consumer's
    // `outcome === "succeeded"` check wrong for half the abort paths. The
    // discriminant now also honors the abort-derived `stopReason`.
    const controller = new AbortController();
    controller.abort();
    const { terminal } = await runChar({
      ticks: [ended()],
      maxTicks: 5,
      signal: controller.signal,
    });
    expect(terminal.outcome).toBe("canceled");
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
      compiler: mkStubCompiler(),
      modelExecutor: executor,
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
// Awaited lifecycle propagation (ADR 89 §4)
// ============================================================================
//
// NOTE: fire-and-forget forwarder ISOLATION (execution-start/tool-start/
// tool-end/execution-end throws must not fail the run) lives in the
// compiler's per-mount LifecycleDispatch + the session's fire-and-forget
// forwarders, NOT the loop. Here we pin only what the LOOP owns: the
// AWAITED `onBeforeLoopTick` / `onAfterLoopTick` hooks run in the
// `loop:tick` command cascade, so a throw in one propagates and fails the
// run — the session's tick-start / tick-end (settle) forwarders ride
// exactly these hooks.

describe("LoopExecutorHarness [characterization] — awaited lifecycle propagation", () => {
  async function mkAwaitedFixture(scope: string) {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness(`loop_${scope}`, sub.journal, sub.bus, sub.inbox);
    await loop.ready;
    const executor = new FakeLanguageModelExecutor(
      `exec_${scope}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      { scripted: { result: ended() } },
    );
    await executor.ready;
    const input: RunExecutionInput = {
      sessionId: `s_${scope}`,
      mountId: "ch-mount",
      compiler: mkStubCompiler(),
      modelExecutor: executor,
      toolExecutor: mkFakeToolExecutor(async (call) => dispatchOk(call, [])),
      target: executor.target,
      stateApplicator: mkRecordingApplicator([]),
      executionId: `exec_${scope}`,
      maxTicks: 3,
    };
    return { loop, input };
  }

  it("a throw in the AWAITED onBeforeLoopTick hook (tick-start forwarder) fails the run", async () => {
    const { loop, input } = await mkAwaitedFixture("aw_before");
    loop.hook({
      onBeforeLoopTick: () => {
        throw new Error("tick-start boom");
      },
    });
    await expect(loop.runExecution(input)).rejects.toThrow(Error);
  });

  it("a throw in the AWAITED onAfterLoopTick hook (the settle forwarder) fails the run", async () => {
    const { loop, input } = await mkAwaitedFixture("aw_after");
    loop.hook({
      onAfterLoopTick: () => {
        throw new Error("settle boom");
      },
    });
    await expect(loop.runExecution(input)).rejects.toThrow(Error);
  });
});

// ============================================================================
// Executor failure paths (needs the run-scripting executor)
// ============================================================================

describe("LoopExecutorHarness [characterization] — executor failure paths", () => {
  it("a failed executor terminal → stopReason 'executor_failed', outcome 'succeeded'", async () => {
    // SUBTLETY (like signal-abort): a failed executor sets stopReason but does
    // NOT populate the harness `aborted` map, so outcome stays "succeeded".
    const trace = await runChar({ scripted: [failRun("failed")], maxTicks: 5 });
    expect(trace.terminal.outcome).toBe("succeeded");
    expect(trace.terminal.result!.ticks).toBe(1);
    expect(trace.terminal.result!.stopReason).toBe("executor_failed");
  });

  it("a failed executor on tick 2 (after a tool_use tick) → 2 ticks, 'executor_failed'", async () => {
    const trace = await runChar({
      scripted: [{ result: toolUse("c1") }, failRun("failed")],
      maxTicks: 5,
    });
    expect(trace.terminal.result!.ticks).toBe(2);
    expect(trace.terminal.result!.stopReason).toBe("executor_failed");
  });

  it("a canceled executor terminal → stopReason 'aborted', outcome 'canceled'", async () => {
    // Same ratified rule as the signal-abort case above: a cancellation the
    // harness `aborted` map never saw (here it originates INSIDE the model
    // executor) still lands a `canceled` terminal — the abort-derived
    // `stopReason` is part of the discriminant.
    const trace = await runChar({ scripted: [failRun("canceled")], maxTicks: 5 });
    expect(trace.terminal.outcome).toBe("canceled");
    expect(trace.terminal.result!.stopReason).toBe("aborted");
  });

  it("a vetoed executor terminal → stopReason 'vetoed'", async () => {
    const trace = await runChar({ scripted: [failRun("vetoed")], maxTicks: 5 });
    expect(trace.terminal.result!.stopReason).toBe("vetoed");
  });
});

// ============================================================================
// Tool-dispatch outcomes
// ============================================================================

describe("LoopExecutorHarness [characterization] — tool-dispatch outcomes", () => {
  it("a soft dispatch error (isError: true) → tool result succeeded: false", async () => {
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async (call) => ({ ...dispatchOk(call), isError: true }),
    });
    const tr = trace.terminal.result!.toolResults;
    expect(tr).toHaveLength(1);
    expect(tr[0]!.succeeded).toBe(false);
  });

  it("a hard dispatch throw is caught → tool result succeeded: false, error captured, run survives", async () => {
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async () => {
        throw new Error("tool boom");
      },
    });
    expect(trace.terminal.outcome).toBe("succeeded"); // a tool throw does not fail the run
    const tr = trace.terminal.result!.toolResults;
    expect(tr[0]!.succeeded).toBe(false);
    expect(tr[0]!.error).toBeInstanceOf(Error);
  });

  it("no tool calls → applyToolResults is NOT invoked (only applyExecutorResult)", async () => {
    const trace = await runChar({ ticks: [ended()], maxTicks: 5 });
    expect(trace.order).toContain("apply:executor-result");
    expect(trace.order).not.toContain("apply:tool-results");
  });

  it("provider-side tool_result in output (not in toolCalls) is NOT dispatched", async () => {
    const dispatched: string[] = [];
    const providerResult: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [
        {
          type: "tool_result",
          toolCallId: "srv-1",
          content: [{ type: "text", text: "server ran" }],
        } as unknown as ContentBlock,
      ],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      // NO `toolCalls` → the loop has nothing to dispatch.
    };
    const trace = await runChar({
      ticks: [providerResult],
      maxTicks: 5,
      dispatch: async (call) => {
        dispatched.push(call.toolCallId);
        return dispatchOk(call);
      },
    });
    expect(dispatched).toEqual([]); // dispatch never called
    expect(trace.terminal.result!.toolResults).toEqual([]); // no loop-dispatched results
    // The provider's tool_result rode through in the accumulated output.
    expect(
      trace.terminal.result!.output.some((b) => (b as { type: string }).type === "tool_result"),
    ).toBe(true);
  });
});

// ============================================================================
// Usage accumulation
// ============================================================================

describe("LoopExecutorHarness [characterization] — usage accumulation", () => {
  it("sums usage across ticks; terminal usage is the total", async () => {
    const t1: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "a" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      toolCalls: [{ id: "c1", name: "t", input: {} } as ToolCall],
    };
    const t2: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "b" }],
      stopReason: "end",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    };
    const trace = await runChar({ ticks: [t1, t2], maxTicks: 5 });
    expect(trace.terminal.result!.usage.inputTokens).toBe(5);
    expect(trace.terminal.result!.usage.outputTokens).toBe(7);
    expect(trace.terminal.result!.usage.totalTokens).toBe(12);
  });
});

// ============================================================================
// Event sequence
// ============================================================================

describe("LoopExecutorHarness [characterization] — event sequence", () => {
  it("emits execution-start → tick-start → tick-end → tick → execution-end in order", async () => {
    const trace = await runChar({ ticks: [ended()], maxTicks: 5 });
    const kinds = trace.events.map((e) => e.kind);
    for (const k of ["execution-start", "tick-start", "tick-end", "tick", "execution-end"]) {
      expect(kinds).toContain(k);
    }
    // Relative order of the run-level bookends.
    expect(kinds.indexOf("execution-start")).toBeLessThan(kinds.indexOf("tick-start"));
    expect(kinds.indexOf("tick-end")).toBeLessThan(kinds.indexOf("execution-end"));
  });

  it("emits the run-level `execution` summary after execution-end, totals intact", async () => {
    const t1: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "a" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      toolCalls: [{ id: "c1", name: "t", input: {} } as ToolCall],
    };
    const t2: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "b" }],
      stopReason: "end",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    };
    const trace = await runChar({ ticks: [t1, t2], maxTicks: 5 });
    const kinds = trace.events.map((e) => e.kind);
    // The summary is the execution twin of the per-tick `tick` event: it
    // follows the `execution-end` boundary exactly as `tick` follows
    // `tick-end`, and it carries the RUN totals, not a tick's slice.
    expect(kinds.indexOf("execution-end")).toBeLessThan(kinds.indexOf("execution"));
    const summary = trace.events.find((e) => e.kind === "execution");
    if (summary?.kind !== "execution") throw new Error("no execution summary emitted");
    expect(summary.tick).toBe(2);
    expect(summary.stopReason).toBe("end");
    expect(summary.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.output).toEqual(trace.terminal.result!.output);
  });

  it("a tool tick emits tool-dispatch-{start,end} around the dispatch", async () => {
    const trace = await runChar({ ticks: [toolUse("c1"), ended()], maxTicks: 5 });
    const kinds = trace.events.map((e) => e.kind);
    expect(kinds).toContain("tool-dispatch-start");
    expect(kinds).toContain("tool-dispatch-end");
    expect(kinds.indexOf("tool-dispatch-start")).toBeLessThan(kinds.indexOf("tool-dispatch-end"));
  });
});

// ============================================================================
// Streaming vs non-streaming
// ============================================================================

describe("LoopExecutorHarness [characterization] — streaming vs non-streaming", () => {
  it("streaming path (stream: true) still terminates and forwards model deltas", async () => {
    const trace = await runChar({ ticks: [ended()], maxTicks: 5, stream: true });
    expect(trace.terminal.outcome).toBe("succeeded");
    expect(trace.terminal.result!.ticks).toBe(1);
    // Deltas forwarded as `model` events on the streaming path.
    expect(trace.events.some((e) => e.kind === "model")).toBe(true);
  });

  it("non-streaming path synthesizes model events from the result", async () => {
    const trace = await runChar({ ticks: [ended()], maxTicks: 5, stream: false });
    expect(trace.terminal.outcome).toBe("succeeded");
    expect(trace.events.some((e) => e.kind === "model")).toBe(true);
  });

  it("streaming path: a rejecting stream.result → failed terminal, 'executor_failed'", async () => {
    const trace = await runChar({ scripted: [failRun("failed")], maxTicks: 5, stream: true });
    expect(trace.terminal.result!.ticks).toBe(1);
    expect(trace.terminal.result!.stopReason).toBe("executor_failed");
  });
});

// ============================================================================
// Structural invariants (MITIGATION — catches classes of drift)
// ============================================================================

describe("LoopExecutorHarness [characterization] — structural invariants", () => {
  it("hold across representative scenarios (bounds, defined outcome, monotone usage, no-dangling)", async () => {
    assertLoopInvariants(await runChar({ ticks: [ended()], maxTicks: 5 }), 5);
    assertLoopInvariants(await runChar({ ticks: [toolUse("c1"), ended()], maxTicks: 5 }), 5);
    assertLoopInvariants(
      await runChar({ ticks: [toolUse("c1"), toolUse("c2"), toolUse("c3")], maxTicks: 2 }),
      2,
    );
    assertLoopInvariants(await runChar({ scripted: [failRun("failed")], maxTicks: 5 }), 5);
  });
});
