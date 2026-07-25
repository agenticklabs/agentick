/**
 * `LanguageModelExecutor.fx.run` — the dual-typed edge on a SPINE harness
 * (ADR 77 Stage 2). Unlike knobs, the executor's `run` is not a registry
 * command — it builds its Operation inline — so `.fx` is hand-exposed
 * (`get fx()` returns the very `runOperation(op, body)` Effect that `run`
 * already builds, un-run) rather than `fxProxy`-derived.
 *
 * Proves:
 *   - `executor.fx.run(input)` is a composable Effect (un-run; nests in a
 *     parent `Effect.gen` — the shape Stage 3's loop needs).
 *   - `executor.run(input)` is the derived Promise facade.
 *   - Both drive the SAME Operation → identical terminal.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  NormalizeInput,
  ProjectInput,
  RenderedTree,
  RunInput,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { LanguageModelExecutor } from "../language-model-executor.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

interface StubRaw {
  readonly text: string;
}

function stubAdapter(): LanguageModelAdapter<StubRaw, never> {
  return {
    provider: "stub",
    target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
    streamByDefault: false,
    prepareRequest(_input: ExecuteInput<LanguageModelInput>): unknown {
      return {};
    },
    send(): Promise<StubRaw> {
      return Promise.resolve({ text: "ok" });
    },
    // Required by the adapter contract; unused — `run` takes the
    // non-streaming (`call`) path since `streamByDefault` is false.
    async *openStream(): AsyncIterable<never> {},
    mapChunk(): readonly AdapterDelta[] {
      return [];
    },
    reconstructRaw(_accum: StreamAccumulatorView): StubRaw {
      return { text: "ok" };
    },
    normalize(raw: StubRaw): LanguageModelExecutionResult {
      return {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
}

async function makeExecutor(scope = "exec-fx"): Promise<LanguageModelExecutor<StubRaw, never>> {
  const exec = new LanguageModelExecutor<StubRaw, never>(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: stubAdapter() },
  );
  await exec.ready;
  return exec;
}

const emptyTree = (): RenderedTree => ({
  specVersion: "2026-05-08",
  context: { entries: [] },
});

const mkInput = (executionId: string): RunInput => ({
  compiled: emptyTree(),
  target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
  tools: [],
  scope: { executionId },
});

describe("LanguageModelExecutor — .fx.run dual-typed edge", () => {
  it("fx.run returns a composable Effect (not a Promise)", async () => {
    const exec = await makeExecutor();
    const eff = exec.fx.run(mkInput("e1"));

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const terminal = await Effect.runPromise(eff);
    expect(terminal.outcome).toBe("succeeded");
  });

  it("the plain run() is the Promise facade", async () => {
    const exec = await makeExecutor();
    const p = exec.run(mkInput("e2"));

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);

    const terminal = await p;
    expect(terminal.outcome).toBe("succeeded");
  });

  it("fx.run nests in one Effect.gen (single fiber tree)", async () => {
    const exec = await makeExecutor();

    // Two ticks composed with yield* — one fiber, no runPromise between.
    const [t1, t2] = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* exec.fx.run(mkInput("e3"));
        const b = yield* exec.fx.run(mkInput("e4"));
        return [a, b] as const;
      }),
    );

    expect(t1.outcome).toBe("succeeded");
    expect(t2.outcome).toBe("succeeded");
  });

  it("both surfaces drive the same Operation → identical terminal shape", async () => {
    const viaFx = await makeExecutor("via-fx");
    const viaPromise = await makeExecutor("via-promise");

    const fromFx = await Effect.runPromise(viaFx.fx.run(mkInput("same")));
    const fromPromise = await viaPromise.run(mkInput("same"));

    expect(fromFx.outcome).toBe(fromPromise.outcome);
    if (fromFx.outcome === "succeeded" && fromPromise.outcome === "succeeded") {
      expect(fromFx.result.output).toEqual(fromPromise.result.output);
    }
  });
});

// ============================================================================
// project / normalize twins (Stage 3) — the streaming path splits
// project → executeStream → normalize so it can forward deltas; the two
// bookend phases compose in the loop's fiber via these twins.
// ============================================================================

const mkProjectInput = (): ProjectInput => ({
  compiled: emptyTree(),
  target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
  tools: [],
});

const mkNormalizeInput = (raw: StubRaw): NormalizeInput<StubRaw> => ({
  targetOutput: raw,
  target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
  scope: {},
});

describe("LanguageModelExecutor — .fx.project / .fx.normalize twins", () => {
  it("fx.project is a composable Effect; project() is the Promise facade; same output", async () => {
    const exec = await makeExecutor("proj");
    const eff = exec.fx.project(mkProjectInput());

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const fromFx = await Effect.runPromise(eff);
    const fromFacade = await exec.project(mkProjectInput());
    expect(fromFx).toEqual(fromFacade);
  });

  it("fx.normalize is a composable Effect; normalize() is the Promise facade; same result", async () => {
    const exec = await makeExecutor("norm");
    const eff = exec.fx.normalize(mkNormalizeInput({ text: "hi" }));

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const fromFx = await Effect.runPromise(eff);
    const fromFacade = await exec.normalize(mkNormalizeInput({ text: "hi" }));
    expect(fromFx.output).toEqual(fromFacade.output);
    expect(fromFx.output).toEqual([{ type: "text", text: "hi" }]);
  });

  it("project + normalize nest in one Effect.gen (the streaming-path bookends, single fiber)", async () => {
    const exec = await makeExecutor("proj-norm");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // project → (executeStream elided) → normalize, all in-fiber.
        yield* exec.fx.project(mkProjectInput());
        return yield* exec.fx.normalize(mkNormalizeInput({ text: "composed" }));
      }),
    );

    expect(result.output).toEqual([{ type: "text", text: "composed" }]);
  });
});
