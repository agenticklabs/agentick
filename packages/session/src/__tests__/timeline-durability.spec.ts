/**
 * A2.2 — the cross-package durability wiring (ADR 49):
 *
 *   1. **Open-or-rehydrate.** Constructing a session with
 *      `timeline: { store }` loads the durable log into the persisted
 *      tier BEFORE first render — resume on any process, any node.
 *      Without a store option, construction is the zero-cost hot path.
 *   2. **Flush barrier at execution end.** A send() does not resolve
 *      until the write-behind pump has drained — any process that
 *      subsequently loads the store sees every completed execution.
 *   3. **Durability divergence is typed + terminal.** A buffered
 *      store-write failure rejects the send with the registered
 *      `TimelineWriteFailed` and lands the session on `"failed"`
 *      status — never silently `"idle"` against a diverged log.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { MemoryTimelineStore, type TimelineStore } from "@agentick/timeline";
import { stubStoreCtx } from "@agentick/store";
import type { ExecutionTarget, TimelineEntry } from "@agentick/spec";
import { TimelineWriteFailed } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = (text: string) =>
  new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
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

function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const idOf = (e: TimelineEntry): string => (e as { message: { id: string } }).message.id;

/**
 * Durable persisted log, read from the LIVE handle. The timeline is
 * CheckpointCapable (checkpointing §3.2) — it persists to its own store and is
 * excluded from the snapshot blob, so the blob is no longer a read surface.
 */
function persistedOf(session: SessionHarness): readonly TimelineEntry[] {
  return session.timeline.read().entries;
}

async function mkSession(opts: {
  sessionId: string;
  timeline?: { store?: TimelineStore; writePolicy?: "behind" | "through" };
}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("dur-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("dur-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("dur-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("dur-t", journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = replyExec("ok");
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: opts.sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...(opts.timeline ? { timeline: opts.timeline } : {}),
  });
  await session.ready;
  return { session, tools };
}

describe("SessionHarness — open-or-rehydrate (ADR 49 A2.2)", () => {
  it("hydrates the persisted tier from the injected store before first render", async () => {
    const store = new MemoryTimelineStore();
    // The harness keys the store by its scopeId — `${sessionId}:timeline`.
    await store.append("s-resume:timeline", [entry("m1"), entry("m2")], stubStoreCtx());

    const { session, tools } = await mkSession({
      sessionId: "s-resume",
      timeline: { store },
    });
    await session.mountReady;

    expect(persistedOf(session).map(idOf)).toEqual(["m1", "m2"]);
    await session.close();
    await tools.close();
  });

  it("without a store option, constructs empty (no hydration path)", async () => {
    const { session, tools } = await mkSession({ sessionId: "s-fresh" });
    await session.mountReady;
    expect(persistedOf(session)).toEqual([]);
    await session.close();
    await tools.close();
  });
});

describe("SessionHarness — flush barrier at execution end (ADR 49 A2.2)", () => {
  it("send() resolution implies the store holds the execution's entries", async () => {
    const store = new MemoryTimelineStore();
    const { session, tools } = await mkSession({
      sessionId: "s-flush",
      timeline: { store, writePolicy: "behind" },
    });
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    await handle.result;

    // The barrier ran before resolution: the durable log already holds
    // the drained user message + the assistant output — no flush() call
    // by the adopter, no settle window.
    const persisted = await store.read("s-flush:timeline", stubStoreCtx());
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    await session.close();
    await tools.close();
  });

  it("a buffered store-write failure rejects the send with TimelineWriteFailed and lands status=failed", async () => {
    const failingStore: TimelineStore = {
      backend: "failing",
      read: async () => [],
      append: async () => {
        throw new Error("disk full");
      },
      keys: async () => [],
      delete: async () => false,
      query: async () => [],
      mutate: async () => {
        throw new Error("disk full");
      },
    };
    const { session, tools } = await mkSession({
      sessionId: "s-diverged",
      timeline: { store: failingStore, writePolicy: "behind" },
    });
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const exit = await handle.result.then(
      () => "resolved",
      (err: unknown) => err,
    );
    expect(exit).toBeInstanceOf(TimelineWriteFailed);
    // Diverged from the durable log — "failed", never a silent "idle".
    expect(session.status).toBe("failed");
    // And it cannot be checkpointed: `snapshot()` fans out `persist`, the
    // flush barrier is latched, so the operation aborts rather than letting a
    // caller unmount behind an un-flushed tail (checkpointing §3.2).
    await expect(session.snapshot()).rejects.toThrow(/timeline write failed/);
    await tools.close();
  });
});
