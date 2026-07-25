/**
 * Tree-side TRANSFORM / GUARD interceptors, end to end (ADR 89 §4) — the
 * unfinished half of the lifecycle projection: React components registering
 * REAL, IN-PATH interceptors on the framework's commands, not just observing
 * them. Every test here runs a REAL execution (real loop, real tool +
 * elicitation executors, a scripted model) so the tree's guard/transform sits
 * in the ACTUAL critical path of the model's tool + generate calls.
 *
 * Coverage: veto-from-component-state; the `<ToolGate>` defer→elicitation
 * confirm flow (accept→proceed, decline→veto); a transform injecting into the
 * model's ACTUAL projected input (asserted via the executor); per-mount
 * isolation on a shared loop; ref-freshness (the guard sees the LATEST
 * render's state); mid-execution unmount safety; and an observe-hooks
 * regression.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import React from "react";
import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { useKnob } from "@agentick/knobs/react";
import {
  CompilerHarness,
  System,
  ToolGate,
  useBridges,
  useGuardToolDispatch,
  useOnToolEnd,
  useTransformModelInput,
} from "@agentick/compiler-react";
import type { ExecutionTarget, LifecycleToolEnd, ProtocolEvent } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

// Non-streaming target — so the loop's tick rides the `model:generate`
// command (ADR 89 §1), the path `useTransformModelInput` covers here.
const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1000 },
};

/** Two-tick scripted executor: tick 1 calls `echo`, tick 2 ends the run. */
function toolThenReplyExec(): FakeLanguageModelExecutor {
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
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          },
        },
      ],
    },
  );
}

const echoTool = {
  id: "t.echo",
  name: "echo",
  description: "echo tool",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.echo",
} as const;

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

interface SessionBundle {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  readonly elicitation: ElicitationHarness;
  /** Count of times the `echo` handler actually RAN (0 ⇒ vetoed/blocked). */
  echoRuns: () => number;
}

async function mkSession(
  stack: Stack,
  sessionId: string,
  agent: React.ReactElement,
  executor: FakeLanguageModelExecutor,
): Promise<SessionBundle> {
  const { journal, bus, inbox } = stack;
  let echoRuns = 0;
  const resolver = new InMemoryHandlerResolver();
  resolver.register("h.echo", async () => {
    echoRuns++;
    return [{ type: "text", text: "ok" }];
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
    target,
    // Share the SAME elicitation instance the tools use, so `bridges.elicitation`
    // (what <ToolGate> drives) is the one this test responds to.
    elicitation,
  });
  await session.ready;
  await session.mountReady;
  return { session, tools, elicitation, echoRuns: () => echoRuns };
}

/** Resolve with the next elicitation request's correlationId (subscribe BEFORE send). */
function nextElicitationCorrelationId(bus: LocalEventBus): Promise<string> {
  type EnvelopeWithMetadata = ProtocolEvent & {
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: "session:channel:elicitation" },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => {
    const env = Chunk.toReadonlyArray(chunk)[0]!;
    const id = env.metadata?.correlationId;
    if (typeof id !== "string") throw new Error("no correlationId on elicitation envelope");
    return id;
  });
}

