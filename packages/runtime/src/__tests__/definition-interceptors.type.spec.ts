/**
 * ADR 96 — the NAMING LAW, at the type level.
 *
 * A local definition bag names its own verbs SHORT (`onBeforeStamp`,
 * `guards: { stamp }`); the registry-wide imperative registrars name the
 * DISCRIMINATED command (`hooks.onBeforeToolStamp`, `guard({ toolStamp })`).
 * The two derive from one registry, so the compiler is the enforcement — a
 * regression fails `tsc`, not vitest (vitest strips types).
 *
 * The bodies exist so the file is a runnable spec; the assertions are the
 * `@ts-expect-error`s and the shapes that must compile.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { HandlerError } from "@agentick/spec";
import type { MessageEnvelope, MessageHandlerError } from "@agentick/spec";

import { BaseHarness, type BaseHarnessOptions } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

interface MarkInput {
  readonly tag: string;
}
type MarkOutput = number;

declare module "../substrate/base-harness.js" {
  interface CommandRegistry {
    "tool:mark": { input: MarkInput; output: MarkOutput };
  }
}

class MarkHarness extends BaseHarness<"tool"> {
  readonly mark: (input: MarkInput) => Promise<MarkOutput>;

  constructor(scopeId: string, options: BaseHarnessOptions<unknown, "tool"> = {}) {
    super("tool", scopeId, new MemoryJournal(), new LocalEventBus(), new LocalInbox(), options);
    this.mark = this.command<MarkInput, MarkOutput, never>({
      name: "tool:mark",
      handler: (i) => Effect.succeed(i.tag.length),
    });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

describe("ADR 96 — the drop-layer bag is exactly this namespace's verbs", () => {
  it("the short hook key types, with the command's input/output inferred", async () => {
    const h = new MarkHarness("t1", {
      hooks: {
        onBeforeMark: (input) => ({ tag: input.tag.trim() }),
        onAfterMark: (output) => output + 1,
      },
    });
    await h.ready;
    await expect(h.mark({ tag: " ab " })).resolves.toBe(3);
  });

  it("the short guard key types, with verdict literals narrowing without `as const`", async () => {
    const h = new MarkHarness("t2", {
      guards: {
        mark: (input) => (input.tag === "" ? { kind: "veto", reason: "empty" } : undefined),
      },
    });
    await h.ready;
    await expect(h.mark({ tag: "" })).rejects.toThrow("operation outcome: vetoed");
  });

  it("the DISCRIMINATED key is not a drop-layer key", () => {
    const options: BaseHarnessOptions<unknown, "tool"> = {
      hooks: {
        // @ts-expect-error — `onBeforeToolMark` is the registry-wide name; the
        // definition bag drops the namespace segment.
        onBeforeToolMark: (input: MarkInput) => input,
      },
      guards: {
        // @ts-expect-error — `toolMark` is the registry-wide name.
        toolMark: () => undefined,
      },
    };
    expect(options).toBeDefined();
  });

  it("a verb this namespace does not own is rejected", () => {
    const options: BaseHarnessOptions<unknown, "tool"> = {
      // @ts-expect-error — `onBeforeAppend` belongs to the timeline namespace.
      hooks: { onBeforeAppend: () => undefined },
    };
    expect(options).toBeDefined();
  });

  it("a wrong replace-result type is still rejected (the bag is typed, not `any`)", () => {
    const options: BaseHarnessOptions<unknown, "tool"> = {
      // @ts-expect-error — `result` must be `MarkOutput` (number).
      guards: { mark: () => ({ kind: "replace", result: "not-a-number" }) },
    };
    expect(options).toBeDefined();
  });
});

describe("ADR 96 — the registry-wide registrars keep the discriminated name", () => {
  it("hooks.onBefore<Command> and guard({ <command> }) type", async () => {
    const h = new MarkHarness("t3");
    await h.ready;
    const offHook = h.hooks.onBeforeToolMark((input) => ({ tag: `${input.tag}!` }));
    // Guards float OUTERMOST, so this decider sees the ORIGINAL input — the
    // transform has not run yet. Deny-before-transform, at the type level too.
    const offGuard = h.guard({
      toolMark: (input) => (input.tag === "x" ? { kind: "veto" } : undefined),
    });
    await expect(h.mark({ tag: "x" })).rejects.toThrow("operation outcome: vetoed");
    offGuard();
    await expect(h.mark({ tag: "x" })).resolves.toBe(2);
    offHook();
    await expect(h.mark({ tag: "x" })).resolves.toBe(1);
  });

  it("guards.<command> infers the input and narrows verdicts without `as const`", async () => {
    const h = new MarkHarness("t4");
    await h.ready;
    const off = h.guards.toolMark((input) => (input.tag === "x" ? { kind: "veto" } : undefined));
    await expect(h.mark({ tag: "x" })).rejects.toThrow("operation outcome: vetoed");
    off();
    await expect(h.mark({ tag: "x" })).resolves.toBe(1);
  });

  it("the drop-layer verb is not a registrar key, and the decider stays typed", async () => {
    const h = new MarkHarness("t5");
    await h.ready;
    // @ts-expect-error — `mark` is the definition bag's key; the registrar,
    // like `hooks`, names the discriminated command.
    h.guards.mark(() => undefined);
    // @ts-expect-error — no such command in the registry.
    h.guards.toolNope(() => undefined);
    // @ts-expect-error — `result` must be `MarkOutput` (number).
    const off = h.guards.toolMark(() => ({ kind: "replace", result: "not-a-number" }));
    off();
    await expect(h.mark({ tag: "ab" })).resolves.toBe(2);
  });
});
