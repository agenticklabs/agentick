/**
 * ADR 99 slice 2 — a FAILED tick reaches the decide fold.
 *
 * The mechanism half: the loop no longer breaks before notify on a failed
 * executor terminal, the fold's default is INVERTED for that outcome (abstain
 * = stop), and two hard caps bound whatever a decide participant asks for.
 * Policy — which failures are worth re-issuing — lives in the session
 * (`tick-failure-recovery.spec.tsx` there).
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  DispatchResult,
  ExecuteErrorChannel,
  ExecutionTerminal,
  LanguageModelExecutionResult,
  CompilerProtocol,
  NotifyTickEndInput,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  TickEndForwardDecision,
  ToolCall,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { MalformedModelOutput, ProviderRejected, SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor, type MockScriptedRun } from "@agentick/model-executor";
import { omitUndefined } from "@agentick/utils";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Fixture
// ============================================================================

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

function mkStubCompiler(): CompilerProtocol {
  return {
    fx: {
      use: () => () => {},
      guard: () => () => {},
      renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "tf-mount" }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
  };
}

const noopApplicator: StateApplicator = {
  fx: { applyExecutorResult: () => Effect.void, applyToolResults: () => Effect.void },
  applyExecutorResult: async () => undefined,
  applyToolResults: async () => undefined,
  appendEntry: async () => undefined,
};

function mkFakeToolExecutor(): ToolExecutorProtocol {
  const ok = (i: { name: string; toolCallId: string }): DispatchResult => ({
    toolCallId: i.toolCallId,
    name: i.name,
    content: [{ type: "text", text: "ok" }],
    durationMs: 1,
  });
  return {
    fx: {
      use: () => () => {},
      guard: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: (i: { name: string; toolCallId: string }) => Effect.succeed(ok(i)),
    },
    replaceCompilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async (i: { name: string; toolCallId: string }) => ok(i),
  } as unknown as ToolExecutorProtocol;
}

const ended = (): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const toolUse = (id: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "calling" }],
  stopReason: "tool_use",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [{ id, name: "t", input: {} } as ToolCall],
});
const fails = (error?: ExecuteErrorChannel): MockScriptedRun => ({
  result: ended(),
  outcome: "failed",
  ...(error !== undefined ? { error } : {}),
});

interface RecoveryConfig {
  readonly scripted: readonly MockScriptedRun[];
  readonly maxTicks?: number;
  readonly maxConsecutiveFailedTicks?: number;
  readonly decide?: (input: NotifyTickEndInput) => TickEndForwardDecision;
  /** Omit the decide callback entirely — the no-policy baseline. */
  readonly noNotify?: boolean;
  /** Default `true` — the path production takes. `false` drives `executor.run`. */
  readonly stream?: boolean;
}

interface RecoveryTrace {
  readonly terminal: ExecutionTerminal;
  readonly notified: NotifyTickEndInput[];
  readonly events: { readonly kind: string; readonly [k: string]: unknown }[];
  readonly executor: FakeLanguageModelExecutor;
}

async function runRecovery(cfg: RecoveryConfig): Promise<RecoveryTrace> {
  const sub = mkSubstrate();
  const loop = new LoopExecutorHarness("tf-loop", sub.journal, sub.bus, sub.inbox);
  await loop.ready;
  const executor = new FakeLanguageModelExecutor("tf-exec", sub.journal, sub.bus, sub.inbox, {
    scripted: cfg.scripted,
  });
  await executor.ready;

  const notified: NotifyTickEndInput[] = [];
  const events: { kind: string; [k: string]: unknown }[] = [];
  loop.hook({
    onLoopRunExecutionChunk: {
      observe: (e) => {
        events.push(e as unknown as { kind: string });
      },
    },
  });

  const input: RunExecutionInput = {
    sessionId: "tf-s",
    mountId: "tf-mount",
    compiler: mkStubCompiler(),
    modelExecutor: executor,
    toolExecutor: mkFakeToolExecutor(),
    target: executor.target,
    stateApplicator: noopApplicator,
    executionId: "tf-exec",
    maxTicks: cfg.maxTicks ?? 5,
    stream: cfg.stream ?? true,
    ...omitUndefined({ maxConsecutiveFailedTicks: cfg.maxConsecutiveFailedTicks }),
    ...(cfg.noNotify === true
      ? {}
      : {
          notifyTickEnd: (i) =>
            Effect.sync(() => {
              notified.push(i);
              return cfg.decide?.(i);
            }),
        }),
  };

  const terminal = await loop.runExecution(input);
  return { terminal, notified, events, executor };
}

