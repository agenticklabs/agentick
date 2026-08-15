/**
 * ADR 99 slice 3 — the bundled tick-failure policy, against the REAL session
 * (compiler + timeline + loop + gates bridge).
 *
 * The load-bearing case is the first one: a failed tick persists nothing, so
 * the retry is the same request over the same conversation. Everything else —
 * which classes retry, how the option replaces the default, the tree seam —
 * is only worth having because that invariant holds.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, type MockScriptedRun } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import {
  CompilerHarness,
  System,
  useLoopControl,
  useOnTickEnd,
  useOnTickStart,
} from "@agentick/compiler-react";
import type {
  ExecuteErrorChannel,
  ExecutionTarget,
  LanguageModelExecutionResult,
  TickFailurePolicy,
  TickResult,
} from "@agentick/spec";
import { MalformedModelOutput, ProviderRejected, StreamFailed } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true, contextWindow: 1000 },
};

const ended = (text = "done"): LanguageModelExecutionResult => ({
  specVersion: "2026-05-08",
  output: [{ type: "text", text }],
  stopReason: "end",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});
const fails = (error: ExecuteErrorChannel): MockScriptedRun => ({
  result: ended(),
  outcome: "failed",
  error,
});
const malformed = (): MockScriptedRun => fails(new MalformedModelOutput({ toolName: "q" }));

interface Fixture {
  readonly session: SessionHarness;
  readonly executor: FakeLanguageModelExecutor;
  close(): Promise<void>;
}

async function mkSession(
  scripted: readonly MockScriptedRun[],
  options: {
    readonly tickFailurePolicy?: TickFailurePolicy;
    readonly maxConsecutiveFailedTicks?: number;
    readonly agent?: React.ReactElement;
  } = {},
): Promise<Fixture> {
  const id = `tfr-${Math.random()}`;
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`${id}-c`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${id}-l`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`${id}-e`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`${id}-t`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`${id}-x`, journal, bus, inbox, { scripted });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: id,
    agent: options.agent ?? React.createElement(System, null, "you are a fixture"),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...(options.tickFailurePolicy !== undefined
      ? { tickFailurePolicy: options.tickFailurePolicy }
      : {}),
    ...(options.maxConsecutiveFailedTicks !== undefined
      ? { maxConsecutiveFailedTicks: options.maxConsecutiveFailedTicks }
      : {}),
  });
  await session.ready;
  await session.mountReady;

  return {
    session,
    executor,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

// ============================================================================
// The invariant recovery rests on
// ============================================================================

describe("ADR 99 — a failed tick persists nothing", () => {
  it("leaves the timeline byte-identical, so the retry is the same request", async () => {
    const snapshots: string[] = [];
    let sessionRef: SessionHarness | undefined;
    const snapshot = (): void => {
      snapshots.push(JSON.stringify(sessionRef?.timeline.read().entries));
    };
    function Agent(): React.ReactElement {
      useOnTickStart(snapshot);
      useOnTickEnd(snapshot);
      return React.createElement(System, null, "you are a fixture");
    }

    const { session, executor, close } = await mkSession([malformed(), { result: ended() }], {
      agent: React.createElement(Agent),
    });
    sessionRef = session;

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;

    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");

    // tick-1 start, tick-1 end (failed), tick-2 start — the conversation the
    // retry renders over is the conversation the failed tick was handed.
    expect(snapshots).toHaveLength(4);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);

    // Which is why the retry's PROJECTION is identical, not merely similar.
    expect(executor.seenRuns).toHaveLength(2);
    expect(JSON.stringify(executor.seenRuns[1]!.compiled)).toEqual(
      JSON.stringify(executor.seenRuns[0]!.compiled),
    );

    // And nothing orphaned in the durable record: one user turn, one answer.
    const roles = session.timeline
      .read()
      .entries.filter((e) => e.kind === "message")
      .map((e) => e.message.role);
    expect(roles).toEqual(["user", "assistant"]);

    await close();
  });
});

// ============================================================================
// The bundled policy
// ============================================================================

describe("ADR 99 — the bundled tick-failure policy", () => {
  it("retries a malformed generation exactly once", async () => {
    const { session, close } = await mkSession([malformed(), malformed(), { result: ended() }]);
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;

    // Tick 1 fails → retry. Tick 2 fails again → the budget is spent.
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("executor_failed");
    expect(result.stopCause?.kind).toBe("failed");
    await close();
  });

  it("does NOT retry a class the model cannot fix by trying again", async () => {
    // A refused request is refused identically on the next tick, and billed.
    const { session, close } = await mkSession([
      fails(new ProviderRejected({ status: 401 })),
      { result: ended() },
    ]);
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.ticks).toBe(1);
    expect(result.stopReason).toBe("executor_failed");
    await close();
  });
});

// ============================================================================
// The dual-form option
// ============================================================================

describe("ADR 99 — tickFailurePolicy", () => {
  it("the table form is a per-class retry budget", async () => {
    const { session, close } = await mkSession(
      [
        fails(new StreamFailed({ cause: "a" })),
        fails(new StreamFailed({ cause: "b" })),
        {
          result: ended(),
        },
      ],
      { tickFailurePolicy: { StreamFailed: 2 } },
    );
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.ticks).toBe(3);
    expect(result.stopReason).toBe("end");
    await close();
  });

  it("a supplied table REPLACES the bundled default — an omitted class stops", async () => {
    const { session, close } = await mkSession([malformed(), { result: ended() }], {
      tickFailurePolicy: { StreamFailed: 1 },
    });
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.ticks).toBe(1);
    expect(result.stopReason).toBe("executor_failed");
    await close();
  });

  it("the predicate form sees the error and the failure count", async () => {
    const seen: Array<{ tag: string; consecutiveFailures: number }> = [];
    const policy: TickFailurePolicy = (error, info) => {
      seen.push({ tag: error._tag, consecutiveFailures: info.consecutiveFailures });
      return info.consecutiveFailures < 3 ? "retry" : "stop";
    };
    const { session, close } = await mkSession([malformed(), malformed(), { result: ended() }], {
      tickFailurePolicy: policy,
    });
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(seen).toEqual([
      { tag: "MalformedModelOutput", consecutiveFailures: 1 },
      { tag: "MalformedModelOutput", consecutiveFailures: 2 },
    ]);
    expect(result.ticks).toBe(3);
    expect(result.stopReason).toBe("end");
    await close();
  });

  it("the loop's hard cap still bounds a generous budget", async () => {
    const { session, close } = await mkSession(
      [malformed(), malformed(), malformed(), malformed()],
      { tickFailurePolicy: { MalformedModelOutput: 10 }, maxConsecutiveFailedTicks: 2 },
    );
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("executor_failed");
    await close();
  });
});

// ============================================================================
// The tree seam
// ============================================================================

describe("ADR 99 — tree-level participation", () => {
  it("useOnTickEnd observes a failed tick and continueAfterTick() re-issues it", async () => {
    const observed: TickResult[] = [];
    function Agent(): React.ReactElement {
      const loopControl = useLoopControl();
      useOnTickEnd((event) => {
        const result = event.result as TickResult;
        if (result.executorTerminal.outcome !== "failed") return;
        observed.push(result);
        loopControl.continueAfterTick();
      });
      return React.createElement(System, null, "you are a fixture");
    }

    // A class the bundled policy REFUSES to retry — so a second tick can only
    // come from the tree's own request.
    const { session, close } = await mkSession(
      [fails(new ProviderRejected({ status: 500 })), { result: ended() }],
      { agent: React.createElement(Agent) },
    );
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;

    expect(observed).toHaveLength(1);
    expect(observed[0]!.consecutiveFailures).toBe(1);
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");
    await close();
  });
});
