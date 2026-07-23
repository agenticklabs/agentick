/**
 * `ctx.run` — the ad-hoc operation ladder rung (ADR 19/83), driven through a
 * REAL tool dispatch on the reference substrate. Proves the conformance
 * invariants the generic ctx-factory suite cannot:
 *
 *   - a `ctx.run(name, fn)` call mints a `tool:run:<name>` operation that
 *     appears in the journal/bus (requested → terminal succeeded);
 *   - its span/op PARENTS under the enclosing dispatch op (parentOpId link);
 *   - the `{ input }` form journals the input on the `requested` envelope;
 *   - a STRING-KEYED hook on the ambient harness observes it (guards/hooks
 *     reach ad-hoc names via the generic tier — the name isn't in CommandRegistry);
 *   - a GUARD can veto it (the verdict taxonomy applies to ad-hoc ops);
 *   - `ctx.runner` is a run-only view (no `makeEvent`/`publish`/lifecycle).
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type { DispatchInput, ProtocolEvent, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import type { CommandHooks } from "@agentick/runtime-next";

import { createTestHarness } from "../testing/index.js";
import type { TestHarnessBundle } from "../testing/index.js";

function reg(name = "runner-tool"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "calls ctx.run",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    toolCallId: "c_run",
    name: "runner-tool",
    input: {},
    context: { via: "dispatch", sessionId: "s1", executionId: "e1", tickId: "t1" },
    ...overrides,
  };
}

async function withBusCapture(
  bus: TestHarnessBundle["bus"],
  run: () => Promise<void>,
): Promise<ProtocolEvent[]> {
  const collected: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        collected.push(e);
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 5));
  await run();
  await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
  return collected;
}

describe("ctx.run — ad-hoc operation through real dispatch", () => {
  it("mints a journaled tool:run:<name> op, parented under the dispatch op, returning fn's value", async () => {
    let seen: number | undefined;
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.runner-tool",
          handler: async (_input, { ctx }) => {
            seen = await ctx.run("step", () => 42);
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      const r = await harness.dispatch(dispatchOf());
      expect(r.isError ?? false).toBe(false);
    });

    expect(seen).toBe(42);

    const runTerminal = events.find((e) => e.name === "tool:run:step" && e.phase === "terminal");
    expect(runTerminal).toBeDefined();
    expect(runTerminal!.outcome).toBe("succeeded");

    // Parents under the enclosing dispatch op (the ADR-77 FiberRef link).
    const dispatchOp = events.find((e) => e.name === "tool:command:dispatch");
    expect(dispatchOp).toBeDefined();
    expect(runTerminal!.parentOpId).toBe(dispatchOp!.opId);
  });

  it("journals the { input } form's input on the requested envelope", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.runner-tool",
          handler: async (_input, { ctx }) => {
            await ctx.run("charge", { input: { amount: 5 } }, () => "done");
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      await harness.dispatch(dispatchOf());
    });

    const requested = events.find((e) => e.name === "tool:run:charge" && e.phase === "requested");
    expect(requested).toBeDefined();
    expect(requested!.payload).toEqual({ amount: 5 });
  });

  it("is observed by a string-keyed hook on the ambient harness", async () => {
    let observed = false;
    const { harness } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.runner-tool",
          handler: async (_input, { ctx }) => {
            await ctx.run("step", () => 1);
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    // Ad-hoc names aren't in CommandRegistry — register via the string key the
    // op derives (`tool:run:step` → `onBeforeToolRunStep`), cast past the typed
    // surface. The hook self-scopes by `ctx.op === "ToolRunStep"`.
    harness.hook({
      onBeforeToolRunStep: () => {
        observed = true;
      },
    } as unknown as CommandHooks);

    await harness.dispatch(dispatchOf());
    expect(observed).toBe(true);
  });

  it("can be vetoed by a guard (verdict taxonomy applies to ad-hoc ops)", async () => {
    let rejected = false;
    const { harness } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.runner-tool",
          handler: async (_input, { ctx }) => {
            try {
              await ctx.run("step", () => 1);
            } catch {
              rejected = true;
            }
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    harness.guard((_input, opCtx) =>
      opCtx.op === "ToolRunStep" ? ({ kind: "veto", reason: "blocked" } as const) : undefined,
    );

    await harness.dispatch(dispatchOf());
    expect(rejected).toBe(true);
  });

  it("exposes ctx.runner as a run-only view (no makeEvent/publish/lifecycle)", async () => {
    let shape: { hasRun: boolean; hasMakeEvent: boolean; hasPublish: boolean } | undefined;
    const { harness } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.runner-tool",
          handler: async (_input, { ctx }) => {
            shape = {
              hasRun: typeof ctx.runner.runOperation === "function",
              hasMakeEvent: "makeEvent" in ctx.runner,
              hasPublish: "publish" in ctx.runner,
            };
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    await harness.dispatch(dispatchOf());
    expect(shape).toEqual({ hasRun: true, hasMakeEvent: false, hasPublish: false });
  });
});
