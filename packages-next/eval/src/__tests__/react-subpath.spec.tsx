/**
 * Verifies the `@agentick/eval-next/react` subpath defaults
 * `reconciler` to `reactReconciler()` when omitted, and still honors
 * an explicit override when supplied.
 *
 * Mirrors the base smoke test minus the reconciler boilerplate.
 */

import React from "react";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { reactReconciler } from "@agentick/reconciler-react-next";
import type { ExecutionTarget } from "@agentick/spec-next";
import { describe, expect, it } from "vitest";

import { defineEval } from "../react/index.js";

const Agent = (): React.ReactElement =>
  React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: false },
  };
}

function mkExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "eval-react-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "OK." }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ],
    },
  );
}

describe("eval-next/react — reconciler default", () => {
  it("runs without an explicit reconciler — defaults to reactReconciler()", async () => {
    const myEval = defineEval({
      description: "react-default",
      rootElement: React.createElement(Agent),
      executor: mkExecutor(),
      target: mkTarget(),
      async test(t) {
        await t.send("ping?");
        t.completed();
      },
    });
    const result = await myEval();
    expect(result.passed).toBe(true);
  });

  it("honors an explicit reconciler override", async () => {
    const explicit = reactReconciler();
    const myEval = defineEval({
      description: "react-explicit",
      rootElement: React.createElement(Agent),
      executor: mkExecutor(),
      reconciler: explicit,
      target: mkTarget(),
      async test(t) {
        await t.send("ping?");
        t.completed();
      },
    });
    const result = await myEval();
    expect(result.passed).toBe(true);
    expect(myEval.definition.reconciler).toBe(explicit);
  });
});
