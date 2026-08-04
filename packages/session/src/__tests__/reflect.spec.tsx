/**
 * The reflection pass, and compaction riding it.
 *
 * `reflect()` is the session's answer to "ask this conversation's own model one
 * more question": project the context the next tick would send, append the
 * question, send it. Compaction is its first caller, and this asserts the pair
 * end to end through a REAL session — the config an adopter writes
 * (`timeline: { compact: rollingSummary(…) }`), not a hand-bound `generate`.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System } from "@agentick/compiler-react";
import { rollingSummary } from "@agentick/timeline/strategies";
import {
  progressEventName,
  type AdapterDelta,
  type ExecutionTarget,
  type ProtocolEvent,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { SessionHarness } from "../harness.js";
import { withInstruction } from "../reflect.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "reflect-test",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const SUMMARY = "the whole conversation, folded";
const USAGE = {
  inputTokens: 40_000,
  outputTokens: 900,
  totalTokens: 40_900,
  cachedInputTokens: 34_000,
};

/** Streams the summary in three chunks, then reports what it cost. */
const DELTAS: readonly AdapterDelta[] = [
  { type: "message-start", role: "assistant" },
  { type: "content-start", blockIndex: 0, blockType: "text" },
  { type: "content-delta", blockIndex: 0, delta: "the whole " },
  { type: "content-delta", blockIndex: 0, delta: "conversation, " },
  { type: "content-delta", blockIndex: 0, delta: "folded" },
  { type: "content-end", blockIndex: 0 },
  { type: "message-end", stopReason: "end", usage: USAGE },
];

function summarizingExecutor() {
  return new FakeLanguageModelExecutor(
    `reflect-exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      target,
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: SUMMARY }],
          stopReason: "end",
          usage: USAGE,
        },
        deltas: DELTAS,
      },
    },
  );
}

async function makeSession(keepVerbatim: number) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`rf-c-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`rf-l-${Math.random()}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`rf-e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`rf-t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = summarizingExecutor();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `rf-${Math.random()}`,
    agent: React.createElement(System, null, "you are helpful"),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { compact: rollingSummary({ keepVerbatim }) },
  });
  await session.ready;
  await session.mountReady;

  for (let i = 0; i < 10; i++) {
    await session.timeline.append({
      kind: "message",
      message: {
        id: `m${i}`,
        ts: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${i}` }],
      },
    });
  }

  return {
    session,
    bus,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

const summaryEvent = (entries: readonly unknown[]) =>
  entries
    .map(
      (e) =>
        (e as { message?: { content?: readonly { data?: Record<string, unknown> }[] } }).message
          ?.content?.[0],
    )
    .find((b) => b?.data?.["summary"] !== undefined);

describe("compaction through a real session", () => {
  it("folds with the session's own model — nothing binds a summarizer", async () => {
    const rig = await makeSession(2);

    await rig.session.timeline.compact();

    const entries = rig.session.timeline.read().entries;
    expect(summaryEvent(entries)?.data?.["summary"]).toBe(SUMMARY);
    await rig.close();
  });

  it("records what the fold cost, cache reads included", async () => {
    const rig = await makeSession(2);

    await rig.session.timeline.compact();

    expect(summaryEvent(rig.session.timeline.read().entries)?.data?.["usage"]).toEqual(USAGE);
    await rig.close();
  });

  it("reports progress as the summary streams", async () => {
    const rig = await makeSession(2);
    const seen: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(rig.bus.subscribe({}), (e) =>
        Effect.sync(() => {
          if (e.name === progressEventName("timeline")) seen.push(e);
        }),
      ),
    );
    await waitFor(() =>
      rig.bus.hasSubscriberFor({ surface: "timeline", name: "x", phase: "terminal" }),
    );

    await rig.session.timeline.compact();

    // The cap is the denominator, so the bar is determinate — and the counts
    // rise, which is the thing a spinner cannot say.
    await waitFor(() => seen.length > 1);
    const updates = seen.map((e) => e.payload as { progress: number; total?: number });
    expect(updates.every((u) => u.total === 8192)).toBe(true);
    expect(updates.at(-1)!.progress).toBeGreaterThan(updates[0]!.progress);
    // One token for the whole fold — a bar, not a series of unrelated ticks.
    expect(new Set(seen.map((e) => (e.payload as { token: string }).token)).size).toBe(1);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await rig.close();
  });
});

describe("withInstruction", () => {
  const input = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    tools: [{ name: "search", description: "", inputSchema: { type: "object" as const } }],
  };

  it("appends the instruction as the last user turn, so the prefix is a cache read", () => {
    const out = withInstruction(input as never, "summarize");
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBe(input.messages[0]);
    expect(out.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "summarize" }],
    });
  });

  it("withholds the tools — a model handed one reaches for it instead of answering", () => {
    expect(withInstruction(input as never, "summarize").tools).toEqual([]);
  });

  it("sets the cap only when one was asked for", () => {
    expect(withInstruction(input as never, "s", 500).parameters?.maxOutputTokens).toBe(500);
    expect(withInstruction(input as never, "s").parameters).toBeUndefined();
  });
});
