/**
 * Gateway telemetry (ADR 78) — MULTI-APP metrics safety. The recommended
 * multi-app pattern (Knowify's ernesto + ask shape): a gateway with ONE
 * `telemetry` setting, TWO hosted apps inheriting it. Both apps' metric export
 * shares the SAME OTel `MetricReader` instances — and a reader binds to exactly
 * ONE `MeterProvider` ("MetricReader can not be bound to a MeterProvider
 * again"). The @agentick/app wiring MATERIALIZES the `MeterProvider` once per reader
 * set and shares the `MetricSink`, so the second app does NOT re-bind and
 * crash. Both apps' `ctx.metrics` reach the sink, kept distinguishable by the
 * low-cardinality `app` ambient label.
 *
 * @verifiedBy this file
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 */

import { describe, expect, it } from "vitest";
import { createTelemetry } from "@agentick/app";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { spyTelemetrySink } from "@agentick/runtime/testing";
import { CompilerHarness } from "@agentick/compiler-react";

import { createGateway } from "../index.js";

const NULL_ROOT = null as unknown;

const emitTool: ToolDeclaration = {
  id: "t.emit",
  name: "emit",
  description: "emit a metric",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.emit",
};

/** A hosted app that dispatches `emit` (tick 1) then finalizes (tick 2). */
function mkAppOptions(appName: string) {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  const modelExecutor = new FakeLanguageModelExecutor(
    `exec-${appName}`,
    sub.journal,
    sub.bus,
    sub.inbox,
    {
      scripted: [
        {
          result: {
            specVersion: SPEC_VERSION,
            output: [
              { type: "tool_use", toolUseId: `tc-${appName}`, name: "emit", input: {} },
            ] as ContentBlock[],
            stopReason: "tool_use",
            toolCalls: [{ id: `tc-${appName}`, name: "emit", input: {} }],
          },
        },
        {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  return {
    name: appName,
    modelExecutor,
    target: {
      kind: "language-model" as const,
      provider: "mock",
      modelId: "mock-v1",
      capabilities: { supportsTools: true, supportsStreaming: true },
    },
    compiler: new CompilerHarness(`r-${appName}`, sub.journal, sub.bus, sub.inbox),
    toolHandlers: new Map([
      [
        "h.emit",
        async (
          _input: unknown,
          { ctx }: { ctx: { metrics: { count: (n: string, v: number) => void } } },
        ) => {
          ctx.metrics.count("emitted", 1);
          return [{ type: "text", text: "ok" }] as ContentBlock[];
        },
      ],
    ]),
  };
}

describe("Gateway telemetry (ADR 78) — two apps share one MeterProvider without crashing", () => {
  it("both hosted apps' ctx.metrics reach the inherited sink, distinguished by the app label", async () => {
    const spy = spyTelemetrySink();
    const gateway = await createGateway({
      telemetry: createTelemetry({ serviceName: "fleet" }, spy),
      tools: [emitTool],
    });
    await gateway.listen();

    // Two apps inherit the gateway's telemetry setting (same reader instances).
    // The SECOND createApp would crash on a re-bind without the shared-meter fix.
    const a = await gateway.createApp({
      appId: "a",
      rootElement: NULL_ROOT,
      options: mkAppOptions("ernesto"),
    });
    const b = await gateway.createApp({
      appId: "b",
      rootElement: NULL_ROOT,
      options: mkAppOptions("ask"),
    });

    const sA = await a.createSession();
    const sB = await b.createSession();
    await (
      await sA.send({ messages: [{ role: "user", content: "go" }] })
    ).result;
    await (
      await sB.send({ messages: [{ role: "user", content: "go" }] })
    ).result;

    const metrics = await spy.collectMetrics();
    const emitted = metrics.filter((m) => m.name === "agentick.emitted");
    const apps = new Set(emitted.map((m) => m.labels.app));
    expect(apps).toEqual(new Set(["ernesto", "ask"]));

    await gateway.close();
  });
});
