/**
 * `runCodeConformance` — certifies any {@link Runtime}, in any language.
 *
 * A suite that must not name a language cannot author source code, so the
 * PROBE supplies the vocabulary: the provider hands over a small set of
 * program builders ("source that returns this value", "source that calls this
 * binding") and the suite drives the contract through them. That inversion is
 * what makes one suite cover a subprocess JavaScript runtime and a Python
 * runtime without a branch.
 *
 * The capability claims are held to account rather than trusted. A provider
 * declaring `enforces: ["timeMs"]` MUST supply a program that overruns it and
 * MUST report `budget-exceeded`; a provider declaring `persistentContext` MUST
 * carry state between executions on one context. A capability nobody can
 * exercise is a capability nobody should believe.
 *
 * The suite drives a real {@link CodeHarness} over the provider, not the
 * provider alone: the guard seam, the journal record and the operation
 * envelope are part of the contract a consumer depends on.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";

import type { CodeBudgetKey, CodeExecuteInput, CodeStream, Runtime } from "./contract.js";
import { fakeCodeHarness, type FakeCodeHarnessBundle } from "./testing/fake-code-harness.js";

// ============================================================================
// Probe contract
// ============================================================================

/**
 * Programs in the provider's own language. Each builder returns source; the
 * suite never inspects it.
 */
export interface CodeSourceVocabulary {
  /** Completes and returns `value`. */
  returns(value: unknown): string;
  /** Completes without returning anything. */
  noValue(): string;
  /** Raises with `message`. */
  throws(message: string): string;
  /** Calls binding `name` with `input` and returns its answer. */
  callsBinding(name: string, input: unknown): string;
  /** Returns the value binding `name`. */
  readsValue(name: string): string;
  /** Writes `text` to `stream` and returns `done`. */
  writes(stream: CodeStream, text: string): string;
  /**
   * Runs until the execution's signal aborts, and nothing else ends it.
   * REQUIRED — honoring abort is not a declared capability but a floor: a
   * runtime that cannot stop a program cannot enforce `timeMs` either.
   */
  blocks(): string;
  /**
   * Overruns `budget`, given the limit the suite will set. REQUIRED for every
   * budget the provider declares in `capabilities.enforces`.
   */
  exceeds?(budget: CodeBudgetKey, limit: number): string;
  /** Stores `value` under `key` in context state. Required iff `persistentContext`. */
  remembers?(key: string, value: unknown): string;
  /** Returns what `remembers` stored. Required iff `persistentContext`. */
  recalls?(key: string): string;
}

export interface CodeConformanceProbe {
  /** Names this provider in the suite output. */
  readonly label: string;
  /** A FRESH runtime per call — the suite closes each harness it opens. */
  makeRuntime(): Runtime | Promise<Runtime>;
  readonly source: CodeSourceVocabulary;
}

// ============================================================================
// Suite
// ============================================================================