/** The shape of a real policy: re-issue failed ticks, abstain on success. */
const retryFailed = (i: NotifyTickEndInput): TickEndForwardDecision =>
  i.outcome === "failed" ? { kind: "continue" } : undefined;

// ============================================================================
// The fold
// ============================================================================

describe("ADR 99 — a failed terminal reaches the decide fold", () => {
  it("notifies with outcome 'failed' and the settled TickResult", async () => {
    const { notified } = await runRecovery({ scripted: [fails()] });
    expect(notified).toHaveLength(1);
    expect(notified[0]!.outcome).toBe("failed");
    expect(notified[0]!.result!.executorTerminal.outcome).toBe("failed");
    expect(notified[0]!.result!.consecutiveFailures).toBe(1);
  });

  it("abstain stops with today's stopReason and stopCause", async () => {
    const { terminal } = await runRecovery({
      scripted: [fails(new MalformedModelOutput({ toolName: "q" }))],
      decide: () => undefined,
    });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("executor_failed");
    const cause = terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error._tag).toBe("MalformedModelOutput");
  });

  it("no notifyTickEnd at all is byte-identical to the pre-ADR stop", async () => {
    // The fail-safe: recovery is opt-in through a participant, so a loop
    // driven with no decide authority must behave exactly as it did before.
    const { terminal, notified } = await runRecovery({ scripted: [fails()], noNotify: true });
    expect(notified).toHaveLength(0);
    expect(terminal.outcome).toBe("succeeded");
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("executor_failed");
    expect(terminal.result!.stopCause?.kind).toBe("failed");
  });

  it("force-continue re-issues the tick — same request, new tickId", async () => {
    const { terminal, executor, events } = await runRecovery({
      scripted: [fails(new MalformedModelOutput({})), { result: ended() }],
      decide: retryFailed,
    });
    expect(terminal.result!.ticks).toBe(2);
    expect(terminal.result!.stopReason).toBe("end");
    expect("stopCause" in terminal.result!).toBe(false);
    // The retry is the SAME model call — nothing was persisted between them,
    // so the projected request must be identical, not merely re-issued.
    expect(executor.seenRuns).toHaveLength(2);
    const request = ({ compiled, target, tools }: (typeof executor.seenRuns)[number]) =>
      JSON.stringify({ compiled, target, tools });
    expect(request(executor.seenRuns[1]!)).toEqual(request(executor.seenRuns[0]!));
    // …under a FRESH tick identity: a retry is a new tick, not a re-entry.
    expect(executor.seenRuns[1]!.scope!.tickId).not.toEqual(executor.seenRuns[0]!.scope!.tickId);
    // A new tick, not a re-entry of the failed one.
    const starts = events.filter((e) => e.kind === "tick-start");
    expect(starts.map((e) => e.tickIndex)).toEqual([1, 2]);
  });

  it("the retry's tick-start names the tick it re-issues", async () => {
    const { events } = await runRecovery({
      scripted: [fails(), { result: ended() }],
      decide: retryFailed,
    });
    const starts = events.filter((e) => e.kind === "tick-start");
    expect(starts[0]!.retryOfTick).toBeUndefined();
    expect(starts[1]!.retryOfTick).toBe(1);
  });

  it("a failed tick emits no tick-end / tick summary", async () => {
    // Unchanged from today: those events carry a settled result, and there
    // isn't one. A client reads the retry off `tick-start.retryOfTick`.
    const { events } = await runRecovery({
      scripted: [fails(), { result: ended() }],
      decide: retryFailed,
    });
    expect(events.filter((e) => e.kind === "tick-end").map((e) => e.tickIndex)).toEqual([2]);
    expect(events.filter((e) => e.kind === "tick").map((e) => e.tickIndex)).toEqual([2]);
  });

  it("the NON-STREAMING path recovers identically — the terminal is the seam", async () => {
    // `stream: false` composes the tick through `executor.run`, which used to
    // reject on a provider failure and so never reached this fold. That the loop
    // needs no arm of its own is the point: it consumes one terminal vocabulary.
    // The executor's own half of that fix is certified in
    // `model-executor/__tests__/run-failure-terminal.spec.ts`.
    const { terminal, notified, executor } = await runRecovery({
      scripted: [fails(new MalformedModelOutput({})), { result: ended() }],
      decide: retryFailed,
      stream: false,
    });
    expect(notified.map((n) => n.outcome)).toEqual(["failed", "succeeded"]);
    expect(notified[0]!.result!.executorTerminal).toMatchObject({
      outcome: "failed",
      error: { _tag: "MalformedModelOutput" },
    });
    expect(terminal.result!.ticks).toBe(2);
    expect(terminal.result!.stopReason).toBe("end");
    expect(executor.seenRuns).toHaveLength(2);
  });

  it("canceled and vetoed terminals never enter the fold", async () => {
    for (const outcome of ["canceled", "vetoed"] as const) {
      const { notified, terminal } = await runRecovery({
        scripted: [{ result: ended(), outcome }],
        decide: retryFailed,
      });
      expect(notified).toHaveLength(0);
      expect(terminal.result!.ticks).toBe(1);
      expect(terminal.result!.stopReason).toBe(outcome === "canceled" ? "aborted" : "vetoed");
    }
  });
});

