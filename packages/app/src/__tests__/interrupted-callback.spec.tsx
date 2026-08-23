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

  it("the mark survives an ASYNC store — hydrate's write-back cannot clobber it (F1)", async () => {
    // InMemory puts apply synchronously at kick time, which HID this race: the
    // hydrate write-back is fire-and-forget, the mark-put is direct — on a store
    // whose puts complete out of submission order (pooled SQL), the write-back
    // can land late and erase the mark. This store completes its FIRST put after
    // a delay and later puts immediately; the resume path's flush barrier must
    // make the mark survive anyway.
    class SlowNeutralizeStore extends InMemorySessionStore {
      armed = false;
      // The runtime's write-behind goes through the VIEW → store.mutate({put});
      // the mark is a direct store.put. While armed, a mutate carrying no mark
      // (the hydrate write-back's shape) completes LATE — modeling a pooled-SQL
      // store finishing puts out of submission order.
      override async mutate(
        m: Parameters<InMemorySessionStore["mutate"]>[0],
        ctx: Parameters<InMemorySessionStore["mutate"]>[1],
      ) {
        const put = (m as { put?: SessionRecord }).put;
        if (this.armed && put !== undefined && put.interruptedExecutionId === undefined) {
          await new Promise((r) => setTimeout(r, 25));
        }
        return super.mutate(m, ctx);
      }
    }
    const store = new SlowNeutralizeStore();
    await seed(store, "racy", { status: "running", currentExecutionId: "exec:r1" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);
    store.armed = true;

    await app.resumeSession("racy");
    expect(cb).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 40)); // let any straggler write land
    const record = await store.get("racy", stubStoreCtx());
    expect(record?.interruptedExecutionId).toBe("exec:r1");

    await app.closeApp();
  });

  it("does NOT fire for legitimate non-`running` waits carrying an execution id (running-ONLY)", async () => {
    // The deliberate-exclusions invariant from slice 1, re-pinned at the seam:
    // paused / input_required / hibernated are persisted WAITS, not crashes —
    // a future "complete the matrix" edit must fail here.
    const store = new InMemorySessionStore();
    await seed(store, "waiting", { status: "input_required", currentExecutionId: "exec:w1" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.resumeSession("waiting");
    expect(cb).not.toHaveBeenCalled();
    const record = await store.get("waiting", stubStoreCtx());
    expect(record?.interruptedExecutionId).toBeUndefined();

    await app.closeApp();
  });

  it("does NOT fire for `running` without an execution id", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "headless", { status: "running" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.resumeSession("headless");
    expect(cb).not.toHaveBeenCalled();

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

/**
 * `createSession` on a known id is open-or-rehydrate (ADR 49), so it adopts a
 * crashed record exactly as `resumeSession` does — and must take the SAME
 * recovery path (checkpointing §4: one path, whichever door). Detection reads
 * the record the SESSION adopted at genesis, so a fresh create — which has no
 * record — never pays for it.
 */
describe("onInterruptedExecution — the create door (open-or-rehydrate)", () => {
  const observed = (ctx: InterruptedExecution) => ({
    executionId: ctx.executionId,
    attempt: ctx.attempt,
    status: ctx.session.status,
    interruptedExecutionId: ctx.session.interruptedExecutionId,
    currentExecutionId: ctx.session.currentExecutionId,
  });

  it("reopening a crash via createSession fires ONCE — same sequence as resumeSession", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "crashed-create", { status: "running", currentExecutionId: "exec:c1" });
    await seed(store, "crashed-resume", { status: "running", currentExecutionId: "exec:c1" });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.createSession({ sessionId: "crashed-create" });
    await app.resumeSession("crashed-resume");
    expect(cb).toHaveBeenCalledTimes(2);
    expect(observed(cb.mock.calls[0]![0])).toEqual(observed(cb.mock.calls[1]![0]));
    expect(observed(cb.mock.calls[0]![0])).toEqual({
      executionId: "exec:c1",
      attempt: 1,
      status: "idle",
      interruptedExecutionId: "exec:c1",
      currentExecutionId: undefined,
    });
    expect((await store.get("crashed-create", stubStoreCtx()))?.interruptedExecutionId).toBe(
      "exec:c1",
    );

    // The idempotent reopen returns the LIVE session — one interruption stays
    // one policy call, however many times the door is used.
    await app.createSession({ sessionId: "crashed-create" });
    expect(cb).toHaveBeenCalledTimes(2);

    await app.closeApp();
  });

  it("boundary present via the create door = no mark, no callback (don't-run-twice)", async () => {
    const store = new InMemorySessionStore();
    const timelineStore = new MemoryTimelineStore();
    const boundaryEntry: TimelineEntry = {
      kind: "boundary",
      ts: 0,
      boundary: { executionId: "exec:cdone", outcome: "succeeded" },
    };
    await timelineStore.append("finished-create:timeline", [boundaryEntry], stubStoreCtx());
    await seed(store, "finished-create", { status: "running", currentExecutionId: "exec:cdone" });
    const cb = vi.fn((_: InterruptedExecution) => "resume" as const);
    const app = await mkApp(store, cb, timelineStore);

    await app.createSession({ sessionId: "finished-create" });
    expect(cb).not.toHaveBeenCalled();

    const record = await store.get("finished-create", stubStoreCtx());
    expect(record?.status).toBe("idle");
    expect(record?.interruptedExecutionId).toBeUndefined();
    expect(record?.resumeAttempts).toBeUndefined();

    await app.closeApp();
  });

  it("a genuinely fresh create pays NOTHING — one record read, the genesis one", async () => {
    // Detection rides the record the session adopted at genesis, so it costs no
    // read of its own. A create door that probed the store itself would make
    // this two — every new session paying for a recovery that cannot apply.
    class CountingStore extends InMemorySessionStore {
      gets = 0;
      override get(id: string, ctx: Parameters<InMemorySessionStore["get"]>[1]) {
        this.gets += 1;
        return super.get(id, ctx);
      }
    }
    const store = new CountingStore();
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.createSession({ sessionId: "brand-new" });
    expect(store.gets).toBe(1);
    expect(cb).not.toHaveBeenCalled();

    await app.closeApp();
  });

  it("resumeAttempts increments across a re-crash reopened through the create door", async () => {
    // The re-driven execution keeps its id, so a second crash of the SAME id is
    // consecutive — the crash-loop budget the policy reads.
    const store = new InMemorySessionStore();
    await seed(store, "recrash", {
      status: "running",
      currentExecutionId: "exec:loop",
      interruptedExecutionId: "exec:loop",
      resumeAttempts: 1,
    });
    const cb = vi.fn((_: InterruptedExecution) => "drop" as const);
    const app = await mkApp(store, cb);

    await app.createSession({ sessionId: "recrash" });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].attempt).toBe(2);
    expect((await store.get("recrash", stubStoreCtx()))?.resumeAttempts).toBe(2);

    await app.closeApp();
  });

  it("a throwing policy rejects the create, exactly as it rejects the resume", async () => {
    const store = new InMemorySessionStore();
    await seed(store, "boom-create", { status: "running", currentExecutionId: "exec:b1" });
    const app = await mkApp(store, () => {
      throw new Error("policy boom");
    });

    // Collapsed to a string before asserting: a `rejects` matcher that gets a
    // RESOLVED open diffs a whole live session harness, which OOMs the worker.
    const outcome = await app.createSession({ sessionId: "boom-create" }).then(
      () => "opened",
      (err: unknown) => String((err as Error).message),
    );
    expect(outcome).toContain("policy boom");

    await app.closeApp();
  });
});
