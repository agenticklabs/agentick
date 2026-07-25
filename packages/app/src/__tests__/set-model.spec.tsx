/**
 * `session.model.setModel(adapter)` — the ergonomic-parity overload (ADR 89
 * §2). `createApp({ model: openai("gpt-4o") })` wraps an adapter at
 * construction; `setModel` accepts the SAME adapter sugar at runtime by way of
 * the app-injected `buildModelExecutor` builder. A BYO-executor app injects no
 * builder, so the adapter overload throws `ModelExecutorBuilderMissingError`.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, LanguageModelExecutor } from "@agentick/model-executor";
import { scriptedAdapter } from "@agentick/model/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  ModelExecutorBuilderMissingError,
  type ExecutionTarget,
  type RegisteredModel,
} from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "hi");
}

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** A scripted `FakeLanguageModelExecutor` whose one-shot reply is `text`. */
function replyExec(text: string): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `exec-${text}`,
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
}

describe("session.model.setModel(adapter) — ergonomic-parity overload (ADR 89 §2)", () => {
  it("adapter-constructed app: setModel(adapter) swaps the default; next send uses it", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("from-A", { provider: "prov-a" }),
    });
    const session = await app.createSession();

    expect(
      (await (await session.send({ messages: [{ role: "user", content: "hi" }] })).result).response,
    ).toBe("from-A");

    // The runtime twin of construction's `model` sugar — pass a bare adapter.
    await session.model.setModel(scriptedAdapter("from-B", { provider: "prov-b" }));
    expect(session.model.current!.target.provider).toBe("prov-b");

    expect(
      (await (await session.send({ messages: [{ role: "user", content: "hi" }] })).result).response,
    ).toBe("from-B");

    await app.closeApp();
  });

  it("BYO-executor app: setModel(adapter) throws; setModel(RegisteredModel) still works", async () => {
    const a = replyExec("from-A");
    await a.ready;
    const app = await createApp(React.createElement(MinimalAgent), { modelExecutor: a, target });
    const session = await app.createSession();

    expect(
      (await (await session.send({ messages: [{ role: "user", content: "hi" }] })).result).response,
    ).toBe("from-A");

    // No builder was injected (BYO-executor) — the adapter overload throws.
    await expect(session.model.setModel(scriptedAdapter("nope"))).rejects.toBeInstanceOf(
      ModelExecutorBuilderMissingError,
    );

    // The RegisteredModel form is unchanged — a hand-built executor swaps in.
    const built = new LanguageModelExecutor(
      "byo-swap",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { adapter: scriptedAdapter("from-B", { provider: "prov-b" }) },
    );
    const registered: RegisteredModel = { modelExecutor: built, target: built.target };
    await session.model.setModel(registered);
    expect(
      (await (await session.send({ messages: [{ role: "user", content: "hi" }] })).result).response,
    ).toBe("from-B");

    await app.closeApp();
  });
});

describe("model-less app (no model / modelExecutor at construction)", () => {
  it("constructs, and its session's model.current is undefined", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {});
    const session = await app.createSession();
    expect(session.model.current).toBeUndefined();
    await app.closeApp();
  });

  it("dispatch and snapshot work model-less (no model needed for either)", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {});
    const session = await app.createSession();

    // A user-audience tool reachable via dispatch — no model involved.
    const dispatched = await session.tools.dispatch("noop-echo", { value: "hi" }).catch((e) => e);
    // The tool isn't registered here; the point is dispatch does not require a
    // model (it fails with a tool-resolution error, NOT NoModelForExecutionError).
    expect((dispatched as { _tag?: string })._tag).not.toBe("NoModelForExecutionError");

    // Snapshot/restore round-trips without a model.
    const snap = await session.snapshot();
    expect(snap).toBeDefined();

    await app.closeApp();
  });

  it("a per-send modelExecutor override runs on an otherwise model-less app", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {});
    const session = await app.createSession();
    const exec = replyExec("from-per-send");
    await exec.ready;

    const res = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        modelExecutor: exec,
        target,
      })
    ).result;
    expect(res.response).toBe("from-per-send");

    await app.closeApp();
  });

  it("setModel(adapter) works on a model-less app (builder IS injected)", async () => {
    // A model-less app still gets the adapter→executor builder (only a
    // BYO-executor app opts out), so the ergonomic adapter overload works.
    const app = await createApp(React.createElement(MinimalAgent), {});
    const session = await app.createSession();

    await session.model.setModel(scriptedAdapter("from-set", { provider: "prov-set" }));
    expect(session.model.current!.target.provider).toBe("prov-set");

    const res = await (await session.send({ messages: [{ role: "user", content: "hi" }] })).result;
    expect(res.response).toBe("from-set");

    await app.closeApp();
  });
});
