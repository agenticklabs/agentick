/**
 * Execution resume, end to end (execution-resume.md §6): a session whose
 * process died mid-turn — one committed tick, no boundary, record still
 * `running` — is reopened, reconciled, re-driven by policy, and COMPLETES
 * under its original executionId with ticks continuing past the committed
 * one. The crash state is seeded directly (deterministic post-crash shape;
 * kill-theater proves nothing this doesn't).
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemorySessionStore } from "@agentick/session";
import { MemoryTimelineStore } from "@agentick/timeline";
import { stubStoreCtx } from "@agentick/store";
import { waitFor } from "@agentick/utils/testing";
import type {
  ExecutionTarget,
  InterruptedExecution,
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

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as UsageStats;

const CRASHED = "exec:crashed";

function crashedTimeline(): TimelineEntry[] {
  return [
    {
      kind: "message",
      message: {
        id: "in-1",
        role: "user",
        content: [{ type: "text", text: "remember: OPAL" }],
        ts: 0,
        metadata: { executionId: CRASHED },
      },
    },
    {
      kind: "message",
      message: {
        id: "as-1",
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        ts: 0,
        metadata: { executionId: CRASHED, tickId: "tick-1", tickIndex: 1 },
      },
    },
  ];
}

async function mkCrashedApp(decision: "resume" | "drop") {
  const sessionStore = new InMemorySessionStore();
  const timelineStore = new MemoryTimelineStore();
  await timelineStore.append("victim:timeline", crashedTimeline(), stubStoreCtx());
  await sessionStore.put(
    {
      id: "victim",
      createdAt: 0,
      updatedAt: 0,
      status: "running",
      currentExecutionId: CRASHED,
      executionCount: 1,
      usage,
    },
    stubStoreCtx(),
  );
  const executor = new FakeLanguageModelExecutor(
    "resume-e2e",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "recovered" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
  await executor.ready;
  const cb = vi.fn((_: InterruptedExecution) => decision);
  const app = await createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target,
    sessions: { store: sessionStore },
    timeline: { store: timelineStore },
    onInterruptedExecution: cb,
  });
  return { app, sessionStore, timelineStore, cb };
}

describe("execution resume — the re-drive (slice 3, end to end)", () => {
  it("completes the crashed turn under its ORIGINAL executionId, ticks continuing", async () => {
    const { app, sessionStore, cb } = await mkCrashedApp("resume");

    const session = await app.resumeSession("victim");
    expect(session).toBeDefined();
    expect(cb).toHaveBeenCalledTimes(1);

    // The re-drive is DETACHED (resumeSession returned at acceptance) — wait
    // for the turn's durable end: the boundary record for the SAME execution.
    await waitFor(() => session!.timeline.executionCursor(CRASHED)?.boundary !== undefined, {
      timeoutMs: 5000,
    });

    const cursor = session!.timeline.executionCursor(CRASHED)!;
    expect(cursor.boundary).toBe("succeeded");
    // Ticks CONTINUED: the committed tick was 1, the re-driven tick is 2 —
    // never a restart at 1.
    expect(cursor.lastTickIndex).toBe(2);

    // The interrupted attempt's input was NOT re-appended.
    const inputs = session!.timeline
      .read()
      .entries.filter((e) => e.kind === "message" && e.message.role === "user");
    expect(inputs.length).toBe(1);

    // Completion RESOLVED the interruption on the durable record: history +
    // budget cleared, count un-bumped (same execution, not a new turn).
    await waitFor(async () => {
      const rec = await sessionStore.get("victim", stubStoreCtx());
      return rec?.interruptedExecutionId === undefined && rec?.status === "idle";
    });
    const record = await sessionStore.get("victim", stubStoreCtx());
    expect(record?.resumeAttempts).toBeUndefined();
    expect(record?.executionCount).toBe(1);

    await app.closeApp();
  });

  it("a `drop` leaves the session idle with the interruption as history — nothing runs", async () => {
    const { app, sessionStore, cb } = await mkCrashedApp("drop");

    const session = await app.resumeSession("victim");
    expect(cb).toHaveBeenCalledTimes(1);

    // No re-drive: no boundary ever appears for the crashed execution.
    await new Promise((r) => setTimeout(r, 50));
    expect(session!.timeline.executionCursor(CRASHED)?.boundary).toBeUndefined();
    const record = await sessionStore.get("victim", stubStoreCtx());
    expect(record?.status).toBe("idle");
    expect(record?.interruptedExecutionId).toBe(CRASHED);
    expect(record?.resumeAttempts).toBe(1);

    await app.closeApp();
  });

  it("resumeExecution refuses a finished execution — the manual door honors don't-run-twice", async () => {
    const { app } = await mkCrashedApp("resume");
    const session = await app.resumeSession("victim");
    await waitFor(() => session!.timeline.executionCursor(CRASHED)?.boundary !== undefined, {
      timeoutMs: 5000,
    });

    // The turn completed above; a MANUAL re-drive of the same execution must
    // refuse rather than run the finished turn again.
    const concrete = session as unknown as {
      resumeExecution(id: string): Promise<unknown>;
    };
    await expect(concrete.resumeExecution(CRASHED)).rejects.toThrow(/already ended/);

    await app.closeApp();
  });
});
