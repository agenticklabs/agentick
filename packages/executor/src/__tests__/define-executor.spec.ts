/**
 * `defineExecutor` smoke tests.
 *
 * The factory + callback bundle should produce a working
 * `LanguageModelExecutor` without subclassing `BaseHarness`. Verifies:
 *   - self-described `target` exposed as a property
 *   - factory marker present (consumable by `isExecutorFactory`)
 *   - end-to-end `run()` happy path returns a succeeded terminal
 *   - aborted execution returns canceled
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
  RenderedTree,
} from "@agentick/spec";
import { isExecutorFactory } from "@agentick/spec";

import { defineExecutor } from "../define-executor.js";

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "callback", modelId: "demo-v1" };
}

const mkResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: "2026-05-08",
  output: [{ type: "text", text }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

describe("defineExecutor()", () => {
  it("returns an ExecutorFactory marker that isExecutorFactory recognizes", () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("ok") });
    expect(isExecutorFactory(f)).toBe(true);
  });

  it("constructs a self-describing executor when called", async () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("ok") });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target.modelId).toBe("demo-v1");
  });

  it("invokes the run callback on executor.run() and returns the terminal", async () => {
    let calls = 0;
    let receivedInput: LanguageModelInput | undefined;
    const f = defineExecutor({
      target: mkTarget(),
      async run(input) {
        calls++;
        receivedInput = input;
        return mkResult("computed");
      },
    });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;

    const terminal = await exec.run({ compiled: mkTree(), target: mkTarget() });
    expect(calls).toBe(1);
    expect(receivedInput?.messages.length).toBeGreaterThan(0);
    if (terminal.outcome !== "succeeded") throw new Error("expected success");
    expect(terminal.result.output[0]).toMatchObject({ type: "text", text: "computed" });
  });

  it("returns outcome=canceled after abort()", async () => {
    const f = defineExecutor({ target: mkTarget(), run: async () => mkResult("never") });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    await exec.abort({ executionId: "exec-1" });
    const terminal = await exec.run({
      compiled: mkTree(),
      target: mkTarget(),
      scope: { executionId: "exec-1" },
    });
    expect(terminal.outcome).toBe("canceled");
  });

  it("translates a thrown callback into ProviderRejected", async () => {
    const f = defineExecutor({
      target: mkTarget(),
      async run() {
        throw new Error("upstream blew up");
      },
    });
    const exec = f({
      scopeId: "x",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.ready;
    await expect(exec.run({ compiled: mkTree(), target: mkTarget() })).rejects.toMatchObject({
      _tag: "ProviderRejected",
    });
  });
});
