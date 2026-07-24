/**
 * Structured-output terminal-tool COMPLIANCE eval — a documented EXAMPLE
 * (three-audiences-plan §B2, guarantees contract tier 3).
 *
 * "Does the model deliver the structured answer via the terminal tool?" is
 * MODEL BEHAVIOR — the same epistemic category as gate attestation — measured
 * on demand and reported as NUMBERS, never asserted in CI. This file is that
 * measurement, shaped as a `defineEval`. It is NOT a `.spec` file, so the
 * vitest CI run never picks it up; it is typechecked (it lives under
 * `__tests__`, which `tsconfig.json` compiles but `tsconfig.build.json`
 * excludes) so it cannot rot.
 *
 * ## How to run
 *
 * ```ts
 * import { structuredOutputComplianceEval } from
 *   "@agentick/eval-next/__tests__/structured-output-compliance.example";
 * // Swap the fake for a REAL adapter to measure real behavior:
 * const result = await structuredOutputComplianceEval({
 *   executor: anthropic({ model: "claude-..." }),      // your adapter
 *   target: { kind: "language-model", provider: "anthropic", modelId: "…",
 *             capabilities: { supportsTools: true } },
 * });
 * console.log(result.passed, result.assertions);
 * ```
 *
 * Run it N times against a real model and aggregate `passed` — that fraction
 * is the unforced-compliance number. The framework's forced wrap-up tick makes
 * the FORCED path a hard guarantee (`toolChoice: { tool }`); this eval measures
 * the NATURAL path the wrap-up backstops.
 *
 * ## What the eval observes — an honest caveat
 *
 * The terminal tool is DELIVERED, not DISPATCHED: it never enters the tool
 * executor's registry (§B2 constraint 1), so it does NOT appear in the eval's
 * dispatch ledger — `t.calledTool("submit_result")` cannot see it. The
 * compliance signals that DO work today:
 *
 *   - `t.completed()` — the structured turn reached a natural terminal stop.
 *   - the framework VALIDATED the delivered value into `SendResult.data`
 *     (a nonconforming answer rejects the send with `ResponseValidationError`),
 *     so a completed structured turn is a CONFORMING one.
 *   - `t.calledTool(<sibling>)` — the real tools the agent used en route.
 *
 * // TODO(b2a-eval-terminal-observability): to assert on the terminal call
 * // itself (`t.calledTool("submit_result")`), the eval ledger would need to
 * // also consume the loop's synthesized terminal `tool-dispatch` stream
 * // event — the dispatch-op ledger cannot see a tool that is never dispatched.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §B2
 */

import React from "react";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ExecutionTarget, LanguageModelExecutor } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { defineEval } from "../index.js";

// The agent: a `search` tool (a real, dispatched sibling) + a tree-level
// `<Output>` declaring the shape EVERY execution produces. The loop injects the
// synthetic `submit_result` terminal tool from that declaration.
const ComplianceAgent = (): React.ReactElement =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a research agent. Use `search`, then deliver the final answer " +
        "by calling the result tool with { title, summary }.",
    ),
    React.createElement("tool" as never, {
      id: "t.search",
      name: "search",
      description: "Search the corpus",
      inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
      exposure: ["model"],
      handlerRef: "handlers/search",
    }),
    React.createElement("output" as never, {
      id: "out.report",
      schema: jsonSchema({
        type: "object",
        required: ["title", "summary"],
        properties: { title: { type: "string" }, summary: { type: "string" } },
      }),
    }),
  );

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

// Default scripted executor — a natural, compliant run: search, then deliver
// the answer via the terminal tool (stopReason "end" = a clean completion).
function mkCompliantExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "b2a-compliance-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "tool_use", toolUseId: "s1", name: "search", input: { q: "topic" } }],
            stopReason: "tool_use",
            toolCalls: [{ id: "s1", name: "search", input: { q: "topic" } }],
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              {
                type: "tool_use",
                toolUseId: "r1",
                name: "submit_result",
                input: { title: "Findings", summary: "the corpus says X" },
              },
            ],
            stopReason: "end",
            toolCalls: [
              {
                id: "r1",
                name: "submit_result",
                input: { title: "Findings", summary: "the corpus says X" },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          },
        },
      ],
    },
  );
}

const searchHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
  ["handlers/search", async () => [{ type: "text", text: "result: X" }]],
]);

type Overrides = { executor?: LanguageModelExecutor; target?: ExecutionTarget };

const complianceApp = (overrides?: Overrides) =>
  createApp(React.createElement(ComplianceAgent), {
    modelExecutor: overrides?.executor ?? mkCompliantExecutor(),
    target: overrides?.target ?? target,
    toolHandlers: searchHandlers,
  });

export const structuredOutputComplianceEval = defineEval<Overrides>({
  description: "structured-output terminal-tool compliance (§B2)",
  app: complianceApp,
  async test(t) {
    await t.send("Research the topic and report your findings.");
    // The structured turn reached a natural terminal stop — and the framework
    // VALIDATED the delivered value into `data` (a nonconforming answer would
    // have rejected the send), so a completed run is a compliant one.
    t.completed();
    // The real sibling tool the agent used en route (the terminal tool itself
    // is delivered, not dispatched — see the caveat above).
    t.calledTool("search", { isError: false });
    t.noFailedActions();
  },
});
