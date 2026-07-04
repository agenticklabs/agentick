/**
 * `run()` one-shot execution (#171) — temporary app + session, single
 * send, auto-teardown, v1 handle ergonomics (await / .result /
 * for-await).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import type { ExecutionTarget } from "@agentick/spec-next";
import type { LanguageModelAdapter } from "@agentick/model-next";

import { run } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function scriptedAdapter(text: string): LanguageModelAdapter<{ text: string }, never> {
  const target: ExecutionTarget = {
    kind: "language-model",
    provider: "scripted",
    modelId: "scripted-v1",
    capabilities: { supportsTools: false, supportsStreaming: false },
  };
  return {
    provider: "scripted",
    target,
    buildParams: (input) => input,
    call: async () => ({ text }),
    openStream: () => {
      throw new Error("not streaming");
    },
    mapChunk: () => [],
    reconstructRaw: () => ({ text: "" }),
    normalize: (raw) => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  };
}

describe("run() — one-shot execution", () => {
  it("`await run(...).result` resolves the SendResult (v1 unwrap ergonomic)", async () => {
    const result = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("pong from run"),
      messages: [{ role: "user", content: "hi" }],
    }).result;
    expect(result.response).toContain("pong from run");
  });

  it("awaiting the handle then iterating streams events before result", async () => {
    const handle = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("streamed pong"),
      messages: [{ role: "user", content: "hi" }],
    });
    const types: string[] = [];
    for await (const event of handle) types.push(event.type);
    expect(types.length).toBeGreaterThan(0);
    const result = await handle.result;
    expect(result.response).toContain("streamed pong");
  });

  it("`for await` directly on the run handle works (no intermediate await)", async () => {
    const handle = run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("direct iteration"),
      messages: [{ role: "user", content: "hi" }],
    });
    const types: string[] = [];
    for await (const event of handle) types.push(event.type);
    expect(types.length).toBeGreaterThan(0);
    expect((await handle.result).response).toContain("direct iteration");
  });

  it("construction failure rejects the handle without leaking an unhandled rejection", async () => {
    // No model and no executor — the app slot guard throws.
    await expect(
      run(React.createElement(MinimalAgent), {
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/model is required/);
  });

  it("runs back-to-back — each invocation owns and tears down its app", async () => {
    const first = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("first"),
      messages: [{ role: "user", content: "1" }],
    }).result;
    const second = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("second"),
      messages: [{ role: "user", content: "2" }],
    }).result;
    expect(first.response).toContain("first");
    expect(second.response).toContain("second");
  });
});
