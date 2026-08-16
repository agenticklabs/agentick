/**
 * `session:channel:status` — the NOTIFY half of the session-status pair.
 *
 * `SessionRecord.status` has always been enumerable (it rides every
 * `list_sessions` row) but a TRANSITION never left the process: `setStatus`
 * write-through hits the store view's local notifier, which is a render ping,
 * not the event bus. A thread list therefore had to poll, and a chat panel that
 * reloaded mid-turn rendered a running session as idle.
 *
 * These cases assert the two halves a subscriber needs: every transition is
 * published, and the channel opens with the CURRENT status so a late subscriber
 * does not have to wait for the next one.
 */

import { describe, expect, it } from "vitest";

import { Chunk, Effect, Stream } from "effect";

import { CompilerHarness } from "@agentick/compiler-react";
import { ELICITATION_CHANNEL_FQN, ElicitationHarness } from "@agentick/elicitation";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import type {
  ContentBlock,
  ExecutionTarget,
  ProtocolEvent,
  SessionStatus,
  SessionStatusFrame,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { SessionHarness } from "../harness.js";
import { SessionRuntime } from "../session-state.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

async function mkSession(holdUntil?: Promise<void>, failing = false) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("st-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("st-l", journal, bus, inbox);
  // The tool executor's own required collaborator. The SESSION builds its own
  // session-scoped one (it was given none), which is the harness `session.elicit`
  // asks through — the production shape.
  const elicitation = new ElicitationHarness("st-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("st-t", journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor("st-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
        ...(holdUntil !== undefined ? { holdUntil } : {}),
        ...(failing ? { outcome: "failed" as const } : {}),
      },
    ],
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `st-s-${Math.random()}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;

  const frames: SessionStatusFrame[] = [];
  const unsubscribe = session.channel<SessionStatusFrame>("status").subscribe((f) => {
    frames.push(f);
  });

  return { session, tools, bus, frames, unsubscribe };
}

const mkFailingSession = () => mkSession(undefined, true);

/** A turn the model call parks in until `release()` — the mid-execution window. */
function heldTurn() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { held, release: () => release() };
}

/** The next elicitation ask off the bus, for its `correlationId`. */
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
  ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
}

describe("session:channel:status publishes every transition", () => {
  it("brackets a real execution with running → idle", async () => {
    const { session, tools, frames, unsubscribe } = await mkSession();

    await session.send({ messages: [{ role: "user", content: "hi" }] });
    await waitFor(() => frames.length >= 2, { description: "running + idle" });

    expect(frames.map((f) => f.status)).toEqual(["running", "idle"]);
    // Self-describing — a thread list folding payloads alone can key the row.
    expect(frames.every((f) => f.sessionId === session.id)).toBe(true);
    // The running frame names the turn in flight, so a client that reattaches
    // can correlate against the execution already under way.
    expect(frames[0]!.executionId).toMatch(/^exec:/);
    expect(frames[1]!.executionId).toBeUndefined();
    // The ending rides the transition that ends the run, and only that one.
    expect(frames[0]!.outcome).toBeUndefined();
    expect(frames[1]!.outcome).toBe("succeeded");

    unsubscribe();
    await session.close();
    await tools.close();
  });

  it("publishes closed on teardown", async () => {
    const { session, tools, frames, unsubscribe } = await mkSession();

    await session.close();
    await waitFor(() => frames.length >= 1, { description: "the closed frame" });
    expect(frames.at(-1)!.status).toBe("closed");

    unsubscribe();
    await tools.close();
  });

  it("opens the channel with the CURRENT status — a mid-execution subscriber sees running", async () => {
    const { held, release } = heldTurn();
    const { session, tools, frames, unsubscribe } = await mkSession(held);

    // Non-streaming: the fake's scripted `holdUntil` parks the `run` path only.
    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await waitFor(() => frames.some((f) => f.status === "running"), {
      description: "the turn to start",
    });

    // What `sub/subscribe` splices in front of a fresh subscriber's stream.
    const env = await session.channelSnapshot("status");
    expect(env!.name).toBe("session:channel:status");
    expect(env!.scope.sessionId).toBe(session.id);
    expect((env!.payload as SessionStatusFrame).status).toBe("running");
    // A snapshot describes a STATE. It has no ending to report.
    expect((env!.payload as SessionStatusFrame).outcome).toBeUndefined();

    release();
    await turn;
    // The idle transition rides the send-result `.finally`, a microtask past
    // the awaited result — hence the wait rather than a bare read.
    await waitFor(() => frames.some((f) => f.status === "idle"), {
      description: "the turn to end",
    });
    expect(((await session.channelSnapshot("status"))!.payload as SessionStatusFrame).status).toBe(
      "idle",
    );

    unsubscribe();
    await session.close();
    await tools.close();
  });
});

describe("the ending rides the transition, never the status", () => {
  it("reports aborted — and the session still comes to rest on idle", async () => {
    const { session, tools, frames, unsubscribe } = await mkSession();

    const controller = new AbortController();
    controller.abort();
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    expect((await handle.result).stopReason).toBe("aborted");

    await waitFor(() => frames.some((f) => f.status === "idle"));
    const end = frames.at(-1)!;
    // "idle", not "aborted": the run ended badly, the session is fine. Folding
    // the ending into the state would leave a usable session looking broken.
    expect(end.status).toBe("idle");
    expect(end.outcome).toBe("aborted");

    unsubscribe();
    await session.close();
    await tools.close();
  });

  it("reports failed when the run raises", async () => {
    const { session, tools, frames, unsubscribe } = await mkFailingSession();

    await session
      .send({ messages: [{ role: "user", content: "hi" }], stream: false })
      .catch(() => undefined);
    await waitFor(() => frames.some((f) => f.status === "idle"));

    const end = frames.at(-1)!;
    expect(end.status).toBe("idle");
    expect(end.outcome).toBe("failed");

    unsubscribe();
    await session.close();
    await tools.close();
  });
});

describe("a session blocked on a human is input_required", () => {
  it("blocks on the first ask, resumes on the answer, and lands idle at the end", async () => {
    const { held, release } = heldTurn();
    const { session, tools, bus, frames, unsubscribe } = await mkSession(held);

    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await waitFor(() => frames.some((f) => f.status === "running"));

    const answered = (async () => {
      const envelope = await nextElicitEnvelope(bus);
      await waitFor(() => frames.some((f) => f.status === "input_required"), {
        description: "the session to block",
      });
      await session.elicitation.respond({
        correlationId: envelope.metadata!.correlationId as string,
        outcome: "accepted",
        value: "yes",
      });
    })();

    const asked = session.elicit.text("Approve?");
    await answered;
    await asked;

    await waitFor(() => session.status === "running", { description: "the session to resume" });
    release();
    await turn;
    await waitFor(() => frames.some((f) => f.status === "idle"));

    expect(frames.map((f) => f.status)).toEqual(["running", "input_required", "running", "idle"]);

    unsubscribe();
    await session.close();
    await tools.close();
  });

  it("an ask raised while IDLE does not block — only a running session does", async () => {
    const { session, tools, bus, frames, unsubscribe } = await mkSession();

    const answered = (async () => {
      const envelope = await nextElicitEnvelope(bus);
      await session.elicitation.respond({
        correlationId: envelope.metadata!.correlationId as string,
        outcome: "accepted",
        value: "yes",
      });
    })();
    await session.elicit.text("Approve?");
    await answered;

    expect(frames).toEqual([]);
    expect(session.status).toBe("idle");

    unsubscribe();
    await session.close();
    await tools.close();
  });

  it("the ending beats the block — a turn that ends with an ask outstanding goes idle", async () => {
    const { held, release } = heldTurn();
    const { session, tools, bus, frames, unsubscribe } = await mkSession(held);

    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await waitFor(() => frames.some((f) => f.status === "running"));

    // Subscribe BEFORE asking — the ask is published once.
    const envelopeP = nextElicitEnvelope(bus);
    const asked = session.elicit.text("Approve?");
    const envelope = await envelopeP;
    await waitFor(() => frames.some((f) => f.status === "input_required"));

    // The turn ends while the ask is still outstanding.
    release();
    await turn;
    await waitFor(() => session.status === "idle", { description: "the turn to end" });

    // Answering now must NOT resurrect "running" on a session that has ended.
    await session.elicitation.respond({
      correlationId: envelope.metadata!.correlationId as string,
      outcome: "accepted",
      value: "yes",
    });
    await asked;
    expect(session.status).toBe("idle");
    expect(frames.map((f) => f.status)).toEqual(["running", "input_required", "idle"]);

    unsubscribe();
    await session.close();
    await tools.close();
  });
});

describe("SessionRuntime.setStatus — a transition, not every write", () => {
  it("calls back only when the value CHANGES, and still persists either way", () => {
    const seen: SessionStatus[] = [];
    const runtime = new SessionRuntime({
      id: "st-runtime",
      store: undefined,
      storeCtx: () => ({ sessionId: "st-runtime" }),
      onStatusTransition: (status) => seen.push(status),
    });

    runtime.setStatus("running");
    runtime.setStatus("running");
    runtime.setStatus("idle");

    expect(seen).toEqual(["running", "idle"]);
    expect(runtime.status()).toBe("idle");
  });
});
