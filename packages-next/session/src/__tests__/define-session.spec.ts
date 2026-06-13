/**
 * `defineSession` — smoke tests for the callback-style factory.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  isSessionHarnessFactory,
  SPEC_VERSION,
  type ApplyResult,
  type SendInput,
  type SessionExecutionHandle,
  type SessionSnapshot,
} from "@agentick/spec-next";

import { defineSession } from "../define-session.js";

function fakeHandle(): SessionExecutionHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { executionId: "e_x", result: Promise.resolve({} as any) } as SessionExecutionHandle;
}

function fakeSnapshot(): SessionSnapshot {
  return {
    specVersion: SPEC_VERSION,
    id: "s_test",
    status: "idle",
    currentTick: 0,
    timeline: [],
    knobs: {},
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

const okApply = async (): Promise<ApplyResult> => ({ appendedEntryIds: ["id_1"] });

describe("defineSession — factory shape", () => {
  it("returns a SessionHarnessFactory (passes marker)", () => {
    const factory = defineSession({
      send: async () => fakeHandle(),
      snapshot: fakeSnapshot,
      applyExecutorResult: okApply,
      applyToolResults: okApply,
      appendEntry: okApply,
    });
    expect(isSessionHarnessFactory(factory)).toBe(true);
  });

  it("constructs a session whose send/snapshot delegate to callbacks", async () => {
    let seenSend: SendInput<unknown> | undefined;
    const factory = defineSession({
      send: async (input) => {
        seenSend = input;
        return fakeHandle();
      },
      snapshot: fakeSnapshot,
      applyExecutorResult: okApply,
      applyToolResults: okApply,
      appendEntry: okApply,
    });
    const session = factory({
      scopeId: "test-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const sendResult = await session.send({ messages: [{ role: "user", content: "hi" }] });
    expect(sendResult.executionId).toBe("e_x");
    expect(seenSend?.messages?.[0]?.content).toBe("hi");

    const snap = session.snapshot();
    expect(snap.id).toBe("s_test");
  });
});

describe("defineSession — defaults", () => {
  it("unconfigured extended methods throw helpful errors", async () => {
    const factory = defineSession({
      send: async () => fakeHandle(),
      snapshot: fakeSnapshot,
      applyExecutorResult: okApply,
      applyToolResults: okApply,
      appendEntry: okApply,
    });
    const session = factory({
      scopeId: "defaults-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await expect(session.spawn({ agent: null } as never)).rejects.toMatchObject({
      _tag: "ExecutionFailed",
    });
    await expect(session.dispatch("anything", {})).rejects.toMatchObject({
      _tag: "ExecutionFailed",
    });
    expect(() => session.channel("x")).toThrow(/channel/);
    expect(() => session.knob("x")).toThrow(/knob/);
  });

  it("top-level handles default to no-ops that resolve cleanly", async () => {
    const factory = defineSession({
      send: async () => fakeHandle(),
      snapshot: fakeSnapshot,
      applyExecutorResult: okApply,
      applyToolResults: okApply,
      appendEntry: okApply,
    });
    const session = factory({
      scopeId: "defaults-2",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    expect(session.timeline.read().entries).toEqual([]);
    expect(session.timeline.readPending()).toEqual([]);
    await session.timeline.append();
    const { ids } = await session.timeline.queue({ role: "user", content: [] });
    expect(ids).toEqual([]);
    expect(session.knobs.list()).toEqual([]);
    expect(session.state.list()).toEqual([]);
  });
});
