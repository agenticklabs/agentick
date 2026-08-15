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
  ExecuteErrorChannel,
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
import { MalformedModelOutput, SPEC_VERSION, ToolValidationError } from "@agentick/spec";
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
      guard: () => () => {},
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
      guard: () => () => {},
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
          notifyTickEnd: () =>
            Effect.promise(async () => {
              order.push("decide:notifyTickEnd");
              return cfg.notifyTickEnd!();
            }),
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
const failRun = (
  outcome: "failed" | "vetoed" | "canceled",
  error?: ExecuteErrorChannel,
): MockScriptedRun => ({
  result: ended(),
  outcome,
  ...(error !== undefined ? { error } : {}),
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

  it("the failure's CAUSE rides the result — `executor_failed` is not the whole story", async () => {
    // The regression this guards: the loop read `executorTerminal.outcome`,
    // mapped it to a stop reason and dropped `.error` at the same statement. The
    // word `executor_failed` was then the only account of the failure ANYWHERE —
    // in the caller's resolved `SendResult`, on the turn-boundary record, and in
    // every UI folding either one. A missing key and a refused model read
    // identically.
    const trace = await runChar({ scripted: [failRun("failed")], maxTicks: 5 });
    const cause = trace.terminal.result!.stopCause;
    expect(cause?.kind).toBe("failed");
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    // Serialized, not the live class: every consumer downstream is across a wire.
    expect(cause.error._tag).toBe("ProviderRejected");
    expect(cause.error.message.length).toBeGreaterThan(0);
  });

  it("a VETO carries its reason, and is NOT reported as a failure", async () => {
    // The distinction `StopCause` exists to preserve. A veto is the guard
    // WORKING; typing it as an error would make every error-rate metric, retry
    // policy and eval score count deliberate policy decisions as breakage. Its
    // reason string used to be dropped here for want of somewhere honest to put
    // it.
    const trace = await runChar({ scripted: [failRun("vetoed")], maxTicks: 5 });
    expect(trace.terminal.result!.stopReason).toBe("vetoed");
    const cause = trace.terminal.result!.stopCause;
    expect(cause?.kind).toBe("vetoed");
    if (cause?.kind !== "vetoed") throw new Error("expected a veto cause");
    expect(cause.reason).toBe("scripted veto");
  });

  it("a CANCELED run carries no cause — the stop reason already says it all", async () => {
    const trace = await runChar({ scripted: [failRun("canceled")], maxTicks: 5 });
    expect(trace.terminal.result!.stopReason).toBe("aborted");
    expect(trace.terminal.result!.stopCause).toBeUndefined();
  });

  it("a turn that SUCCEEDED carries no cause", async () => {
    // The field is evidence of a bad stop, so its mere PRESENCE is meaningful to a
    // renderer (it draws a failure row off it). A `stopCause: undefined` key left
    // on every result would make that unreliable.
    const trace = await runChar({ scripted: [{ result: ended() }], maxTicks: 5 });
    expect(trace.terminal.result!.stopReason).not.toBe("executor_failed");
    expect("stopCause" in trace.terminal.result!).toBe(false);
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

  it("projects DispatchResult.metadata onto tool-dispatch verbatim", async () => {
    // The MCP-App frame payload rides the SAME `metadata.mcp` namespace the
    // server-side result extensions use — the loop forwards the bag, it does
    // not interpret or reshape it.
    const resultMetadata = {
      mcp: { meta: { ui: { resourceUri: "ui://widget/invoice-list", prefersBorder: true } } },
    };
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async (call) => ({ ...dispatchOk(call), metadata: resultMetadata }),
    });
    const dispatched = trace.events.find((e) => e.kind === "tool-dispatch");
    expect(dispatched?.metadata).toEqual(resultMetadata);
  });

  it("omits metadata on tool-dispatch when the result carried none", async () => {
    const trace = await runChar({ ticks: [toolUse("c1"), ended()], maxTicks: 5 });
    const dispatched = trace.events.find((e) => e.kind === "tool-dispatch");
    expect(dispatched).toBeDefined();
    expect("metadata" in dispatched!).toBe(false);
  });

  it("projects DispatchResult.presentation onto tool-dispatch-end and tool-dispatch", async () => {
    const presentation = {
      name: "search_invoices",
      title: "Search invoices",
      summary: "Searching invoices for ACME",
    };
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async (call) => ({ ...dispatchOk(call), presentation }),
    });
    expect(trace.events.find((e) => e.kind === "tool-dispatch-end")?.presentation).toEqual(
      presentation,
    );
    expect(trace.events.find((e) => e.kind === "tool-dispatch")?.presentation).toEqual(
      presentation,
    );
  });

  it("tool-dispatch-start carries NO presentation — it is resolved inside the dispatch", async () => {
    // The resolution site is the tool executor, mid-dispatch (it needs the
    // validated input + the stripped model narration). `tool-dispatch-start`
    // is emitted strictly BEFORE that, so a slot there would be structurally
    // always-undefined — and filling it would mean a second, divergent
    // resolution path off the raw declaration.
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async (call) => ({ ...dispatchOk(call), presentation: { name: call.name } }),
    });
    const start = trace.events.find((e) => e.kind === "tool-dispatch-start");
    expect(start).toBeDefined();
    expect("presentation" in start!).toBe(false);
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
// Failure classification (ADR 99 slices 1 + 4b)
// ============================================================================

