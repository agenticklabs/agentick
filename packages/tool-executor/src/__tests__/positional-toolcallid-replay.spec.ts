/**
 * Positional `toolCallId` → replay — the one-spot fix for durable code mode.
 *
 * A tool dispatch is already a journaled op with a deterministic opId
 * (`tool:dispatch:${toolCallId}`), so a repeat dispatch of the SAME toolCallId
 * replays the cached terminal instead of re-running the handler. The ONLY reason
 * a code-driven (host-initiated) call doesn't replay today is its toolCallId is
 * random — `host:${generateId()}` at `define-tool-executor.ts:483`. This proves
 * both halves in isolation: a STABLE (positional) key replays; a random key
 * re-executes. Make that one site positional and code-mode tool calls become
 * replay-safe through machinery that already exists — no loop/session change.
 *
 * The `sideEffects` counter is the witness: a replayed dispatch never runs the
 * handler, so it never advances.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { DispatchInput } from "@agentick/spec";

import { defineToolExecutor } from "../define-tool-executor.js";

function build() {
  const state = { sideEffects: 0 };
  const factory = defineToolExecutor({
    dispatch: async (input) => {
      state.sideEffects += 1;
      return {
        toolCallId: input.toolCallId,
        name: input.name,
        content: [{ type: "text" as const, text: `charged#${state.sideEffects}` }],
      };
    },
  });
  const exec = factory({
    scopeId: "positional-replay",
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  });
  return { exec, state };
}

function call(toolCallId: string): DispatchInput {
  return { toolCallId, name: "charge", input: {}, context: { via: "dispatch" } };
}

describe("positional toolCallId → replay (the one-spot code-mode fix)", () => {
  it("a STABLE (positional) toolCallId replays — the handler fires ONCE across re-dispatch", async () => {
    const { exec, state } = build();

    const first = await exec.dispatch(call("code:exec-0:tool:0"));
    const second = await exec.dispatch(call("code:exec-0:tool:0")); // same positional key

    expect(state.sideEffects).toBe(1); // handler fired once — second dispatch replayed
    expect(second.content).toEqual(first.content); // cached terminal returned, not a re-run
  });

  it("a RANDOM host toolCallId (today's `host:${generateId()}`) re-executes — the side effect fires TWICE", async () => {
    const { exec, state } = build();

    await exec.dispatch(call(`host:${generateId()}`));
    await exec.dispatch(call(`host:${generateId()}`)); // fresh random each time

    expect(state.sideEffects).toBe(2); // no replay — the current gap the positional key closes
  });
});
