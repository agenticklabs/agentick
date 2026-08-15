/**
 * ADR 99 slice 3 at the ADOPTER's entry point — `createApp` down to a retried
 * tick. The session owns the policy; this pins that an app-level configuration
 * reaches it, which is the only door most adopters will use.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, type MockScriptedRun } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { reactCompiler } from "@agentick/compiler-react";
import type { ExecutionTarget, LanguageModelExecutionResult } from "@agentick/spec";
import { MalformedModelOutput, ProviderRejected } from "@agentick/spec";

import { createApp } from "../react.js";

function Agent(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system" }, "You are a helpful agent."),
    React.createElement("message" as never, { role: "user" }, "hi"),
  );
}

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const ended: LanguageModelExecutionResult = {
  specVersion: "2026-05-08",
  output: [{ type: "text", text: "recovered" }],
  stopReason: "end",
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
};

function mkExecutor(scripted: readonly MockScriptedRun[]): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `tfp-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted },
  );
}

describe("createApp — tick-failure policy reaches the session", () => {
  it("the bundled default retries a malformed generation with no configuration at all", async () => {
    const executor = mkExecutor([
      { result: ended, outcome: "failed", error: new MalformedModelOutput({ toolName: "q" }) },
      { result: ended },
    ]);
    await executor.ready;
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      compiler: reactCompiler(),
      target,
    });
    const { result } = await app.runOnce({ send: { messages: [{ role: "user", content: "x" }] } });
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");
    await app.closeApp();
  });

  it("`createApp({ tickFailurePolicy })` — the flat shorthand cascades like defaultMaxTicks", async () => {
    const executor = mkExecutor([
      { result: ended, outcome: "failed", error: new ProviderRejected({ status: 503 }) },
      { result: ended },
    ]);
    await executor.ready;
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      compiler: reactCompiler(),
      target,
      tickFailurePolicy: { ProviderRejected: 1 },
      maxConsecutiveFailedTicks: 2,
    });
    const { result } = await app.runOnce({ send: { messages: [{ role: "user", content: "x" }] } });
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");
    await app.closeApp();
  });

  it("`createApp({ session: { tickFailurePolicy } })` replaces it", async () => {
    // The bundled policy would stop on this class; the app-level table says retry.
    const executor = mkExecutor([
      { result: ended, outcome: "failed", error: new ProviderRejected({ status: 503 }) },
      { result: ended },
    ]);
    await executor.ready;
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      compiler: reactCompiler(),
      target,
      session: { tickFailurePolicy: { ProviderRejected: 1 } },
    });
    const { result } = await app.runOnce({ send: { messages: [{ role: "user", content: "x" }] } });
    expect(result.ticks).toBe(2);
    expect(result.stopReason).toBe("end");
    await app.closeApp();
  });
});
