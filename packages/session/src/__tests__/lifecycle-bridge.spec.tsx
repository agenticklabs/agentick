/**
 * THE integration gate (#206 / ADR 55): the loop → compiler →
 * lifecycle-hook chain, end to end, through a REAL stack. Its absence is
 * why the dead bridge shipped green across five packages — every prior
 * lifecycle test injected at the store/harness boundary by hand. This one
 * runs a real execution (with a scripted tool call) and asserts the WHOLE
 * useOn* family fires — tick-end, execution-start/end, tool-start/end —
 * plus useContextInfo's live window.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { useKnob } from "@agentick/knobs/react";
import {
  CompilerHarness,
  useBridges,
  useContextInfo,
  useOnTickEnd,
  useOnExecutionStart,
  useOnExecutionEnd,
  useOnToolStart,
  useOnToolEnd,
  useOnModelGenerateStart,
  useOnModelGenerateEnd,
  useOnError,
  type ContextInfo,
} from "@agentick/compiler-react";
import { System } from "@agentick/compiler-react";
import type {
  ExecutionTarget,
  LifecycleError,
  LifecycleExecutionEnd,
  LifecycleExecutionStart,
  LifecycleModelGenerateEnd,
  LifecycleModelGenerateStart,
  LifecycleToolEnd,
  LifecycleToolStart,
  NotifyTickEndInput,
  TickEndForwardDecision,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  // Self-described window — effectiveModelInfo folds it (no seed row for "mock").
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1000 },
};

/**
 * Two-tick scripted executor: tick 1 emits a `tool_use` with one tool
 * call (loop dispatches it → tool-start/tool-end fire), tick 2 ends the
 * run. Both ticks report 250 input tokens so useContextInfo's final
 * utilization stays 0.25 (250 / 1000).
 */
function toolThenReplyExec() {
  return new FakeLanguageModelExecutor(
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
            usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
            usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 },
          },
        },
      ],
    },
  );
}

describe("lifecycle bridge — real loop drives the WHOLE hook family (#206 / ADR 55)", () => {
  it("tick-end, execution-start/end, tool-start/end all fire; useContextInfo yields a live window + utilization", async () => {
    const tickEnds: number[] = [];
    const executionStarts: LifecycleExecutionStart[] = [];
    const executionEnds: LifecycleExecutionEnd[] = [];
    const toolStarts: LifecycleToolStart[] = [];
    const toolEnds: LifecycleToolEnd[] = [];
    const modelStarts: LifecycleModelGenerateStart[] = [];
    const modelEnds: LifecycleModelGenerateEnd[] = [];
    const errors: unknown[] = [];
    const contextSamples: ContextInfo[] = [];

    function Agent() {
      useOnTickEnd(() => {
        tickEnds.push(Date.now());
      });
      useOnExecutionStart((e) => {
        executionStarts.push(e);
      });
      useOnExecutionEnd((e) => {
        executionEnds.push(e);
      });
      useOnToolStart((e) => {
        toolStarts.push(e);
      });
      useOnToolEnd((e) => {
        toolEnds.push(e);
      });
      useOnModelGenerateStart((e) => {
        modelStarts.push(e);
      });
      useOnModelGenerateEnd((e) => {
        modelEnds.push(e);
      });
      useOnError((e) => {
        errors.push(e);
      });
      contextSamples.push(useContextInfo());
      return React.createElement(System, null, "you are helpful");
    }

    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("lc-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("lc-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);
    const elicitation = new ElicitationHarness("lc-t:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("lc-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = toolThenReplyExec();
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `lc-${Math.random()}`,
      agent: React.createElement(Agent),
      compiler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
      // No `models` injection needed — the window rides target.capabilities.
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          id: "t.echo",
          name: "echo",
          description: "echo tool",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.echo",
        },
      ],
    });
    await handle.result;

    // The async bridge fired: real tick-ends reached the hook store.
    expect(tickEnds.length).toBeGreaterThan(0);

    // The COMPLETED bridge (ADR 55): the rest of the family is now live
    // from a real run — not just tick-end.
    expect(executionStarts.length).toBeGreaterThan(0);
    expect(executionEnds.length).toBeGreaterThan(0);
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolEnds.length).toBeGreaterThan(0);
    // The scripted tool succeeds (handler registered) — end carries it.
    expect(toolStarts[0]!.name).toBe("echo");
    expect(toolEnds[0]!.outcome).toBe("succeeded");
    // This run is NON-streaming (supportsStreaming: false). ADR 89 §1
    // routes the non-streaming `fx.run` THROUGH the `model:generate`
    // command, so the model-generate projection fires here too — one
    // start+end per tick (two ticks: the tool_use tick + the reply tick),
    // all flagged `stream: false`. The streaming-path test below proves
    // the streaming variant.
    expect(modelStarts.length).toBeGreaterThan(0);
    expect(modelEnds.length).toBeGreaterThan(0);
    expect(modelStarts.every((e) => e.stream === false)).toBe(true);
    expect(modelEnds.every((e) => e.stream === false)).toBe(true);
    // Happy path — no error bridged.
    expect(errors).toHaveLength(0);

    // WINDOW is SYNCHRONOUS render-context (ADR 54 / 55): it appears in a
    // render sample immediately — no flush needed, no async race.
    expect(contextSamples.some((c) => c.contextWindow === 1000)).toBe(true);

    // usedTokens is the ASYNC bridge half (historical) — flush React's
    // Scheduler, then the latest render reflects it + utilization.
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(() => setImmediate(r), 0));
    const last = contextSamples[contextSamples.length - 1]!;
    expect(last.contextWindow).toBe(1000);
    expect(last.usedTokens).toBe(250);
    expect(last.utilization).toBeCloseTo(0.25); // 250 / 1000

    // The locally-measured estimate rides the same bridge, and carries the one
    // thing `usedTokens` cannot: which part of the request was conversation and
    // which was tool schema. A trigger that folds the timeline can only act on
    // the first, so a single total is the wrong number to hand it.
    //
    // This assertion is here rather than in a unit test on purpose — the chain
    // it proves is executor → TickResult → lifecycle metadata → hook, five
    // packages, exactly the shape that shipped dead before this file existed.
    expect(last.estimated).toBeDefined();
    expect(last.estimated!.total).toBe(last.estimated!.messages + last.estimated!.tools);
    // The tree declares one tool, so the schema half is real and separable.
    expect(last.estimated!.tools).toBeGreaterThan(0);

    await session.close();
    await tools.close();
  });
});

