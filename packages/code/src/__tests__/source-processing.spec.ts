/**
 * Hooks that read — and rewrite — the program: the three pre-run shapes the
 * README teaches, pinned.
 *
 * The one-shot takes ONE bag so a hook handles the same shape every other
 * command hands it, and the motivating case is a processor: a lint gate that
 * refuses bad source, or a transform that fixes it. The rewriting one is why
 * the digest cannot be derived once at the door and trusted afterwards.
 *
 * @verifiedBy this file
 */

import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";

import { sha256Hex } from "../code-hash.js";
import { CODE_EXECUTE_REWRITTEN } from "../harness.js";
import type { CodeExecuteInput } from "../contract.js";
import { fakeCode, fakeCodeHarness, fakeCodeSource, fakeProgram } from "../testing/index.js";

async function events(journal: MemoryJournal): Promise<readonly ProtocolEvent[]> {
  return Chunk.toReadonlyArray(
    await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({}, "beginning")).pipe(Effect.orDie),
    ),
  );
}

describe("a processor reads the program before it runs", () => {
  it("a lint gate refuses the source, and the provider is never touched", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    let reached = false;

    // The shape an adopter writes: read `input.source`, decide, veto. A plain
    // decider — the verdict is data, and nothing here needs a fiber.
    harness.guard({
      codeExecute: (input) =>
        input.source.includes("eval(")
          ? { kind: "veto", reason: "lint: eval() is not allowed" }
          : { kind: "proceed" },
    });

    // The sentinel is the proof: a veto that merely rejected the promise while
    // the program ran would satisfy a `rejects` assertion on its own.
    await expect(
      harness.execute({
        source: fakeProgram({ op: "call", binding: "danger", input: { snippet: "eval(x)" } }),
        bindings: {
          danger: async () => {
            reached = true;
            return null;
          },
        },
      }),
    ).rejects.toMatchObject({ _tag: "OperationOutcomeError", outcome: "vetoed" });
    expect(reached).toBe(false);

    // And a program the gate is happy with runs untouched.
    const clean = await harness.execute({ source: fakeCodeSource.returns("lint clean") });
    expect(clean).toMatchObject({ outcome: "returned", value: "lint clean" });

    await close();
  });
});

describe("a pre-run pipeline runs on plain async hooks", () => {
  it("an observing hook reads the program and proceeds, leaving it untouched", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const observed: string[] = [];

    // The soft shape: no return value, so the input passes through as-is. The
    // op's own logger is on `ctx`, which is what makes a warning correlate
    // with the execution that provoked it.
    harness.hook({
      onBeforeCodeExecute: (input: CodeExecuteInput, ctx) => {
        observed.push(input.codeHash);
        ctx.log.warn({ msg: "program observed", bindings: input.bindings.length });
      },
    });

    const asked = fakeCodeSource.returns("untouched");
    expect(await harness.execute({ source: asked })).toMatchObject({
      outcome: "returned",
      value: "untouched",
    });
    expect(observed).toEqual([await sha256Hex(asked)]);
    await close();
  });

  it("the around form wraps both faces of one execution", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const order: string[] = [];

    // `onCodeExecute` is the whole middleware, for a pass that must see the
    // answer too — timing, try/finally, a retry. A before-hook cannot: it is
    // one-sided by construction.
    harness.hook({
      onCodeExecute: async (input: CodeExecuteInput, next) => {
        order.push("entered");
        try {
          return await next(input);
        } finally {
          order.push("left");
        }
      },
    });

    expect(await harness.execute({ source: fakeCodeSource.returns("wrapped") })).toMatchObject({
      outcome: "returned",
      value: "wrapped",
    });
    expect(order).toEqual(["entered", "left"]);
    await close();
  });
});

describe("the journal cannot lie about what executed", () => {
  it("a middleware that REWRITES the source is journaled with the rewritten digest", async () => {
    const { harness, journal, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const asked = fakeCodeSource.returns("original");
    const ran = fakeCodeSource.returns("autofixed");

    // An autofix: the program that executes is not the program that was asked
    // for. The requested envelope keeps the request; the execution gets its own
    // record, or the audit trail would describe a program nobody ran.
    harness.hook({ onBeforeCodeExecute: (input: CodeExecuteInput) => ({ ...input, source: ran }) });

    const result = await harness.execute({ source: asked });
    expect(result).toMatchObject({ outcome: "returned", value: "autofixed" });

    const all = await events(journal);
    const requested = all.find((e) => e.name === "code:command:execute" && e.phase === "requested");
    if (requested === undefined) throw new Error("no code:execute was journaled");
    expect((requested.payload as CodeExecuteInput).source).toBe(asked);

    const rewritten = all.find((e) => e.name === CODE_EXECUTE_REWRITTEN);
    expect(rewritten).toBeDefined();
    const payload = rewritten?.payload as {
      readonly requestedHash: string;
      readonly executedHash: string;
      readonly source: string;
    };
    expect(payload.executedHash).toBe(await sha256Hex(ran));
    expect(payload.requestedHash).toBe(await sha256Hex(asked));
    expect(payload.source).toBe(ran);

    await close();
  });

  it("an untouched program emits no rewrite event — the absence IS the guarantee", async () => {
    const { harness, journal, close } = await fakeCodeHarness({ runtime: fakeCode() });

    await harness.execute({ source: fakeCodeSource.returns("as asked") });

    expect((await events(journal)).some((e) => e.name === CODE_EXECUTE_REWRITTEN)).toBe(false);
    await close();
  });
});
