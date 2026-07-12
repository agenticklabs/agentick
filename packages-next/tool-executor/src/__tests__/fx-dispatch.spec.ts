/**
 * `ToolExecutorHarness.fx.dispatch` — the dual-typed edge on the tool
 * executor (ADR 77 Stage 2). The tool executor is the first spine harness
 * where `dispatch` IS a registry command — so `.fx` COULD be `fxProxy`-
 * derived (like knobs). But the public facade maps the dispatch door →
 * origin (`viaToOrigin(context.via)`), which a bare `fxProxy` (default
 * origin `"host"`) would drop. So the twin hand-authors over
 * `commandEffect`, preserving the door provenance.
 *
 * Proves:
 *   - `fx.dispatch(input)` is a composable Effect (un-run; nests in gen).
 *   - `dispatch(input)` is the derived Promise facade.
 *   - The twin PRESERVES the door → origin mapping (`via: "model"` →
 *     `origin: "model"` on the journaled envelope), NOT default `"host"`.
 */

import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { DispatchInput, ProtocolEvent, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import type { LocalEventBus } from "@agentick/runtime-next";

import { createTestHarness } from "../testing/index.js";

const echoReg = (): ToolRegistration => ({
  declaration: {
    id: "h.echo",
    name: "echo",
    description: "echo tool",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    exposure: ["model", "dispatch"],
    handlerRef: "h.echo",
  },
  handlerRef: "h.echo",
  binding: { scope: "runtime" },
});

const dispatchOf = (via: "model" | "dispatch", toolCallId: string): DispatchInput => ({
  name: "echo",
  toolCallId,
  input: {},
  context: { via },
});

async function makeHarness() {
  return createTestHarness({
    tools: [echoReg()],
    handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "ok" }] }],
  });
}

function collectTool(bus: LocalEventBus): { events: ProtocolEvent[]; stop: () => Promise<void> } {
  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({ surface: "tool" }), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );
  return { events, stop: async () => void (await Effect.runPromise(Fiber.interrupt(fiber))) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("ToolExecutorHarness — .fx.dispatch dual-typed edge", () => {
  it("fx.dispatch returns a composable Effect (not a Promise)", async () => {
    const { harness } = await makeHarness();
    const eff = harness.fx.dispatch(dispatchOf("dispatch", "tc1"));

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const result = await Effect.runPromise(eff);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("the plain dispatch() is the Promise facade", async () => {
    const { harness } = await makeHarness();
    const p = harness.dispatch(dispatchOf("dispatch", "tc2"));

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);

    const result = await p;
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("the twin PRESERVES the door → origin mapping (via 'model' → origin 'model')", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = collectTool(bus);

    // Composed via fx (Effect) with via: "model" — must stamp origin
    // "model", not fxProxy's default "host".
    await Effect.runPromise(harness.fx.dispatch(dispatchOf("model", "tc3")));
    await settle();
    await stop();

    const requested = events.find(
      (e) => e.name === "tool:command:dispatch" && e.phase === "requested",
    );
    expect(requested?.scope.origin).toBe("model");
  });

  it("fx.dispatch nests in one Effect.gen (single fiber tree)", async () => {
    const { harness } = await makeHarness();

    const [a, b] = await Effect.runPromise(
      Effect.gen(function* () {
        const r1 = yield* harness.fx.dispatch(dispatchOf("model", "tc4a"));
        const r2 = yield* harness.fx.dispatch(dispatchOf("dispatch", "tc4b"));
        return [r1, r2] as const;
      }),
    );

    expect(a.content).toEqual([{ type: "text", text: "ok" }]);
    expect(b.content).toEqual([{ type: "text", text: "ok" }]);
  });
});
