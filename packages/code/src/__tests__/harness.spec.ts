/**
 * Harness-only invariants — the things that are true of the ENVELOPE rather
 * than of any provider, and so are not the conformance suite's business.
 */

import { describe, expect, it, vi } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import { deriveHookNames, type MemoryJournal } from "@agentick/runtime";
import type { EventQuery, ProtocolEvent } from "@agentick/spec";

import { fakeCodeHarness } from "../testing/fake-code-harness.js";
import { fakeCode, fakeProgram } from "../testing/fake-code.js";
import { fakeCodeSource } from "../testing/fake-code-probe.js";
import { defineCode, isCodeDefinition } from "../definition.js";
import { sha256Hex } from "../code-hash.js";
import type { CodeExecuteInput, CodeExecuteResult, Runtime } from "../contract.js";

/** Journal reads go through `compileQuery` — the same matcher a bus subscription uses. */
async function collect(
  journal: MemoryJournal,
  query: EventQuery,
): Promise<readonly ProtocolEvent[]> {
  const chunk = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery(query, "beginning")).pipe(Effect.orDie),
  );
  return Chunk.toReadonlyArray(chunk);
}

describe("CodeHarness — provider binding", () => {
  it("is inert until a runtime is bound, then answers", async () => {
    const { harness, close } = await fakeCodeHarness();
    expect(harness.hasRuntime()).toBe(false);

    harness.bindRuntime(fakeCode());
    expect(harness.hasRuntime()).toBe(true);
    expect(harness.capabilities().name).toBe("fake");

    const result = await harness.run({ source: fakeCodeSource.returns("bound") });
    expect(result).toMatchObject({ outcome: "returned", value: "bound" });
    await close();
  });

  it("a provider failure at createContext surfaces as CodeRuntimeFailed, not as a program error", async () => {
    const broken: Runtime = {
      capabilities: { name: "broken", enforces: [], persistentContext: false },
      createContext: () => Promise.reject(new Error("membrane refused")),
      dispose: async () => {},
    };
    const { harness, close } = await fakeCodeHarness({ runtime: broken });
    await expect(harness.createContext()).rejects.toMatchObject({
      _tag: "CodeRuntimeFailed",
      phase: "create-context",
    });
    await close();
  });

  it("close disposes every open context and the runtime itself", async () => {
    const runtime = fakeCode();
    const disposeRuntime = vi.spyOn(runtime, "dispose");
    const { harness, close } = await fakeCodeHarness({ runtime });

    const context = await harness.createContext();
    await close();

    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    await expect(context.execute(fakeCodeSource.returns(1))).rejects.toMatchObject({
      _tag: "CodeContextDisposed",
    });
  });
});

