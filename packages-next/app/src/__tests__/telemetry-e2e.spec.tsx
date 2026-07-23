/**
 * Telemetry end-to-end (ADR 64/78) — proves the FULL export path: a
 * `createApp({ telemetry })` switch built from `createTelemetry(..., spyTelemetrySink())`
 * threads a provider all the way down to `ctx.trace` / `ctx.metrics` in a real
 * tool handler, and the emissions land on the standard-OTel edge (the spy's
 * SpanProcessor + MetricReader) — closing the facet slice's flagged threading
 * gap. The spy records at the OTel edge, so a passing assertion also proves the
 * Effect → `@effect/opentelemetry` → OTel bridge.
 *
 * @verifiedBy this file
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { spyTelemetrySink } from "@agentick/runtime-next/testing";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock } from "@agentick/spec-next";

import { createApp } from "../react.js";
import { createTelemetry } from "../telemetry-wiring.js";

function ToolAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "helpful"),
    React.createElement("tool" as never, {
      id: "t.search",
      name: "search",
      description: "Search the knowledge base",
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string" } },
      },
      exposure: ["model"],
      handlerRef: "handlers/search",
    }),
    React.createElement("message" as never, { role: "user" }, "find things"),
  );
}

/** Executor scripted with a tool call (tick 1) then a final answer (tick 2). */
async function mkToolExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "tel-e2e-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              { type: "tool_use", toolUseId: "tc-1", name: "search", input: { q: "hi" } },
            ] as ContentBlock[],
            stopReason: "tool_use",
            toolCalls: [{ id: "tc-1", name: "search", input: { q: "hi" } }],
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

// A handler that exercises BOTH observability verbs against the live ctx.
const toolHandlers = new Map<
  string,
  (
    input: unknown,
    deps: { ctx: import("@agentick/tool-executor-next").ToolHandlerCtx },
  ) => Promise<ContentBlock[]>
>([
  [
    "handlers/search",
    async (_input, { ctx }) => {
      ctx.metrics.count("search.requests", 1);
      await ctx.trace("retrieval", (span) => {
        span.setAttribute("result.count", 3);
      });
      return [{ type: "text", text: "done" }];
    },
  ],
]);

describe("Telemetry end-to-end — ctx.trace / ctx.metrics reach the sink", () => {
  it("a tool handler's ctx.trace span nests under the dispatch, and ctx.metrics carries {tool, op}", async () => {
    const spy = spyTelemetrySink();

    const app = await createApp(React.createElement(ToolAgent), {
      name: "e2e-app",
      modelExecutor: await mkToolExecutor(),
      target: {
        kind: "language-model" as const,
        provider: "mock",
        modelId: "mock-v1",
        capabilities: { supportsTools: true, supportsStreaming: true },
      },
      toolHandlers,
      telemetry: createTelemetry({ serviceName: "e2e" }, spy),
    });

    const session = await app.createSession({ sessionId: "e2e" });
    const handle = await session.send({ messages: [{ role: "user", content: "find things" }] });
    await handle.result;

    // SPAN: the handler's `ctx.trace("retrieval")` child span nests under the
    // tool dispatch op span (ADR-77 parenting), recorded at the OTel edge.
    const retrieval = spy.spans.find((s) => s.name === "retrieval");
    expect(retrieval).toBeDefined();
    expect(retrieval!.parent).toBe("tool:command:dispatch");
    expect(retrieval!.attributes.get("result.count")).toBe(3);

    // METRIC: `ctx.metrics.count` namespaced + carrying the low-cardinality
    // ambient default labels {tool, op}. Exported through the MeterProvider to
    // the spy's MetricReader.
    const metrics = await spy.collectMetrics();
    const search = metrics.find((m) => m.name === "agentick.search.requests");
    expect(search).toBeDefined();
    expect(search!.labels).toMatchObject({ tool: "search", op: "ToolDispatch" });

    await session.close();
    await app.closeApp();
  });
});
