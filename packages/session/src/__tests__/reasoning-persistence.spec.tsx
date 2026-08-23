/**
 * Reasoning content survives the session fold onto the timeline.
 *
 * The chain-of-thought surface rests on ONE claim the rest of the stack cannot
 * make for itself: a tick whose output contains `reasoning` blocks yields a
 * persisted assistant entry that still contains them, in the provider's block
 * order, with the round-trip material (`signature`, `isRedacted`,
 * `providerMetadata`) intact.
 *
 * Every hop upstream of here is already pinned elsewhere — adapters route
 * thinking to the reasoning channel (`model-anthropic`, `model-google`,
 * `model-openai` specs), and `StreamAccumulator.toContentBlocks` assembles one
 * block per block index (`model` spec). Downstream, a renderer can only show
 * what the entry kept. This file is the seam between those two facts, and
 * nothing else covered it: a fold that dropped `reasoning` on the floor — or
 * flattened it into the neighbouring text — would have passed the whole suite.
 *
 * The signature matters as much as the text. Anthropic requires a signed
 * thinking block to replay verbatim on the next turn when tools are in play, so
 * an entry that keeps `text` but loses `signature` is not a cosmetic loss; it is
 * a turn the provider will reject.
 *
 * The loop is a `defineLoop` stub driving the session's REAL
 * `stateApplicator.applyExecutorResult` — the seam the shipped loop uses.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { defineLoop } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { MemoryTimelineStore, type TimelineStore } from "@agentick/timeline";
import type {
  ContentBlock,
  ExecutionTarget,
  ExecutionTerminal,
  LoopExecutorFactory,
  ReasoningBlock,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A loop stub that folds one tick carrying exactly `output` through the session. */
function scriptedLoop(output: readonly ContentBlock[]) {
  return defineLoop({
    async runExecution(input): Promise<ExecutionTerminal> {
      await input.stateApplicator.applyExecutorResult({
        sessionId: input.sessionId,
        executionId: input.executionId,
        tickId: "tick-0",
        result: { specVersion: "2026-05-08", output, stopReason: "end", usage },
      });
      return {
        outcome: "succeeded",
        result: {
          executionId: input.executionId,
          ticks: 1,
          usage,
          stopReason: "end",
          output: [...output],
          toolResults: [],
        },
      };
    },
  });
}

function Agent() {
  return React.createElement("message" as never, { role: "user" }, "hi");
}

async function mkSession(
  loopFactory: LoopExecutorFactory,
  store = new InMemorySessionStore(),
  timeline?: { readonly store: TimelineStore; readonly sessionId: string },
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const loop = loopFactory({ scopeId: `l-${Math.random()}`, journal, bus, inbox });
  const compiler = new CompilerHarness(`c-${Math.random()}`, journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness(`e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`x-${Math.random()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage,
      },
    },
  });
  await Promise.all([
    compiler.ready,
    tools.ready,
    elicitation.ready,
    executor.ready,
    (loop as unknown as { ready: Promise<unknown> }).ready,
  ]);

  const sessionId = timeline?.sessionId ?? `s-${Math.random()}`;
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: store,
    ...(timeline ? { timeline: { store: timeline.store } } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, sessionId, store, journal, bus, inbox };
}

const send = async (session: SessionHarness) =>
  (await session.send({ messages: [{ role: "user", content: "go" }] })).result;

/** The assistant entry's content, or `undefined` if the fold produced none. */
function assistantContent(session: SessionHarness): readonly ContentBlock[] | undefined {
  const entry = session.timeline
    .read()
    .entries.find((e) => e.kind === "message" && e.message.role === "assistant");
  return (entry as { message?: { content?: readonly ContentBlock[] } } | undefined)?.message
    ?.content;
}

// ---------------------------------------------------------------------------

