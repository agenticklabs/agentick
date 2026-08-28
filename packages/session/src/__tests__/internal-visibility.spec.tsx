/**
 * Internal visibility (backlog F) — stamping the spine, session side.
 * See docs/proposals/v2/internal-visibility.md.
 *
 * The `internal` disposition propagates DOWN the spine: an internal session or
 * execution stamps every message `visibility:"internal"` (client-hidden,
 * model-visible); an internal tool's result inherits it; the turn boundary
 * records it for cost-querying. The bus and journal stay WHOLE — stamping never
 * drops, so an internal entry is still present in the durable timeline (the
 * model reads it; the CLIENT hides it, tested in the timeline React view).
 *
 * Driven by a `defineLoop` stub through the session's REAL state applicator —
 * the same seam the shipped loop uses. (The tool-REGISTRY lookup that sets
 * `LoopToolResult.internal` from `annotations.internal`, and the streaming
 * sink-wrap, live in the loop; here we pin the SESSION's honor of the stamp.)
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { defineLoop } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import type {
  ExecutionTarget,
  ExecutionTerminal,
  LoopExecutorFactory,
  LoopToolResult,
  TimelineEntry,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** One assistant tick through the real applicator, then optional tool results. */
function scriptedLoop(opts: { readonly toolResults?: readonly LoopToolResult[] } = {}) {
  return defineLoop({
    async runExecution(input): Promise<ExecutionTerminal> {
      await input.stateApplicator.applyExecutorResult({
        sessionId: input.sessionId,
        executionId: input.executionId,
        tickId: "tick-0",
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage,
        },
      });
      if (opts.toolResults !== undefined && opts.toolResults.length > 0) {
        await input.stateApplicator.applyToolResults({
          sessionId: input.sessionId,
          executionId: input.executionId,
          tickId: "tick-0",
          results: opts.toolResults,
        });
      }
      return {
        outcome: "succeeded",
        result: {
          executionId: input.executionId,
          ticks: 1,
          usage,
          stopReason: "end",
          output: [{ type: "text", text: "ok" }],
          toolResults: opts.toolResults ?? [],
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
  sessionOpts: { readonly internal?: boolean } = {},
): Promise<SessionHarness> {
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
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: new InMemorySessionStore(),
    ...(sessionOpts.internal !== undefined ? { internal: sessionOpts.internal } : {}),
  });
  await session.ready;
  await session.mountReady;
  return session;
}

const entriesOf = (session: SessionHarness): readonly TimelineEntry[] =>
  session.timeline.read().entries;

/** Visibilities of the message entries with a given role, in order. */
function visOf(entries: readonly TimelineEntry[], role: string): (string | undefined)[] {
  return entries
    .filter((e): e is Extract<TimelineEntry, { kind: "message" }> => e.kind === "message")
    .filter((e) => e.message.role === role)
    .map((e) => e.visibility);
}

function boundaryOf(entries: readonly TimelineEntry[]) {
  const b = entries.find((e) => e.kind === "boundary");
  return b !== undefined && b.kind === "boundary" ? b.boundary : undefined;
}

const toolResult = (internal?: boolean): LoopToolResult => ({
  toolCallId: "call-1",
  toolName: "some_tool",
  succeeded: true,
  content: [{ type: "text", text: "tool ok" }],
  durationMs: 1,
  ...(internal !== undefined ? { internal } : {}),
});

describe("internal visibility — the stamp spine (session side)", () => {
  it("a normal turn stamps NOTHING internal", async () => {
    const session = await mkSession(scriptedLoop());
    await (
      await session.send({ messages: [{ role: "user", content: "go" }] })
    ).result;
    const es = entriesOf(session);
    expect(visOf(es, "user")).toEqual([undefined]);
    expect(visOf(es, "assistant")).toEqual([undefined]);
    expect(boundaryOf(es)?.internal).toBeUndefined();
    await session.close();
  });

  it("a message-level visibility hides ONE input while the response stays visible", async () => {
    const session = await mkSession(scriptedLoop());
    await (
      await session.send({
        messages: [
          { role: "user", content: "context payload", visibility: "internal" },
          { role: "user", content: "go" },
        ],
      })
    ).result;
    const es = entriesOf(session);
    expect(visOf(es, "user")).toEqual(["internal", undefined]);
    expect(visOf(es, "assistant")).toEqual([undefined]);
    expect(boundaryOf(es)?.internal).toBeUndefined();
    await session.close();
  });

  it("a message never WIDENS out of an internal execution ('log' stays log)", async () => {
    const session = await mkSession(scriptedLoop());
    await (
      await session.send({
        messages: [
          { role: "user", content: "escape attempt", visibility: "model" },
          { role: "user", content: "note", visibility: "log" },
        ],
        internal: true,
      })
    ).result;
    const es = entriesOf(session);
    expect(visOf(es, "user")).toEqual(["internal", "log"]);
    expect(visOf(es, "assistant")).toEqual(["internal"]);
    await session.close();
  });

  it("send({ internal }) stamps the whole execution — input + assistant + boundary", async () => {
    const session = await mkSession(scriptedLoop());
    await (
      await session.send({ messages: [{ role: "user", content: "go" }], internal: true })
    ).result;
    const es = entriesOf(session);
    expect(visOf(es, "user")).toEqual(["internal"]); // input stamped (rail set before input append)
    expect(visOf(es, "assistant")).toEqual(["internal"]);
    expect(boundaryOf(es)?.internal).toBe(true);
    await session.close();
  });

  it("createSession({ internal }) stamps every turn — send need NOT repeat it", async () => {
    const session = await mkSession(scriptedLoop(), { internal: true });
    await (
      await session.send({ messages: [{ role: "user", content: "go" }] })
    ).result;
    const es = entriesOf(session);
    expect(visOf(es, "user")).toEqual(["internal"]);
    expect(visOf(es, "assistant")).toEqual(["internal"]);
    expect(boundaryOf(es)?.internal).toBe(true);
    await session.close();
  });

  it("an internal tool's result is stamped even in a NON-internal execution", async () => {
    const session = await mkSession(scriptedLoop({ toolResults: [toolResult(true)] }));
    await (
      await session.send({ messages: [{ role: "user", content: "go" }] })
    ).result;
    const es = entriesOf(session);
    // Execution is not internal → assistant stays visible; the internal tool's result is hidden.
    expect(visOf(es, "assistant")).toEqual([undefined]);
    expect(visOf(es, "tool")).toEqual(["internal"]);
    await session.close();
  });

  it("an internal execution stamps tool results too (execution ORs in)", async () => {
    const session = await mkSession(scriptedLoop({ toolResults: [toolResult(false)] }));
    await (
      await session.send({ messages: [{ role: "user", content: "go" }], internal: true })
    ).result;
    expect(visOf(entriesOf(session), "tool")).toEqual(["internal"]);
    await session.close();
  });

  it("stamping does NOT drop — internal entries stay in the durable timeline (bus/journal whole)", async () => {
    const session = await mkSession(scriptedLoop(), { internal: true });
    await (
      await session.send({ messages: [{ role: "user", content: "go" }] })
    ).result;
    const es = entriesOf(session);
    // The model reads them from the persisted tier; they are present, just stamped.
    expect(es.filter((e) => e.kind === "message")).not.toHaveLength(0);
    expect(es.some((e) => e.kind === "message" && e.message.role === "assistant")).toBe(true);
    await session.close();
  });

  // The branch verbs feed the SAME session rung as createSession({ internal }):
  // the disposition each verb declares (ADR 100 — always `true` off `spawn`,
  // the source's own off `fork`/`reply`) reaches the child's
  // `SessionRecord.internal` through `createSessionBody`, covered above. What
  // each verb DECLARES is pinned in `branching.spec.ts`; the parent → child
  // record integration needs the app harness.
  it.todo("a spawned child's record is internal");
  it.todo("a branch off an internal session inherits internal");

  // Streaming rung (the loop's sink-wrap + StreamEvent.internal + client stream render)
  // is the next increment — the live path, distinct from the durable stamp above.
  it.todo("StreamEvents carry internal for an internal execution (sink-wrap at the loop door)");
  // Block rung: tool_use block metadata.internal (loop) + block-level client render.
  it.todo("the tool_use call block is stamped metadata.internal for an internal tool");
});
