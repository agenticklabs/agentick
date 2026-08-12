/**
 * The compaction trigger (ADR 97) — where the fold decision lives, and the two
 * ways it used to go wrong.
 *
 * Both failures are about a trigger that keeps asking a question. The first
 * shipped: a component read the PREVIOUS request's token count, the fold did
 * not change that number, and the next tick folded an already-folded thread —
 * two compaction markers back to back, the second rewriting the first one's
 * summary. The second is what event-driven triggering does NOT fix on its own:
 * a fold that cannot help returns its input unchanged, leaving the measurement
 * over the ceiling and the trigger free to pay for the same refusal forever.
 *
 * Written against a real session so the chain under test is the real one:
 * executor → TickResult → the tick-end fold → the timeline harness.
 */

import { describe, expect, it, vi } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import type { CompactStrategy, ExecutionTarget, TimelineEntry } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1_000_000 },
};

/**
 * TWO ticks per send — a tool call, then the reply — reporting `secondTick`
 * input tokens on the second.
 *
 * The tick count is the whole point. A single-tick send produces one tick-end,
 * so a trigger could not fire twice however broken it was, and a test built on
 * one would pass against the bug it claims to cover. The double-fold happened
 * BETWEEN ticks.
 *
 * The second tick's number is a parameter because that is exactly what the fold
 * changes in production: fold at tick 1, and tick 2's prompt — and therefore
 * the number the provider reports for it — is smaller. A fake that reports the
 * same figure twice is describing a fold that did not work.
 */
const twoTickExec = (secondTick = 500_000) =>
  new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "calling echo" }],
            toolCalls: [{ id: "tc1", name: "echo", input: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 500_000, outputTokens: 1, totalTokens: 500_001 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
            usage: { inputTokens: secondTick, outputTokens: 1, totalTokens: secondTick + 1 },
          },
        },
      ],
    },
  );

/** The tool the first tick calls — what makes a send TWO ticks. */
const ECHO = {
  id: "t.echo",
  name: "echo",
  description: "echo tool",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.echo",
} as const;

async function mkSession(sessionId: string, compact: CompactStrategy, secondTick?: number) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`${sessionId}-r`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${sessionId}-l`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`${sessionId}-t:elicitation`, journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);
  const tools = new ToolExecutorHarness(`${sessionId}-t`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = twoTickExec(secondTick);
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { compact },
  });
  await session.ready;
  return { session, tools };
}

/** A strategy that always wants to fold, and records every run. */
function recordingStrategy(
  produce: (entries: readonly TimelineEntry[]) => readonly TimelineEntry[],
): { strategy: CompactStrategy; runs: () => number } {
  const run = vi.fn(async ({ entries }: { entries: readonly TimelineEntry[] }) => produce(entries));
  return {
    strategy: {
      source: "projection",
      run: run as unknown as CompactStrategy["run"],
      shouldCompact: () => true,
    },
    runs: () => run.mock.calls.length,
  };
}

const summaryEntry = (): TimelineEntry =>
  ({
    kind: "message",
    message: {
      id: `s${Math.random()}`,
      ts: 0,
      role: "event",
      content: [{ type: "system_event", event: "compaction", data: { summary: "s" } }],
    },
  }) as TimelineEntry;

describe("the trigger runs at tick end, not in the tree", () => {
  it("stops once the fold has actually shrunk the request", async () => {
    // Tick 1 reports 500k and folds. Tick 2 reports 900, because the fold
    // worked and the prompt that went out is small. The trigger must READ that
    // drop and leave the thread alone.
    //
    // This is the shipped defect exactly: the old trigger read a number taken
    // BEFORE the fold, never saw it drop, and compacted the already-folded
    // thread again — two markers back to back, the second rewriting the first
    // one's summary. A tick-end trigger sees the 900.
    const { strategy, runs } = recordingStrategy(() => [summaryEntry()]);
    const withThreshold: CompactStrategy = {
      ...strategy,
      shouldCompact: (ctx) => ctx.usedTokens >= 100_000,
    };
    const { session, tools } = await mkSession("ct-once", withThreshold, 900);

    await (
      await session.send({ messages: [{ role: "user", content: "hi" }], tools: [ECHO] })
    ).result;

    expect(runs()).toBe(1);

    await session.close();
    await tools.close();
  });

  it("asks the STRATEGY, so the threshold lives in exactly one place", async () => {
    // A strategy that declines is never folded, however large the request —
    // the session contributes the measurement and the window, never a ceiling
    // of its own. The duplicate constant in a userland trigger is what this
    // arrangement exists to make impossible.
    const declining: CompactStrategy = {
      source: "projection",
      run: async ({ entries }) => entries,
      shouldCompact: () => false,
    };
    const run = vi.spyOn(declining, "run" as never);
    const { session, tools } = await mkSession("ct-decline", declining);

    await (
      await session.send({ messages: [{ role: "user", content: "hi" }], tools: [ECHO] })
    ).result;
    expect(run).not.toHaveBeenCalled();

    await session.close();
    await tools.close();
  });
});

describe("a fold that cannot help is not retried", () => {
  it("stops after one refusal instead of paying for it every tick", async () => {
    // `rollingSummary` returns its input unchanged when there is nothing older
    // than the verbatim tail, when only summaries remain, and when the summary
    // came back truncated. The measurement does not move either — so without a
    // guard the trigger fires on every subsequent tick, an unbounded series of
    // PAID model calls each accomplishing nothing.
    const { strategy, runs } = recordingStrategy((entries) => entries);
    const { session, tools } = await mkSession("ct-stall", strategy);

    // Two ticks, both over the ceiling, and a fold that changes nothing. The
    // second tick must NOT pay for the same refusal.
    await (
      await session.send({ messages: [{ role: "user", content: "one" }], tools: [ECHO] })
    ).result;
    expect(runs()).toBe(1);

    // A second send appends, which bumps the projection — the guard is keyed on
    // the version precisely so new material clears it. The refusal is recorded
    // against the projection it happened at, not against the session forever.
    await (
      await session.send({ messages: [{ role: "user", content: "two" }], tools: [ECHO] })
    ).result;
    expect(runs()).toBe(2);

    await session.close();
    await tools.close();
  });

  it("a fold that throws leaves the tick intact", async () => {
    // An oversized conversation is recoverable; a failed tick is not.
    const exploding: CompactStrategy = {
      source: "projection",
      run: async () => {
        throw new Error("summarizer exploded");
      },
      shouldCompact: () => true,
    };
    const { session, tools } = await mkSession("ct-throw", exploding);

    const res = await (
      await session.send({ messages: [{ role: "user", content: "hi" }], tools: [ECHO] })
    ).result;
    expect(res.stopReason).not.toBe("executor_failed");

    await session.close();
    await tools.close();
  });
});
