/**
 * #33 — explicit "no dangling tool_use" invariant test.
 *
 * ADR 67 pins the ordering: within a tick the loop DISPATCHES the model's
 * tool calls and PERSISTS their results (`stateApplicator.applyToolResults`)
 * BEFORE it makes the continuation decision. So a tier-1 stop on a
 * `tool_use` tick — including hitting the `maxTicks` hard cap — can never
 * leave the timeline with a dangling `tool_use` that has no matching
 * `tool_result`.
 *
 * The invariant is structurally guaranteed by `harness.ts` (the
 * `applyToolResults` call at the end of the tick body precedes the
 * continuation block). This is the explicit, named, belt-and-suspenders
 * assertion: script a single `tool_use` tick with `maxTicks: 1`, and prove
 * a RECORDING `stateApplicator` observed `applyToolResults` even though the
 * loop stopped at the cap.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ContentBlock,
  LanguageModelExecutionResult,
  LoopToolResult,
  ReconcilerProtocol,
  RenderedTree,
  StateApplicator,
  ToolRegistration,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { ToolExecutorHarness, InMemoryHandlerResolver } from "@agentick/tool-executor-next";
import { ElicitationHarness } from "@agentick/elicitation-next";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Fixtures
// ============================================================================

function mkSubstrate() {
  return {
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  };
}

/**
 * A minimal reconciler that emits no tools — the tool under test is
 * pre-registered on the executor via `initialTools`, and dispatch is
 * driven by the scripted model result's `toolCalls`, not by the render.
 */
function mkEmptyReconciler(): ReconcilerProtocol {
  const tree: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };
  return {
    mount: async () => ({ mountId: "nd-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    notifyLifecycle: async () => undefined,
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "nd-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

/**
 * State applicator that records every `applyToolResults` call's payload
 * into a shared array. `applyExecutorResult` is also recorded so the test
 * can assert ordering (executor result THEN tool results, both before the
 * stop).
 */
function mkRecordingApplicator(): {
  readonly applicator: StateApplicator;
  readonly toolResultCalls: Array<readonly LoopToolResult[]>;
  readonly order: string[];
} {
  const toolResultCalls: Array<readonly LoopToolResult[]> = [];
  const order: string[] = [];
  const applicator: StateApplicator = {
    applyExecutorResult: async () => {
      order.push("executor-result");
    },
    applyToolResults: async (input) => {
      order.push("tool-results");
      toolResultCalls.push(input.results);
    },
    appendEntry: async () => undefined,
  };
  return { applicator, toolResultCalls, order };
}

function recordToolReg(): ToolRegistration {
  return {
    declaration: {
      id: "t.record",
      name: "record_me",
      description: "records that it ran",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
      handlerRef: "h.record",
    },
    handlerRef: "h.record",
    binding: { scope: "runtime" },
  };
}

// ============================================================================
// Suite
// ============================================================================

describe("LoopExecutorHarness — no dangling tool_use (#33, ADR 67)", () => {
  it("persists tool_results (applyToolResults) even when the loop stops at maxTicks on a tool_use tick", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_nd", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    // Tool executor with a real handler so dispatch succeeds and produces
    // a genuine tool_result to persist.
    const resolver = new InMemoryHandlerResolver();
    resolver.register(
      "h.record",
      async (): Promise<readonly ContentBlock[]> => [{ type: "text", text: "tool ran" }],
    );
    const elic = new ElicitationHarness("loop_nd:elic", sub.journal, sub.bus, sub.inbox);
    await elic.ready;
    const toolExecutor = new ToolExecutorHarness("tools_nd", sub.journal, sub.bus, sub.inbox, {
      handlerResolver: resolver,
      elicitation: elic,
      initialTools: [recordToolReg()],
    });
    await toolExecutor.ready;

    // Script ONE tick: the model stops with `tool_use` and asks to call
    // `record_me`. With maxTicks: 1 the loop dispatches + persists, then
    // hits the cap and stops — the classic "would dangle if persistence
    // ran after the stop decision" scenario.
    const scriptedResult: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "calling the tool" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [{ id: "call-1", name: "record_me", input: {} }],
    };
    const executor = new FakeLanguageModelExecutor("exec_nd", sub.journal, sub.bus, sub.inbox, {
      scripted: { result: scriptedResult },
    });
    await executor.ready;

    const { applicator, toolResultCalls, order } = mkRecordingApplicator();

    const terminal = await loop.runExecution({
      sessionId: "s_nd",
      mountId: "nd-mount",
      reconciler: mkEmptyReconciler(),
      executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: applicator,
      executionId: "exec_nd",
      maxTicks: 1,
    });

    // The loop stopped at the cap.
    expect(terminal.outcome).toBe("succeeded");
    const runResult = terminal.result;
    expect(runResult).toBeDefined();
    expect(runResult!.ticks).toBe(1);
    expect(runResult!.stopReason).toBe("max_ticks");

    // The invariant: applyToolResults WAS called (tool_results persisted)
    // even though the loop stopped at maxTicks on a tool_use tick — no
    // dangling tool_use.
    expect(toolResultCalls).toHaveLength(1);
    expect(toolResultCalls[0]!.map((r) => r.toolCallId)).toEqual(["call-1"]);
    expect(toolResultCalls[0]![0]!.succeeded).toBe(true);
    expect(toolResultCalls[0]![0]!.content).toEqual([{ type: "text", text: "tool ran" }]);

    // And it was persisted BEFORE the stop — the executor result and the
    // tool results are both recorded (persistence precedes the
    // continuation/maxTicks decision).
    expect(order).toEqual(["executor-result", "tool-results"]);

    // The run surfaced the persisted tool result on the aggregate too.
    expect(runResult!.toolResults.map((r) => r.toolCallId)).toEqual(["call-1"]);
  });
});