describe("CodeHarness — the operation envelope", () => {
  it("guardCodeExecute sees the source, the digest and the binding names", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const program = fakeCodeSource.returns("guarded");
    const seen: unknown[] = [];
    harness.guardCodeExecute((input) => {
      seen.push(input);
      return Effect.succeed({ kind: "proceed" });
    });

    await harness.run({ source: program, bindings: { tenant: "acme" } });

    expect(seen).toEqual([
      {
        contextId: expect.stringContaining("code-ctx-"),
        source: program,
        codeHash: await sha256Hex(program),
        bindings: ["tenant"],
      },
    ]);
    await close();
  });

  it("a guard can REPLACE a program's answer without running it", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    harness.guardCodeExecute(() =>
      Effect.succeed({
        kind: "replace",
        result: {
          outcome: "returned",
          value: "cached",
          stdout: "",
          stderr: "",
          truncated: [],
          durationMs: 0,
        },
      }),
    );

    const result = await harness.run({ source: fakeCodeSource.returns("live") });
    expect(result).toMatchObject({ outcome: "returned", value: "cached" });
    await close();
  });

  it("fx.execute composes in the caller's fiber", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const context = await harness.createContext();
    const program = fakeCodeSource.returns("in-fiber");

    const result = await Effect.runPromise(
      // Only a context and a program — the audit fields are the harness's.
      harness.fx.execute({ contextId: context.id, source: program }),
    );

    expect(result).toMatchObject({ outcome: "returned", value: "in-fiber" });
    await close();
  });

  it("declaring the verb mints onBeforeCodeExecute / onAfterCodeExecute, and they fire", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const seen: string[] = [];
    harness.hook({
      onBeforeCodeExecute: (input: CodeExecuteInput) => {
        seen.push(`before:${input.bindings.join(",")}`);
        return input;
      },
      onAfterCodeExecute: (output: CodeExecuteResult) => {
        seen.push(`after:${output.outcome}`);
        return output;
      },
    });

    await harness.run({ source: fakeCodeSource.returns("hooked"), bindings: { tenant: "acme" } });

    expect(seen).toEqual(["before:tenant", "after:returned"]);
    expect(deriveHookNames("code:command:execute")).toEqual([
      "onBeforeCodeExecute",
      "onAfterCodeExecute",
    ]);
    await close();
  });

  it("code:execute is internal — never inbox- or wire-addressable", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const execute = harness.commands().find((c) => c.name === "code:execute");
    expect(execute?.exposure).toBe("internal");
    await close();
  });

  it("every execute envelope carries codeContextId, and a scoped query filters by it", async () => {
    const { harness, journal, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const first = await harness.createContext();
    const second = await harness.createContext();

    await first.execute(fakeCodeSource.returns("mine"));
    await second.execute(fakeCodeSource.returns("theirs"));

    // Stamped: both ops carry their own context, and neither carries the other's.
    const all = await collect(journal, {});
    const executes = all.filter((e) => e.name === "code:command:execute");
    expect(new Set(executes.map((e) => e.scope.codeContextId))).toEqual(
      new Set([first.id, second.id]),
    );

    // Filterable: one context's executions separated out of a session holding
    // two — the cut `sessionId` cannot make. Same `compileQuery` matcher a
    // scoped bus subscription runs.
    const mine = await collect(journal, { scope: { codeContextId: first.id } });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.scope.codeContextId === first.id)).toBe(true);
    expect(mine.map((e) => e.phase)).toEqual(["requested", "terminal"]);

    await first.dispose();
    await second.dispose();
    await close();
  });

  it("interrupting the OPERATION FIBER aborts the program — no caller signal involved", async () => {
    // The cascade half of abort: a cancelled turn or an aborted tool dispatch
    // interrupts the enclosing op, and that has to reach a program already
    // running behind a Promise. The caller-signal pins cannot see this path —
    // nothing here supplies a signal.
    let observedSignal: AbortSignal | undefined;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    // A recording provider rather than the fake: the subject is what the
    // HARNESS hands the provider, so the double's whole job is to keep it.
    const recording: Runtime = {
      capabilities: { name: "recording", enforces: [], persistentContext: false },
      createContext: async () => ({
        execute: (_source, options) =>
          new Promise((_resolve, reject) => {
            observedSignal = options?.signal;
            startedResolve();
            const signal = options?.signal;
            // No signal → nothing can ever end this, which is precisely the
            // orphaned-program failure this test exists to catch.
            if (signal === undefined) return;
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    };

    const { harness, journal, close } = await fakeCodeHarness({ runtime: recording });
    const context = await harness.createContext();
    const source = "blocks-until-interrupted";

    const fiber = Effect.runFork(harness.fx.execute({ contextId: context.id, source }));
    try {
      await started;

      // (a) The fiber's own signal reached the provider, un-aborted, while running.
      expect(observedSignal).toBeDefined();
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      // Always interrupt, even when an assertion above threw: a harness that
      // withheld the signal leaves a Promise nothing can ever settle, and the
      // suite must FAIL on that rather than hang on it.
      await Effect.runPromise(Fiber.interrupt(fiber));
    }

    // (a) …and the interrupt reached the in-flight program through it.
    expect(observedSignal?.aborted).toBe(true);

    // (b) An interrupted op publishes no success: `runOperation`'s settle lets
    // interrupts pass through rather than inventing a terminal.
    const events = await collect(journal, {});
    const executes = events.filter((e) => e.name === "code:command:execute");
    expect(executes.map((e) => e.phase)).toContain("requested");
    expect(executes.some((e) => e.phase === "terminal" && e.outcome === "succeeded")).toBe(false);

    await close();
  });

  it("an inbox message naming the internal verb is REFUSED, not silently run", async () => {
    const { harness, inbox, close } = await fakeCodeHarness({ runtime: fakeCode() });
    let ran = false;
    // Reaching the provider would set this; a clean refusal never does.
    const source = fakeProgram({ op: "call", binding: "reached", input: {} });
    const context = await harness.createContext({
      bindings: {
        reached: async () => {
          ran = true;
          return null;
        },
      },
    });

    await expect(
      Effect.runPromise(
        inbox.ask(harness.address, {
          type: "code:execute",
          origin: "wire",
          payload: { contextId: context.id, source, codeHash: "x", bindings: [] },
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Unknown code message type") });
    expect(ran).toBe(false);

    await context.dispose();
    await close();
  });
});

describe("CodeHarness — budgets", () => {
  it("refuses a budget the provider does not declare", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: fakeCode({ enforces: ["timeMs"] }),
    });
    await expect(harness.createContext({ budgets: { memoryMb: 64 } })).rejects.toMatchObject({
      _tag: "CodeBudgetUnsupported",
      budget: "memoryMb",
    });
    await close();
  });

  it("truncates on outputBytes and still returns the answer", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const result = await harness.run({
      source: fakeProgram(
        { op: "print", stream: "stdout", text: "0123456789" },
        { op: "return", value: "answered" },
      ),
      budgets: { outputBytes: 4 },
    });

    expect(result).toMatchObject({ outcome: "returned", value: "answered" });
    expect(result.stdout).toBe("0123");
    expect(result.truncated).toEqual(["stdout"]);
    await close();
  });
});

describe("CodeHarness — what it deliberately is not", () => {
  it("is NOT SnapshotCapable — carries no export/importSnapshot", async () => {
    // A context holds live provider resources that no snapshot can carry, so
    // the harness must not advertise a capability it would have to fake on
    // restore. Programs are journaled; contexts are not.
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const probe = harness as unknown as Record<string, unknown>;
    expect(probe.exportSnapshot).toBeUndefined();
    expect(probe.importSnapshot).toBeUndefined();
    await close();
  });
});

describe("defineCode", () => {
  it("is identity plus a non-enumerable brand", () => {
    const runtime = fakeCode();
    const definition = defineCode({ runtime });
    expect(definition.runtime).toBe(runtime);
    expect(isCodeDefinition(definition)).toBe(true);
    expect(Object.keys(definition)).toEqual(["runtime"]);
    expect(isCodeDefinition({ runtime })).toBe(false);
  });
});

describe("CodeHarness — the pins that are the HARNESS's, not a provider's", () => {
  it("dispose is idempotent and a disposed context refuses to execute", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const context = await harness.createContext();
    await context.dispose();
    await context.dispose();
    await expect(context.execute(fakeCodeSource.returns(1))).rejects.toMatchObject({
      _tag: "CodeContextDisposed",
    });
    await close();
  });

  it("a signal already aborted never reaches the provider", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    let called = false;
    await expect(
      harness.run({
        source: fakeCodeSource.callsBinding("recall", {}),
        signal: AbortSignal.abort("pre-aborted"),
        bindings: {
          recall: async () => {
            called = true;
            return null;
          },
        },
      }),
    ).rejects.toMatchObject({ _tag: "CodeAborted" });
    expect(called).toBe(false);
    await close();
  });

  it("a guard veto stops the program before the provider is touched", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    let called = false;
    harness.guardCodeExecute(() => Effect.succeed({ kind: "veto", reason: "policy" }));
    await expect(
      harness.run({
        source: fakeCodeSource.callsBinding("recall", {}),
        bindings: {
          recall: async () => {
            called = true;
            return null;
          },
        },
      }),
    ).rejects.toBeTruthy();
    expect(called).toBe(false);
    await close();
  });

  it("an unbound harness fails CodeProviderMissing rather than choosing a runtime", async () => {
    const { harness, close } = await fakeCodeHarness();
    expect(harness.hasRuntime()).toBe(false);
    await expect(harness.run({ source: fakeCodeSource.returns(1) })).rejects.toMatchObject({
      _tag: "CodeProviderMissing",
    });
    expect(() => harness.capabilities()).toThrow(/none is bound/);
    await close();
  });
});

