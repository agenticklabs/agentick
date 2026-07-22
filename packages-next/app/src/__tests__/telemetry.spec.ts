/**
 * Telemetry (ADR 78, brick #1) — proves that an app-supplied `telemetry`
 * Layer's tracer actually RECEIVES the substrate's `Effect.withSpan` spans:
 * the app builds a `ManagedRuntime` from the Layer ONCE and runs app-edge
 * operations on it, so the tracer is active and spans export with their
 * `agentick.*` attributes. Also pins that the runtime is disposed on close.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Layer, Tracer } from "effect";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock } from "@agentick/spec-next";

const Agent = () => React.createElement("message", { role: "user" }, "hi");

async function mkExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "tel-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

/** An Effect tracer that records every span it opens. */
function collectingTracer() {
  const spans: Array<{ name: string; attributes: Map<string, unknown> }> = [];
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind) => {
      const attributes = new Map<string, unknown>();
      spans.push({ name, attributes });
      return {
        _tag: "Span",
        spanId: `s${spans.length}`,
        traceId: "t",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        kind,
        sampled: true,
        end() {},
        attribute(key: string, value: unknown) {
          attributes.set(key, value);
        },
        event() {},
        addLinks() {},
      } as unknown as Tracer.Span;
    },
    context: (f) => f(),
  });
  const layer = Layer.mergeAll(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  return { layer: layer as Layer.Layer<never, never, never>, spans };
}

describe("App telemetry (ADR 78) — spans reach the supplied tracer", () => {
  it("an app-edge operation's Effect.withSpan lands on the telemetry Layer's tracer, with agentick.* attributes", async () => {
    const { layer, spans } = collectingTracer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      telemetry: layer,
    });

    // `closeApp` runs the `app:command:close-app` operation on the telemetry
    // runtime — its withSpan must reach our collector.
    await app.closeApp();

    const closeSpan = spans.find((s) => s.name === "app:command:close-app");
    expect(closeSpan).toBeDefined();
    expect(closeSpan!.attributes.get("agentick.surface")).toBe("app");
    expect(closeSpan!.attributes.get("agentick.op_id")).toMatch(/^app:close-app:/);
  });

  it("telemetryNamespace whitelabels the attribute prefix (agentick → acme)", async () => {
    const { layer, spans } = collectingTracer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      telemetry: layer,
      telemetryNamespace: "acme",
    });
    await app.closeApp();

    const closeSpan = spans.find((s) => s.name === "app:command:close-app");
    expect(closeSpan!.attributes.get("acme.surface")).toBe("app");
    expect(closeSpan!.attributes.get("acme.op_id")).toMatch(/^app:close-app:/);
    // The framework name does not leak when whitelabelled.
    expect(closeSpan!.attributes.has("agentick.surface")).toBe(false);
  });

  it("no telemetry Layer → no crash, no runtime (behavior-preserving)", async () => {
    const app = await createApp(React.createElement(Agent), { modelExecutor: await mkExecutor() });
    await expect(app.closeApp()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Telemetry rung 1 — the `createApp({ telemetry })` enrichment switch.
// ---------------------------------------------------------------------------

function ToolAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "helpful"),
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
    React.createElement("message" as never, { role: "user" }, "47 * 23"),
  );
}

/** Executor scripted with a tool call (tick 1) then a final answer (tick 2). */
async function mkToolExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "tel-tool-exec",
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
                input: { expression: "47*23" },
              },
            ] as ContentBlock[],
            stopReason: "tool_use",
            toolCalls: [{ id: "tc-1", name: "calculator", input: { expression: "47*23" } }],
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "1081" } satisfies ContentBlock],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

const pricedTarget = {
  kind: "language-model" as const,
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
  // Self-described pricing so `estimateCost` resolves (mock-v1 isn't in SEED).
  pricing: { inputPerMTok: 1, outputPerMTok: 2 },
};

const toolHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
  ["handlers/calculator", async () => [{ type: "text", text: "1081" }]],
]);

