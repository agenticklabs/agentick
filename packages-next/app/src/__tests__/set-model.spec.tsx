/**
 * `session.model.setModel(adapter)` — the ergonomic-parity overload (ADR 89
 * §2). `createApp({ model: openai("gpt-4o") })` wraps an adapter at
 * construction; `setModel` accepts the SAME adapter sugar at runtime by way of
 * the app-injected `buildModelExecutor` builder. A BYO-executor app injects no
 * builder, so the adapter overload throws `ModelExecutorBuilderMissingError`.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, LanguageModelExecutor } from "@agentick/model-executor-next";
import { scriptedAdapter } from "@agentick/model-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  ModelExecutorBuilderMissingError,
  type ExecutionTarget,
  type RegisteredModel,
} from "@agentick/spec-next";

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
    expect(session.model.current.target.provider).toBe("prov-b");

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
