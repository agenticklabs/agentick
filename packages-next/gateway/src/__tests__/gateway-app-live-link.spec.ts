/**
 * ADR 84 §3 — the CAPSTONE: gateway → app live interceptor link.
 *
 * `gateway.createApp` threads `interceptorParent: gateway` into the app, which
 * (via `AppHarnessOptions.interceptorParent` → `BaseHarness`) registers the app
 * as a LIVE interceptor child of the gateway. The app already threads the same
 * live edge to its sessions and their per-session sub-harnesses (ADR 83 §4). So
 * a hook registered on the GATEWAY — AFTER a session already exists — must fold
 * down the whole chain gateway → app → session → tool-executor and fire around
 * that session's real `tool:dispatch`.
 *
 * This is the whole point of the arc: it proves the FULL live chain end-to-end
 * against the REAL GatewayHarness + a real app + a real session + the real
 * per-session tool-executor (no stubs), exercising the LATE case a frozen
 * construction-fold could never satisfy — the session and its subs were built
 * with NOTHING registered on the gateway.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md
 * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md §4
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolDeclaration, ToolHandler } from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";

import { createGateway } from "../index.js";

const NULL_ROOT = null as unknown;
const ECHO_REF = "h.echo";

/** A dispatch-exposed tool whose handler echoes back the `value` it received. */
function echoTool(): ToolDeclaration {
  return {
    id: "t.echo",
    name: "echo",
    description: "echoes its input.value",
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model", "dispatch"],
    handlerRef: ECHO_REF,
  };
}

/** Records + echoes the arguments the handler was actually invoked with. */
function makeEchoHandler(seen: { value?: unknown }): ToolHandler {
  return async (input) => {
    const value = (input as { value?: unknown }).value;
    seen.value = value;
    return [{ type: "text", text: String(value) } satisfies ContentBlock];
  };
}

function mkAppOptions(seen: { value?: unknown }) {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    executor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    reconciler: new ReconcilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
    tools: [echoTool()],
    toolHandlers: new Map<string, ToolHandler>([[ECHO_REF, makeEchoHandler(seen)]]),
  };
}

describe("ADR 84 §3 — gateway → app live interceptor link (CAPSTONE)", () => {
  it("gateway.hook registered AFTER the session exists reaches the per-session tool-executor", async () => {
    const seen: { value?: unknown } = {};
    const gateway = await createGateway();
    await gateway.listen();

    // App + session constructed with NOTHING registered on the gateway yet —
    // a frozen construction-fold would have snapshotted an empty layer here.
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions(seen) });
    const session = await app.createSession();

    // LATE registration on the GATEWAY, after the whole subtree exists.
    gateway.hook({
      onBeforeToolDispatch: (input) => ({
        ...input,
        input: { ...(input.input as Record<string, unknown>), value: "reshaped-by-gateway" },
      }),
    });

    // Dispatch on the per-session tool-executor: the late gateway.hook folded
    // down gateway → app → session → tool-executor and fired around the REAL
    // `tool:dispatch` body — both the handler AND the surfaced content reflect
    // the reshaped input.
    const result = await session.dispatch("echo", { value: "original" });
    expect(seen.value).toBe("reshaped-by-gateway");
    expect((result[0] as { text: string }).text).toBe("reshaped-by-gateway");

    await gateway.close();
  });

  it("gateway.hook unsubscribe cascades — after removal the dispatch sees raw input", async () => {
    const seen: { value?: unknown } = {};
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions(seen) });
    const session = await app.createSession();

    const off = gateway.hook({
      onBeforeToolDispatch: (input) => ({
        ...input,
        input: { ...(input.input as Record<string, unknown>), value: "reshaped-by-gateway" },
      }),
    });
    off();

    const result = await session.dispatch("echo", { value: "verbatim" });
    expect(seen.value).toBe("verbatim");
    expect((result[0] as { text: string }).text).toBe("verbatim");

    await gateway.close();
  });
});