// ============================================================================
// The hard caps
// ============================================================================

describe("ADR 99 — maxConsecutiveFailedTicks", () => {
  it("stops a permanently failing model at the default cap, reporting the LAST failure", async () => {
    const { terminal, notified } = await runRecovery({
      scripted: [
        fails(new ProviderRejected({ cause: new Error("boom-1") })),
        fails(new ProviderRejected({ cause: new Error("boom-2") })),
        fails(new ProviderRejected({ cause: new Error("boom-3") })),
        fails(new ProviderRejected({ cause: new Error("boom-4") })),
      ],
      maxTicks: 10,
      decide: retryFailed,
    });
    expect(terminal.result!.ticks).toBe(3);
    expect(notified.map((n) => n.result!.consecutiveFailures)).toEqual([1, 2, 3]);
    expect(terminal.result!.stopReason).toBe("executor_failed");
    const cause = terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error.message).toContain("boom-3");
  });

  it("is configurable", async () => {
    const { terminal } = await runRecovery({
      scripted: [fails(), fails(), fails()],
      maxTicks: 10,
      maxConsecutiveFailedTicks: 1,
      decide: retryFailed,
    });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("executor_failed");
  });

  it("counts CONSECUTIVE failures — a success resets the counter", async () => {
    const { terminal, notified } = await runRecovery({
      scripted: [fails(), { result: toolUse("c1") }, fails(), { result: ended() }],
      maxTicks: 10,
      decide: retryFailed,
    });
    expect(notified.map((n) => n.result!.consecutiveFailures)).toEqual([1, 0, 1, 0]);
    expect(terminal.result!.ticks).toBe(4);
    expect(terminal.result!.stopReason).toBe("end");
  });

  it("maxTicks still bounds the retries", async () => {
    const { terminal } = await runRecovery({
      scripted: [fails(), fails()],
      maxTicks: 1,
      decide: retryFailed,
    });
    expect(terminal.result!.ticks).toBe(1);
    expect(terminal.result!.stopReason).toBe("executor_failed");
    expect(terminal.result!.stopCause?.kind).toBe("failed");
  });
});
