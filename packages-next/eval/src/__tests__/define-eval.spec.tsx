/**
 * MVP smoke tests for `defineEval({ description, app, test })`.
 *
 *   - defineEval returns a callable; basic invocation works.
 *   - t.send → drives the agent; t.completed asserts stop reason.
 *   - t.calledTool / t.notCalledTool inspect the recorded tool ledger.
 *   - t.noFailedActions checks tool outcomes.
 *   - per-invocation overrides flow into the `app` thunk unchanged.
 *
 * Uses FakeLanguageModelExecutor with scripted tool calls — deterministic,
 * no real model. The agent JSX declares a `calculator` tool handler.
 */

import React from "react";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec-next";
import { describe, expect, it } from "vitest";

import { defineEval } from "../index.js";

const AgentNoTools = (): React.ReactElement =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
  );

const AgentWithCalculator = (): React.ReactElement =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
    React.createElement("tool" as never, {
      id: "t.calculator",
      name: "calculator",
      description: "Evaluate arithmetic",
      inputSchema: {
        type: "object",
        required: ["expression"],
        properties: { expression: { type: "string" } },
      },
      exposure: ["model"],
      handlerRef: "handlers/calculator",
    }),
  );

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: false },
  };
}

function mkCalculatorExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "eval-test-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              {
                type: "tool_use",
                toolUseId: "tc-1",
                name: "calculator",
                input: { expression: "47 * 23" },
              },
            ],
            stopReason: "tool_use",
            toolCalls: [{ id: "tc-1", name: "calculator", input: { expression: "47 * 23" } }],
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "47 × 23 = 1081." }],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          },
        },
      ],
    },
  );
}

function mkNoToolExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "eval-no-tool-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "I don't know." }],
            stopReason: "end",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          },
        },
      ],
    },
  );
}

const calculatorHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
  [
    "handlers/calculator",
    async (input) => {
      const { expression } = input as { expression: string };
      const value = Function(`"use strict"; return (${expression});`)();
      return [{ type: "text", text: String(value) }];
    },
  ],
]);

// Adopter-side app factory — closes over the defaults; the override
// shape is `{ executor?: FakeLanguageModelExecutor }` for the few
// tests that swap the model.
type Overrides = { executor?: FakeLanguageModelExecutor };

const calculatorApp = (overrides?: Overrides) =>
  createApp(React.createElement(AgentWithCalculator), {
    executor: overrides?.executor ?? mkCalculatorExecutor(),
    target: mkTarget(),
    toolHandlers: calculatorHandlers,
  });

const noToolApp = (overrides?: Overrides) =>
  createApp(React.createElement(AgentNoTools), {
    executor: overrides?.executor ?? mkNoToolExecutor(),
    target: mkTarget(),
  });

describe("defineEval — MVP shape", () => {
  it("returns a callable that resolves to an EvalResult", async () => {
    const myEval = defineEval<Overrides>({
      description: "minimal smoke test",
      app: calculatorApp,
      async test(t) {
        await t.send("What's 47 * 23?");
        t.completed();
      },
    });

    const result = await myEval();
    expect(result.description).toBe("minimal smoke test");
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]!.kind).toBe("completed");
    expect(result.assertions[0]!.passed).toBe(true);
  });

  it("exposes the original definition for introspection", () => {
    const myEval = defineEval<Overrides>({
      description: "introspect",
      app: calculatorApp,
      async test() {},
    });
    expect(myEval.definition.description).toBe("introspect");
    expect(myEval.definition.app).toBe(calculatorApp);
  });

  it("t.calledTool records a passing assertion when the tool was called with matching input", async () => {
    const myEval = defineEval<Overrides>({
      description: "tool-call observed",
      app: calculatorApp,
      async test(t) {
        await t.send("Compute 47 * 23");
        t.completed();
        t.calledTool("calculator", {
          input: { expression: "47 * 23" },
          isError: false,
        });
        t.noFailedActions();
      },
    });

    const result = await myEval();
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("calculator");
    expect(result.toolCalls[0]!.outcome).toBe("succeeded");
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it("t.calledTool records a failing assertion when input doesn't match", async () => {
    const myEval = defineEval<Overrides>({
      description: "tool-call input mismatch",
      app: calculatorApp,
      async test(t) {
        await t.send("Compute 47 * 23");
        t.calledTool("calculator", { input: { expression: "99 * 99" } });
      },
    });
    const result = await myEval();
    expect(result.passed).toBe(false);
    const calledToolAssertion = result.assertions.find((a) => a.kind === "calledTool");
    expect(calledToolAssertion?.passed).toBe(false);
    expect(calledToolAssertion?.message).toMatch(/none matched/);
  });

  it("t.notCalledTool passes when the tool was NOT called", async () => {
    const myEval = defineEval<Overrides>({
      description: "tool-not-called",
      app: noToolApp,
      async test(t) {
        await t.send("What's the meaning of life?");
        t.completed();
        t.notCalledTool("calculator");
        t.notCalledTool("refunds_issue");
      },
    });
    const result = await myEval();
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("per-invocation overrides flow into the app thunk", async () => {
    // The factory checks the overrides arg for an executor and uses
    // it if present, otherwise its default. We pass the no-tool
    // executor at invocation time; the eval should see "I don't know."
    const myEval = defineEval<Overrides>({
      description: "override executor",
      app: (overrides) =>
        createApp(React.createElement(AgentWithCalculator), {
          executor: overrides?.executor ?? mkCalculatorExecutor(),
          target: mkTarget(),
          toolHandlers: calculatorHandlers,
        }),
      async test(t) {
        const response = await t.send("Hello?");
        t.completed();
        expect(response).toBe("I don't know.");
        t.notCalledTool("calculator");
      },
    });
    const result = await myEval({ executor: mkNoToolExecutor() });
    expect(result.passed).toBe(true);
  });
});
