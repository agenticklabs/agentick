/**
 * `session.model` — model selection / swap facade (ADR 89 §2).
 *
 * The facade is NOT a harness; it is a thin projection over the
 * session-default model the session already owns. These tests pin the §2
 * contract:
 *
 *   1. `setModel` swaps the session default — the NEXT send uses the new
 *      executor (never mid-execution).
 *   2. `onBeforeSessionSetModel` can VETO a swap (policy: "may not switch
 *      to model X") — the default is unchanged.
 *   3. THE §2 PAYOFF — a `session.model.use` transform AND a
 *      `session.model.guard` veto, registered ONCE, still apply to the
 *      model call ACROSS a `setModel` executor swap (they ride the tier-4
 *      call middleware seam, not any executor instance).
 *   4. Effective-model precedence — a per-send `input.modelExecutor`
 *      override still beats the swapped session default.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, LanguageModelExecutor } from "@agentick/model-executor-next";
import { scriptedAdapter } from "@agentick/model-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import { ModelExecutorBuilderMissingError, type ExecutionTarget } from "@agentick/spec-next";

import { SessionHarness, type SessionHarnessOptions } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** A fake executor whose one-shot scripted reply is `text`. */
const replyExec = (text: string) =>
  new FakeLanguageModelExecutor(
    `exec-${text}-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

/** Build a session whose default model-executor is `executor`. */
async function mkSession(
  executor: FakeLanguageModelExecutor,
  buildModelExecutor?: SessionHarnessOptions["buildModelExecutor"],
) {
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
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...(buildModelExecutor !== undefined ? { buildModelExecutor } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

/**
 * The adapter→executor builder the APP injects (mirrored here). Wraps a bare
 * `LanguageModelAdapter` in the REAL `LanguageModelExecutor` on a fresh
 * substrate — the same shape `AppHarness.createSessionBody` threads down.
 */
function mkBuilder(): SessionHarnessOptions["buildModelExecutor"] {
  return (adapter) => {
    const modelExecutor = new LanguageModelExecutor(
      `built-exec-${Math.random()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { adapter },
    );
    return { modelExecutor, target: modelExecutor.target };
  };
}

/** Run one send and return the joined text of the response. */
async function sendText(
  session: SessionHarness,
  extra?: Parameters<SessionHarness["send"]>[0],
): Promise<string> {
  const handle = await session.send({
    messages: [{ role: "user", content: "hi" }],
    ...(extra ?? {}),
  });
  const result = await handle.result;
  return result.response;
}

