/**
 * MVP smoke tests for `defineEval` + the `t` (test context) shape.
 *
 *   - defineEval returns a callable; basic invocation works.
 *   - t.send → drives the agent; t.completed asserts stop reason.
 *   - t.calledTool / t.notCalledTool inspect the recorded tool ledger.
 *   - t.noFailedActions checks tool outcomes.
 *   - per-call overrides (executor swap) work.
 *
 * Uses FakeLanguageModelExecutor with scripted tool calls — deterministic,
 * no real model. The agent JSX declares a `calculator` tool handler.
 */

import React from "react";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { reactReconciler } from "@agentick/reconciler-react-next";
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
  // Single-tick path — model answers directly without calling any tool.
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

describe("defineEval — MVP shape", () => {
  it("returns a callable that resolves to an EvalResult", async () => {
    const myEval = defineEval({
      description: "minimal smoke test",
      rootElement: React.createElement(AgentWithCalculator),
      executor: mkCalculatorExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
      toolHandlers: calculatorHandlers,
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
    const myEval = defineEval({
      description: "introspect",
      rootElement: React.createElement(AgentWithCalculator),
      executor: mkCalculatorExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
      async test() {},
    });
    expect(myEval.definition.description).toBe("introspect");
  });

  it("t.calledTool records a passing assertion when the tool was called with matching input", async () => {
    const myEval = defineEval({
      description: "tool-call observed",
      rootElement: React.createElement(AgentWithCalculator),
      executor: mkCalculatorExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
      toolHandlers: calculatorHandlers,
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
    const myEval = defineEval({
      description: "tool-call input mismatch",
      rootElement: React.createElement(AgentWithCalculator),
      executor: mkCalculatorExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
      toolHandlers: calculatorHandlers,
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
    const myEval = defineEval({
      description: "tool-not-called",
      rootElement: React.createElement(AgentNoTools),
      executor: mkNoToolExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
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

  it("per-call executor override replaces the default", async () => {
    const myEval = defineEval({
      description: "override executor",
      rootElement: React.createElement(AgentWithCalculator),
      // Default executor — never used in this test
      executor: mkCalculatorExecutor(),
      reconciler: reactReconciler(),
      target: mkTarget(),
      async test(t) {
        const response = await t.send("Hello?");
        t.completed();
        // Sanity: the override's scripted output is what we got.
        expect(response).toBe("I don't know.");
        // No tool calls because we used the no-tool executor.
        t.notCalledTool("calculator");
      },
    });
    const result = await myEval({ executor: mkNoToolExecutor() });
    expect(result.passed).toBe(true);
  });
});