describe("App telemetry rung 1 — the enrichment switch", () => {
  it("switch ON stamps model / tool / tick attrs + usage + cost + app identity", async () => {
    const { layer, spans } = collectingTracer();
    const app = await createApp(React.createElement(ToolAgent), {
      name: "test-app",
      modelExecutor: await mkToolExecutor(),
      target: pricedTarget,
      toolHandlers,
      telemetry: { layer, serviceName: "svc", attributes: { "deploy.region": "us-east" } },
    });
    const session = await app.createSession({ sessionId: "rung1" });
    const handle = await session.send({ messages: [{ role: "user", content: "47*23" }] });
    await handle.result;

    // Model-generate span: GenAI semconv model + usage (verbatim), framework
    // cost (`agentick.*`), and the finish reason.
    const gen = spans.find(
      (s) => s.name === "model:command:generate_stream" || s.name === "model:command:generate",
    );
    expect(gen).toBeDefined();
    expect(gen!.attributes.get("gen_ai.request.model")).toBe("mock-v1");
    expect(gen!.attributes.get("gen_ai.system")).toBe("mock");
    expect(gen!.attributes.get("gen_ai.usage.input_tokens")).toBe(8);
    expect(gen!.attributes.get("gen_ai.usage.output_tokens")).toBe(4);
    expect(gen!.attributes.get("gen_ai.response.finish_reason")).toBe("tool_use");
    // cost = 8/1e6*1 + 4/1e6*2 = 1.6e-5
    expect(gen!.attributes.get("agentick.usage.cost_usd")).toBeCloseTo(1.6e-5, 10);
    // App identity (framework namespace) + functionId default + service.name.
    expect(gen!.attributes.get("agentick.app.name")).toBe("test-app");
    expect(gen!.attributes.get("agentick.function.id")).toBe("test-app");
    expect(gen!.attributes.get("service.name")).toBe("svc");
    expect(gen!.attributes.get("deploy.region")).toBe("us-east"); // adopter key, verbatim

    // Tool-dispatch span carries the tool name.
    const dispatch = spans.find((s) => s.name === "tool:command:dispatch");
    expect(dispatch).toBeDefined();
    expect(dispatch!.attributes.get("agentick.tool.name")).toBe("calculator");

    // Tick span carries the 1-based index.
    const tick = spans.find((s) => s.name === "loop:command:tick");
    expect(tick).toBeDefined();
    expect(tick!.attributes.get("agentick.tick.index")).toBe(1);

    await session.close();
    await app.closeApp();
  });

  it("per-call telemetry.functionId (rung 2) OVERRIDES the app-name default", async () => {
    const { layer, spans } = collectingTracer();
    const app = await createApp(React.createElement(ToolAgent), {
      name: "test-app",
      modelExecutor: await mkToolExecutor(),
      target: pricedTarget,
      toolHandlers,
      telemetry: { layer },
    });
    const session = await app.createSession({ sessionId: "rung2" });
    const handle = await session.send({
      messages: [{ role: "user", content: "47*23" }],
      telemetry: { functionId: "custom-fn", metadata: { requestId: "r-9" } },
    });
    await handle.result;

    const gen = spans.find(
      (s) => s.name === "model:command:generate_stream" || s.name === "model:command:generate",
    );
    expect(gen).toBeDefined();
    // Rung 2 composes innermost → its functionId WINS over rung-1's app-name.
    expect(gen!.attributes.get("agentick.function.id")).toBe("custom-fn");
    expect(gen!.attributes.get("agentick.metadata.requestId")).toBe("r-9");

    await session.close();
    await app.closeApp();
  });

  it("switch OFF → ZERO enrichment interceptors registered (zero overhead)", async () => {
    const off = await createApp(React.createElement(ToolAgent), {
      modelExecutor: await mkToolExecutor(),
      target: pricedTarget,
      toolHandlers,
      // no telemetry
    });
    const on = await createApp(React.createElement(ToolAgent), {
      modelExecutor: await mkToolExecutor(),
      target: pricedTarget,
      toolHandlers,
      telemetry: true,
    });
    // White-box: the switch builds NO interceptors when off, some when on.
    const list = (a: unknown) =>
      (a as { telemetryMiddleware: readonly unknown[] }).telemetryMiddleware;
    expect(list(off)).toHaveLength(0);
    expect(list(on).length).toBeGreaterThan(0);

    await off.closeApp();
    await on.closeApp();
  });
});