describe("CodeHarness — the audit record is the harness's to write (C1)", () => {
  it("fx.execute journals the TRUE digest — a caller has no field to forge", async () => {
    const { harness, journal, close } = await fakeCodeHarness({ runtime: fakeCode() });
    const context = await harness.createContext({ bindings: { tenant: "acme" } });
    const program = fakeCodeSource.returns("fx");

    await Effect.runPromise(harness.fx.execute({ contextId: context.id, source: program }));

    const requested = (await collect(journal, {})).filter(
      (e) => e.name === "code:command:execute" && e.phase === "requested",
    );
    const input = requested[0]?.payload as CodeExecuteInput;
    expect(input.codeHash).toBe(await sha256Hex(program));
    expect(input.bindings).toEqual(["tenant"]);
    await context.dispose();
    await close();
  });

  it("a guard vetoing on a binding name cannot be defeated through fx", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    // The reviewer's scenario: policy refuses any program with `deleteAll` in
    // scope. Before C1, fx let a caller declare `bindings: []` and walk past it.
    harness.guardCodeExecute((input) =>
      Effect.succeed(
        input.bindings.includes("tools.deleteAll")
          ? { kind: "veto", reason: "destructive binding" }
          : { kind: "proceed" },
      ),
    );
    let called = false;
    const context = await harness.createContext({
      bindings: {
        tools: {
          deleteAll: async () => {
            called = true;
            return null;
          },
        },
      },
    });

    await expect(
      Effect.runPromise(
        harness.fx.execute({
          contextId: context.id,
          source: fakeCodeSource.callsBinding("deleteAll", {}),
        }),
      ),
    ).rejects.toBeTruthy();
    expect(called).toBe(false);
    await context.dispose();
    await close();
  });
});

