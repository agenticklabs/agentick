/**
 * Code-mode membrane injection — proven with the REAL `deriveContext` idiom.
 *
 * The `code:execute` op runs its program across a Promise membrane (the sandbox),
 * so the enclosing op's fiber context is NOT inherited on the far side. The house
 * pattern for exactly this crossing is `deriveContext(parent, facets, extras)`:
 * the parent trunk is carried EXPLICITLY (as data), and the boundary re-derives
 * its ctx from it. This proves that pattern threads the parent opId across the
 * membrane, that positional child keys derive from it, and that the child ops
 * replay on a re-run — no FiberRef, no ALS.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { EMPTY_CONTEXT } from "@agentick/spec";
import type {
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  RuntimeContext,
} from "@agentick/spec";

import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";
import { positionalOpId } from "../substrate/positional-op-id.js";
import { deriveTestContext } from "../testing/derive-test-context.js";

class DeriveProbe extends BaseHarness<"tool"> {
  readonly runs = new Map<string, number>();

  constructor() {
    super("tool", "derive-probe", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  }

  /** A child tool op run under an explicitly-supplied (positional) opId. */
  childOp(opId: string, produce: () => string): Promise<string> {
    const op: Operation<undefined, string> = {
      opId,
      surface: "tool",
      name: "tool:derive:child",
      scope: { sessionId: "s", executionId: "e", tickId: "t" },
      input: undefined,
    };
    return Effect.runPromise(
      this.runOperation(op, () =>
        Effect.sync(() => {
          this.runs.set(opId, (this.runs.get(opId) ?? 0) + 1);
          return produce();
        }),
      ),
    );
  }

  runsOf(opId: string): number {
    return this.runs.get(opId) ?? 0;
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

describe("deriveContext injection — the code-mode membrane, the house way", () => {
  it("carries the parent trunk across a Promise membrane via deriveContext, keys positionally, and replays", async () => {
    const h = new DeriveProbe();
    await h.ready;

    // The `code:execute` op's ctx — in-fiber this is `yield* getContext`. It carries
    // the execution's opId (the stable logical id the child keys derive from).
    const parentCtx: RuntimeContext = { ...EMPTY_CONTEXT, opId: "code:exec-42" };

    // One code execution: cross a Promise membrane (Promise-land, off-fiber) and,
    // on the FAR side, re-derive the dispatch ctx from the parent EXPLICITLY — the
    // `deriveContext` idiom the tool-dispatch crossing already uses.
    const runProgram = async (
      charge: () => string,
      email: () => string,
    ): Promise<readonly string[]> => {
      let index = 0;
      const dispatch = async (produce: () => string): Promise<string> => {
        const dispatchCtx = deriveTestContext(parentCtx, { surface: "tool" });
        expect(dispatchCtx.opId).toBe("code:exec-42"); // the parent trunk crossed the boundary as data
        const opId = positionalOpId(dispatchCtx.opId ?? "", index++); // positional from the parent opId
        return h.childOp(opId, produce);
      };
      return [await dispatch(charge), await dispatch(email)];
    };

    expect(
      await runProgram(
        () => "charged",
        () => "emailed",
      ),
    ).toEqual(["charged", "emailed"]);
    // Re-run the SAME execution — same parent opId, same call order → positional keys
    // line up → each child replays (sentinels never surface, side effects fire once):
    expect(
      await runProgram(
        () => "should-not-recharge",
        () => "should-not-resend",
      ),
    ).toEqual(["charged", "emailed"]);

    expect(h.runsOf(positionalOpId("code:exec-42", 0))).toBe(1);
    expect(h.runsOf(positionalOpId("code:exec-42", 1))).toBe(1);

    await h.close();
  });
});
