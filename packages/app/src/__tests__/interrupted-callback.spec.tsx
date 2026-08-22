/**
 * `onInterruptedExecution` — the resume-path policy callback under TWO-SIGNAL
 * detection (execution-resume.md §1/§3.2). The record's `running` is the
 * write-behind candidate; the timeline's turn boundary is authoritative. A crash
 * (candidate + no boundary) marks the record and fires the callback ONCE; a
 * finished turn (boundary present) is the don't-run-twice case — clean record,
 * no callback. The re-drive itself is slice 3.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemorySessionStore } from "@agentick/session";
import { MemoryTimelineStore } from "@agentick/timeline";
import { stubStoreCtx } from "@agentick/store";
import type {
  ExecutionTarget,
  InterruptedExecution,
  OnInterruptedExecution,
  SessionRecord,
  TimelineEntry,
  UsageStats,
} from "@agentick/spec";

import { createApp } from "../react.js";

function PlainAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "Be helpful."),
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as UsageStats;

async function mkApp(
  store: InMemorySessionStore,
  onInterruptedExecution?: OnInterruptedExecution,
  timelineStore?: MemoryTimelineStore,
) {
  const executor = new FakeLanguageModelExecutor(
    "resume-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: [] },
  );
  await executor.ready;
  return createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    sessions: { store },
    ...(timelineStore !== undefined ? { timeline: { store: timelineStore } } : {}),
    ...(onInterruptedExecution !== undefined ? { onInterruptedExecution } : {}),
  });
}

function seed(
  store: InMemorySessionStore,
  id: string,
  overrides: Partial<SessionRecord>,
): Promise<void> {
  return store.put(
    { id, createdAt: 0, updatedAt: 0, status: "idle", executionCount: 1, usage, ...overrides },
    stubStoreCtx(),
  );
}

describe("onInterruptedExecution — the resume-path callback (slice 2)", () => {
  it("fires ONCE with the marked ctx when resuming a crashed `running` record", async () => {
    // Also the no-entries edge: this execution committed NOTHING to the timeline
    // (executionCursor === undefined), so only the record proves it existed —
    // still an interruption (a re-drive would start from tick 0), never a skip.
    const store = new InMemorySessionStore();
    await seed(store, "crashed", { status: "running", currentExecutionId: "exec:99" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    const session = await app.resumeSession("crashed");
    expect(session).toBeDefined();
    expect(cb).toHaveBeenCalledTimes(1);

    const ctx = cb.mock.calls[0]![0];
    expect(ctx.executionId).toBe("exec:99");
    expect(ctx.attempt).toBe(1);
    expect(ctx.session.status).toBe("idle"); // reconciled — NOT an `interrupted` status
    expect(ctx.session.interruptedExecutionId).toBe("exec:99");
    expect(ctx.session.currentExecutionId).toBeUndefined();

    await app.closeApp();
  });

  it("does NOT fire for a clean (idle) record", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "clean", { status: "idle" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.resumeSession("clean");
    expect(cb).not.toHaveBeenCalled();

    await app.closeApp();
  });

  it("propagates loudly — a throwing policy rejects the resume (adopter bugs are not swallowed)", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "boom", { status: "running", currentExecutionId: "exec:1" });
    const app = await mkApp(store, () => {
      throw new Error("policy boom");
    });

    await expect(app.resumeSession("boom")).rejects.toThrow("policy boom");

    await app.closeApp();
  });

  it("boundary present = the turn FINISHED — no mark, no callback (don't-run-twice)", async () => {
    // Signal 2 is authoritative: a durable turn boundary for the execution means
    // only the record's idle-write was lost. The record comes out clean — no
    // interruption history, no budget, no policy invocation, no re-drive.
    const store = new InMemorySessionStore();
    const timelineStore = new MemoryTimelineStore();
    const boundaryEntry: TimelineEntry = {
      kind: "boundary",
      ts: 0,
      boundary: { executionId: "exec:done", outcome: "succeeded" },
    };
    await timelineStore.append("finished:timeline", [boundaryEntry], stubStoreCtx());
    await seed(store, "finished", { status: "running", currentExecutionId: "exec:done" });
    const cb = vi.fn((_: InterruptedExecution) => "resume" as const);
    const app = await mkApp(store, cb, timelineStore);

    await app.resumeSession("finished");
    expect(cb).not.toHaveBeenCalled();

    const record = await store.get("finished", stubStoreCtx());
    expect(record?.status).toBe("idle");
    expect(record?.currentExecutionId).toBeUndefined();
    expect(record?.interruptedExecutionId).toBeUndefined();
    expect(record?.resumeAttempts).toBeUndefined();

    await app.closeApp();
  });

  it("a `drop` leaves interruptedExecutionId as honest history on the record", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "dropped", { status: "running", currentExecutionId: "exec:7" });
    const app = await mkApp(store, (_: InterruptedExecution) => "drop");

    await app.resumeSession("dropped");

    const record = await store.get("dropped", stubStoreCtx());
    expect(record?.status).toBe("idle");
    expect(record?.interruptedExecutionId).toBe("exec:7");

    await app.closeApp();
  });
});
