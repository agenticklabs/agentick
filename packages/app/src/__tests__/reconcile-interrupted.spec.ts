/**
 * The interruption mark — the pure half of the two-signal detection
 * (execution-resume.md §3.1). Detection moved to the resume path (the record's
 * `running` is the candidate signal; the timeline boundary is authoritative —
 * see interrupted-callback.spec); this function only RECORDS a verdict already
 * reached: crash history + the per-execution budget, additively — never an
 * `interrupted` session status.
 */

import type { SessionRecord, UsageStats } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { markInterruptedRecord } from "../harness.js";

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

describe("markInterruptedRecord", () => {
  it("records the crash additively — idle, cleared current, history + budget", () => {
    const before = rec({ status: "running", currentExecutionId: "exec:abc" });
    const after = markInterruptedRecord(before, "exec:abc");

    expect(after).not.toBe(before); // a new record
    expect(after.status).toBe("idle"); // sendable again — NOT an `interrupted` status
    expect(after.currentExecutionId).toBeUndefined(); // cleared
    expect(after.interruptedExecutionId).toBe("exec:abc"); // the history
    expect(after.resumeAttempts).toBe(1); // budget bumped from absent → 1
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("increments resumeAttempts for a re-crash of the SAME execution (consecutive)", () => {
    // A resumed execution keeps its id, so a re-crash marks the id already stored
    // as interruptedExecutionId.
    const after = markInterruptedRecord(
      rec({
        status: "running",
        currentExecutionId: "exec:x",
        interruptedExecutionId: "exec:x",
        resumeAttempts: 2,
      }),
      "exec:x",
    );
    expect(after.resumeAttempts).toBe(3);
  });

  it("resets resumeAttempts to 1 when a DIFFERENT execution is interrupted", () => {
    // A fresh turn (B) after execution A was dropped must not inherit A's count.
    const after = markInterruptedRecord(
      rec({
        status: "running",
        currentExecutionId: "exec:B",
        interruptedExecutionId: "exec:A",
        resumeAttempts: 3,
      }),
      "exec:B",
    );
    expect(after.interruptedExecutionId).toBe("exec:B");
    expect(after.resumeAttempts).toBe(1);
  });
});
