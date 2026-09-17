/**
 * The cold start is a fact about the log, so a render keyed to it is stable
 * from tick to tick: it moves only when a new execution begins after a gap.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { TimelineEntry } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";

import { coldStart, lastReplyAt } from "../cold-start.js";
import { TimelineHarness } from "../harness.js";

const MIN = 60_000;
const TTL = 5 * MIN;

const user = (id: string, ts: number): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", ts, content: [blocks.text(id)] },
});
const reply = (id: string, ts: number, executionId: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "assistant", ts, content: [blocks.text(id)], metadata: { executionId } },
});
const tool = (id: string, ts: number, executionId: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "tool", ts, content: [blocks.text(id)], metadata: { executionId } },
});

// Execution 1 at t=0: asked at 0, answered at 1 min. Execution 2 asked at 2 min (warm),
// answered at 3 min. Execution 3 asked at 20 min (cold), a tool round, answered at 21 min.
const log: TimelineEntry[] = [
  user("u1", 0),
  reply("a1", 1 * MIN, "e1"),
  user("u2", 2 * MIN),
  reply("a2", 3 * MIN, "e2"),
  user("u3a", 20 * MIN),
  user("u3b", 20 * MIN + 1),
  tool("t3", 20 * MIN + 30_000, "e3"),
  reply("a3", 21 * MIN, "e3"),
];

describe("coldStart", () => {
  it("is the first entry of the latest execution that began more than the ttl after the previous reply", () => {
    expect(coldStart(log, TTL)).toBe(4);
  });

  it("measures the gap to the user run that asked, not to the reply it produced", () => {
    // Execution 3 asked 17 minutes after a2 and answered 18 minutes after: cold under 17m, not under 17m30s.
    expect(coldStart(log, 17 * MIN - 1)).toBe(4);
    expect(coldStart(log, 17 * MIN + 30_000)).toBeUndefined();
  });

  it("does not move when the execution it names keeps going", () => {
    const before = coldStart(log.slice(0, 7), TTL);
    const after = coldStart(log, TTL);
    expect(before).toBe(4);
    expect(after).toBe(before);
  });

  it("is undefined while every execution began warm, and the first execution is never cold", () => {
    expect(coldStart(log.slice(0, 4), TTL)).toBeUndefined();
    expect(coldStart([user("u1", 10 * MIN), reply("a1", 11 * MIN, "e1")], TTL)).toBeUndefined();
    expect(coldStart([], TTL)).toBeUndefined();
  });

  it("moves forward to the latest cold start, never back", () => {
    const later = [...log, user("u4", 60 * MIN), reply("a4", 61 * MIN, "e4")];
    expect(coldStart(later, TTL)).toBe(8);
  });
});

describe("lastReplyAt", () => {
  it("is the newest assistant timestamp, and undefined before the first reply", () => {
    expect(lastReplyAt(log)).toBe(21 * MIN);
    expect(lastReplyAt([user("u1", 0)])).toBeUndefined();
  });
});

describe("the snapshot carries both, identity-stable per version", () => {
  let harness: TimelineHarness;
  beforeAll(async () => {
    harness = new TimelineHarness(
      "cold",
      new MemoryJournal({ capacity: 1_000 }),
      new LocalEventBus(),
      new LocalInbox(),
      {},
    );
    await harness.ready;
    await harness.append(...log);
  });

  it("binds the log's facts to the snapshot the hook returns", () => {
    const snapshot = harness.read();
    expect(snapshot.lastReplyAt).toBe(21 * MIN);
    expect(snapshot.coldStart?.(TTL)).toBe(4);
    expect(snapshot.coldStart?.(60 * MIN)).toBeUndefined();
  });

  it("returns the same snapshot until the projection changes", async () => {
    const first = harness.read();
    expect(harness.read()).toBe(first);
    await harness.append(user("u4", 60 * MIN));
    const second = harness.read();
    expect(second).not.toBe(first);
    expect(second.coldStart?.(TTL)).toBe(4);
  });
});