describe("tree-side guard/transform interceptors — end to end (ADR 89 §4)", () => {
  it("VETO from component state: a guard vetoes the model's tool call → the handler never runs", async () => {
    const stack = await mkStack(`veto-${Math.random()}`);
    function Agent(): React.ReactElement {
      useGuardToolDispatch((input) => (input.name === "echo" ? "veto" : "proceed"));
      return React.createElement(System, null, "guard");
    }
    const bundle = await mkSession(
      stack,
      `veto-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );

    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result; // the vetoed dispatch becomes a failed tool result — run completes

    // The guard short-circuited BEFORE the body: the echo handler never ran.
    expect(bundle.echoRuns()).toBe(0);

    await bundle.session.close();
    await bundle.tools.close();
  });

  it("PROCEED: a guard that admits the call lets the handler run (the veto's twin)", async () => {
    const stack = await mkStack(`proceed-${Math.random()}`);
    function Agent(): React.ReactElement {
      useGuardToolDispatch(() => "proceed");
      return React.createElement(System, null, "guard");
    }
    const bundle = await mkSession(
      stack,
      `proceed-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );
    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result;
    expect(bundle.echoRuns()).toBe(1);
    await bundle.session.close();
    await bundle.tools.close();
  });

  it("DEFER → elicitation confirm: <ToolGate> ACCEPTED admits the tool call", async () => {
    const stack = await mkStack(`gate-ok-${Math.random()}`);
    function Agent(): React.ReactElement {
      const { elicitation } = useBridges();
      return React.createElement(ToolGate, {
        tool: "echo",
        confirm: async (input) => {
          const res = await elicitation.elicit({
            mode: "url",
            message: `Run ${input.name}?`,
            url: "https://confirm.example/x",
            elicitationId: `gate-${input.toolCallId}`,
          });
          return res.outcome === "accepted";
        },
      });
    }
    const bundle = await mkSession(
      stack,
      `gate-ok-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );

    // Subscribe BEFORE send so the confirm's elicitation request is captured.
    const idP = nextElicitationCorrelationId(stack.bus);
    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    const correlationId = await idP;
    // The guard is SUSPENDED in-path on the elicitation — approve it.
    await bundle.elicitation.respond({ correlationId, outcome: "accepted", value: {} });
    await handle.result;

    expect(bundle.echoRuns()).toBe(1);
    await bundle.session.close();
    await bundle.tools.close();
  });

  it("DEFER → elicitation confirm: <ToolGate> DECLINED vetoes the tool call", async () => {
    const stack = await mkStack(`gate-no-${Math.random()}`);
    function Agent(): React.ReactElement {
      const { elicitation } = useBridges();
      return React.createElement(ToolGate, {
        tool: "echo",
        confirm: async (input) => {
          const res = await elicitation.elicit({
            mode: "url",
            message: `Run ${input.name}?`,
            url: "https://confirm.example/x",
            elicitationId: `gate-${input.toolCallId}`,
          });
          return res.outcome === "accepted";
        },
      });
    }
    const bundle = await mkSession(
      stack,
      `gate-no-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );

    const idP = nextElicitationCorrelationId(stack.bus);
    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    const correlationId = await idP;
    await bundle.elicitation.respond({ correlationId, outcome: "declined", reason: "no" });
    await handle.result;

    // Declined → the guard vetoes → the handler never runs.
    expect(bundle.echoRuns()).toBe(0);
    await bundle.session.close();
    await bundle.tools.close();
  });

  it("TRANSFORM injects into the model's ACTUAL projected input (asserted via the executor)", async () => {
    const stack = await mkStack(`xform-${Math.random()}`);
    const SENTINEL = "TREE_INJECTED_SYSTEM_NOTE";
    function Agent(): React.ReactElement {
      useTransformModelInput(async (input, next) =>
        next({
          ...input,
          targetInput: {
            ...input.targetInput,
            messages: [
              { role: "system", content: [{ type: "text", text: SENTINEL }] },
              ...input.targetInput.messages,
            ],
          },
        }),
      );
      return React.createElement(System, null, "xform");
    }
    // No tool call — one-tick reply is enough to fire model:generate once.
    const executor = new FakeLanguageModelExecutor(
      `exec-x-${Math.random()}`,
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
              usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
            },
          },
        ],
      },
    );

    // The EXECUTOR observes its own `model:generate` input via a tier-2
    // middleware — composed INSIDE the tier-4 tree transform, so it sees the
    // post-injection input the provider would receive.
    const seen: unknown[] = [];
    executor.use(async (input, next, ctx) => {
      if (ctx.op === "ModelGenerate") seen.push(input);
      return next(input);
    });

    const bundle = await mkSession(
      stack,
      `xform-${Math.random()}`,
      React.createElement(Agent),
      executor,
    );
    const handle = await bundle.session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).toContain(SENTINEL);

    await bundle.session.close();
    await bundle.tools.close();
  });

  it("PER-MOUNT isolation: mount A's guard does NOT fire for mount B's tool call (shared loop)", async () => {
    const stack = await mkStack(`iso-${Math.random()}`);
    function GuardedAgent(): React.ReactElement {
      useGuardToolDispatch(() => "veto");
      return React.createElement(System, null, "a");
    }
    function PlainAgent(): React.ReactElement {
      return React.createElement(System, null, "b");
    }
    const a = await mkSession(
      stack,
      `iso-a-${Math.random()}`,
      React.createElement(GuardedAgent),
      toolThenReplyExec(),
    );
    const b = await mkSession(
      stack,
      `iso-b-${Math.random()}`,
      React.createElement(PlainAgent),
      toolThenReplyExec(),
    );

    // B has NO guard — its echo call must run even though A (same shared loop)
    // registered a vetoing guard.
    const hb = await b.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await hb.result;
    expect(b.echoRuns()).toBe(1);

    // A's guard still vetoes A's own call.
    const ha = await a.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await ha.result;
    expect(a.echoRuns()).toBe(0);

    await a.session.close();
    await b.session.close();
    await a.tools.close();
    await b.tools.close();
  });

  it("REF-FRESHNESS: the guard sees the LATEST render's state, not the first render's", async () => {
    const stack = await mkStack(`fresh-${Math.random()}`);
    function Agent(): React.ReactElement {
      // A reactive knob — a `set` re-renders this component, refreshing the
      // guard's ref to a closure over the NEW value.
      const [blocked] = useKnob("blocked", true);
      useGuardToolDispatch(() => (blocked ? "veto" : "proceed"));
      return React.createElement(System, null, "fresh");
    }
    // TWO rounds with DISTINCT tool-call ids (tcA/tcB) — a fresh id per send
    // avoids the dispatch idempotency cache (opId keyed by toolCallId), so
    // send 2 truly re-dispatches rather than replaying send 1's terminal.
    const executor = new FakeLanguageModelExecutor(
      `exec-fresh-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        scripted: [
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "call A" }],
              toolCalls: [{ id: "tcA", name: "echo", input: {} }],
              stopReason: "tool_use",
              usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
            },
          },
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "done A" }],
              stopReason: "end",
              usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
            },
          },
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "call B" }],
              toolCalls: [{ id: "tcB", name: "echo", input: {} }],
              stopReason: "tool_use",
              usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
            },
          },
          {
            result: {
              specVersion: "2026-05-08",
              output: [{ type: "text", text: "done B" }],
              stopReason: "end",
              usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
            },
          },
        ],
      },
    );
    const bundle = await mkSession(
      stack,
      `fresh-${Math.random()}`,
      React.createElement(Agent),
      executor,
    );

    // Send 1 — `blocked` defaults true → veto → handler blocked.
    const h1 = await bundle.session.send({
      messages: [{ role: "user", content: "one" }],
      tools: [echoTool],
    });
    await h1.result;
    expect(bundle.echoRuns()).toBe(0);

    // Flip the knob. Send 2 re-renders the tree (the knob subscription marks
    // Agent dirty), so its render captures blocked=false into the guard's ref
    // → the SAME guard now admits the (fresh-id) call.
    await bundle.session.knobs.set({ id: "blocked", value: false });
    const h2 = await bundle.session.send({
      messages: [{ role: "user", content: "two" }],
      tools: [echoTool],
    });
    await h2.result;
    expect(bundle.echoRuns()).toBe(1);

    await bundle.session.close();
    await bundle.tools.close();
  });

  it("UNMOUNT mid-execution is safe: closing the session tears down the forwarder without a crash", async () => {
    const stack = await mkStack(`unmount-${Math.random()}`);
    function Agent(): React.ReactElement {
      useGuardToolDispatch(() => "veto");
      return React.createElement(System, null, "u");
    }
    const bundle = await mkSession(
      stack,
      `unmount-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );
    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result;
    expect(bundle.echoRuns()).toBe(0);

    // Close mid-life — the mount is torn down; a subsequent pull for this mount
    // returns [] (no stale registration), and close does not throw.
    await bundle.session.close();
    expect(
      stack.compiler.collectTreeInterceptors({
        mountId: `mount:${bundle.session.id}`,
        command: "ToolDispatch",
      }),
    ).toHaveLength(0);
    await bundle.tools.close();
  });

  it("REGRESSION: an observe hook (useOnToolEnd) is unaffected by a coexisting guard", async () => {
    const stack = await mkStack(`regress-${Math.random()}`);
    const toolEnds: LifecycleToolEnd[] = [];
    function Agent(): React.ReactElement {
      // An observe hook AND a proceeding guard on the same command. The observe
      // rides the tier-2 lifecycle forwarder; the guard is the tier-4 tree
      // interceptor. On a PROCEEDing guard the tool runs and the observe fires
      // exactly as before — the interceptor system leaves observe untouched.
      // (A tier-4 VETO short-circuits BEFORE the inner tier-2 observe by
      // design — the denied op never reaches the observe; the bus/journal is
      // the cross-process record of a vetoed terminal, per the ADR-89 split.)
      useOnToolEnd((e) => void toolEnds.push(e));
      useGuardToolDispatch(() => "proceed");
      return React.createElement(System, null, "r");
    }
    const bundle = await mkSession(
      stack,
      `regress-${Math.random()}`,
      React.createElement(Agent),
      toolThenReplyExec(),
    );
    const handle = await bundle.session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [echoTool],
    });
    await handle.result;

    expect(bundle.echoRuns()).toBe(1);
    expect(toolEnds.length).toBeGreaterThan(0);
    expect(toolEnds[0]!.name).toBe("echo");
    expect(toolEnds[0]!.outcome).toBe("succeeded");

    await bundle.session.close();
    await bundle.tools.close();
  });
});