describe("CodeHarness — teardown aborts, drains, then disposes (H2)", () => {
  /** A provider whose program only ends when its signal fires, recording order. */
  function gated(order: string[]): { runtime: Runtime; started: Promise<void> } {
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => {
      startedResolve = r;
    });
    const runtime: Runtime = {
      capabilities: { name: "gated", enforces: [], persistentContext: false },
      createContext: async () => ({
        execute: (_source, options) =>
          new Promise((_resolve, reject) => {
            startedResolve();
            const signal = options?.signal;
            if (signal === undefined) return;
            const stop = (): void => {
              order.push("program-aborted");
              reject(new Error("aborted"));
            };
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          }),
        dispose: async () => {
          order.push("context-disposed");
        },
      }),
      dispose: async () => {
        order.push("runtime-disposed");
      },
    };
    return { runtime, started };
  }

  it("dispose during execute aborts the program and tears down only after it settles", async () => {
    const order: string[] = [];
    const { runtime, started } = gated(order);
    const { harness, close } = await fakeCodeHarness({ runtime });
    const context = await harness.createContext();

    const running = context.execute("blocks");
    await started;
    const settled = running.catch((e: { _tag?: string }) => e._tag);

    await context.dispose();

    expect(await settled).toBe("CodeAborted");
    expect(order).toEqual(["program-aborted", "context-disposed"]);
    await close();
  });

  it("close under a running program aborts it, and returns only once it has settled", async () => {
    const order: string[] = [];
    const { runtime, started } = gated(order);
    const { harness, close } = await fakeCodeHarness({ runtime });
    const context = await harness.createContext();

    const running = context.execute("blocks");
    await started;
    const settled = running.catch((e: { _tag?: string }) => e._tag);

    await close();

    expect(await settled).toBe("CodeAborted");
    expect(order).toEqual(["program-aborted", "context-disposed", "runtime-disposed"]);
  });

  it("an execute racing a dispose is STOPPED, not orphaned", async () => {
    // The window is the digest computation. The old failure was that a dispose
    // landing in it reported `CodeContextDisposed` — the harness losing track
    // of a program the caller had every right to have run. Under the abort
    // ruling the execute is deliberately stopped instead, and says so.
    let reached = false;
    const { harness, close } = await fakeCodeHarness({
      runtime: {
        capabilities: { name: "r", enforces: [], persistentContext: false },
        createContext: async () => ({
          execute: async (): Promise<CodeExecuteResult> => {
            reached = true;
            return {
              outcome: "returned",
              value: 1,
              stdout: "",
              stderr: "",
              truncated: [],
              durationMs: 0,
            };
          },
          dispose: async () => {},
        }),
        dispose: async () => {},
      },
    });
    const context = await harness.createContext();
    const running = context.execute("x");
    const settled = running.catch((e: { _tag?: string }) => e._tag);
    await context.dispose();

    expect(await settled).toBe("CodeAborted");
    expect(reached).toBe(false);
    await close();
  });
});

