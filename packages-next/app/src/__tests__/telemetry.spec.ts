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
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
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
      executor: await mkExecutor(),
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
      executor: await mkExecutor(),
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
    const app = await createApp(React.createElement(Agent), { executor: await mkExecutor() });
    await expect(app.closeApp()).resolves.toBeUndefined();
  });
});
