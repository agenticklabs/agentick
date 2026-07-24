/**
 * `GatesHarness` — the slim command surface over the ONE {@link GatesController}.
 *
 * These tests prove the harness is a thin front-end: every command delegates to
 * the SAME controller the harness owns (the ownership inversion, ADR 27), the
 * `gates:override` audit carries the caller's origin (`host` via the public
 * method, `wire` over the inbox), a missing gate rejects with a typed error, the
 * inbox address is the dynamic-lane shape `gates:<sessionId>:gates`, and the
 * four verbs enumerate as `exposure: "wire"`.
 *
 * The controller's own behavior (predicate evaluation, loop holds, the
 * verified-only rule) is covered by `controller.spec.ts` and stays untouched.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CommandInfo, TickResult } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { stubKnobsHarness } from "@agentick/knobs-next/testing";

import { gate } from "../descriptor.js";
import { GatesHarness } from "../harness.js";
import { spyLoopControl } from "../testing/index.js";
import type { GateOverrideAudit } from "../controller.js";

function tickResult(
  overrides: Partial<TickResult> & Pick<TickResult, "shouldContinue">,
): TickResult {
  return {
    executionId: "e1",
    sessionId: "s1",
    tickId: "t1",
    tickIndex: 0,
    executorTerminal: {
      kind: "complete",
      result: { kind: "language-model-result", ticks: [], usage: { totalTokens: 0 } },
    } as unknown as TickResult["executorTerminal"],
    toolResults: [],
    ...overrides,
  };
}

const wrote = (tool: string): Pick<TickResult, "toolResults"> => ({
  toolResults: [{ toolCallId: "c1", toolName: tool, succeeded: true, content: [], durationMs: 1 }],
});

async function makeHarness() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const knobs = stubKnobsHarness();
  const loop = spyLoopControl();
  const audits: GateOverrideAudit[] = [];
  const harness = new GatesHarness("s1:gates", journal, bus, inbox, {
    knobs,
    loopControl: loop,
    audit: (e) => audits.push(e),
  });
  await harness.ready;
  return { harness, knobs, loop, audits, inbox };
}

describe("GatesHarness", () => {
  it("exposes the dynamic-lane inbox address gates:<sessionId>:gates", async () => {
    const { harness } = await makeHarness();
    expect(harness.address).toBe("gates:s1:gates");
  });

  it("gates:clear delegates to the ONE owned controller", async () => {
    const { harness } = await makeHarness();
    harness.controller.register(
      "review",
      gate({
        description: "Await review",
        instructions: "Review before finishing.",
        activateWhen: (r) => r.toolResults.some((t) => t.toolName === "write_file"),
      }),
    );
    // Engage the latch through the controller's tick-end wiring.
    await harness.controller.handleTickEnd(
      tickResult({ shouldContinue: false, ...wrote("write_file") }),
    );
    expect(harness.controller.get("review")?.value).toBe("active");

    // The command releases the SAME controller's gate.
    await harness.clear({ name: "review" });
    expect(harness.controller.get("review")?.value).toBe("inactive");
  });

  it("gates:override audits the host escape with origin: host (public method)", async () => {
    const { harness, audits } = await makeHarness();
    harness.controller.register(
      "inv",
      gate({ description: "x", instructions: "x", satisfied: () => false }),
    );
    await harness.controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(harness.controller.get("inv")?.value).toBe("active");

    await harness.override({ name: "inv", value: "inactive", reason: "manual unblock" });

    expect(harness.controller.get("inv")?.value).toBe("inactive");
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "gate:override",
        name: "inv",
        value: "inactive",
        reason: "manual unblock",
        origin: "host",
      }),
    ]);
  });

  it("gates:override over the inbox stamps origin: wire on the audit", async () => {
    const { harness, audits, inbox } = await makeHarness();
    harness.controller.register(
      "inv",
      gate({ description: "x", instructions: "x", satisfied: () => false }),
    );
    await harness.controller.handleTickEnd(tickResult({ shouldContinue: true }));
    expect(harness.controller.get("inv")?.value).toBe("active");

    await Effect.runPromise(
      inbox.ask(harness.address, {
        type: "gates:override",
        origin: "wire",
        payload: { sessionId: "s1", name: "inv", value: "inactive", reason: "remote unblock" },
      }),
    );

    expect(harness.controller.get("inv")?.value).toBe("inactive");
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "gate:override",
        name: "inv",
        value: "inactive",
        reason: "remote unblock",
        origin: "wire",
      }),
    ]);
  });

  it("a verb naming a missing gate rejects with a typed error (errors over nulls)", async () => {
    const { harness } = await makeHarness();
    await expect(harness.clear({ name: "does-not-exist" })).rejects.toBeDefined();
  });

  it("enumerates the four wire verbs via gates:commands, all exposure: wire", async () => {
    const { harness, inbox } = await makeHarness();

    const reply = (await Effect.runPromise(
      inbox.ask(harness.address, { type: "gates:commands", origin: "wire" }),
    )) as readonly CommandInfo[];

    const byName = new Map(reply.map((c) => [c.name, c]));
    for (const name of ["gates:list", "gates:clear", "gates:defer", "gates:override"]) {
      expect(byName.get(name)?.exposure).toBe("wire");
    }
  });
});
