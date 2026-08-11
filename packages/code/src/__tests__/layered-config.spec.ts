/**
 * The definition's `bindings` and `budgets` are a BASE LAYER, and a context
 * merges over them per leaf.
 *
 * The rule is what makes the base usable at all: a context that wanted one more
 * tool would otherwise have to restate the whole `tools` namespace, and one
 * that wanted a longer deadline would have to restate every ceiling. The pins
 * below fix both directions — what a context adds, and what it replaces.
 *
 * @verifiedBy this file
 */

import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { MemoryJournal } from "@agentick/runtime";

import type { CodeExecuteInput } from "../contract.js";
import { fakeCode, fakeCodeHarness, fakeCodeSource, fakeProgram } from "../testing/index.js";

async function auditedBindings(journal: MemoryJournal): Promise<readonly string[]> {
  const events = Chunk.toReadonlyArray(
    await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({}, "beginning")).pipe(Effect.orDie),
    ),
  );
  const requested = events.find(
    (e) => e.name === "code:command:execute" && e.phase === "requested",
  );
  if (requested === undefined) throw new Error("no code:execute was journaled");
  return (requested.payload as CodeExecuteInput).bindings;
}

describe("CodeHarness — the definition's bindings are a base layer", () => {
  it("a default binding is in scope for a program that asked for nothing", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      bindings: { tools: { search: async () => "from the default" } },
    });

    const result = await harness.execute({
      source: fakeCodeSource.callsBinding("tools.search", {}),
    });

    expect(result).toMatchObject({ outcome: "returned", value: "from the default" });
    await close();
  });

  it("a context ADDS to a namespace without wiping it", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      bindings: { tools: { search: async () => "default search" }, tenantId: "acme" },
    });

    const context = await harness.createContext({
      bindings: { tools: { audit: async () => "context audit" } },
    });
    // Both namespaces' leaves survive the merge, and so does the sibling value.
    expect(context.bindings).toEqual(["tenantId", "tools.audit", "tools.search"]);

    const both = await context.execute(
      fakeProgram(
        { op: "call", binding: "tools.search", input: {} },
        { op: "call", binding: "tools.audit", input: {} },
        { op: "return-last" },
      ),
    );
    expect(both).toMatchObject({ outcome: "returned", value: "context audit" });
    expect(await context.execute(fakeCodeSource.callsBinding("tools.search", {}))).toMatchObject({
      outcome: "returned",
      value: "default search",
    });

    await context.dispose();
    await close();
  });

  it("a context OVERRIDES one leaf and leaves the rest of the layer standing", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      bindings: { tools: { search: async () => "default" }, tenantId: "acme" },
    });

    const context = await harness.createContext({
      bindings: { tools: { search: async () => "overridden" } },
    });

    expect(await context.execute(fakeCodeSource.callsBinding("tools.search", {}))).toMatchObject({
      outcome: "returned",
      value: "overridden",
    });
    expect(await context.execute(fakeCodeSource.readsValue("tenantId"))).toMatchObject({
      outcome: "returned",
      value: "acme",
    });

    await context.dispose();
    await close();
  });

  it("the audit record names the MERGED set — policy sees what actually ran", async () => {
    const { harness, journal, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      bindings: { tools: { search: async () => "s" } },
    });

    await harness.execute({
      source: fakeCodeSource.callsBinding("tools.search", {}),
      bindings: { tools: { deleteAll: async () => "d" }, tenantId: "acme" },
    });

    expect(await auditedBindings(journal)).toEqual(["tenantId", "tools.deleteAll", "tools.search"]);
    await close();
  });
});

describe("CodeHarness — the definition's budgets are a base layer", () => {
  it("a default ceiling applies to a context that named none", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      budgets: { timeMs: 10 },
    });

    const result = await harness.execute({ source: fakeCodeSource.exceeds!("timeMs", 10) });

    expect(result).toMatchObject({ outcome: "budget-exceeded", budget: "timeMs", limit: 10 });
    await close();
  });

  it("a context overrides ONE ceiling and inherits the others", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode(),
      budgets: { timeMs: 10, outputBytes: 4 },
    });

    // The raised deadline wins; the inherited output ceiling still cuts.
    const result = await harness.execute({
      source: fakeProgram(
        { op: "sleep", ms: 50 },
        { op: "print", stream: "stdout", text: "chatty" },
        { op: "return", value: "done" },
      ),
      budgets: { timeMs: 1_000 },
    });

    expect(result.outcome).toBe("returned");
    expect(result.stdout).toHaveLength(4);
    expect(result.truncated).toEqual(["stdout"]);
    await close();
  });

  it("a base ceiling the provider cannot enforce is refused, like any other", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode({ enforces: ["timeMs"] }),
      budgets: { outputBytes: 100 },
    });

    await expect(harness.createContext()).rejects.toMatchObject({
      _tag: "CodeBudgetUnsupported",
      budget: "outputBytes",
    });
    await close();
  });
});