describe("LoopExecutorHarness — failure classification", () => {
  it("a stream failure the adapter already classified keeps its own tag", async () => {
    // The distinction recovery policy reads: "the model emitted garbage" (retry
    // is promising) vs "this request is bad" (retry is futile, and billed).
    // Wrapping every stream failure in `ProviderRejected` erased it at the last
    // hop, after the adapter had gone to the trouble of making it.
    const trace = await runChar({
      scripted: [failRun("failed", new MalformedModelOutput({ toolName: "knowify__query" }))],
      maxTicks: 5,
      stream: true,
    });
    const cause = trace.terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error._tag).toBe("MalformedModelOutput");
    expect(trace.terminal.result!.stopReason).toBe("executor_failed");
  });

  it("a cause from OUTSIDE the ExecuteError family is still wrapped", async () => {
    // Substrate failures and adapter throws that escape classification arrive
    // untyped, and the terminal must still carry a typed error. Scripted through
    // the fake's typed slot on purpose — this arm exists for exactly the values
    // the type system cannot promise.
    const trace = await runChar({
      scripted: [failRun("failed", new Error("socket hang up") as unknown as ExecuteErrorChannel)],
      maxTicks: 5,
      stream: true,
    });
    const cause = trace.terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error._tag).toBe("ProviderRejected");
    expect(cause.error.message).toContain("socket hang up");
  });

  it("a failed dispatch renders the error into the tool_result the model reads", async () => {
    // `content: []` with `is_error: true` told the model only that SOMETHING went
    // wrong. The paired result IS the feedback loop for this class — the
    // `tool_use` block is valid, so the model self-corrects on the next tick
    // rather than the tick being retried.
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async () => {
        throw new ToolValidationError({ toolName: "t", issues: [] });
      },
    });
    const expected = [{ type: "text", text: "tool t validation failed" }];
    const result = trace.terminal.result!.toolResults[0]!;
    expect(result.succeeded).toBe(false);
    expect(result.content).toEqual(expected);
    // The event stream carries the same body — a client renders the failure off
    // this, and it was empty there too.
    const dispatched = trace.events.find((e) => e.kind === "tool-dispatch");
    expect(dispatched?.content).toEqual(expected);
  });

  it("the persisted text NAMES the bad argument — the model cannot fix what it cannot see", async () => {
    // Wave 1 rendered the error's message and stopped there; the message was a
    // bare classification, so the model was told the call was invalid and not
    // which argument. The issues now fold into the message at composition.
    const trace = await runChar({
      ticks: [toolUse("c1"), ended()],
      maxTicks: 5,
      dispatch: async () => {
        throw new ToolValidationError({
          toolName: "t",
          issues: [
            { path: ["amount"], message: "expected number, received string" },
            { path: ["items", 0, { key: "id" }], message: "required" },
          ],
        });
      },
    });
    const text = (trace.terminal.result!.toolResults[0]!.content[0] as { text: string }).text;
    expect(text).toContain("amount: expected number, received string");
    expect(text).toContain("items.0.id: required");
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
