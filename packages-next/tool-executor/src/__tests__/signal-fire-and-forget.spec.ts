/**
 * Signal fire-and-forget under emit failure (ADR 64) — a failed signal
 * projection MUST never block or fail the tool handler.
 *
 * We inject a bus whose `append` DIES for any `*:signal:*` event (and
 * whose `hasSubscriberFor` returns true for signal keys, so the
 * subscriber-probe short-circuit doesn't hide the append). A tool
 * handler calls `ctx.log(...)` / `ctx.progress(...)` and then returns
 * content. The dispatch must STILL succeed with the handler's return
 * value intact — the emit is launched via `Effect.runFork` (detached),
 * so its defect can't propagate into the dispatch command path.
 *
 * Non-signal envelopes (the dispatch's own requested/before/terminal
 * lifecycle) pass straight through to a real inner bus, so this isolates
 * the SIGNAL emit failure from the operation's own journaling path.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { DispatchInput, EventKey, ProtocolEvent, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";

import { InMemoryHandlerResolver } from "../handler-resolver.js";
import { ToolExecutorHarness } from "../harness.js";

/**
 * A bus that fails every `*:signal:*` append (models a dead/failing
 * projection sink) but delegates everything else to a real inner bus.
 * `hasSubscriberFor` reports `true` for signal keys so `emitSignal`
 * reaches `append` instead of the cheap no-listener no-op.
 */
class SignalHostileBus extends LocalEventBus {
  signalAppendAttempts = 0;

  override append(event: ProtocolEvent): Effect.Effect<void, never, never> {
    if (event.name.includes(":signal:")) {
      this.signalAppendAttempts++;
      return Effect.die(new Error("injected: signal projection append failed"));
    }
    return super.append(event);
  }

  override hasSubscriberFor(key: EventKey): boolean {
    if (key.name.includes(":signal:")) return true;
    return super.hasSubscriberFor(key);
  }
}

function reg(name = "signaller"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "logs + reports progress, then returns content",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(): DispatchInput {
  return {
    toolCallId: "c_signaller",
    name: "signaller",
    input: {},
    context: { via: "dispatch", sessionId: "s1", executionId: "e1", tickId: "t1" },
  };
}

describe("ctx.log / ctx.progress fire-and-forget under emit failure (ADR 64)", () => {
  it("dispatch STILL succeeds with content intact when the signal bus append dies", async () => {
    const journal = new MemoryJournal();
    const bus = new SignalHostileBus();
    const inbox = new LocalInbox();
    const resolver = new InMemoryHandlerResolver();
    resolver.register("h.signaller", async (_input, { ctx }) => {
      // Both emits target a bus whose append dies for signals.
      ctx.log("error", { boom: true }, "doomed-logger");
      ctx.progress("job-x", { progress: 1, total: 1, message: "still fine" });
      return [{ type: "text", text: "handler-return-intact" }];
    });

    const elicitation = new ElicitationHarness("t:elicitation", journal, bus, inbox);
    const harness = new ToolExecutorHarness("t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
      initialTools: [reg()],
    });
    await harness.ready;
    await elicitation.ready;

    const result = await harness.dispatch(dispatchOf());

    // The failed signal emit was swallowed — the handler's return value
    // survived intact and the dispatch reports success.
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "handler-return-intact" }]);

    // Both signal appends were actually attempted (probe passed, append
    // reached) — proving the swallow is real, not a no-listener skip.
    // Give the forked emit fibers a beat to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.signalAppendAttempts).toBe(2);

    await harness.close();
    await elicitation.close();
  });
});
