/**
 * Hooks that read — and rewrite — the program.
 *
 * `run` takes ONE bag so a hook handles the same shape every other command
 * hands it, and the motivating case is a processor: a lint gate that refuses
 * bad source, or a transform that fixes it. Both are pinned here, and the
 * second one is why the digest cannot be derived once at the door and trusted
 * afterwards.
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

    // The shape an adopter writes: read `input.source`, decide, veto.
    harness.guardCodeExecute((input) =>
      Effect.succeed(
        input.source.includes("eval(")
          ? { kind: "veto", reason: "lint: eval() is not allowed" }
          : { kind: "proceed" },
      ),
    );

    // The sentinel is the proof: a veto that merely rejected the promise while
    // the program ran would satisfy a `rejects` assertion on its own.
    await expect(
      harness.run({
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
    const clean = await harness.run({ source: fakeCodeSource.returns("lint clean") });
    expect(clean).toMatchObject({ outcome: "returned", value: "lint clean" });

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

    const result = await harness.run({ source: asked });
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

    await harness.run({ source: fakeCodeSource.returns("as asked") });

    expect((await events(journal)).some((e) => e.name === CODE_EXECUTE_REWRITTEN)).toBe(false);
    await close();
  });
});