describe("CodeHarness — one context runs one program at a time (M9)", () => {
  it("two concurrent executes on one context are strictly ordered", async () => {
    const order: string[] = [];
    let n = 0;
    const recording: Runtime = {
      capabilities: { name: "seq", enforces: [], persistentContext: false },
      createContext: async () => ({
        execute: async (source): Promise<CodeExecuteResult> => {
          order.push(`start:${source}`);
          await new Promise((r) => setTimeout(r, source === "slow" ? 20 : 1));
          order.push(`end:${source}`);
          return {
            outcome: "returned",
            value: ++n,
            stdout: "",
            stderr: "",
            truncated: [],
            durationMs: 0,
          };
        },
        dispose: async () => {},
      }),
      dispose: async () => {},
    };
    const { harness, close } = await fakeCodeHarness({ runtime: recording });
    const context = await harness.createContext();

    await Promise.all([context.execute("slow"), context.execute("fast")]);

    // No interleaving: the slow program finishes before the fast one starts.
    expect(order).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);
    await context.dispose();
    await close();
  });
});

describe("CodeHarness — refusals at the boundary", () => {
  it("a key cannot contain the path separator, so a dotted name is unambiguous (M2)", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    // One record cannot claim a name twice, so the old cross-group collision is
    // gone by construction. What replaces the check is this: a key that spelled
    // a separator could forge another binding's path in the audit record.
    await expect(
      harness.createContext({ bindings: { "tools.same": "forged" } }),
    ).rejects.toMatchObject({ _tag: "CodeBindingNameInvalid", bindingName: "tools.same" });

    const context = await harness.createContext({
      bindings: { tools: { same: async () => 1 }, same: "v" },
    });
    expect(context.bindings).toEqual(["same", "tools.same"]);
    await context.dispose();
    await close();
  });

  it("a prototype-member or non-identifier binding name is refused (M3)", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: fakeCode() });
    for (const name of ["__proto__", "constructor", "prototype"]) {
      await expect(harness.createContext({ bindings: { [name]: 1 } })).rejects.toMatchObject({
        _tag: "CodeBindingNameInvalid",
      });
      // And at DEPTH: a namespace is not a place the check stops.
      await expect(
        harness.createContext({ bindings: { ns: { [name]: 1 } } }),
      ).rejects.toMatchObject({ _tag: "CodeBindingNameInvalid", bindingName: `ns.${name}` });
    }
    await expect(
      harness.createContext({ bindings: { "not an identifier": 1 } }),
    ).rejects.toMatchObject({ _tag: "CodeBindingNameInvalid" });
    await close();
  });

  it("a rejected binding leaves no context behind — the provider is never touched", async () => {
    let created = 0;
    const counting: Runtime = {
      capabilities: { name: "counting", enforces: [], persistentContext: false },
      createContext: async () => {
        created += 1;
        return { execute: async () => ({}) as CodeExecuteResult, dispose: async () => {} };
      },
      dispose: async () => {},
    };
    const { harness, close } = await fakeCodeHarness({ runtime: counting });
    // A COMPUTED key: `{ __proto__: 1 }` written literally sets the prototype
    // and creates no own property, so it would not even reach the check.
    await expect(harness.createContext({ bindings: { ["__proto__"]: 1 } })).rejects.toBeTruthy();
    expect(created).toBe(0);
    await close();
  });

  it("bindRuntime binds once (M6)", async () => {
    const { harness, close } = await fakeCodeHarness();
    harness.bindRuntime(fakeCode());
    expect(() => harness.bindRuntime(fakeCode())).toThrow(/already bound/);
    await close();
  });

  it("createContext after close is refused without touching the runtime (M7)", async () => {
    const runtime = fakeCode();
    const create = vi.spyOn(runtime, "createContext");
    const { harness, close } = await fakeCodeHarness({ runtime });
    await close();
    await expect(harness.createContext()).rejects.toMatchObject({ _tag: "CodeHarnessClosed" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("CodeHarness — the provider is held to the result union (H4)", () => {
  function answering(result: unknown): Runtime {
    return {
      capabilities: { name: "odd", enforces: [], persistentContext: false },
      createContext: async () => ({
        execute: async () => result as CodeExecuteResult,
        dispose: async () => {},
      }),
      dispose: async () => {},
    };
  }

  it("an unknown outcome is a contract violation, not a result", async () => {
    const { harness, close } = await fakeCodeHarness({ runtime: answering({ outcome: "weird" }) });
    await expect(harness.run({ source: "x" })).rejects.toMatchObject({ _tag: "CodeResultInvalid" });
    await close();
  });

  it('a "returned" arm with no value is refused', async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: answering({ outcome: "returned", stdout: "", stderr: "", durationMs: 0 }),
    });
    await expect(harness.run({ source: "x" })).rejects.toMatchObject({ _tag: "CodeResultInvalid" });
    await close();
  });

  it("an omitted `truncated` is filled, not left undefined for the caller", async () => {
    const { harness, close } = await fakeCodeHarness({
      runtime: answering({ outcome: "no-value", stdout: "", stderr: "", durationMs: 0 }),
    });
    const result = await harness.run({ source: "x" });
    expect(result.truncated).toEqual([]);
    await close();
  });
});

describe("CodeHarness — run() answers even when teardown does not (H3)", () => {
  it("a dispose failure after the program answered is logged, not thrown", async () => {
    const failing: Runtime = {
      capabilities: { name: "leaky", enforces: [], persistentContext: false },
      createContext: async () => ({
        execute: async (): Promise<CodeExecuteResult> => ({
          outcome: "returned",
          value: "the answer",
          stdout: "",
          stderr: "",
          truncated: [],
          durationMs: 0,
        }),
        dispose: async () => {
          throw new Error("provider cannot let go");
        },
      }),
      dispose: async () => {},
    };
    const { harness, close } = await fakeCodeHarness({ runtime: failing });
    const result = await harness.run({ source: "x" });
    expect(result).toMatchObject({ outcome: "returned", value: "the answer" });
    await close().catch(() => undefined);
  });
});
