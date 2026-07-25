/**
 * Request escalation — root-session round-trip (ADR 69 T1).
 *
 * A task's work fn calls `ctx.elicit.text(...)`. The request ESCALATES
 * (nested `inbox.ask`) to the task's owning session; this session is a
 * ROOT (no `parentSessionId`), so its `handleMessage` resolves the
 * escalation TERMINALLY against its real client elicitation harness. The
 * test plays the client — it answers on the elicitation channel — and the
 * answer threads back down the `ask` return stack to unblock the task.
 *
 * This is the cross-harness proof: a REAL `SessionHarness` terminal + the
 * REAL per-session `TasksHarness` (wired with `buildElicit` by
 * `buildSessionBridges`) + the REAL `ElicitationHarness`. It lives here
 * because session-next is the package that depends on all three.
 *
 * Covered:
 *   - the answer round-trips (`ctx.elicit.text` resolves with it);
 *   - the FSM flips `working → input_required → working → completed`;
 *   - `interactive ⊥ detached` end-to-end: a detached task's `ctx.elicit`
 *     throws the typed error through the real sugar, before any escalation.
 *
 * T2a (below) exercises the recursive `parentSessionId` forward hop with a
 * real 2-session chain, ancestor interception (answer / deny / forward), and
 * lineage provenance.
 *
 * TODO(ADR-69 T2b): the cross-process child-executor elicit bridge (a forked
 * task's escalation over IPC → parent inbox → the session escalation entry).
 */

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness, buildElicitSugar } from "@agentick/elicitation";
import { ELICITATION_CHANNEL_FQN } from "@agentick/elicitation";
import { ChildProcessTaskExecutor, TASK_STATUS_CHANNEL_FQN, TasksHarness } from "@agentick/tasks";
import type { TasksHarnessProtocol } from "@agentick/spec";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { DetachedTaskCannotElicitError } from "@agentick/spec";
import type {
  EscalationHop,
  ElicitationResult,
  ExecutionTarget,
  ProtocolEvent,
  TaskInfo,
} from "@agentick/spec";
import { drainRejection } from "@agentick/utils/testing";
import { omitUndefined } from "@agentick/utils";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = () =>
  new FakeLanguageModelExecutor(
    "exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

async function mkSession(opts: { parentSessionId?: string } = {}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...omitUndefined({ parentSessionId: opts.parentSessionId }),
  });
  await session.ready;
  await session.mountReady;
  return { session, bus, close: () => session.close() };
}

/** Resolves with the next elicitation request envelope on the bus. */
function nextElicitEnvelope(
  bus: LocalEventBus,
): Promise<ProtocolEvent & { readonly metadata?: Readonly<Record<string, unknown>> }> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: ELICITATION_CHANNEL_FQN },
        }) as Stream.Stream<
          ProtocolEvent & { readonly metadata?: Readonly<Record<string, unknown>> },
          unknown,
          never
        >,
        1,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c))[0]!);
}

/** Collect the next `n` task status envelopes off the bus. */
function takeStatuses(bus: LocalEventBus, n: number): Promise<readonly ProtocolEvent[]> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: TASK_STATUS_CHANNEL_FQN },
        }) as Stream.Stream<ProtocolEvent, unknown, never>,
        n,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c)));
}