describe("reasoning content survives the fold onto the timeline", () => {
  it("keeps a reasoning block, its text, and its signature on the assistant entry", async () => {
    const { session } = await mkSession(
      scriptedLoop([
        {
          type: "reasoning",
          text: "the user wants a sum",
          providerMetadata: { anthropic: { signature: "sig-abc" } },
        },
        { type: "text", text: "42" },
      ]),
    );
    await send(session);

    const content = assistantContent(session);
    expect(content?.map((b) => b.type)).toEqual(["reasoning", "text"]);

    const reasoning = content!.find((b) => b.type === "reasoning") as ReasoningBlock;
    expect(reasoning.text).toBe("the user wants a sum");
    // Anthropic rejects the NEXT turn if a signed thinking block does not
    // replay verbatim, so losing this is a broken conversation, not a lost label.
    // Namespaced by DIALECT — an opaque blob nobody can read is only meaningful
    // alongside whose it is.
    expect(reasoning.providerMetadata).toEqual({ anthropic: { signature: "sig-abc" } });

    await session.close();
  });

  it("preserves block ORDER across an interleaved reasoning / tool_use / text turn", async () => {
    // The order is the record of what the model did, and it is the only thing a
    // transcript can render honestly. A fold that grouped by type would still
    // "keep" every block and still lose this.
    const { session } = await mkSession(
      scriptedLoop([
        { type: "reasoning", text: "first, look it up" },
        { type: "tool_use", toolUseId: "c1", name: "lookup", input: { q: "x" } },
        { type: "reasoning", text: "now explain it" },
        { type: "text", text: "here you go" },
      ]),
    );
    await send(session);

    expect(assistantContent(session)?.map((b) => b.type)).toEqual([
      "reasoning",
      "tool_use",
      "reasoning",
      "text",
    ]);

    await session.close();
  });

  it("keeps a REDACTED reasoning block whole, opaque provider payload included", async () => {
    const { session } = await mkSession(
      scriptedLoop([
        {
          type: "reasoning",
          text: "[redacted]",
          isRedacted: true,
          providerMetadata: { anthropic: { redactedData: "opaque-blob" } },
        },
        { type: "text", text: "done" },
      ]),
    );
    await send(session);

    const reasoning = assistantContent(session)!.find(
      (b) => b.type === "reasoning",
    ) as ReasoningBlock;
    expect(reasoning.isRedacted).toBe(true);
    // The blob is what re-projection resends; a renderer never shows it, and
    // that is exactly why a fold could drop it without any test noticing.
    expect(reasoning.providerMetadata).toEqual({ anthropic: { redactedData: "opaque-blob" } });

    await session.close();
  });

  it("survives checkpoint → resume — reasoning that vanishes on reload is not persisted", async () => {
    // The timeline is CheckpointCapable (checkpointing §3.2), so the reload is
    // a real durable round-trip: `snapshot()` flushes to the store, and a fresh
    // session over the SAME store and id resumes from it. Nothing is carried in
    // a payload, which is precisely why the blocks have to survive serialization
    // in the store rather than in a in-memory hand-off.
    const timelineStore = new MemoryTimelineStore();
    const sessionId = `s-reasoning-${Math.random()}`;
    const { session } = await mkSession(
      scriptedLoop([
        {
          type: "reasoning",
          text: "thinking out loud",
          providerMetadata: { anthropic: { signature: "sig-xyz" } },
        },
        { type: "text", text: "answer" },
      ]),
      new InMemorySessionStore(),
      { store: timelineStore, sessionId },
    );
    await send(session);
    await session.snapshot();
    await session.close();

    const { session: restored } = await mkSession(scriptedLoop([]), new InMemorySessionStore(), {
      store: timelineStore,
      sessionId,
    });
    await restored.restore();

    const reasoning = assistantContent(restored)!.find(
      (b) => b.type === "reasoning",
    ) as ReasoningBlock;
    expect(reasoning.text).toBe("thinking out loud");
    expect(reasoning.providerMetadata).toEqual({ anthropic: { signature: "sig-xyz" } });

    await restored.close();
  });
});