// ============================================================================
// ADR 89 §4 — projection wiring + barrier + error projection
// ============================================================================

interface Stack {
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  readonly compiler: CompilerHarness;
  readonly loop: LoopExecutorHarness;
}

async function mkStack(scope: string): Promise<Stack> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`${scope}-r`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${scope}-l`, journal, bus, inbox);
  await Promise.all([compiler.ready, loop.ready]);
  return { journal, bus, inbox, compiler, loop };
}

async function mkSession(
  stack: Stack,
  sessionId: string,
  agent: React.ReactElement,
  executor: FakeLanguageModelExecutor,
  targetOverride?: ExecutionTarget,
): Promise<{ session: SessionHarness; tools: ToolExecutorHarness }> {
  const { journal, bus, inbox } = stack;
  const resolver = new InMemoryHandlerResolver();
  resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);
  resolver.register("h.boom", async () => {
    throw new Error("handler exploded");
  });
  const elicitation = new ElicitationHarness(`${sessionId}-t:elicitation`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`${sessionId}:tools`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  await Promise.all([tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent,
    compiler: stack.compiler,
    loop: stack.loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target: targetOverride ?? target,
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

const echoTool = {
  id: "t.echo",
  name: "echo",
  description: "echo tool",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.echo",
} as const;

describe("lifecycle projection wiring (ADR 89 §4)", () => {
  it("routes per mount: two sessions on ONE shared loop — only the running session's hooks fire", async () => {
    const stack = await mkStack(`route-${Math.random()}`);

    const aTicks: string[] = [];
    const bTicks: string[] = [];
    function AgentA() {
      useOnTickEnd((e) => void aTicks.push(e.tickId));
      return React.createElement(System, null, "a");
    }
    function AgentB() {
      useOnTickEnd((e) => void bTicks.push(e.tickId));
      return React.createElement(System, null, "b");
    }

    const a = await mkSession(
      stack,
      `route-a-${Math.random()}`,
      React.createElement(AgentA),
      toolThenReplyExec(),
    );
    const b = await mkSession(
      stack,
      `route-b-${Math.random()}`,
      React.createElement(AgentB),
      toolThenReplyExec(),
    );

    const handle = await a.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result;

    // Session A's mount saw its ticks; session B — same shared loop
    // instance, different mount — saw NOTHING. The forwarders filter by
    // the identity the hook payloads carry (TickResult.sessionId).
    expect(aTicks.length).toBeGreaterThan(0);
    expect(bTicks).toHaveLength(0);

    // Unsubscribe cascades on close: after A closes, B's run doesn't
    // trip A's (now-unhooked) forwarders.
    await a.session.close();
    const hb = await b.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await hb.result;
    expect(bTicks.length).toBeGreaterThan(0);
    expect(aTicks.length).toBeLessThanOrEqual(2); // unchanged by B's run

    await b.session.close();
    await a.tools.close();
    await b.tools.close();
  });

  it("THE BARRIER: a knob mutated by an ASYNC useOnTickEnd effect is visible to the DECIDE (settle-before-decide, ADR 67)", async () => {
    const stack = await mkStack(`barrier-${Math.random()}`);

    function Agent() {
      const [, setFlag] = useKnob("flag", "unset");
      void setFlag;
      const { knobs } = useBridges();
      useOnTickEnd(async () => {
        // Real async boundary BEFORE the mutation: were the settle
        // fire-and-forget (not awaited in the loop:tick cascade), the
        // DECIDE below would read "unset".
        await new Promise((r) => setTimeout(r, 0));
        await knobs.set({ id: "flag", value: "settled" });
      });
      return React.createElement(System, null, "barrier");
    }

    const executor = toolThenReplyExec();
    const { session, tools } = await mkSession(
      stack,
      `barrier-${Math.random()}`,
      React.createElement(Agent),
      executor,
    );

    // Observe the DECIDE: the loop calls the session's tick-end bridge (the
    // ADR-67 continuation fold) AFTER the tick command's terminal. Read the
    // knob exactly there.
    //
    // Patch the Fx TWIN, not the Promise facade: the bridge is Effect-canonical
    // so the loop composes it in its own fiber, and the facade is no longer on
    // the path at all. Wrapping the facade here would observe nothing.
    const knobAtDecide: Array<string | undefined> = [];
    const original = session.notifyLifecycleFx.bind(session);
    (session as { notifyLifecycleFx: typeof session.notifyLifecycleFx }).notifyLifecycleFx = (
      i: NotifyTickEndInput,
    ): Effect.Effect<TickEndForwardDecision, unknown, never> =>
      Effect.suspend(() => {
        knobAtDecide.push(session.knobs.get("flag") as string | undefined);
        return original(i);
      });

    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result;

    // Every decide observed the tick-end effect's mutation — the settle
    // completed in-cascade before the terminal, before the decide.
    expect(knobAtDecide.length).toBeGreaterThan(0);
    for (const seen of knobAtDecide) expect(seen).toBe("settled");

    await session.close();
    await tools.close();
  });

  it("useOnModelGenerateStart/End fire from the REAL model:generate_stream command (tier-4 call middleware)", async () => {
    const stack = await mkStack(`model-${Math.random()}`);

    const starts: LifecycleModelGenerateStart[] = [];
    const ends: LifecycleModelGenerateEnd[] = [];
    function Agent() {
      useOnModelGenerateStart((e) => void starts.push(e));
      useOnModelGenerateEnd((e) => void ends.push(e));
      return React.createElement(System, null, "model");
    }

    // Streaming-capable fake — the loop's default streaming path rides
    // the `model:generate_stream` COMMAND, whose onBefore/After hooks the
    // session's tier-4 forwarders project. (The non-streaming `fx.run`
    // rides the `model:generate` command symmetrically — see the first
    // test in this file, which asserts `stream: false`.)
    const executor = new FakeLanguageModelExecutor(
      `exec-stream-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "done" }],
              stopReason: "end",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
        ],
      },
    );
    const { session, tools } = await mkSession(
      stack,
      `model-${Math.random()}`,
      React.createElement(Agent),
      executor,
      executor.target, // fake's default target supports streaming
    );

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.stream).toBe(true);
    expect(typeof starts[0]!.tickId).toBe("string");
    expect(typeof starts[0]!.executionId).toBe("string");

    await session.close();
    await tools.close();
  });

  it("error projection: a FAILED executor terminal fires useOnError (phase 'model'); no tick-end settle for the failed tick", async () => {
    const stack = await mkStack(`err-model-${Math.random()}`);

    const errors: LifecycleError[] = [];
    const tickEnds: string[] = [];
    function Agent() {
      useOnError((e) => void errors.push(e));
      useOnTickEnd((e) => void tickEnds.push(e.tickId));
      return React.createElement(System, null, "err");
    }

    const failing = new FakeLanguageModelExecutor(
      `exec-fail-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            outcome: "failed",
            result: {
              specVersion: "2026-05-08",
              output: [],
              stopReason: "end",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
          },
        ],
      },
    );
    const { session, tools } = await mkSession(
      stack,
      `err-model-${Math.random()}`,
      React.createElement(Agent),
      failing,
    );

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.stopReason).toBe("executor_failed");

    expect(errors).toHaveLength(1);
    expect(errors[0]!.phase).toBe("model");
    // The failed tick did NOT settle (parity with the retired in-body
    // settle, which only ran on a succeeded executor terminal).
    expect(tickEnds).toHaveLength(0);

    await session.close();
    await tools.close();
  });

  it("a provider failure reaches BOTH surfaces: the resolved SendResult and the turn boundary", async () => {
    // The whole point of the field, end to end. `executor_failed` RESOLVES the
    // caller's promise (a turn that reached a provider and was refused is an
    // outcome, not a broken contract), so `.catch` never runs and `stopReason`
    // used to be everything a caller could learn. Meanwhile the turn appended NO
    // assistant entry — nothing generated — so the boundary is the only durable
    // trace, and it recorded the outcome without the cause. Both gaps, one claim.
    const stack = await mkStack(`err-cause-${Math.random()}`);
    const failing = new FakeLanguageModelExecutor(
      `exec-cause-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            outcome: "failed",
            result: {
              specVersion: "2026-05-08",
              output: [],
              stopReason: "end",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
          },
        ],
      },
    );
    const { session, tools } = await mkSession(
      stack,
      `err-cause-${Math.random()}`,
      React.createElement(function Agent() {
        return React.createElement(System, null, "err");
      }),
      failing,
    );

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;
    expect(result.stopReason).toBe("executor_failed");

    // Surface 1 — the caller's channel.
    expect(result.stopCause?.kind).toBe("failed");
    if (result.stopCause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(result.stopCause.error._tag).toBe("ProviderRejected");

    // Surface 2 — the durable record. Also confirms the premise: no assistant
    // entry was written, so without the boundary there is nothing on the
    // timeline to say this turn ever happened.
    const persisted = session.timeline.readPersisted();
    expect(persisted.some((e) => e.kind === "message" && e.message.role === "assistant")).toBe(
      false,
    );
    const boundary = persisted.find((e) => e.kind === "boundary");
    if (boundary?.kind !== "boundary") throw new Error("expected a boundary entry");
    expect(boundary.boundary.outcome).toBe("failed");
    if (boundary.boundary.stopCause?.kind !== "failed") {
      throw new Error("expected the boundary to carry the failure cause");
    }
    expect(boundary.boundary.stopCause.error._tag).toBe("ProviderRejected");
    expect(boundary.boundary.stopCause.error.message).toBe(result.stopCause.error.message);

    await session.close();
    await tools.close();
  });

  it("error projection: a HARD tool-handler throw fires tool-end (failed) AND useOnError (phase 'tool')", async () => {
    const stack = await mkStack(`err-tool-${Math.random()}`);

    const errors: LifecycleError[] = [];
    const toolEnds: LifecycleToolEnd[] = [];
    function Agent() {
      useOnError((e) => void errors.push(e));
      useOnToolEnd((e) => void toolEnds.push(e));
      return React.createElement(System, null, "err");
    }

    const executor = new FakeLanguageModelExecutor(
      `exec-boom-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "calling boom" }],
              toolCalls: [{ id: "tc-boom", name: "boom", input: {} }],
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "done" }],
              stopReason: "end",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
        ],
      },
    );
    const { session, tools } = await mkSession(
      stack,
      `err-tool-${Math.random()}`,
      React.createElement(Agent),
      executor,
    );

    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          id: "t.boom",
          name: "boom",
          description: "always throws",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.boom",
        },
      ],
    });
    await handle.result;

    expect(toolEnds.length).toBeGreaterThan(0);
    expect(toolEnds[0]!.name).toBe("boom");
    expect(toolEnds[0]!.outcome).toBe("failed");
    const toolErrors = errors.filter((e) => e.phase === "tool");
    expect(toolErrors).toHaveLength(1);
    expect(toolErrors[0]!.error.message).toContain("handler exploded");

    await session.close();
    await tools.close();
  });
});
