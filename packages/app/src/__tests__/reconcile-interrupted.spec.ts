/**
 * Boot-reconciliation mark — the capability half of execution resume
 * (execution-resume.md §3.1). A record still `running` at rebuild time is a crash
 * mid-turn (eviction refuses in-flight sessions); reconcile records the
 * interruption additively — no `interrupted` session status — and returns the
 * SAME reference unchanged when there is nothing to do.
 */

import type { SessionRecord, SessionStatus, UsageStats } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { reconcileInterruptedRecord } from "../harness.js";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as UsageStats;

function rec(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "s1",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    executionCount: 1,
    usage,
    ...overrides,
  };
}

describe("reconcileInterruptedRecord", () => {
  it("marks a crashed `running` execution interrupted, additively", () => {
    const before = rec({ status: "running", currentExecutionId: "exec:abc" });
    const after = reconcileInterruptedRecord(before);

    expect(after).not.toBe(before); // a new record
    expect(after.status).toBe("idle"); // sendable again — NOT an `interrupted` status
    expect(after.currentExecutionId).toBeUndefined(); // cleared
    expect(after.interruptedExecutionId).toBe("exec:abc"); // moved here
    expect(after.resumeAttempts).toBe(1); // budget bumped from absent → 1
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("increments resumeAttempts for a re-crash of the SAME execution (consecutive)", () => {
    // A resumed execution keeps its id, so a re-crash carries currentExecutionId
    // === the stored interruptedExecutionId.
    const after = reconcileInterruptedRecord(
      rec({
        status: "running",
        currentExecutionId: "exec:x",
        interruptedExecutionId: "exec:x",
        resumeAttempts: 2,
      }),
    );
    expect(after.resumeAttempts).toBe(3);
  });

  it("resets resumeAttempts to 1 when a DIFFERENT execution is interrupted", () => {
    // A fresh turn (B) after execution A was dropped must not inherit A's count.
    const after = reconcileInterruptedRecord(
      rec({
        status: "running",
        currentExecutionId: "exec:B",
        interruptedExecutionId: "exec:A",
        resumeAttempts: 3,
      }),
    );
    expect(after.interruptedExecutionId).toBe("exec:B");
    expect(after.resumeAttempts).toBe(1);
  });

  it("is a no-op (same reference) for an idle record", () => {
    const before = rec({ status: "idle" });
    expect(reconcileInterruptedRecord(before)).toBe(before);
  });

  it("is a no-op when `running` carries no execution id", () => {
    const before = rec({ status: "running" });
    expect(reconcileInterruptedRecord(before)).toBe(before);
  });

  it("leaves legitimate non-`running` waits untouched (not crashes)", () => {
    for (const status of ["input_required", "paused", "hibernated"] as SessionStatus[]) {
      const before = rec({ status, currentExecutionId: "exec:y" });
      expect(reconcileInterruptedRecord(before)).toBe(before);
    }
  });
});
