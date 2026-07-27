/**
 * ADR 93 — the declarative `guard({ bag })` form's CONTEXTUAL TYPING.
 *
 * The adopter-facing claim: an inline guard bag types WITHOUT `as const`. Each
 * verdict literal (`kind: "veto"`, `"replace"`, `"defer"`, `"proceed"`) must be
 * contextually typed by `HandlerVerdict`'s discriminated union — a widened
 * `kind: string` (what a NON-contextual position infers) does not satisfy it,
 * and the `as const` an adopter then reaches for is friction the bag exists to
 * remove.
 *
 * Regression pinned: while `guard` was two OVERLOADS (decider first, bag
 * second), a bag whose deciders take no parameters was checked against the
 * decider overload first; such an arrow is not context-sensitive, so TypeScript
 * widened and cached its return as `{ kind: string }` and the bag overload then
 * rejected it (`TS2769: No overload matches this call`). The two forms are now
 * ONE signature over a union, which hands the object literal its contextual type
 * from the `CommandGuards` arm.
 *
 * These assertions live in the TYPES; the runtime bodies exist so vitest also
 * proves each verdict reaches its terminal. A regression fails `tsc`, not
 * vitest — vitest strips types.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { HandlerError } from "@agentick/spec";
import type { MessageEnvelope, MessageHandlerError } from "@agentick/spec";

import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

interface GateInput {
  readonly locked: boolean;
}
type GateOutput = string;

declare module "../substrate/base-harness.js" {
  interface CommandRegistry {
    "tool:admit": { input: GateInput; output: GateOutput };
  }
}

class GuardBagHarness extends BaseHarness<"tool"> {
  readonly admit: (input: GateInput) => Promise<GateOutput>;

  constructor(id: string) {
    super("tool", id, new MemoryJournal(), new LocalEventBus(), new LocalInbox(), {});
    this.admit = this.command<GateInput, GateOutput, never>({
      name: "tool:admit",
      handler: () => Effect.succeed("admitted"),
    });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

describe("ADR 93 — guard bag contextual typing", () => {
  it("an inline bag of verdict literals compiles with NO `as const`", async () => {
    const h = new GuardBagHarness("gb_1");
    await h.ready;

    // The load-bearing assertion is that this compiles. `input` must be
    // narrowed to `GateInput` (the command's input), and each verdict literal
    // must contextually type against `HandlerVerdict<GateOutput>`.
    const off = h.guard({
      toolAdmit: (input, ctx) => {
        expect(ctx).toBeDefined();
        return input.locked ? { kind: "veto", reason: "locked" } : undefined;
      },
    });

    await expect(h.admit({ locked: true })).rejects.toThrow("operation outcome: vetoed");
    off();
    await expect(h.admit({ locked: true })).resolves.toBe("admitted");
  });

  it("every verdict arm types inline — veto / replace / defer / proceed", async () => {
    const h = new GuardBagHarness("gb_2");
    await h.ready;

    // `replace` carries the command's OUTPUT type — a wrong `result` type must
    // still be an error, which is what makes the contextual typing meaningful.
    const offReplace = h.guard({
      toolAdmit: () => ({ kind: "replace", result: "substituted" }),
    });
    await expect(h.admit({ locked: false })).resolves.toBe("substituted");
    offReplace();

    const offDefer = h.guard({ toolAdmit: () => ({ kind: "defer", retryAfter: 5 }) });
    await expect(h.admit({ locked: false })).rejects.toThrow("operation outcome: deferred");
    offDefer();

    const offProceed = h.guard({ toolAdmit: () => ({ kind: "proceed" }) });
    await expect(h.admit({ locked: false })).resolves.toBe("admitted");
    offProceed();
  });

  it("an async decider types inline too", async () => {
    const h = new GuardBagHarness("gb_3");
    await h.ready;

    const off = h.guard({
      toolAdmit: async (input) =>
        input.locked ? { kind: "veto", reason: "locked (async)" } : undefined,
    });
    await expect(h.admit({ locked: true })).rejects.toThrow("operation outcome: vetoed");
    off();
  });

  it("a bare decider still resolves to the union's DECIDER arm", async () => {
    const h = new GuardBagHarness("gb_4");
    await h.ready;

    const off = h.guard<GateInput, GateOutput>((input) =>
      input.locked ? { kind: "veto", reason: "locked" } : undefined,
    );
    await expect(h.admit({ locked: true })).rejects.toThrow("operation outcome: vetoed");
    off();
    await expect(h.admit({ locked: false })).resolves.toBe("admitted");
  });

  it("a WRONG replace-result type is still rejected (the bag is typed, not `any`)", async () => {
    const h = new GuardBagHarness("gb_5");
    await h.ready;

    const off = h.guard({
      // @ts-expect-error — `result` must be `GateOutput` (string), not a number.
      toolAdmit: () => ({ kind: "replace", result: 42 }),
    });
    off();
    expect(true).toBe(true);
  });

  it("an unknown command key is rejected", async () => {
    const h = new GuardBagHarness("gb_6");
    await h.ready;

    const off = h.guard({
      // @ts-expect-error — `nopeNotACommand` is not a declared command.
      nopeNotACommand: () => ({ kind: "veto" }),
    });
    off();
    expect(true).toBe(true);
  });
});