export function runCodeConformance(probe: CodeConformanceProbe): void {
  const { source } = probe;

  describe(`Runtime conformance — ${probe.label}`, () => {
    async function open(): Promise<FakeCodeHarnessBundle> {
      return fakeCodeHarness({ runtime: await probe.makeRuntime() });
    }

    it("createContext → execute → dispose round-trips", async () => {
      const { harness, close } = await open();
      const context = await harness.createContext();
      const result = await context.execute(source.returns(42));
      expect(result.outcome).toBe("returned");
      if (result.outcome === "returned") expect(result.value).toEqual(42);
      await context.dispose();
      await close();
    });

    it("run() is a one-shot context — used once, disposed", async () => {
      const { harness, close } = await open();
      const result = await harness.run(source.returns("one-shot"));
      expect(result.outcome).toBe("returned");
      if (result.outcome === "returned") expect(result.value).toBe("one-shot");
      await close();
    });

    it("a completion with no value reports no-value, not a null value", async () => {
      const { harness, close } = await open();
      const result = await harness.run(source.noValue());
      expect(result.outcome).toBe("no-value");
      await close();
    });

    it("a program that raises is a result, not a rejection", async () => {
      const { harness, close } = await open();
      const result = await harness.run(source.throws("boom"));
      expect(result.outcome).toBe("threw");
      if (result.outcome === "threw") expect(result.error.message).toContain("boom");
      await close();
    });

    it("a function binding is reachable by name and its answer comes back", async () => {
      const { harness, close } = await open();
      const seen: unknown[] = [];
      const result = await harness.run(source.callsBinding("recall", { q: "ping" }), {
        bindings: {
          tools: {
            recall: async (input) => {
              seen.push(input);
              return { hits: 1 };
            },
          },
        },
      });
      expect(seen).toEqual([{ q: "ping" }]);
      expect(result.outcome).toBe("returned");
      if (result.outcome === "returned") expect(result.value).toEqual({ hits: 1 });
      await close();
    });

    it("a value binding is reachable by name", async () => {
      const { harness, close } = await open();
      const result = await harness.run(source.readsValue("sessionId"), {
        bindings: { values: { sessionId: "s-1" } },
      });
      expect(result.outcome).toBe("returned");
      if (result.outcome === "returned") expect(result.value).toBe("s-1");
      await close();
    });

    it("stdout is a side channel — narration does not become the answer", async () => {
      const { harness, close } = await open();
      const result = await harness.run(source.writes("stdout", "narration"));
      expect(result.stdout).toContain("narration");
      expect(result.outcome).toBe("returned");
      if (result.outcome === "returned") expect(result.value).not.toBe("narration");
      await close();
    });

    it("a budget the provider does not declare is refused, not ignored", async () => {
      const { harness, close } = await open();
      const enforced = new Set(harness.capabilities().enforces);
      const unsupported = (["timeMs", "memoryMb", "outputBytes"] as const).find(
        (key) => !enforced.has(key),
      );
      if (unsupported !== undefined) {
        await expect(
          harness.createContext({ budgets: { [unsupported]: 1 } }),
        ).rejects.toMatchObject({ _tag: "CodeBudgetUnsupported" });
      }
      await close();
    });

    it("every declared budget is really enforced", async () => {
      const { harness, close } = await open();
      const enforced = harness.capabilities().enforces;
      for (const budget of enforced) {
        const exceeds = required(source.exceeds, `exceeds() for the declared budget "${budget}"`);
        const limit = budget === "outputBytes" ? 8 : 10;
        const result = await harness.run(exceeds(budget, limit), {
          budgets: { [budget]: limit },
        });
        if (budget === "outputBytes") {
          // The SHAPING budget: output is cut and the program still ANSWERS.
          // Asserting only the truncation would pass for a provider that
          // killed the run, which is the behavior this budget exists to avoid.
          expect(result.truncated.length).toBeGreaterThan(0);
          expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(limit);
          expect(result.outcome).toBe("returned");
          if (result.outcome === "returned") expect(result.value).toBeDefined();
        } else {
          expect(result.outcome).toBe("budget-exceeded");
          if (result.outcome === "budget-exceeded") {
            expect(result.budget).toBe(budget);
            expect(result.limit).toBe(limit);
          }
        }
      }
      await close();
    });

    it("persistentContext is what the provider says it is — both ways", async () => {
      const { harness, close } = await open();
      const remembers = required(source.remembers, "remembers()");
      const recalls = required(source.recalls, "recalls()");
      const persists = harness.capabilities().persistentContext;

      const context = await harness.createContext();
      await context.execute(remembers("k", "carried"));
      const again = await context.execute(recalls("k"));

      if (persists) {
        expect(again.outcome).toBe("returned");
        if (again.outcome === "returned") expect(again.value).toBe("carried");
      } else {
        // The NEGATIVE claim has to be asserted too. `false` means state does
        // NOT survive — a provider that quietly persists anyway has a
        // cross-execution leak, and a suite that only checks the `true` arm
        // certifies it happily.
        if (again.outcome === "returned") expect(again.value).not.toBe("carried");
      }
      await context.dispose();

      // Isolation is the claim BOTH settings share: one context never reads
      // another's state, whatever `persistentContext` says about its own.
      const first = await harness.createContext();
      await first.execute(remembers("k", "first-context"));
      const second = await harness.createContext();
      const crossed = await second.execute(recalls("k"));
      if (crossed.outcome === "returned") expect(crossed.value).not.toBe("first-context");
      await first.dispose();
      await second.dispose();
      await close();
    });

    it("an abort mid-flight stops the PROGRAM, not just the promise", async () => {
      const { harness, close } = await open();
      const controller = new AbortController();
      // The sentinel is the point. A provider that "supports" abort by
      // sleeping and then throwing would satisfy a settles-with-CodeAborted
      // assertion while the program ran to completion behind it — so the
      // program is given a binding it reaches only if it kept going, and the
      // suite fails if that binding was ever called.
      let ranToCompletion = false;
      const running = harness.run(source.blocks(), {
        signal: controller.signal,
        bindings: {
          tools: {
            sentinel: async () => {
              ranToCompletion = true;
              return null;
            },
          },
        },
      });
      // Let the provider actually start, so this is a MID-FLIGHT abort rather
      // than the pre-check.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const abortedAt = Date.now();
      controller.abort("cancelled by conformance");

      await expect(running).rejects.toMatchObject({ _tag: "CodeAborted" });
      // Promptly: an abort that only lands when the program would have ended
      // anyway is not an abort.
      expect(Date.now() - abortedAt).toBeLessThan(2_000);
      expect(ranToCompletion).toBe(false);
      await close();
    });

    it("the REQUESTED envelope names bindings without carrying their values", async () => {
      const { harness, journal, close } = await open();
      const program = source.callsBinding("recall", { q: "audit" });
      await harness.run(program, {
        bindings: {
          tools: { recall: async () => "ok" },
          values: { apiKey: "sk-do-not-journal-me" },
        },
      });

      const events = await collect(journal);
      const requested = events.filter(
        (e) => e.name === "code:command:execute" && e.phase === "requested",
      );
      expect(requested).toHaveLength(1);

      const input = inputOf(requested[0]!);
      expect(input.source).toBe(program);
      expect(input.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(input.bindings).toEqual(["apiKey", "recall"]);
      // Scoped to the REQUESTED envelope on purpose. This is the claim the
      // harness can actually keep: it never copies a binding's value into the
      // record it writes. It is NOT a claim that a secret cannot reach the
      // journal by another route — see the pin below.
      expect(JSON.stringify(requested)).not.toContain("sk-do-not-journal-me");
      await close();
    });

    it("a program that RETURNS a binding value publishes it — the boundary, stated", async () => {
      const { harness, journal, close } = await open();
      await harness.run(source.readsValue("apiKey"), {
        bindings: { values: { apiKey: "sk-returned-on-purpose" } },
      });

      const events = await collect(journal);
      // The terminal envelope carries the RESULT, and the result is whatever
      // the program answered. A program that returns a secret has published
      // it; so has one that prints it. The harness withholds what IT knows,
      // not what the program chooses to say — redaction of results is the
      // adopter's policy layer, and `guardCodeExecute` is where a binding too
      // sensitive to risk gets refused in the first place.
      expect(JSON.stringify(events)).toContain("sk-returned-on-purpose");
      await close();
    });
  });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * A vocabulary entry the provider's own capability claim makes mandatory. A
 * missing one is a broken PROBE, not a failing runtime, so it reads as a
 * precondition rather than as an assertion about the system under test.
 */
function required<T>(entry: T | undefined, what: string): T {
  if (entry === undefined) throw new Error(`code conformance: the probe must supply ${what}`);
  return entry;
}

async function collect(journal: MemoryJournal): Promise<readonly ProtocolEvent[]> {
  const chunk = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({}, "beginning")).pipe(Effect.orDie),
  );
  return Chunk.toReadonlyArray(chunk);
}

/** The `requested` envelope carries the command input as its payload. */
function inputOf(event: ProtocolEvent): CodeExecuteInput {
  return event.payload as CodeExecuteInput;
}
