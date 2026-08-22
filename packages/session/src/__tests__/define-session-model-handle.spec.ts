/**
 * `defineSession` — the model-less session's `model` handle.
 *
 * `ModelSelectionHandle.current` is typed `RegisteredModel | undefined` and its
 * contract says so in prose: "a model-less session is LEGAL — the model is
 * enforced at execution time, not construction". So the natural guard
 * (`if (session.model.current)`) must WORK on a session built without a model;
 * the no-op handle stands for exactly that case.
 *
 * The mutation half keeps rejecting: `setModel` / `setTarget` on a callback
 * session have nowhere to write, and that IS a configuration error. Reads
 * degrade, writes complain — the same split `noopKnobsHandle` /
 * `noopStateHandle` / `noopGatesHandle` already follow in this module.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { SPEC_VERSION, type ApplyResult, type SessionExecutionHandle } from "@agentick/spec";
import type { RegisteredModel } from "@agentick/spec";

import { defineSession } from "../define-session.js";

function fakeHandle(): SessionExecutionHandle {
  return {
    executionId: "e_x",
    status: "completed",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: Promise.resolve({} as any),
    events: async function* () {},
    readable: () => new ReadableStream(),
    pipeTo: async () => {},
    abort: async () => {},
  };
}

const okApply = async (): Promise<ApplyResult> => ({ appendedEntryIds: ["id_1"] });

function modellessSession(scopeId: string) {
  const factory = defineSession({
    send: async () => fakeHandle(),
    snapshot: () => ({
      specVersion: SPEC_VERSION,
      id: scopeId,
      status: "idle" as const,
      currentTick: 0,
      bridges: { timeline: { persisted: [], projection: [] }, knobs: {} },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    applyExecutorResult: okApply,
    applyToolResults: okApply,
    appendEntry: okApply,
  });
  return factory({
    scopeId,
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  });
}

describe("defineSession — model-less session's model handle", () => {
  it("`current` reads as undefined instead of throwing", () => {
    const session = modellessSession("modelless-1");
    expect(session.model.current).toBeUndefined();
  });

  it("the documented guard compiles AND runs", () => {
    const session = modellessSession("modelless-2");
    // `current` is `RegisteredModel | undefined` — narrowing it is the point.
    const current: RegisteredModel | undefined = session.model.current;
    const modelId = current ? current.target.modelId : "none";
    expect(modelId).toBe("none");
  });

  it("the MUTATION paths still reject with a configuration message", async () => {
    const session = modellessSession("modelless-3");
    await expect(session.model.setModel({} as RegisteredModel)).rejects.toThrow(/not configured/);
    await expect(
      session.model.setTarget({ kind: "language-model", provider: "p", modelId: "m" }),
    ).rejects.toThrow(/not configured/);
  });

  it("interceptor registration is inert but returns a callable unsubscribe", () => {
    const session = modellessSession("modelless-4");
    const offUse = session.model.use(async (input, next) => next(input));
    const offGuard = session.model.guard(() => undefined);
    expect(() => {
      offUse();
      offGuard();
    }).not.toThrow();
  });
});
