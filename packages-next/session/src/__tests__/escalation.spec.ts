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
 * TODO(ADR-69 T2): the recursive `parentSessionId` forward hop (the
 * `handleEscalation` forward branch is BUILT but exercised at T2), ancestor
 * interception, and the cross-process child-executor elicit bridge.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { ELICITATION_CHANNEL_FQN } from "@agentick/elicitation-next";
import { TASK_STATUS_CHANNEL_FQN } from "@agentick/tasks-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { DetachedTaskCannotElicitError } from "@agentick/spec-next";
import type { ExecutionTarget, ProtocolEvent, TaskInfo } from "@agentick/spec-next";
import { drainRejection } from "@agentick/utils-next/testing";
import { omitUndefined } from "@agentick/utils-next";

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
  const reconciler = new ReconcilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = replyExec();
  await Promise.all([reconciler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: null,
    reconciler,
    loop,
    executor,
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
