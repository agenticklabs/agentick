/**
 * The session fold checkpoints the timeline (checkpointing §3.2/§4).
 *
 * `TimelineHarness` is {@link CheckpointCapable}, so `session.snapshot()` fans
 * out `persist` (the flush barrier) and `session.restore()` fans out `hydrate`
 * (the store read) — no payload ever carried the log.
 * What these pin:
 *
 *   1. the snapshot carries NO timeline payload — the durable log is the store's;
 *   2. `restore()` re-reads the store on a LIVE session, which is what makes
 *      evict→resume and restart→resume the same code path;
 *   3. durability survives the harness only because the injected store outlives
 *      it — a fresh session over the same store + id resumes the conversation.
 *
 * @see docs/proposals/v2/checkpointing.md
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { MemoryTimelineStore, type TimelineStore } from "@agentick/timeline";
import type { ExecutionTarget, TimelineEntry } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const ids = (entries: readonly TimelineEntry[]): string[] =>
  entries.map((e) => (e as { message: { id: string } }).message.id);

interface Rig {
  readonly session: SessionHarness;
  close(): Promise<void>;
}

/** A real session over a real timeline bridge backed by the injected store. */
async function mkSession(sessionId: string, store: TimelineStore): Promise<Rig> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const suffix = Math.random();
  const compiler = new CompilerHarness(`cp-r-${suffix}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`cp-l-${suffix}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`cp-e-${suffix}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`cp-t-${suffix}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(
    `cp-x-${suffix}`,
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
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    timeline: { store, writePolicy: "behind" },
  });
  await session.ready;
  await session.mountReady;
  return {
    session,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

describe("SessionHarness — timeline checkpoint fold (checkpointing §3.2)", () => {
  it("snapshot() flushes the log to the store", async () => {
    const store = new MemoryTimelineStore();
    const rig = await mkSession("cp-flush", store);

    await rig.session.timeline.append(entry("m1"), entry("m2"));
    await rig.session.snapshot();

    expect(ids(await store.read("cp-flush:timeline", { sessionId: "cp-flush" }))).toEqual([
      "m1",
      "m2",
    ]);
    await rig.close();
  });

  it("restore() re-reads the store on a LIVE session — one resume path", async () => {
    // Genesis loads the store at construction, so a write that lands AFTER the
    // session opened is the only thing that can prove `restore()` itself
    // hydrates rather than inheriting construction's read.
    const store = new MemoryTimelineStore();
    const writer = await mkSession("cp-live", store);
    await writer.session.timeline.append(entry("m1"));
    await writer.session.snapshot();

    const reader = await mkSession("cp-live", store);
    expect(ids(reader.session.timeline.read().entries)).toEqual(["m1"]);

    await writer.session.timeline.append(entry("m2"));
    await writer.session.snapshot();

    await reader.session.restore();
    expect(ids(reader.session.timeline.read().entries)).toEqual(["m1", "m2"]);
    expect(ids(reader.session.timeline.read().entries)).toEqual(["m1", "m2"]);

    await writer.close();
    await reader.close();
  });

  it("THE STORE OUTLIVES THE SESSION: a fresh session over the same store resumes", async () => {
    // The evict→resume shape at the session layer: session A retains nothing,
    // and session B is built from the recipe + the store, never from a payload.
    const store = new MemoryTimelineStore();
    const a = await mkSession("cp-evict", store);
    await a.session.timeline.append(entry("m1"), entry("m2"));
    await a.session.snapshot();
    await a.close();

    const b = await mkSession("cp-evict", store);
    await b.session.restore();
    expect(ids(b.session.timeline.read().entries)).toEqual(["m1", "m2"]);
    await b.close();
  });
});