describe("SessionHarness — task elicit escalation (ADR 69 T1)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("root session terminally resolves a task's ctx.elicit; the answer round-trips and the FSM flips working → input_required → working → completed", async () => {
    const { session, bus, close: c } = await mkSession();
    close = c;

    // Client side — answer the first elicitation request with a value.
    const clientAnswered = (async () => {
      const env = await nextElicitEnvelope(bus);
      const correlationId = env.metadata!.correlationId as string;
      await session.elicitation.respond({
        correlationId,
        outcome: "accepted",
        value: "approved",
      });
    })();

    // Status timeline: working (submit) → input_required (escalate) →
    // working (answered) → completed (return). Subscribe before submit.
    const statusesP = takeStatuses(bus, 4);

    const handle = session.tasks.submit(async (ctx) => {
      const answer = await ctx.elicit.text("Approve?");
      return [{ type: "text", text: answer }];
    });

    const result = (await handle.result) as ReadonlyArray<{ type: string; text: string }>;
    await clientAnswered;

    // The client's answer threaded all the way back to the work fn.
    expect(result).toEqual([{ type: "text", text: "approved" }]);
    expect(session.tasks.status(handle.taskId)).toBe("completed");

    const statuses = (await statusesP).map((e) => (e.payload as TaskInfo).status);
    expect(statuses).toEqual(["working", "input_required", "working", "completed"]);
  });

  it("interactive ⊥ detached: a detached task's ctx.elicit throws DetachedTaskCannotElicitError (no escalation issued)", async () => {
    const { session, bus, close: c } = await mkSession();
    close = c;

    // If escalation were (wrongly) issued, this would capture the request;
    // we assert it never fires by racing it against the task failure.
    let escalated = false;
    void nextElicitEnvelope(bus).then(() => {
      escalated = true;
    });

    const handle = session.tasks.submit(
      async (ctx) => {
        const answer = await ctx.elicit.text("Approve?");
        return [{ type: "text", text: answer }];
      },
      { detached: true },
    );

    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    const cause = (rejection as { failure?: { cause?: unknown } }).failure?.cause;
    expect(cause).toBeInstanceOf(DetachedTaskCannotElicitError);
    expect(escalated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2a — multi-agent bubbling (recursion + interception + lineage)
// ---------------------------------------------------------------------------

/**
 * Build one SessionHarness on a SHARED substrate (so `session:{id}`
 * addressing routes between siblings on the same inbox). Distinct
 * sub-harness id prefixes avoid inbox-address collisions.
 */
async function mkSessionOn(
  shared: { journal: MemoryJournal; bus: LocalEventBus; inbox: LocalInbox },
  prefix: string,
  opts: {
    parentSessionId?: string;
    /**
     * Optional pre-built tasks harness keyed off the resolved sessionId —
     * used by the T2b forked-child test to inject a `ChildProcessTaskExecutor`
     * (the default `buildSessionBridges` wiring is in-process only).
     */
    tasks?: (sessionId: string) => TasksHarnessProtocol;
  } = {},
) {
  const { journal, bus, inbox } = shared;
  const compiler = new CompilerHarness(`${prefix}-r`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${prefix}-l`, journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness(`${prefix}-t:elicitation`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`${prefix}-t`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const sessionId = `${prefix}-${Math.random().toString(36).slice(2)}`;
  const tasks = opts.tasks?.(sessionId);
  if (tasks !== undefined) await (tasks as { ready: Promise<void> }).ready;

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...omitUndefined({ parentSessionId: opts.parentSessionId, tasks }),
  });
  await session.ready;
  await session.mountReady;
  return { session };
}

/**
 * A 2-session chain: a CHILD session (`parentSessionId` = parent's id)
 * and a ROOT parent, both on one shared inbox so the child's forward hop
 * (`session:{parentId}`) routes to the parent.
 */
async function mkChain() {
  const shared = {
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  };
  const { session: parent } = await mkSessionOn(shared, "parent");
  const { session: child } = await mkSessionOn(shared, "child", { parentSessionId: parent.id });
  return {
    parent,
    child,
    bus: shared.bus,
    close: async () => {
      await child.close();
      await parent.close();
    },
  };
}

describe("SessionHarness — escalation bubbling + interception + lineage (ADR 69 T2a)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("2-session chain: a child task's ctx.elicit escalates → the child forwards to the root parent → the parent terminally resolves → the answer threads back + the FSM flips", async () => {
    const chain = await mkChain();
    close = chain.close;

    // Client answers the parent's (root) terminal elicit.
    const clientAnswered = (async () => {
      const env = await nextElicitEnvelope(chain.bus);
      const correlationId = env.metadata!.correlationId as string;
      await chain.parent.elicitation.respond({
        correlationId,
        outcome: "accepted",
        value: "approved-by-root",
      });
    })();

    const statusesP = takeStatuses(chain.bus, 4);

    const handle = chain.child.tasks.submit(async (ctx) => {
      const answer = await ctx.elicit.text("Approve?");
      return [{ type: "text", text: answer }];
    });

    const result = (await handle.result) as ReadonlyArray<{ type: string; text: string }>;
    await clientAnswered;

    // The root's answer threaded back down the nested-ask stack to the
    // child's task work fn.
    expect(result).toEqual([{ type: "text", text: "approved-by-root" }]);
    expect(chain.child.tasks.status(handle.taskId)).toBe("completed");

    const statuses = (await statusesP).map((e) => (e.payload as TaskInfo).status);
    expect(statuses).toEqual(["working", "input_required", "working", "completed"]);
  });

  it("interception short-circuits: a parent interceptor answers the child's elicit; the parent's real client elicit is NEVER called", async () => {
    const chain = await mkChain();
    close = chain.close;

    // Spy the parent's terminal resolver — it must not be reached.
    let realElicitCalls = 0;
    const target = chain.parent.elicitation;
    const orig = target.elicit.bind(target);
    (target as { elicit: typeof target.elicit }).elicit = ((req: Parameters<typeof orig>[0]) => {
      realElicitCalls += 1;
      return orig(req);
    }) as typeof target.elicit;

    chain.parent.interceptEscalation(async (payload) => {
      if (payload.class === "elicit") {
        return {
          forward: false,
          response: { outcome: "accepted", value: "answered-by-ancestor" } as ElicitationResult,
        };
      }
      return { forward: true };
    });

    const handle = chain.child.tasks.submit(async (ctx) => {
      const answer = await ctx.elicit.text("Approve?");
      return [{ type: "text", text: answer }];
    });

    const result = (await handle.result) as ReadonlyArray<{ type: string; text: string }>;
    expect(result).toEqual([{ type: "text", text: "answered-by-ancestor" }]);
    expect(realElicitCalls).toBe(0);
  });

  it("interception deny: a parent interceptor that THROWS denies the request → the child task's ctx.elicit rejects", async () => {
    const chain = await mkChain();
    close = chain.close;

    chain.parent.interceptEscalation(async () => {
      throw new Error("denied by ancestor policy");
    });

    const handle = chain.child.tasks.submit(async (ctx) => {
      const answer = await ctx.elicit.text("Approve?");
      return [{ type: "text", text: answer }];
    });

    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
  });

  it("interception forward: an interceptor returning { forward: true } falls through to the terminal client elicit", async () => {
    const chain = await mkChain();
    close = chain.close;

    let interceptorCalls = 0;
    chain.parent.interceptEscalation(async () => {
      interceptorCalls += 1;
      return { forward: true };
    });

    const clientAnswered = (async () => {
      const env = await nextElicitEnvelope(chain.bus);
      const correlationId = env.metadata!.correlationId as string;
      await chain.parent.elicitation.respond({
        correlationId,
        outcome: "accepted",
        value: "terminal-answer",
      });
    })();

    const handle = chain.child.tasks.submit(async (ctx) => [
      { type: "text", text: await ctx.elicit.text("Approve?") },
    ]);

    const result = (await handle.result) as ReadonlyArray<{ type: string; text: string }>;
    await clientAnswered;
    expect(interceptorCalls).toBe(1);
    expect(result).toEqual([{ type: "text", text: "terminal-answer" }]);
  });

  it("lineage: the envelope reaching the parent carries [origin(task+session), child-session hop] in order", async () => {
    const chain = await mkChain();
    close = chain.close;

    let captured: readonly EscalationHop[] | undefined;
    chain.parent.interceptEscalation(async (payload) => {
      captured = payload.lineage;
      return {
        forward: false,
        response: { outcome: "accepted", value: "ok" } as ElicitationResult,
      };
    });

    const handle = chain.child.tasks.submit(async (ctx) => [
      { type: "text", text: await ctx.elicit.text("Approve?") },
    ]);
    await handle.result;

    expect(captured).toBeDefined();
    expect(captured).toHaveLength(2);
    // Origin — the task, stamped with its owning (child) session.
    expect(captured![0]).toMatchObject({
      scopeId: `session:${chain.child.id}`,
      taskId: handle.taskId,
    });
    // Forward hop — the child session appended itself before forwarding.
    expect(captured![1]).toMatchObject({ scopeId: `session:${chain.child.id}` });
    expect(captured![1]!.taskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T2b — cross-process child elicit bridge composes the SAME chain
// ---------------------------------------------------------------------------

/**
 * A FORKED child task's `ctx.elicit` escalates over IPC (ADR 69 T2b): the
 * child marshals a serializable intent, the parent-side
 * `ChildProcessTaskExecutor` reconstructs the live-schema request via the
 * injected sugar and feeds it into the SAME `hooks.escalate` an in-process
 * task uses — so ancestor interception + lineage apply to a forked task for
 * free. This proves it end-to-end with a REAL fork + a real 2-session
 * chain: a parent interceptor short-circuits the child's elicit and the
 * parent's terminal client elicit is NEVER reached.
 *
 * The tasks-owned wire mechanics (intent-only marshaling, typed-error
 * round-trip, the live-schema boundary) are proven with real forks in
 * `@agentick/tasks`'s `child-elicit.spec.ts`.
 */
const CHILD_WORKER_MODULE = fileURLToPath(
  new URL("../../../tasks/src/__tests__/fixtures/task-worker.ts", import.meta.url),
);
const CHILD_FORK_OPTIONS = { execArgv: ["--import", "tsx"] };

describe("SessionHarness — forked-child elicit bridge composes the chain (ADR 69 T2b)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("a forked child task's ctx.elicit escalates over IPC; a parent interceptor short-circuits → the parent's real client elicit is NEVER called", async () => {
    const shared = {
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    };
    const { session: parent } = await mkSessionOn(shared, "parent");
    // The child session's TasksHarness runs a real child-process executor
    // (the default session bridges are in-process only) + the real sugar.
    const { session: child } = await mkSessionOn(shared, "child", {
      parentSessionId: parent.id,
      tasks: (sessionId) =>
        new TasksHarness(`${sessionId}:tasks`, shared.journal, shared.bus, shared.inbox, {
          parentScope: { sessionId },
          buildElicit: buildElicitSugar,
          executors: [
            new ChildProcessTaskExecutor({
              workerModule: CHILD_WORKER_MODULE,
              forkOptions: CHILD_FORK_OPTIONS,
              killGracePeriodMs: 1_000,
            }),
          ],
        }),
    });
    close = async () => {
      await child.close();
      await parent.close();
    };

    // Spy the parent's terminal client elicit — it must not be reached.
    let realElicitCalls = 0;
    const elicitTarget = parent.elicitation;
    const orig = elicitTarget.elicit.bind(elicitTarget);
    (elicitTarget as { elicit: typeof elicitTarget.elicit }).elicit = ((
      req: Parameters<typeof orig>[0],
    ) => {
      realElicitCalls += 1;
      return orig(req);
    }) as typeof elicitTarget.elicit;

    parent.interceptEscalation(async (payload) => {
      if (payload.class === "elicit") {
        return {
          forward: false,
          response: { outcome: "accepted", value: true } as ElicitationResult,
        };
      }
      return { forward: true };
    });

    const handle = (
      child.tasks as {
        submit: (opts: { executorKind: string; handlerRef: string }) => {
          result: Promise<readonly { type: string; text: string }[]>;
        };
      }
    ).submit({ executorKind: "child-process", handlerRef: "asks-approval" });

    const result = await handle.result;
    expect(result).toEqual([{ type: "text", text: "approved" }]);
    // The ancestor interceptor answered the FORKED child's elicit; the
    // parent's real client elicit was never consulted — interception +
    // lineage compose for a cross-process task exactly as in-process.
    expect(realElicitCalls).toBe(0);
  });
});