describe("session.model — selection / swap facade (ADR 89 §2)", () => {
  it("setModel swaps the session default — the next send uses the new executor", async () => {
    const a = replyExec("from-A");
    const b = replyExec("from-B");
    const { session, tools } = await mkSession(a);
    await b.ready;

    expect(await sendText(session)).toBe("from-A");

    await session.model.setModel({ modelExecutor: b, target });
    // `current` reflects the swap immediately.
    expect(session.model.current.modelExecutor).toBe(b);

    expect(await sendText(session)).toBe("from-B");

    await session.close();
    await tools.close();
  });

  it("setTarget swaps only the target, keeping the current runner", async () => {
    const a = replyExec("from-A");
    const { session, tools } = await mkSession(a);

    const cheaper: ExecutionTarget = { ...target, modelId: "mock-mini" };
    await session.model.setTarget(cheaper);

    expect(session.model.current.modelExecutor).toBe(a); // runner unchanged
    expect(session.model.current.target.modelId).toBe("mock-mini");
    // Same executor still answers, now under the swapped target.
    expect(await sendText(session)).toBe("from-A");

    await session.close();
    await tools.close();
  });

  it("onBeforeSessionSetModel can VETO a swap — the default is unchanged", async () => {
    const a = replyExec("from-A");
    const b = replyExec("from-B");
    const { session, tools } = await mkSession(a);
    await b.ready;

    // Policy: this session may not switch to the "blocked" model.
    const off = session.hook({
      onBeforeSessionSetModel: (input) => {
        if (input.target.modelId === "blocked") {
          throw new Error("policy: switching to `blocked` is not allowed");
        }
      },
    });

    await expect(
      session.model.setModel({ modelExecutor: b, target: { ...target, modelId: "blocked" } }),
    ).rejects.toThrow(/blocked/);

    // The default was NOT swapped — the next send still uses A.
    expect(session.model.current.modelExecutor).toBe(a);
    expect(await sendText(session)).toBe("from-A");

    // A non-blocked swap still goes through.
    await session.model.setModel({ modelExecutor: b, target });
    expect(await sendText(session)).toBe("from-B");

    off();
    await session.close();
    await tools.close();
  });

  it("a session.model.use transform, registered once, applies across a setModel swap", async () => {
    const a = replyExec("from-A");
    const b = replyExec("from-B");
    const { session, tools } = await mkSession(a);
    await b.ready;

    // A session-scoped transform on the model call. Registered ONCE, before
    // any swap — it must fire on BOTH executors' model calls.
    let calls = 0;
    const off = session.model.use(async (input, next) => {
      calls += 1;
      return next(input);
    });

    expect(await sendText(session)).toBe("from-A");
    expect(calls).toBe(1); // fired on executor A's model call

    await session.model.setModel({ modelExecutor: b, target });

    expect(await sendText(session)).toBe("from-B");
    expect(calls).toBe(2); // STILL fires on executor B's model call — the payoff

    off();
    await session.close();
    await tools.close();
  });

  it("a session.model.guard veto, registered once, applies to model:generate across a swap", async () => {
    const a = replyExec("from-A");
    const b = replyExec("from-B");
    const { session, tools } = await mkSession(a);
    await b.ready;

    // A session-scoped guard on the model call — vetoes every generate.
    // Registered ONCE, before any swap.
    let vetoing = true;
    const off = session.model.guard((_input, _ctx) =>
      vetoing ? { kind: "veto", reason: "guarded" } : undefined,
    );

    // Non-streaming so the veto rides the well-trodden `model:generate`
    // command → vetoed-terminal fold; the streaming path scopes identically.
    const first = await session.send({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const firstResult = await first.result;
    expect(firstResult.stopReason).toBe("vetoed"); // executor A's call vetoed

    await session.model.setModel({ modelExecutor: b, target });

    const second = await session.send({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const secondResult = await second.result;
    expect(secondResult.stopReason).toBe("vetoed"); // STILL vetoed on executor B — the payoff

    // Lift the guard: the swapped executor now answers.
    vetoing = false;
    expect(await sendText(session, { stream: false })).toBe("from-B");

    off();
    await session.close();
    await tools.close();
  });

  it("setModel(adapter) swaps the default — the next send uses the built executor", async () => {
    const a = replyExec("from-A");
    // Builder injected → the adapter overload wraps `scriptedAdapter` in a real
    // executor. Ergonomic parity with `createApp({ model: openai(...) })`.
    const { session, tools } = await mkSession(a, mkBuilder());

    expect(await sendText(session)).toBe("from-A");

    await session.model.setModel(scriptedAdapter("from-adapter"));
    // `current` reflects the swap immediately — the built executor's own target.
    expect(session.model.current.target.provider).toBe("scripted");

    expect(await sendText(session)).toBe("from-adapter");

    await session.close();
    await tools.close();
  });

  it("setModel(adapter) with NO injected builder throws ModelExecutorBuilderMissingError", async () => {
    const a = replyExec("from-A");
    // No builder → BYO-executor session. The adapter overload has nothing to
    // build with and must throw the typed error (a RegisteredModel still works).
    const { session, tools } = await mkSession(a);

    await expect(session.model.setModel(scriptedAdapter("nope"))).rejects.toBeInstanceOf(
      ModelExecutorBuilderMissingError,
    );

    // The default is unchanged — the next send still uses A.
    expect(session.model.current.modelExecutor).toBe(a);
    expect(await sendText(session)).toBe("from-A");

    await session.close();
    await tools.close();
  });

  it("onBeforeSessionSetModel vetoes the adapter form identically (normalized before the command)", async () => {
    const a = replyExec("from-A");
    const { session, tools } = await mkSession(a, mkBuilder());

    // Policy keyed on the NORMALIZED target — proof the adapter was wrapped to a
    // RegisteredModel BEFORE the command, so the veto path sees identical input.
    const off = session.hook({
      onBeforeSessionSetModel: (input) => {
        if (input.target.provider === "scripted") {
          throw new Error("policy: switching to a `scripted` provider is not allowed");
        }
      },
    });

    await expect(session.model.setModel(scriptedAdapter("blocked"))).rejects.toThrow(/scripted/);

    // The default was NOT swapped — the next send still uses A.
    expect(session.model.current.modelExecutor).toBe(a);
    expect(await sendText(session)).toBe("from-A");

    off();
    await session.close();
    await tools.close();
  });

  it("precedence — a per-send modelExecutor override beats the swapped default", async () => {
    const a = replyExec("from-A");
    const b = replyExec("from-B");
    const c = replyExec("from-C");
    const { session, tools } = await mkSession(a);
    await Promise.all([b.ready, c.ready]);

    await session.model.setModel({ modelExecutor: b, target });

    // Per-send override wins over the swapped default...
    expect(await sendText(session, { modelExecutor: c })).toBe("from-C");
    // ...and the swapped default still governs a plain send.
    expect(await sendText(session)).toBe("from-B");

    await session.close();
    await tools.close();
  });
});
